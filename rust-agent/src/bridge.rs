use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, info, warn};

use crate::channels::DriverRegistry;
use crate::config::GatewayConfig;
use crate::gateway::MethodRegistry;
use crate::protocol::{
    classify_method, decision_event_frame, frame_kind, parse_frame_text, parse_rpc_request,
    parse_rpc_response, ConnectFrame, FrameKind,
};
use crate::scheduler::{SessionScheduler, SubmitOutcome};
use crate::security::ActionEvaluator;
use crate::types::ActionRequest;

pub struct GatewayBridge {
    gateway: GatewayConfig,
    decision_event: String,
    max_queue: usize,
    drivers: Arc<DriverRegistry>,
    methods: Arc<MethodRegistry>,
}

impl GatewayBridge {
    pub fn new(gateway: GatewayConfig, decision_event: String, max_queue: usize) -> Self {
        Self {
            gateway,
            decision_event,
            max_queue: max_queue.max(16),
            drivers: Arc::new(DriverRegistry::default_registry()),
            methods: Arc::new(MethodRegistry::default_registry()),
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
        let capabilities = self
            .drivers
            .capabilities()
            .into_iter()
            .map(|c| c.name)
            .collect::<Vec<_>>()
            .join(",");
        debug!("active channel drivers: {capabilities}");

        info!("connecting to gateway {}", self.gateway.url);
        let (stream, _resp) = connect_async(&self.gateway.url)
            .await
            .with_context(|| "failed websocket connect")?;
        let (mut write, mut read) = stream.split();
        let (decision_tx, mut decision_rx) = mpsc::channel::<serde_json::Value>(self.max_queue);
        let inflight = Arc::new(Semaphore::new(self.max_queue));
        let scheduler = Arc::new(SessionScheduler::new(self.max_queue));

        let connect_frame = ConnectFrame::new(self.gateway.token.as_deref()).to_value();
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
                            let frame = match parse_frame_text(&text) {
                                Ok(v) => v,
                                Err(err) => {
                                    debug!("skip non-json frame: {err}");
                                    continue;
                                }
                            };

                            let kind = frame_kind(&frame);
                            match kind {
                                FrameKind::Req => {
                                    if let Some(req) = parse_rpc_request(&frame) {
                                        let family = classify_method(&req.method);
                                        let resolved = self.methods.resolve(&req.method);
                                        debug!(
                                            "rpc req id={} method={} family={family:?} known={}",
                                            req.id, req.method
                                            , resolved.known
                                        );
                                        if !resolved.known {
                                            warn!("unknown rpc method seen: {}", resolved.canonical);
                                        }
                                    }
                                }
                                FrameKind::Resp => {
                                    if let Some(resp) = parse_rpc_response(&frame) {
                                        if let Some(err) = resp.error {
                                            warn!(
                                                "rpc resp error id={} code={:?} message={}",
                                                resp.id, err.code, err.message
                                            );
                                        } else {
                                            debug!(
                                                "rpc resp id={} ok={:?}",
                                                resp.id, resp.ok
                                            );
                                        }
                                    }
                                    continue;
                                }
                                FrameKind::Error => {
                                    warn!("received rpc error frame");
                                    continue;
                                }
                                FrameKind::Event | FrameKind::Unknown => {}
                            }

                            if let Some(request) = self.drivers.extract(&frame) {
                                match scheduler.submit(request).await {
                                    SubmitOutcome::Dispatch(dispatch_request) => {
                                        let Ok(slot) = inflight.clone().try_acquire_owned() else {
                                            warn!(
                                                "decision queue saturated, dropping request {}",
                                                dispatch_request.id
                                            );
                                            let _ = scheduler.complete(&dispatch_request).await;
                                            continue;
                                        };
                                        spawn_session_worker(
                                            dispatch_request,
                                            slot,
                                            evaluator.clone(),
                                            decision_tx.clone(),
                                            self.decision_event.clone(),
                                            scheduler.clone(),
                                        );
                                    }
                                    SubmitOutcome::Queued => {}
                                    SubmitOutcome::Dropped {
                                        request_id,
                                        session_id,
                                    } => {
                                        warn!(
                                            "session queue full, dropping request {} (session={})",
                                            request_id, session_id
                                        );
                                    }
                                }
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

fn spawn_session_worker(
    request: ActionRequest,
    slot: OwnedSemaphorePermit,
    evaluator: Arc<dyn ActionEvaluator>,
    decision_tx: mpsc::Sender<serde_json::Value>,
    decision_event: String,
    scheduler: Arc<SessionScheduler>,
) {
    tokio::spawn(async move {
        let _permit = slot;
        let mut current = request;
        loop {
            let decision = evaluator.evaluate(current.clone()).await;
            let out = decision_event_frame(&decision_event, &current, &decision);
            let _ = decision_tx.send(out).await;

            match scheduler.complete(&current).await {
                Some(next) => {
                    current = next;
                }
                None => break,
            }
        }
    });
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
