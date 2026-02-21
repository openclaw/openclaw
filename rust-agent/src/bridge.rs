use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, info, warn};

use crate::channels::DriverRegistry;
use crate::config::{GatewayConfig, GroupActivationMode, SessionQueueMode};
use crate::gateway::{MethodRegistry, RpcDispatchOutcome, RpcDispatcher};
use crate::protocol::{
    classify_method, decision_event_frame, frame_kind, parse_frame_text, parse_rpc_request,
    parse_rpc_response, rpc_error_response_frame, rpc_success_response_frame, ConnectFrame,
    FrameKind,
};
use crate::scheduler::{SessionScheduler, SessionSchedulerConfig, SubmitOutcome};
use crate::security::ActionEvaluator;
use crate::types::ActionRequest;

pub struct GatewayBridge {
    gateway: GatewayConfig,
    decision_event: String,
    scheduler_cfg: SessionSchedulerConfig,
    drivers: Arc<DriverRegistry>,
    methods: Arc<MethodRegistry>,
    rpc: Arc<RpcDispatcher>,
}

impl GatewayBridge {
    pub fn new(
        gateway: GatewayConfig,
        decision_event: String,
        max_queue: usize,
        queue_mode: SessionQueueMode,
        group_activation_mode: GroupActivationMode,
    ) -> Self {
        Self {
            gateway,
            decision_event,
            scheduler_cfg: SessionSchedulerConfig::new(
                max_queue.max(16),
                queue_mode,
                group_activation_mode,
            ),
            drivers: Arc::new(DriverRegistry::default_registry()),
            methods: Arc::new(MethodRegistry::default_registry()),
            rpc: Arc::new(RpcDispatcher::new()),
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
        let (decision_tx, mut decision_rx) =
            mpsc::channel::<serde_json::Value>(self.scheduler_cfg.max_pending);
        let inflight = Arc::new(Semaphore::new(self.scheduler_cfg.max_pending));
        let scheduler = Arc::new(SessionScheduler::new(self.scheduler_cfg));

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
                                        match self.rpc.handle_request(&req).await {
                                            RpcDispatchOutcome::Handled(result) => {
                                                let response =
                                                    rpc_success_response_frame(&req.id, result);
                                                let _ = decision_tx.send(response).await;
                                                continue;
                                            }
                                            RpcDispatchOutcome::Error {
                                                code,
                                                message,
                                                details,
                                            } => {
                                                let response = rpc_error_response_frame(
                                                    &req.id, code, &message, details
                                                );
                                                let _ = decision_tx.send(response).await;
                                                continue;
                                            }
                                            RpcDispatchOutcome::NotHandled => {}
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
                                FrameKind::Event => {
                                    self.rpc.ingest_event_frame(&frame).await;
                                }
                                FrameKind::Unknown => {}
                            }

                            if let Some(request) = self.drivers.extract(&frame) {
                                let (queue_mode_override, group_activation_override) = self
                                    .rpc
                                    .session_scheduler_overrides(request.session_id.as_deref())
                                    .await;
                                let submit_outcome =
                                    if queue_mode_override.is_none() && group_activation_override.is_none() {
                                        scheduler.submit(request).await
                                    } else {
                                        scheduler
                                            .submit_with_overrides(
                                                request,
                                                queue_mode_override,
                                                group_activation_override,
                                            )
                                            .await
                                    };
                                match submit_outcome {
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
                                            self.rpc.clone(),
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
                                    SubmitOutcome::IgnoredActivation {
                                        request_id,
                                        session_id,
                                    } => {
                                        debug!(
                                            "ignored request {} due to group activation policy (session={})",
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
    rpc: Arc<RpcDispatcher>,
) {
    tokio::spawn(async move {
        let _permit = slot;
        let mut current = request;
        loop {
            let decision = evaluator.evaluate(current.clone()).await;
            rpc.record_decision(&current, &decision).await;
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
    use tokio::time::{sleep, timeout, Duration};
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    use crate::config::{
        Config, GatewayConfig, GroupActivationMode, PolicyAction, SessionQueueMode,
    };
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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
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
            cfg.runtime.session_queue_mode,
            cfg.runtime.group_activation_mode,
        );
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn mention_activation_ignores_non_mentioned_group_event() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "event",
                        "event": "agent",
                        "payload": {
                            "id": "req-ignore",
                            "sessionKey": "agent:main:discord:group:g1",
                            "chatType": "group",
                            "wasMentioned": false,
                            "command": "git status"
                        }
                    })
                    .to_string(),
                ))
                .await?;
            write
                .send(Message::Text(
                    json!({
                        "type": "event",
                        "event": "agent",
                        "payload": {
                            "id": "req-accept",
                            "sessionKey": "agent:main:discord:group:g1",
                            "chatType": "group",
                            "wasMentioned": true,
                            "command": "git status"
                        }
                    })
                    .to_string(),
                ))
                .await?;

            let decision = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for decision"))?
                .ok_or_else(|| anyhow::anyhow!("decision stream ended"))??;
            let decision_json: Value = serde_json::from_str(decision.to_text()?)?;
            assert_eq!(
                decision_json
                    .pointer("/payload/requestId")
                    .and_then(Value::as_str),
                Some("req-accept")
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
            SessionQueueMode::Followup,
            GroupActivationMode::Mention,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn session_patch_group_activation_overrides_bridge_default() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-patch-ga-override",
                        "method": "sessions.patch",
                        "params": {
                            "key": "agent:main:discord:group:g-override",
                            "groupActivation": "always"
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let patch_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for patch response"))?
                .ok_or_else(|| anyhow::anyhow!("patch response stream ended"))??;
            let patch_json: Value = serde_json::from_str(patch_response.to_text()?)?;
            assert_eq!(patch_json.get("ok").and_then(Value::as_bool), Some(true));

            write
                .send(Message::Text(
                    json!({
                        "type": "event",
                        "event": "agent",
                        "payload": {
                            "id": "req-override-accepted",
                            "sessionKey": "agent:main:discord:group:g-override",
                            "chatType": "group",
                            "wasMentioned": false,
                            "command": "git status"
                        }
                    })
                    .to_string(),
                ))
                .await?;

            let decision = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for decision"))?
                .ok_or_else(|| anyhow::anyhow!("decision stream ended"))??;
            let decision_json: Value = serde_json::from_str(decision.to_text()?)?;
            assert_eq!(
                decision_json
                    .pointer("/payload/requestId")
                    .and_then(Value::as_str),
                Some("req-override-accepted")
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
            SessionQueueMode::Followup,
            GroupActivationMode::Mention,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    struct SlowEvaluator;

    #[async_trait]
    impl ActionEvaluator for SlowEvaluator {
        async fn evaluate(&self, request: ActionRequest) -> Decision {
            sleep(Duration::from_millis(120)).await;
            Decision {
                action: DecisionAction::Allow,
                risk_score: 0,
                reasons: vec![format!("ok:{}", request.id)],
                tags: vec!["test".to_owned()],
                source: "slow-stub".to_owned(),
            }
        }
    }

    #[tokio::test]
    async fn steer_mode_keeps_latest_pending_at_bridge_level() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            for req_id in ["req-1", "req-2", "req-3"] {
                write
                    .send(Message::Text(
                        json!({
                            "type": "event",
                            "event": "agent",
                            "payload": {
                                "id": req_id,
                                "sessionKey": "agent:main:discord:group:g1",
                                "chatType": "group",
                                "wasMentioned": true,
                                "prompt": format!("hello-{req_id}")
                            }
                        })
                        .to_string(),
                    ))
                    .await?;
            }

            let mut seen = Vec::new();
            while seen.len() < 2 {
                let decision = timeout(Duration::from_secs(3), read.next())
                    .await
                    .map_err(|_| anyhow::anyhow!("timed out waiting for decision"))?
                    .ok_or_else(|| anyhow::anyhow!("decision stream ended"))??;
                let decision_json: Value = serde_json::from_str(decision.to_text()?)?;
                if let Some(req_id) = decision_json
                    .pointer("/payload/requestId")
                    .and_then(Value::as_str)
                {
                    seen.push(req_id.to_owned());
                }
            }

            assert_eq!(seen, vec!["req-1".to_owned(), "req-3".to_owned()]);
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
            SessionQueueMode::Steer,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(SlowEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn session_patch_queue_mode_overrides_bridge_default() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-patch-qm-override",
                        "method": "sessions.patch",
                        "params": {
                            "key": "agent:main:discord:group:g-qm-override",
                            "queueMode": "steer"
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let _patch_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for patch response"))?
                .ok_or_else(|| anyhow::anyhow!("patch response stream ended"))??;

            for req_id in ["req-qm-1", "req-qm-2", "req-qm-3"] {
                write
                    .send(Message::Text(
                        json!({
                            "type": "event",
                            "event": "agent",
                            "payload": {
                                "id": req_id,
                                "sessionKey": "agent:main:discord:group:g-qm-override",
                                "chatType": "group",
                                "wasMentioned": true,
                                "prompt": format!("hello-{req_id}")
                            }
                        })
                        .to_string(),
                    ))
                    .await?;
            }

            let mut seen = Vec::new();
            while seen.len() < 2 {
                let decision = timeout(Duration::from_secs(3), read.next())
                    .await
                    .map_err(|_| anyhow::anyhow!("timed out waiting for decision"))?
                    .ok_or_else(|| anyhow::anyhow!("decision stream ended"))??;
                let decision_json: Value = serde_json::from_str(decision.to_text()?)?;
                if let Some(req_id) = decision_json
                    .pointer("/payload/requestId")
                    .and_then(Value::as_str)
                {
                    seen.push(req_id.to_owned());
                }
            }

            assert_eq!(seen, vec!["req-qm-1".to_owned(), "req-qm-3".to_owned()]);
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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(SlowEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn rpc_sessions_patch_returns_response_frame() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-patch",
                        "method": "sessions.patch",
                        "params": {
                            "key": "agent:main:discord:group:g1",
                            "sendPolicy": "deny",
                            "groupActivation": "mention",
                            "queueMode": "steer"
                        }
                    })
                    .to_string(),
                ))
                .await?;

            let response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for rpc response"))?
                .ok_or_else(|| anyhow::anyhow!("rpc response stream ended"))??;
            let response_json: Value = serde_json::from_str(response.to_text()?)?;

            assert_eq!(
                response_json.get("type").and_then(Value::as_str),
                Some("resp")
            );
            assert_eq!(
                response_json.get("id").and_then(Value::as_str),
                Some("req-patch")
            );
            assert_eq!(response_json.get("ok").and_then(Value::as_bool), Some(true));
            assert_eq!(
                response_json.pointer("/result/ok").and_then(Value::as_bool),
                Some(true)
            );
            assert_eq!(
                response_json.pointer("/result/key").and_then(Value::as_str),
                Some("agent:main:discord:group:g1")
            );
            assert_eq!(
                response_json
                    .pointer("/result/entry/sendPolicy")
                    .and_then(Value::as_str),
                Some("deny")
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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn rpc_sessions_patch_supports_null_clear_roundtrip() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-patch-set",
                        "method": "sessions.patch",
                        "params": {
                            "key": "agent:main:discord:group:g-patch-clear",
                            "sendPolicy": "deny",
                            "verboseLevel": "off",
                            "model": "openai/gpt-4o-mini"
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let set_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for set patch response"))?
                .ok_or_else(|| anyhow::anyhow!("set patch response stream ended"))??;
            let set_json: Value = serde_json::from_str(set_response.to_text()?)?;
            assert_eq!(
                set_json
                    .pointer("/result/entry/sendPolicy")
                    .and_then(Value::as_str),
                Some("deny")
            );
            assert_eq!(
                set_json
                    .pointer("/result/entry/modelOverride")
                    .and_then(Value::as_str),
                Some("gpt-4o-mini")
            );

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-patch-clear",
                        "method": "sessions.patch",
                        "params": {
                            "key": "agent:main:discord:group:g-patch-clear",
                            "sendPolicy": null,
                            "verboseLevel": null,
                            "model": null
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let clear_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for clear patch response"))?
                .ok_or_else(|| anyhow::anyhow!("clear patch response stream ended"))??;
            let clear_json: Value = serde_json::from_str(clear_response.to_text()?)?;
            assert!(clear_json.pointer("/result/entry/sendPolicy").is_none());
            assert!(clear_json.pointer("/result/entry/verboseLevel").is_none());
            assert!(clear_json.pointer("/result/entry/modelOverride").is_none());
            assert!(clear_json
                .pointer("/result/entry/providerOverride")
                .is_none());

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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn rpc_sessions_list_reflects_recorded_decisions() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "event",
                        "event": "agent",
                        "payload": {
                            "id": "req-action-1",
                            "sessionKey": "agent:main:discord:group:g1",
                            "chatType": "group",
                            "wasMentioned": true,
                            "command": "git status"
                        }
                    })
                    .to_string(),
                ))
                .await?;

            let _decision = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for decision"))?
                .ok_or_else(|| anyhow::anyhow!("decision stream ended"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-list",
                        "method": "sessions.list",
                        "params": {"limit": 10}
                    })
                    .to_string(),
                ))
                .await?;

            let response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for list response"))?
                .ok_or_else(|| anyhow::anyhow!("list response stream ended"))??;
            let response_json: Value = serde_json::from_str(response.to_text()?)?;

            assert_eq!(
                response_json.get("type").and_then(Value::as_str),
                Some("resp")
            );
            assert_eq!(
                response_json.get("id").and_then(Value::as_str),
                Some("req-list")
            );
            assert_eq!(response_json.get("ok").and_then(Value::as_bool), Some(true));
            assert_eq!(
                response_json
                    .pointer("/result/sessions/0/key")
                    .and_then(Value::as_str),
                Some("agent:main:discord:group:g1")
            );
            assert_eq!(
                response_json
                    .pointer("/result/sessions/0/totalRequests")
                    .and_then(Value::as_u64),
                Some(1)
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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn rpc_sessions_send_and_history_roundtrip() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-send",
                        "method": "sessions.send",
                        "params": {
                            "sessionKey": "agent:main:discord:group:g9",
                            "message": "hello-session",
                            "requestId": "rpc-out-9",
                            "channel": "discord"
                        }
                    })
                    .to_string(),
                ))
                .await?;

