use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::{mpsc, Semaphore};
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, info, warn};

use crate::channels::DriverRegistry;
use crate::config::GatewayConfig;
use crate::security::ActionEvaluator;
use crate::types::decision_event_frame;

pub struct GatewayBridge {
    gateway: GatewayConfig,
    decision_event: String,
    max_queue: usize,
    drivers: Arc<DriverRegistry>,
}

impl GatewayBridge {
    pub fn new(gateway: GatewayConfig, decision_event: String, max_queue: usize) -> Self {
        Self {
            gateway,
            decision_event,
            max_queue: max_queue.max(16),
            drivers: Arc::new(DriverRegistry::default_registry()),
        }
    }

    pub async fn run_forever(&self, evaluator: Arc<dyn ActionEvaluator>) -> Result<()> {
        let mut backoff_secs = 1_u64;
        loop {
            match self.run_once(evaluator.clone()).await {
                Ok(()) => {
                    warn!("gateway stream ended normally; reconnecting");
                }
                Err(err) => {
                    warn!("gateway stream failed: {err:#}");
                }
            }
            sleep(Duration::from_secs(backoff_secs)).await;
            backoff_secs = (backoff_secs * 2).min(30);
        }
    }

    async fn run_once(&self, evaluator: Arc<dyn ActionEvaluator>) -> Result<()> {
        info!("connecting to gateway {}", self.gateway.url);
        let (stream, _resp) = connect_async(&self.gateway.url)
            .await
            .with_context(|| "failed websocket connect")?;
        let (mut write, mut read) = stream.split();
        let (decision_tx, mut decision_rx) = mpsc::channel::<serde_json::Value>(self.max_queue);
        let inflight = Arc::new(Semaphore::new(self.max_queue));

        let connect_frame = json!({
            "type": "req",
            "id": "connect-openclaw-agent-rs",
            "method": "connect",
            "params": {
                "client": "openclaw-agent-rs",
                "role": "client",
                "auth": {
                    "token": self.gateway.token.clone().unwrap_or_default()
                }
            }
        });
        write
            .send(Message::Text(connect_frame.to_string()))
            .await
            .with_context(|| "failed sending connect frame")?;

        loop {
            tokio::select! {
                outbound = decision_rx.recv() => {
                    let Some(outbound) = outbound else {
                        break;
                    };
                    write
                        .send(Message::Text(outbound.to_string()))
                        .await
                        .with_context(|| "failed sending decision frame")?;
                }
                inbound = read.next() => {
                    let Some(message) = inbound else {
                        break;
                    };
                    match message {
                        Ok(Message::Text(text)) => {
                            let frame = match serde_json::from_str::<serde_json::Value>(&text) {
                                Ok(v) => v,
                                Err(err) => {
                                    debug!("skip non-json frame: {err}");
                                    continue;
                                }
                            };

                            if let Some(request) = self.drivers.extract(&frame) {
                                let Ok(slot) = inflight.clone().try_acquire_owned() else {
                                    warn!("decision queue saturated, dropping request {}", request.id);
                                    continue;
                                };
                                let tx = decision_tx.clone();
                                let local_eval = evaluator.clone();
                                let decision_event = self.decision_event.clone();
                                tokio::spawn(async move {
                                    let decision = local_eval.evaluate(request.clone()).await;
                                    let out = decision_event_frame(&decision_event, &request, &decision);
                                    let _ = tx.send(out).await;
                                    drop(slot);
                                });
                            }
                        }
                        Ok(Message::Binary(_)) => {}
                        Ok(Message::Ping(payload)) => {
                            write.send(Message::Pong(payload)).await?;
                        }
                        Ok(Message::Pong(_)) => {}
                        Ok(Message::Close(frame)) => {
                            info!("gateway closed websocket: {:?}", frame);
                            break;
                        }
                        Err(err) => {
                            return Err(err).with_context(|| "websocket read error");
                        }
                        _ => {}
                    }
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use anyhow::Result;
    use async_trait::async_trait;
    use futures_util::{SinkExt, StreamExt};
    use serde::Deserialize;
    use serde_json::{json, Value};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    use crate::config::{Config, GatewayConfig, PolicyAction};
    use crate::security::{ActionEvaluator, DefenderEngine};
    use crate::types::{ActionRequest, Decision, DecisionAction};

    use super::GatewayBridge;

    struct StubEvaluator;

    #[derive(Debug, Clone, Deserialize)]
    struct ReplaySuite {
        cases: Vec<ReplayCase>,
    }

    #[derive(Debug, Clone, Deserialize)]
    struct ReplayCase {
        name: String,
        frame: Value,
        expect: ReplayExpectation,
    }

    #[derive(Debug, Clone, Deserialize)]
    struct ReplayExpectation {
        action: DecisionAction,
        min_risk: Option<u8>,
        tags_include: Option<Vec<String>>,
    }

    #[async_trait]
    impl ActionEvaluator for StubEvaluator {
        async fn evaluate(&self, _request: ActionRequest) -> Decision {
            Decision {
                action: DecisionAction::Allow,
                risk_score: 0,
                reasons: vec!["ok".to_owned()],
                tags: vec!["test".to_owned()],
                source: "stub".to_owned(),
            }
        }
    }

    #[tokio::test]
    async fn bridge_emits_decision_event_for_action_frame() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;
            let connect_txt = connect.to_text()?;
            let connect_json: Value = serde_json::from_str(connect_txt)?;
            assert_eq!(
                connect_json.get("method").and_then(Value::as_str),
                Some("connect")
            );

            let action = json!({
                "type": "event",
                "event": "agent",
                "payload": {
                    "id": "req-bridge-1",
                    "command": "git status",
                    "sessionId": "s-bridge"
                }
            });
            write.send(Message::Text(action.to_string())).await?;

            let decision = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing decision frame"))??;
            let decision_txt = decision.to_text()?;
            let decision_json: Value = serde_json::from_str(decision_txt)?;
            assert_eq!(
                decision_json.get("event").and_then(Value::as_str),
                Some("security.decision")
            );
            assert_eq!(
                decision_json
                    .pointer("/payload/requestId")
                    .and_then(Value::as_str),
                Some("req-bridge-1")
            );
            write.send(Message::Close(None)).await?;
            Ok::<(), anyhow::Error>(())
        });

        let bridge = GatewayBridge::new(
            GatewayConfig {
                url: format!("ws://{addr}"),
                token: None,
            },
            "security.decision".to_owned(),
            16,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;

        Ok(())
    }

    #[tokio::test]
    async fn replay_harness_with_real_defender() -> Result<()> {
        let suite: ReplaySuite = serde_json::from_str(include_str!("../tests/replay/basic.json"))?;
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let cases = suite.cases.clone();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;
            let connect_txt = connect.to_text()?;
            let connect_json: Value = serde_json::from_str(connect_txt)?;
            assert_eq!(
                connect_json.get("method").and_then(Value::as_str),
                Some("connect")
            );

            for case in cases {
                write.send(Message::Text(case.frame.to_string())).await?;
                let decision = read
                    .next()
                    .await
                    .ok_or_else(|| anyhow::anyhow!("missing decision for case {}", case.name))??;
                let decision_txt = decision.to_text()?;
                let decision_json: Value = serde_json::from_str(decision_txt)?;

                assert_eq!(
                    decision_json.get("event").and_then(Value::as_str),
                    Some("security.decision"),
                    "case {}",
                    case.name
                );
                let action_value = decision_json
                    .pointer("/payload/decision/action")
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("missing action for case {}", case.name))?;
                let action: DecisionAction = serde_json::from_value(action_value)?;
                assert_eq!(action, case.expect.action, "case {}", case.name);

                if let Some(min_risk) = case.expect.min_risk {
                    let risk = decision_json
                        .pointer("/payload/decision/risk_score")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as u8;
                    assert!(
                        risk >= min_risk,
                        "case {} risk {} < expected {}",
                        case.name,
                        risk,
                        min_risk
                    );
                }
                if let Some(tags_include) = case.expect.tags_include {
                    let tags = decision_json
                        .pointer("/payload/decision/tags")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let tag_set: std::collections::HashSet<String> = tags
                        .into_iter()
                        .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                        .collect();
                    for expected_tag in tags_include {
                        assert!(
                            tag_set.contains(&expected_tag),
                            "case {} missing expected tag {}",
                            case.name,
                            expected_tag
                        );
                    }
                }
            }

            write.send(Message::Close(None)).await?;
            Ok::<(), anyhow::Error>(())
        });

        let mut cfg = Config {
            gateway: GatewayConfig {
                url: format!("ws://{addr}"),
                token: None,
            },
            ..Config::default()
        };
        cfg.security.protect_paths.clear();
        cfg.security
            .tool_policies
            .insert("browser".to_owned(), PolicyAction::Review);

        let evaluator: Arc<dyn ActionEvaluator> = DefenderEngine::new(cfg.clone()).await?;
        let bridge = GatewayBridge::new(
            cfg.gateway,
            cfg.runtime.decision_event,
            cfg.runtime.max_queue,
        );
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }
}