            let send_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for send response"))?
                .ok_or_else(|| anyhow::anyhow!("send response stream ended"))??;
            let send_json: Value = serde_json::from_str(send_response.to_text()?)?;
            assert_eq!(send_json.get("type").and_then(Value::as_str), Some("resp"));
            assert_eq!(
                send_json.get("id").and_then(Value::as_str),
                Some("req-send")
            );
            assert_eq!(send_json.get("ok").and_then(Value::as_bool), Some(true));
            assert_eq!(
                send_json
                    .pointer("/result/recorded/kind")
                    .and_then(Value::as_str),
                Some("send")
            );

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-history",
                        "method": "sessions.history",
                        "params": {
                            "sessionKey": "agent:main:discord:group:g9",
                            "limit": 10
                        }
                    })
                    .to_string(),
                ))
                .await?;

            let history_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for history response"))?
                .ok_or_else(|| anyhow::anyhow!("history response stream ended"))??;
            let history_json: Value = serde_json::from_str(history_response.to_text()?)?;

            assert_eq!(
                history_json.get("type").and_then(Value::as_str),
                Some("resp")
            );
            assert_eq!(
                history_json.get("id").and_then(Value::as_str),
                Some("req-history")
            );
            assert_eq!(history_json.get("ok").and_then(Value::as_bool), Some(true));
            assert_eq!(
                history_json
                    .pointer("/result/count")
                    .and_then(Value::as_u64),
                Some(1)
            );
            assert_eq!(
                history_json
                    .pointer("/result/history/0/text")
                    .and_then(Value::as_str),
                Some("hello-session")
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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn rpc_sessions_resolve_reset_delete_roundtrip() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-patch2",
                        "method": "sessions.patch",
                        "params": {
                            "sessionKey": "agent:main:discord:group:g10",
                            "queueMode": "steer"
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let _patch_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for patch response"))?
                .ok_or_else(|| anyhow::anyhow!("patch response stream ended"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-resolve2",
                        "method": "sessions.resolve",
                        "params": {
                            "sessionKey": "agent:main:discord:group:g10"
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let resolve_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for resolve response"))?
                .ok_or_else(|| anyhow::anyhow!("resolve response stream ended"))??;
            let resolve_json: Value = serde_json::from_str(resolve_response.to_text()?)?;
            assert_eq!(
                resolve_json.pointer("/result/key").and_then(Value::as_str),
                Some("agent:main:discord:group:g10")
            );

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-reset2",
                        "method": "sessions.reset",
                        "params": {
                            "sessionKey": "agent:main:discord:group:g10",
                            "reason": "new"
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let reset_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for reset response"))?
                .ok_or_else(|| anyhow::anyhow!("reset response stream ended"))??;
            let reset_json: Value = serde_json::from_str(reset_response.to_text()?)?;
            assert_eq!(
                reset_json
                    .pointer("/result/session/totalRequests")
                    .and_then(Value::as_u64),
                Some(0)
            );

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-delete2",
                        "method": "sessions.delete",
                        "params": {
                            "sessionKey": "agent:main:discord:group:g10"
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let delete_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for delete response"))?
                .ok_or_else(|| anyhow::anyhow!("delete response stream ended"))??;
            let delete_json: Value = serde_json::from_str(delete_response.to_text()?)?;
            assert_eq!(
                delete_json
                    .pointer("/result/deleted")
                    .and_then(Value::as_bool),
                Some(true)
            );
            assert_eq!(
                delete_json.pointer("/result/path").and_then(Value::as_str),
                Some("memory://session-registry")
            );
            assert_eq!(
                delete_json
                    .pointer("/result/archived/0")
                    .and_then(Value::as_str),
                Some("memory://session-registry/archives/agent:main:discord:group:g10.deleted")
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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn rpc_sessions_resolve_by_label_roundtrip() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-patch-label",
                        "method": "sessions.patch",
                        "params": {
                            "sessionKey": "agent:ops:discord:subagent:g15",
                            "label": "deploy",
                            "spawnedBy": "main"
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let _patch_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for patch response"))?
                .ok_or_else(|| anyhow::anyhow!("patch response stream ended"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-resolve-label",
                        "method": "sessions.resolve",
                        "params": {
                            "label": "deploy",
                            "agentId": "ops",
                            "spawnedBy": "main",
                            "includeUnknown": true,
                            "includeGlobal": false
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let resolve_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for resolve response"))?
                .ok_or_else(|| anyhow::anyhow!("resolve response stream ended"))??;
            let resolve_json: Value = serde_json::from_str(resolve_response.to_text()?)?;
            assert_eq!(
                resolve_json.pointer("/result/key").and_then(Value::as_str),
                Some("agent:ops:discord:subagent:g15")
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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn rpc_sessions_preview_and_compact_roundtrip() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            for idx in 0..3 {
                write
                    .send(Message::Text(
                        json!({
                            "type": "req",
                            "id": format!("req-send-p{idx}"),
                            "method": "sessions.send",
                            "params": {
                                "sessionKey": "agent:main:discord:group:g11",
                                "message": format!("preview-message-{idx}")
                            }
                        })
                        .to_string(),
                    ))
                    .await?;
                let _ = timeout(Duration::from_secs(2), read.next())
                    .await
                    .map_err(|_| anyhow::anyhow!("timed out waiting for send response"))?
                    .ok_or_else(|| anyhow::anyhow!("send response stream ended"))??;
            }

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-preview3",
                        "method": "sessions.preview",
                        "params": {
                            "keys": ["agent:main:discord:group:g11"],
                            "limit": 5,
                            "maxChars": 16
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let preview_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for preview response"))?
                .ok_or_else(|| anyhow::anyhow!("preview response stream ended"))??;
            let preview_json: Value = serde_json::from_str(preview_response.to_text()?)?;
            assert_eq!(
                preview_json
                    .pointer("/result/previews/0/status")
                    .and_then(Value::as_str),
                Some("ok")
            );

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-compact3",
                        "method": "sessions.compact",
                        "params": {
                            "sessionKey": "agent:main:discord:group:g11",
                            "maxLines": 1
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let compact_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for compact response"))?
                .ok_or_else(|| anyhow::anyhow!("compact response stream ended"))??;
            let compact_json: Value = serde_json::from_str(compact_response.to_text()?)?;
            assert_eq!(
                compact_json
                    .pointer("/result/compacted")
                    .and_then(Value::as_bool),
                Some(true)
            );
            assert_eq!(
                compact_json.pointer("/result/kept").and_then(Value::as_u64),
                Some(1)
            );
            assert_eq!(
                compact_json.pointer("/result/path").and_then(Value::as_str),
                Some("memory://session-registry")
            );
            assert_eq!(
                compact_json
                    .pointer("/result/archived/0")
                    .and_then(Value::as_str),
                Some("memory://session-registry/archives/agent:main:discord:group:g11.compact")
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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn rpc_sessions_usage_roundtrip() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "event",
                        "event": "agent",
                        "payload": {
                            "id": "req-usage-1",
                            "sessionKey": "agent:main:discord:group:g12",
                            "chatType": "group",
                            "wasMentioned": true,
                            "command": "git status"
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let _decision = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for decision"))?
                .ok_or_else(|| anyhow::anyhow!("decision stream ended"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-usage-2",
                        "method": "sessions.usage",
                        "params": {
                            "sessionKey": "agent:main:discord:group:g12",
                            "limit": 10
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let usage_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for usage response"))?
                .ok_or_else(|| anyhow::anyhow!("usage response stream ended"))??;
            let usage_json: Value = serde_json::from_str(usage_response.to_text()?)?;
            assert_eq!(usage_json.get("ok").and_then(Value::as_bool), Some(true));
            assert_eq!(
                usage_json
                    .pointer("/result/sessions/0/totalRequests")
                    .and_then(Value::as_u64),
                Some(1)
            );
            assert_eq!(
                usage_json
                    .pointer("/result/sessions/0/allowedCount")
                    .and_then(Value::as_u64),
                Some(1)
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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn rpc_sessions_usage_includes_range_and_context_weight_hint() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "event",
                        "event": "agent",
                        "payload": {
                            "id": "req-usage-range-seed",
                            "sessionKey": "agent:main:discord:group:g16",
                            "chatType": "group",
                            "wasMentioned": true,
                            "command": "git status"
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let _decision = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for decision"))?
                .ok_or_else(|| anyhow::anyhow!("decision stream ended"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-usage-range-rpc",
                        "method": "sessions.usage",
                        "params": {
                            "sessionKey": "agent:main:discord:group:g16",
                            "includeContextWeight": true
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let usage_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for usage response"))?
                .ok_or_else(|| anyhow::anyhow!("usage response stream ended"))??;
            let usage_json: Value = serde_json::from_str(usage_response.to_text()?)?;
            assert_eq!(
                usage_json
                    .pointer("/result/range/days")
                    .and_then(Value::as_i64),
                Some(30)
            );
            assert!(
                usage_json
                    .pointer("/result/updatedAt")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    > 0
            );
            assert_eq!(
                usage_json
                    .pointer("/result/totals/totalTokens")
                    .and_then(Value::as_u64),
                Some(1)
            );
            assert!(usage_json
                .pointer("/result/sessions/0/contextWeight")
                .is_some());

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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn rpc_sessions_usage_timeseries_and_logs_roundtrip() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-usage-detail-send",
                        "method": "sessions.send",
                        "params": {
                            "sessionKey": "agent:main:discord:group:g13",
                            "message": "hello usage detail"
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let _send_resp = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for send response"))?
                .ok_or_else(|| anyhow::anyhow!("send response stream ended"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-usage-detail-logs",
                        "method": "sessions.usage.logs",
                        "params": {
                            "key": "agent:main:discord:group:g13",
                            "limit": 5
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let logs_resp = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for logs response"))?
                .ok_or_else(|| anyhow::anyhow!("logs response stream ended"))??;
            let logs_json: Value = serde_json::from_str(logs_resp.to_text()?)?;
            assert_eq!(
                logs_json.pointer("/result/count").and_then(Value::as_u64),
                Some(1)
            );

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-usage-detail-ts",
                        "method": "sessions.usage.timeseries",
                        "params": {
                            "sessionKey": "agent:main:discord:group:g13",
                            "maxPoints": 10
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let ts_resp = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for timeseries response"))?
                .ok_or_else(|| anyhow::anyhow!("timeseries response stream ended"))??;
            let ts_json: Value = serde_json::from_str(ts_resp.to_text()?)?;
            assert_eq!(
                ts_json.pointer("/result/count").and_then(Value::as_u64),
                Some(1)
            );
            assert_eq!(
                ts_json
                    .pointer("/result/points/0/sendEvents")
                    .and_then(Value::as_u64),
                Some(1)
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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn rpc_sessions_list_filters_roundtrip() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            for (id, key) in [
                ("req-lf-p1", "agent:ops:discord:group:help"),
                ("req-lf-p2", "custom:other:session"),
                ("req-lf-p3", "main"),
            ] {
                write
                    .send(Message::Text(
                        json!({
                            "type": "req",
                            "id": id,
                            "method": "sessions.patch",
                            "params": { "sessionKey": key }
                        })
                        .to_string(),
                    ))
                    .await?;
                let _ = timeout(Duration::from_secs(2), read.next())
                    .await
                    .map_err(|_| anyhow::anyhow!("timed out waiting for patch response"))?
                    .ok_or_else(|| anyhow::anyhow!("patch response stream ended"))??;
            }

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-lf-list",
                        "method": "sessions.list",
                        "params": {
                            "includeUnknown": false,
                            "includeGlobal": false,
                            "agentId": "ops",
                            "search": "help",
                            "limit": 20
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let list_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for list response"))?
                .ok_or_else(|| anyhow::anyhow!("list response stream ended"))??;
            let list_json: Value = serde_json::from_str(list_response.to_text()?)?;
            assert_eq!(
                list_json.pointer("/result/count").and_then(Value::as_u64),
                Some(1)
            );
            assert_eq!(
                list_json
                    .pointer("/result/sessions/0/key")
                    .and_then(Value::as_str),
                Some("agent:ops:discord:group:help")
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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn rpc_health_and_status_roundtrip() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            for method in ["health", "status"] {
                write
                    .send(Message::Text(
                        json!({
                            "type": "req",
                            "id": format!("req-{method}"),
                            "method": method,
                            "params": {}
                        })
                        .to_string(),
                    ))
                    .await?;
                let response = timeout(Duration::from_secs(2), read.next())
                    .await
                    .map_err(|_| anyhow::anyhow!("timed out waiting for response"))?
                    .ok_or_else(|| anyhow::anyhow!("response stream ended"))??;
                let json: Value = serde_json::from_str(response.to_text()?)?;
                assert_eq!(json.get("ok").and_then(Value::as_bool), Some(true));
                if method == "health" {
                    assert_eq!(
                        json.pointer("/result/service").and_then(Value::as_str),
                        Some("openclaw-agent-rs")
                    );
                } else {
                    assert_eq!(
                        json.pointer("/result/runtime/name").and_then(Value::as_str),
                        Some("openclaw-agent-rs")
                    );
                }
            }

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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }

    #[tokio::test]
    async fn rpc_usage_status_and_cost_roundtrip() -> Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await?;
            let ws = accept_async(stream).await?;
            let (mut write, mut read) = ws.split();

            let _connect = read
                .next()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing connect frame"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "event",
                        "event": "agent",
                        "payload": {
                            "id": "req-usage-status-cost-seed",
                            "sessionKey": "agent:main:discord:group:g14",
                            "chatType": "group",
                            "wasMentioned": true,
                            "command": "git status"
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let _decision = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for decision"))?
                .ok_or_else(|| anyhow::anyhow!("decision stream ended"))??;

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-usage-status-rpc",
                        "method": "usage.status",
                        "params": {}
                    })
                    .to_string(),
                ))
                .await?;
            let usage_status_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for usage.status response"))?
                .ok_or_else(|| anyhow::anyhow!("usage.status response stream ended"))??;
            let usage_status_json: Value = serde_json::from_str(usage_status_response.to_text()?)?;
            assert_eq!(
                usage_status_json
                    .pointer("/result/totals/totalRequests")
                    .and_then(Value::as_u64),
                Some(1)
            );

            write
                .send(Message::Text(
                    json!({
                        "type": "req",
                        "id": "req-usage-cost-rpc",
                        "method": "usage.cost",
                        "params": {
                            "days": 7
                        }
                    })
                    .to_string(),
                ))
                .await?;
            let usage_cost_response = timeout(Duration::from_secs(2), read.next())
                .await
                .map_err(|_| anyhow::anyhow!("timed out waiting for usage.cost response"))?
                .ok_or_else(|| anyhow::anyhow!("usage.cost response stream ended"))??;
            let usage_cost_json: Value = serde_json::from_str(usage_cost_response.to_text()?)?;
            assert_eq!(
                usage_cost_json.get("ok").and_then(Value::as_bool),
                Some(true)
            );
            assert_eq!(
                usage_cost_json
                    .pointer("/result/range/days")
                    .and_then(Value::as_i64),
                Some(7)
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
            SessionQueueMode::Followup,
            GroupActivationMode::Always,
        );
        let evaluator: Arc<dyn ActionEvaluator> = Arc::new(StubEvaluator);
        bridge.run_once(evaluator).await?;
        server.await??;
        Ok(())
    }
}
