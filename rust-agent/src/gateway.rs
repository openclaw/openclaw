use std::collections::{HashMap, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::config::{GroupActivationMode, SessionQueueMode};
use crate::protocol::{MethodFamily, RpcRequestFrame};
use crate::session_key::{parse_session_key, SessionKind};
use crate::types::{ActionRequest, Decision, DecisionAction};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MethodSpec {
    pub name: &'static str,
    pub family: MethodFamily,
    pub requires_auth: bool,
    pub min_role: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedMethod {
    pub requested: String,
    pub canonical: String,
    pub known: bool,
    pub spec: Option<MethodSpec>,
}

pub struct MethodRegistry {
    known: &'static [MethodSpec],
}

impl MethodRegistry {
    pub fn default_registry() -> Self {
        Self {
            known: &[
                MethodSpec {
                    name: "connect",
                    family: MethodFamily::Connect,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "health",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "status",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "usage.status",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "usage.cost",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "agent.exec",
                    family: MethodFamily::Agent,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "sessions.patch",
                    family: MethodFamily::Sessions,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "sessions.resolve",
                    family: MethodFamily::Sessions,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "sessions.list",
                    family: MethodFamily::Sessions,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "sessions.preview",
                    family: MethodFamily::Sessions,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "sessions.reset",
                    family: MethodFamily::Sessions,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "sessions.delete",
                    family: MethodFamily::Sessions,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "sessions.compact",
                    family: MethodFamily::Sessions,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "sessions.usage",
                    family: MethodFamily::Sessions,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "sessions.usage.timeseries",
                    family: MethodFamily::Sessions,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "sessions.usage.logs",
                    family: MethodFamily::Sessions,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "sessions.history",
                    family: MethodFamily::Sessions,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "sessions.send",
                    family: MethodFamily::Sessions,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "session.status",
                    family: MethodFamily::Session,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "node.invoke",
                    family: MethodFamily::Node,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "cron.add",
                    family: MethodFamily::Cron,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "gateway.restart",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "owner",
                },
                MethodSpec {
                    name: "message.send",
                    family: MethodFamily::Message,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "browser.open",
                    family: MethodFamily::Browser,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "canvas.present",
                    family: MethodFamily::Canvas,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "pairing.approve",
                    family: MethodFamily::Pairing,
                    requires_auth: true,
                    min_role: "owner",
                },
            ],
        }
    }

    pub fn resolve(&self, method: &str) -> ResolvedMethod {
        let canonical = normalize(method);
        let spec = self.known.iter().find(|s| s.name == canonical).copied();
        ResolvedMethod {
            requested: method.to_owned(),
            canonical,
            known: spec.is_some(),
            spec,
        }
    }
}

pub struct RpcDispatcher {
    sessions: SessionRegistry,
    started_at_ms: u64,
}

const MAX_SESSION_HISTORY_PER_SESSION: usize = 128;
const RUNTIME_NAME: &str = "openclaw-agent-rs";
const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");
const SUPPORTED_RPC_METHODS: &[&str] = &[
    "health",
    "status",
    "usage.status",
    "usage.cost",
    "sessions.list",
    "sessions.preview",
    "sessions.patch",
    "sessions.resolve",
    "sessions.reset",
    "sessions.delete",
    "sessions.compact",
    "sessions.usage",
    "sessions.usage.timeseries",
    "sessions.usage.logs",
    "sessions.history",
    "sessions.send",
    "session.status",
];

impl RpcDispatcher {
    pub fn new() -> Self {
        Self {
            sessions: SessionRegistry::new(),
            started_at_ms: now_ms(),
        }
    }

    pub async fn handle_request(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        match normalize(&req.method).as_str() {
            "health" => self.handle_health().await,
            "status" => self.handle_status().await,
            "usage.status" => self.handle_usage_status().await,
            "usage.cost" => self.handle_usage_cost(req).await,
            "sessions.list" => self.handle_sessions_list(req).await,
            "sessions.preview" => self.handle_sessions_preview(req).await,
            "sessions.patch" => self.handle_sessions_patch(req).await,
            "sessions.resolve" => self.handle_sessions_resolve(req).await,
            "sessions.reset" => self.handle_sessions_reset(req).await,
            "sessions.delete" => self.handle_sessions_delete(req).await,
            "sessions.compact" => self.handle_sessions_compact(req).await,
            "sessions.usage" => self.handle_sessions_usage(req).await,
            "sessions.usage.timeseries" => self.handle_sessions_usage_timeseries(req).await,
            "sessions.usage.logs" => self.handle_sessions_usage_logs(req).await,
            "sessions.history" => self.handle_sessions_history(req).await,
            "sessions.send" => self.handle_sessions_send(req).await,
            "session.status" | "sessions.status" => self.handle_session_status(req).await,
            _ => RpcDispatchOutcome::NotHandled,
        }
    }

    pub async fn record_decision(&self, request: &ActionRequest, decision: &Decision) {
        self.sessions.record_decision(request, decision).await;
    }

    async fn handle_health(&self) -> RpcDispatchOutcome {
        let now = now_ms();
        let summary = self.sessions.summary().await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "service": RUNTIME_NAME,
            "version": RUNTIME_VERSION,
            "ts": now,
            "uptimeMs": now.saturating_sub(self.started_at_ms),
            "sessions": summary
        }))
    }

    async fn handle_status(&self) -> RpcDispatchOutcome {
        let now = now_ms();
        let summary = self.sessions.summary().await;
        RpcDispatchOutcome::Handled(json!({
            "runtime": {
                "name": RUNTIME_NAME,
                "version": RUNTIME_VERSION,
                "startedAtMs": self.started_at_ms,
                "uptimeMs": now.saturating_sub(self.started_at_ms),
            },
            "sessions": summary,
            "rpc": {
                "supportedMethods": SUPPORTED_RPC_METHODS,
                "count": SUPPORTED_RPC_METHODS.len()
            }
        }))
    }

    async fn handle_usage_status(&self) -> RpcDispatchOutcome {
        let totals = self.sessions.usage_totals().await;
        RpcDispatchOutcome::Handled(json!({
            "enabled": true,
            "source": "rust-parity",
            "updatedAtMs": now_ms(),
            "totals": totals
        }))
    }

    async fn handle_usage_cost(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<UsageCostParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let totals = self.sessions.usage_totals().await;
        let range = normalize_usage_range(params.start_date, params.end_date, params.days);
        RpcDispatchOutcome::Handled(json!({
            "updatedAtMs": now_ms(),
            "range": range,
            "summary": {
                "totalCost": 0.0,
                "inputCost": 0.0,
                "outputCost": 0.0,
                "cacheReadCost": 0.0,
                "cacheWriteCost": 0.0,
                "missingCostEntries": 0
            },
            "tokens": {
                "total": totals.total_requests,
                "input": 0,
                "output": 0,
                "cacheRead": 0,
                "cacheWrite": 0
            },
            "actions": {
                "allow": totals.allowed_count,
                "review": totals.review_count,
                "block": totals.blocked_count
            }
        }))
    }

    async fn handle_sessions_list(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsListParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let sessions = self
            .sessions
            .list(SessionListQuery {
                limit: params.limit.unwrap_or(200).clamp(1, 1_000),
                active_minutes: params.active_minutes,
                include_global: params.include_global.unwrap_or(true),
                include_unknown: params.include_unknown.unwrap_or(true),
                search: normalize_optional_text(params.search, 128),
                agent_id: normalize_optional_text(params.agent_id, 64),
            })
            .await;
        RpcDispatchOutcome::Handled(json!({
            "sessions": sessions,
            "count": sessions.len()
        }))
    }

    async fn handle_sessions_preview(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsPreviewParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let keys = params
            .keys
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| {
                let normalized = v.trim().to_owned();
                if normalized.is_empty() {
                    None
                } else {
                    Some(normalized)
                }
            })
            .take(64)
            .collect::<Vec<_>>();
        let limit = params.limit.unwrap_or(12).clamp(1, 256);
        let max_chars = params.max_chars.unwrap_or(240).clamp(20, 4096);
        if keys.is_empty() {
            return RpcDispatchOutcome::Handled(json!({
                "ts": now_ms(),
                "previews": []
            }));
        }
        let previews = self.sessions.preview(&keys, limit, max_chars).await;
        RpcDispatchOutcome::Handled(json!({
            "ts": now_ms(),
            "previews": previews
        }))
    }

    async fn handle_sessions_patch(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsPatchParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let session_key = params.session_key.trim().to_owned();
        if session_key.is_empty() {
            return RpcDispatchOutcome::bad_request("sessionKey is required");
        }

        let send_policy = match params.send_policy {
            Some(v) => match parse_send_policy(&v) {
                Some(x) => Some(x),
                None => {
                    return RpcDispatchOutcome::bad_request("sendPolicy must be allow|deny|inherit")
                }
            },
            None => None,
        };
        let group_activation = match params.group_activation {
            Some(v) => match parse_group_activation_mode(&v) {
                Some(x) => Some(x),
                None => {
                    return RpcDispatchOutcome::bad_request(
                        "groupActivation must be mention|always",
                    )
                }
            },
            None => None,
        };
        let queue_mode = match params.queue_mode {
            Some(v) => match parse_queue_mode(&v) {
                Some(x) => Some(x),
                None => {
                    return RpcDispatchOutcome::bad_request(
                        "queueMode must be followup|steer|collect",
                    )
                }
            },
            None => None,
        };

        let patched = self
            .sessions
            .patch(SessionPatch {
                session_key: params.session_key,
                send_policy,
                group_activation,
                queue_mode,
                label: normalize_optional_text(params.label, 128),
                spawned_by: normalize_optional_text(params.spawned_by, 128),
            })
            .await;
        RpcDispatchOutcome::Handled(json!({
            "session": patched
        }))
    }

    async fn handle_sessions_resolve(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsResolveParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let candidate = params
            .session_key
            .or(params.key)
            .or(params.session_id)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty());
        if let Some(candidate) = candidate {
            if let Some(key) = self.sessions.resolve_key(&candidate).await {
                return RpcDispatchOutcome::Handled(json!({
                    "ok": true,
                    "key": key
                }));
            }
            return RpcDispatchOutcome::not_found("session not found");
        }

        let label = normalize_optional_text(params.label, 128);
        if label.is_none() {
            return RpcDispatchOutcome::bad_request(
                "sessionKey|key|sessionId or label is required",
            );
        }

        let key = self
            .sessions
            .resolve_query(SessionResolveQuery {
                label,
                agent_id: normalize_optional_text(params.agent_id, 64),
                spawned_by: normalize_optional_text(params.spawned_by, 64),
                include_global: params.include_global.unwrap_or(true),
                include_unknown: params.include_unknown.unwrap_or(true),
            })
            .await;
        if let Some(key) = key {
            return RpcDispatchOutcome::Handled(json!({
                "ok": true,
                "key": key
            }));
        }
        RpcDispatchOutcome::not_found("session not found")
    }

    async fn handle_sessions_reset(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsResetParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let session_key = params
            .session_key
            .or(params.key)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty());
        let Some(session_key) = session_key else {
            return RpcDispatchOutcome::bad_request("sessionKey|key is required");
        };

        let reset = self
            .sessions
            .reset(
                &session_key,
                normalize_optional_text(params.reason, 64).unwrap_or_else(|| "reset".to_owned()),
            )
            .await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "key": session_key,
            "reset": true,
            "session": reset.session,
            "reason": reset.reason
        }))
    }

    async fn handle_sessions_delete(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsDeleteParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let session_key = params
            .session_key
            .or(params.key)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty());
        let Some(session_key) = session_key else {
            return RpcDispatchOutcome::bad_request("sessionKey|key is required");
        };
        if parse_session_key(&session_key).kind == SessionKind::Main {
            return RpcDispatchOutcome::bad_request("cannot delete main session");
        }

        let deleted = self.sessions.delete(&session_key).await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "key": session_key,
            "deleted": deleted
        }))
    }

    async fn handle_sessions_compact(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsCompactParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let session_key = params
            .session_key
            .or(params.key)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty());
        let Some(session_key) = session_key else {
            return RpcDispatchOutcome::bad_request("sessionKey|key is required");
        };
        let max_lines = params.max_lines.unwrap_or(64).clamp(1, 1_024);
        let compacted = self.sessions.compact(&session_key, max_lines).await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "key": session_key,
            "compacted": compacted.compacted,
            "kept": compacted.kept,
            "removed": compacted.removed,
            "reason": compacted.reason
        }))
    }

    async fn handle_sessions_usage(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsUsageParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let session_key = params
            .session_key
            .or(params.key)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty());
        let usage = self
            .sessions
            .usage(session_key.as_deref(), params.limit)
            .await;
        RpcDispatchOutcome::Handled(json!({
            "generatedAtMs": now_ms(),
            "sessionKey": session_key,
            "sessions": usage,
            "count": usage.len()
        }))
    }

    async fn handle_sessions_usage_timeseries(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsUsageTimeseriesParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let session_key = params
            .session_key
            .or(params.key)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty());
        let Some(session_key) = session_key else {
            return RpcDispatchOutcome::bad_request("sessionKey|key is required");
        };
        let max_points = params.max_points.unwrap_or(200).clamp(1, 1_000);
        let Some(points) = self
            .sessions
            .usage_timeseries(&session_key, max_points)
            .await
        else {
            return RpcDispatchOutcome::not_found("session not found");
        };
        RpcDispatchOutcome::Handled(json!({
            "key": session_key,
            "points": points,
            "count": points.len()
        }))
    }

    async fn handle_sessions_usage_logs(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsUsageLogsParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let session_key = params
            .session_key
            .or(params.key)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty());
        let Some(session_key) = session_key else {
            return RpcDispatchOutcome::bad_request("sessionKey|key is required");
        };
        let limit = params.limit.unwrap_or(200).clamp(1, 1_000);
        let Some(logs) = self.sessions.usage_logs(&session_key, limit).await else {
            return RpcDispatchOutcome::not_found("session not found");
        };
        RpcDispatchOutcome::Handled(json!({
            "key": session_key,
            "logs": logs,
            "count": logs.len()
        }))
    }

    async fn handle_sessions_history(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsHistoryParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };

        let session_key = match params.session_key {
            Some(v) if v.trim().is_empty() => {
                return RpcDispatchOutcome::bad_request("sessionKey cannot be empty");
            }
            Some(v) => Some(v.trim().to_owned()),
            None => None,
        };

        let history = self
            .sessions
            .history(session_key.as_deref(), params.limit)
            .await;
        RpcDispatchOutcome::Handled(json!({
            "sessionKey": session_key,
            "history": history,
            "count": history.len()
        }))
    }

    async fn handle_sessions_send(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsSendParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let session_key = params.session_key.trim().to_owned();
        if session_key.is_empty() {
            return RpcDispatchOutcome::bad_request("sessionKey is required");
        }

        let message = normalize_optional_text(params.message, 2_048);
        let command = normalize_optional_text(params.command, 1_024);
        if message.is_none() && command.is_none() {
            return RpcDispatchOutcome::bad_request("message or command is required");
        }

        let (session, recorded) = self
            .sessions
            .record_send(SessionSend {
                session_key,
                request_id: params.request_id,
                message,
                command,
                source: normalize_optional_text(params.source, 128)
                    .unwrap_or_else(|| "rpc".to_owned()),
                channel: normalize_optional_text(params.channel, 128),
            })
            .await;
        RpcDispatchOutcome::Handled(json!({
            "accepted": true,
            "session": session,
            "recorded": recorded
        }))
    }

    async fn handle_session_status(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionStatusParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        if let Some(session_key) = params.session_key {
            if let Some(session) = self.sessions.get(&session_key).await {
                return RpcDispatchOutcome::Handled(json!({
                    "session": session
                }));
            }
            return RpcDispatchOutcome::not_found("session not found");
        }

        let summary = self.sessions.summary().await;
        RpcDispatchOutcome::Handled(json!({
            "summary": summary
        }))
    }
}

impl Default for RpcDispatcher {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub enum RpcDispatchOutcome {
    NotHandled,
    Handled(Value),
    Error {
        code: i64,
        message: String,
        details: Option<Value>,
    },
}

impl RpcDispatchOutcome {
    fn bad_request(message: impl Into<String>) -> Self {
        Self::Error {
            code: 400,
            message: message.into(),
            details: None,
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::Error {
            code: 404,
            message: message.into(),
            details: None,
        }
    }
}

struct SessionRegistry {
    entries: Mutex<HashMap<String, SessionEntry>>,
}

#[derive(Debug, Clone)]
struct SessionListQuery {
    limit: usize,
    active_minutes: Option<u64>,
    include_global: bool,
    include_unknown: bool,
    search: Option<String>,
    agent_id: Option<String>,
}

#[derive(Debug, Clone)]
struct SessionResolveQuery {
    label: Option<String>,
    agent_id: Option<String>,
    spawned_by: Option<String>,
    include_global: bool,
    include_unknown: bool,
}

impl SessionRegistry {
    fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    async fn record_decision(&self, request: &ActionRequest, decision: &Decision) {
        let session_key = request
            .session_id
            .clone()
            .unwrap_or_else(|| "global".to_owned());
        let now = now_ms();

        let mut guard = self.entries.lock().await;
        let entry = guard
            .entry(session_key.clone())
            .or_insert_with(|| SessionEntry::new(&session_key));

        entry.updated_at_ms = now;
        entry.total_requests += 1;
        entry.last_action = Some(decision.action);
        entry.last_risk_score = decision.risk_score;
        match decision.action {
            DecisionAction::Allow => entry.allowed_count += 1,
            DecisionAction::Review => entry.review_count += 1,
            DecisionAction::Block => entry.blocked_count += 1,
        }
        if entry.channel.is_none() {
            entry.channel = request.channel.clone();
        }
        entry.push_history(SessionHistoryEvent {
            at_ms: now,
            kind: SessionHistoryKind::Decision,
            request_id: Some(request.id.clone()),
            text: normalize_optional_text(request.prompt.clone(), 2_048),
            command: normalize_optional_text(request.command.clone(), 1_024),
            action: Some(decision.action),
            risk_score: Some(decision.risk_score),
            source: normalize_optional_text(Some(request.source.clone()), 128),
            channel: request.channel.clone().or_else(|| entry.channel.clone()),
        });
    }

    async fn record_send(&self, send: SessionSend) -> (SessionView, SessionHistoryRecord) {
        let now = now_ms();
        let mut guard = self.entries.lock().await;
        let entry = guard
            .entry(send.session_key.clone())
            .or_insert_with(|| SessionEntry::new(&send.session_key));
        entry.updated_at_ms = now;
        if entry.channel.is_none() {
            entry.channel = send.channel.clone();
        }

        let event = SessionHistoryEvent {
            at_ms: now,
            kind: SessionHistoryKind::Send,
            request_id: send.request_id,
            text: send.message,
            command: send.command,
            action: None,
            risk_score: None,
            source: Some(send.source),
            channel: send.channel.or_else(|| entry.channel.clone()),
        };
        entry.push_history(event.clone());

        let record = SessionHistoryRecord::from_event(&entry.key, event);
        (entry.to_view(), record)
    }

    async fn patch(&self, patch: SessionPatch) -> SessionView {
        let now = now_ms();
        let mut guard = self.entries.lock().await;
        let entry = guard
            .entry(patch.session_key.clone())
            .or_insert_with(|| SessionEntry::new(&patch.session_key));
        entry.updated_at_ms = now;
        if let Some(send_policy) = patch.send_policy {
            entry.send_policy = Some(send_policy);
        }
        if let Some(group_activation) = patch.group_activation {
            entry.group_activation = Some(group_activation);
        }
        if let Some(queue_mode) = patch.queue_mode {
            entry.queue_mode = Some(queue_mode);
        }
        if let Some(label) = patch.label {
            entry.label = Some(label);
        }
        if let Some(spawned_by) = patch.spawned_by {
            entry.spawned_by = Some(spawned_by);
        }
        entry.to_view()
    }

    async fn get(&self, session_key: &str) -> Option<SessionView> {
        let guard = self.entries.lock().await;
        guard.get(session_key).map(SessionEntry::to_view)
    }

    async fn resolve_key(&self, candidate: &str) -> Option<String> {
        let guard = self.entries.lock().await;
        if guard.contains_key(candidate) {
            return Some(candidate.to_owned());
        }
        guard
            .keys()
            .find(|key| key.eq_ignore_ascii_case(candidate))
            .cloned()
    }

    async fn resolve_query(&self, query: SessionResolveQuery) -> Option<String> {
        let guard = self.entries.lock().await;
        let mut entries = guard.values().cloned().collect::<Vec<_>>();
        if !query.include_unknown {
            entries.retain(|entry| entry.kind != SessionKind::Other);
        }
        if !query.include_global {
            entries.retain(|entry| !is_global_session(entry));
        }
        if let Some(label) = query.label {
            entries.retain(|entry| {
                entry
                    .label
                    .as_deref()
                    .map(|v| v.eq_ignore_ascii_case(&label))
                    .unwrap_or(false)
            });
        }
        if let Some(agent_id) = query.agent_id {
            entries.retain(|entry| {
                entry
                    .agent_id
                    .as_deref()
                    .map(|v| v.eq_ignore_ascii_case(&agent_id))
                    .unwrap_or(false)
            });
        }
        if let Some(spawned_by) = query.spawned_by {
            entries.retain(|entry| {
                entry
                    .spawned_by
                    .as_deref()
                    .map(|v| v.eq_ignore_ascii_case(&spawned_by))
                    .unwrap_or(false)
            });
        }
        entries.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
        entries.first().map(|entry| entry.key.clone())
    }

    async fn list(&self, query: SessionListQuery) -> Vec<SessionView> {
        let guard = self.entries.lock().await;
        let mut items = guard.values().cloned().collect::<Vec<_>>();
        if let Some(mins) = query.active_minutes {
            let min_updated = now_ms().saturating_sub(mins.saturating_mul(60_000));
            items.retain(|entry| entry.updated_at_ms >= min_updated);
        }
        if !query.include_unknown {
            items.retain(|entry| entry.kind != SessionKind::Other);
        }
        if !query.include_global {
            items.retain(|entry| !is_global_session(entry));
        }
        if let Some(agent_id) = query.agent_id {
            items.retain(|entry| {
                entry
                    .agent_id
                    .as_deref()
                    .map(|v| v.eq_ignore_ascii_case(&agent_id))
                    .unwrap_or(false)
            });
        }
        if let Some(search) = query.search {
            let needle = search.to_ascii_lowercase();
            items.retain(|entry| {
                entry.key.to_ascii_lowercase().contains(&needle)
                    || entry
                        .channel
                        .as_deref()
                        .map(|v| v.to_ascii_lowercase().contains(&needle))
                        .unwrap_or(false)
                    || entry
                        .agent_id
                        .as_deref()
                        .map(|v| v.to_ascii_lowercase().contains(&needle))
                        .unwrap_or(false)
                    || entry
                        .label
                        .as_deref()
                        .map(|v| v.to_ascii_lowercase().contains(&needle))
                        .unwrap_or(false)
                    || entry
                        .spawned_by
                        .as_deref()
                        .map(|v| v.to_ascii_lowercase().contains(&needle))
                        .unwrap_or(false)
            });
        }
        items.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
        items
            .into_iter()
            .take(query.limit)
            .map(|entry| entry.to_view())
            .collect()
    }

    async fn history(
        &self,
        session_key: Option<&str>,
        limit: Option<usize>,
    ) -> Vec<SessionHistoryRecord> {
        let lim = limit.unwrap_or(100).clamp(1, 1_000);
        let guard = self.entries.lock().await;
        if let Some(key) = session_key {
            return guard
                .get(key)
                .map(|entry| {
                    entry
                        .history
                        .iter()
                        .rev()
                        .take(lim)
                        .cloned()
                        .map(|event| SessionHistoryRecord::from_event(&entry.key, event))
                        .collect()
                })
                .unwrap_or_default();
        }

        let mut merged = guard
            .values()
            .flat_map(|entry| {
                entry
                    .history
                    .iter()
                    .rev()
                    .take(lim)
                    .cloned()
                    .map(|event| SessionHistoryRecord::from_event(&entry.key, event))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        merged.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
        merged.truncate(lim);
        merged
    }

    async fn preview(
        &self,
        keys: &[String],
        limit: usize,
        max_chars: usize,
    ) -> Vec<SessionPreviewEntry> {
        let guard = self.entries.lock().await;
        let lim = limit.clamp(1, 256);
        keys.iter()
            .map(|key| {
                let Some(entry) = guard.get(key) else {
                    return SessionPreviewEntry {
                        key: key.clone(),
                        status: "missing".to_owned(),
                        items: Vec::new(),
                    };
                };
                let items = entry
                    .history
                    .iter()
                    .rev()
                    .take(lim)
                    .cloned()
                    .map(|event| SessionPreviewItem {
                        at_ms: event.at_ms,
                        kind: event.kind,
                        text: event
                            .text
                            .as_deref()
                            .map(|v| truncate_text(v, max_chars))
                            .filter(|v| !v.is_empty()),
                        command: event
                            .command
                            .as_deref()
                            .map(|v| truncate_text(v, max_chars))
                            .filter(|v| !v.is_empty()),
                        action: event.action,
                        risk_score: event.risk_score,
                        source: event.source,
                        channel: event.channel,
                    })
                    .collect::<Vec<_>>();
                SessionPreviewEntry {
                    key: key.clone(),
                    status: if items.is_empty() {
                        "empty".to_owned()
                    } else {
                        "ok".to_owned()
                    },
                    items,
                }
            })
            .collect()
    }

    async fn reset(&self, session_key: &str, reason: String) -> SessionReset {
        let now = now_ms();
        let mut guard = self.entries.lock().await;
        let entry = guard
            .entry(session_key.to_owned())
            .or_insert_with(|| SessionEntry::new(session_key));
        entry.updated_at_ms = now;
        entry.total_requests = 0;
        entry.allowed_count = 0;
        entry.review_count = 0;
        entry.blocked_count = 0;
        entry.last_action = None;
        entry.last_risk_score = 0;
        entry.history.clear();
        SessionReset {
            session: entry.to_view(),
            reason,
        }
    }

    async fn delete(&self, session_key: &str) -> bool {
        let mut guard = self.entries.lock().await;
        guard.remove(session_key).is_some()
    }

    async fn compact(&self, session_key: &str, max_lines: usize) -> SessionCompactResult {
        let mut guard = self.entries.lock().await;
        let Some(entry) = guard.get_mut(session_key) else {
            return SessionCompactResult {
                compacted: false,
                kept: 0,
                removed: 0,
                reason: Some("missing session".to_owned()),
            };
        };
        let max_lines = max_lines.clamp(1, 1_024);
        let before = entry.history.len();
        if before <= max_lines {
            return SessionCompactResult {
                compacted: false,
                kept: before,
                removed: 0,
                reason: Some("below limit".to_owned()),
            };
        }

        while entry.history.len() > max_lines {
            let _ = entry.history.pop_front();
        }
        entry.updated_at_ms = now_ms();
        SessionCompactResult {
            compacted: true,
            kept: entry.history.len(),
            removed: before.saturating_sub(entry.history.len()),
            reason: None,
        }
    }

    async fn usage(
        &self,
        session_key: Option<&str>,
        limit: Option<usize>,
    ) -> Vec<SessionUsageView> {
        let lim = limit.unwrap_or(100).clamp(1, 1_000);
        let guard = self.entries.lock().await;
        let mut items = guard
            .values()
            .filter(|entry| session_key.map(|k| k == entry.key).unwrap_or(true))
            .cloned()
            .collect::<Vec<_>>();
        items.sort_by(|a, b| {
            b.total_requests
                .cmp(&a.total_requests)
                .then_with(|| b.updated_at_ms.cmp(&a.updated_at_ms))
        });
        items
            .into_iter()
            .take(lim)
            .map(|entry| SessionUsageView {
                key: entry.key,
                kind: entry.kind,
                agent_id: entry.agent_id,
                channel: entry.channel,
                label: entry.label,
                spawned_by: entry.spawned_by,
                total_requests: entry.total_requests,
                allowed_count: entry.allowed_count,
                review_count: entry.review_count,
                blocked_count: entry.blocked_count,
                last_action: entry.last_action,
                last_risk_score: entry.last_risk_score,
                updated_at_ms: entry.updated_at_ms,
            })
            .collect()
    }

    async fn usage_timeseries(
        &self,
        session_key: &str,
        max_points: usize,
    ) -> Option<Vec<SessionUsageTimeseriesPoint>> {
        let guard = self.entries.lock().await;
        let entry = guard.get(session_key)?;
        let mut by_day: HashMap<String, SessionUsageTimeseriesPoint> = HashMap::new();
        for event in &entry.history {
            let date = format_utc_date(event.at_ms);
            let point = by_day
                .entry(date.clone())
                .or_insert_with(|| SessionUsageTimeseriesPoint {
                    date,
                    total_events: 0,
                    decision_events: 0,
                    send_events: 0,
                    allow_count: 0,
                    review_count: 0,
                    block_count: 0,
                });
            point.total_events += 1;
            match event.kind {
                SessionHistoryKind::Decision => {
                    point.decision_events += 1;
                    match event.action {
                        Some(DecisionAction::Allow) => point.allow_count += 1,
                        Some(DecisionAction::Review) => point.review_count += 1,
                        Some(DecisionAction::Block) => point.block_count += 1,
                        None => {}
                    }
                }
                SessionHistoryKind::Send => {
                    point.send_events += 1;
                }
            }
        }
        let mut points = by_day.into_values().collect::<Vec<_>>();
        points.sort_by(|a, b| a.date.cmp(&b.date));
        if points.len() > max_points {
            points = points.split_off(points.len() - max_points);
        }
        Some(points)
    }

    async fn usage_logs(
        &self,
        session_key: &str,
        limit: usize,
    ) -> Option<Vec<SessionHistoryRecord>> {
        let guard = self.entries.lock().await;
        let entry = guard.get(session_key)?;
        Some(
            entry
                .history
                .iter()
                .rev()
                .take(limit.clamp(1, 1_000))
                .cloned()
                .map(|event| SessionHistoryRecord::from_event(&entry.key, event))
                .collect(),
        )
    }

    async fn usage_totals(&self) -> UsageTotals {
        let guard = self.entries.lock().await;
        UsageTotals {
            sessions: guard.len() as u64,
            total_requests: guard.values().map(|e| e.total_requests).sum(),
            allowed_count: guard.values().map(|e| e.allowed_count).sum(),
            review_count: guard.values().map(|e| e.review_count).sum(),
            blocked_count: guard.values().map(|e| e.blocked_count).sum(),
        }
    }

    async fn summary(&self) -> SessionSummary {
        let guard = self.entries.lock().await;
        let total_sessions = guard.len() as u64;
        let total_requests = guard.values().map(|e| e.total_requests).sum::<u64>();
        SessionSummary {
            total_sessions,
            total_requests,
            updated_at_ms: now_ms(),
        }
    }
}

#[derive(Debug, Clone)]
struct SessionEntry {
    key: String,
    kind: SessionKind,
    agent_id: Option<String>,
    channel: Option<String>,
    label: Option<String>,
    spawned_by: Option<String>,
    updated_at_ms: u64,
    total_requests: u64,
    allowed_count: u64,
    review_count: u64,
    blocked_count: u64,
    last_action: Option<DecisionAction>,
    last_risk_score: u8,
    send_policy: Option<SendPolicyOverride>,
    group_activation: Option<GroupActivationMode>,
    queue_mode: Option<SessionQueueMode>,
    history: VecDeque<SessionHistoryEvent>,
}

impl SessionEntry {
    fn new(session_key: &str) -> Self {
        let parsed = parse_session_key(session_key);
        Self {
            key: session_key.to_owned(),
            kind: parsed.kind,
            agent_id: parsed.agent_id,
            channel: parsed.channel,
            label: None,
            spawned_by: None,
            updated_at_ms: now_ms(),
            total_requests: 0,
            allowed_count: 0,
            review_count: 0,
            blocked_count: 0,
            last_action: None,
            last_risk_score: 0,
            send_policy: None,
            group_activation: None,
            queue_mode: None,
            history: VecDeque::new(),
        }
    }

    fn to_view(&self) -> SessionView {
        SessionView {
            key: self.key.clone(),
            kind: self.kind,
            agent_id: self.agent_id.clone(),
            channel: self.channel.clone(),
            label: self.label.clone(),
            spawned_by: self.spawned_by.clone(),
            updated_at_ms: self.updated_at_ms,
            total_requests: self.total_requests,
            allowed_count: self.allowed_count,
            review_count: self.review_count,
            blocked_count: self.blocked_count,
            last_action: self.last_action,
            last_risk_score: self.last_risk_score,
            send_policy: self.send_policy,
            group_activation: self.group_activation,
            queue_mode: self.queue_mode,
        }
    }

    fn push_history(&mut self, event: SessionHistoryEvent) {
        if self.history.len() >= MAX_SESSION_HISTORY_PER_SESSION {
            let _ = self.history.pop_front();
        }
        self.history.push_back(event);
    }
}

#[derive(Debug, Clone)]
struct SessionPatch {
    session_key: String,
    send_policy: Option<SendPolicyOverride>,
    group_activation: Option<GroupActivationMode>,
    queue_mode: Option<SessionQueueMode>,
    label: Option<String>,
    spawned_by: Option<String>,
}

#[derive(Debug, Clone)]
struct SessionReset {
    session: SessionView,
    reason: String,
}

#[derive(Debug, Clone)]
struct SessionCompactResult {
    compacted: bool,
    kept: usize,
    removed: usize,
    reason: Option<String>,
}

#[derive(Debug, Clone)]
struct SessionSend {
    session_key: String,
    request_id: Option<String>,
    message: Option<String>,
    command: Option<String>,
    source: String,
    channel: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum SessionHistoryKind {
    Decision,
    Send,
}

#[derive(Debug, Clone)]
struct SessionHistoryEvent {
    at_ms: u64,
    kind: SessionHistoryKind,
    request_id: Option<String>,
    text: Option<String>,
    command: Option<String>,
    action: Option<DecisionAction>,
    risk_score: Option<u8>,
    source: Option<String>,
    channel: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SessionHistoryRecord {
    #[serde(rename = "sessionKey")]
    session_key: String,
    #[serde(rename = "atMs")]
    at_ms: u64,
    kind: SessionHistoryKind,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<DecisionAction>,
    #[serde(rename = "riskScore", skip_serializing_if = "Option::is_none")]
    risk_score: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
}

impl SessionHistoryRecord {
    fn from_event(session_key: &str, event: SessionHistoryEvent) -> Self {
        Self {
            session_key: session_key.to_owned(),
            at_ms: event.at_ms,
            kind: event.kind,
            request_id: event.request_id,
            text: event.text,
            command: event.command,
            action: event.action,
            risk_score: event.risk_score,
            source: event.source,
            channel: event.channel,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
struct SessionPreviewEntry {
    key: String,
    status: String,
    items: Vec<SessionPreviewItem>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SessionPreviewItem {
    #[serde(rename = "atMs")]
    at_ms: u64,
    kind: SessionHistoryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<DecisionAction>,
    #[serde(rename = "riskScore", skip_serializing_if = "Option::is_none")]
    risk_score: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SessionUsageView {
    key: String,
    kind: SessionKind,
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(rename = "spawnedBy", skip_serializing_if = "Option::is_none")]
    spawned_by: Option<String>,
    #[serde(rename = "totalRequests")]
    total_requests: u64,
    #[serde(rename = "allowedCount")]
    allowed_count: u64,
    #[serde(rename = "reviewCount")]
    review_count: u64,
    #[serde(rename = "blockedCount")]
    blocked_count: u64,
    #[serde(rename = "lastAction", skip_serializing_if = "Option::is_none")]
    last_action: Option<DecisionAction>,
    #[serde(rename = "lastRiskScore")]
    last_risk_score: u8,
    #[serde(rename = "updatedAtMs")]
    updated_at_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SessionUsageTimeseriesPoint {
    date: String,
    #[serde(rename = "totalEvents")]
    total_events: u64,
    #[serde(rename = "decisionEvents")]
    decision_events: u64,
    #[serde(rename = "sendEvents")]
    send_events: u64,
    #[serde(rename = "allowCount")]
    allow_count: u64,
    #[serde(rename = "reviewCount")]
    review_count: u64,
    #[serde(rename = "blockCount")]
    block_count: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
struct UsageTotals {
    sessions: u64,
    #[serde(rename = "totalRequests")]
    total_requests: u64,
    #[serde(rename = "allowedCount")]
    allowed_count: u64,
    #[serde(rename = "reviewCount")]
    review_count: u64,
    #[serde(rename = "blockedCount")]
    blocked_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SendPolicyOverride {
    Allow,
    Deny,
    Inherit,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SessionView {
    key: String,
    kind: SessionKind,
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(rename = "spawnedBy", skip_serializing_if = "Option::is_none")]
    spawned_by: Option<String>,
    #[serde(rename = "updatedAtMs")]
    updated_at_ms: u64,
    #[serde(rename = "totalRequests")]
    total_requests: u64,
    #[serde(rename = "allowedCount")]
    allowed_count: u64,
    #[serde(rename = "reviewCount")]
    review_count: u64,
    #[serde(rename = "blockedCount")]
    blocked_count: u64,
    #[serde(rename = "lastAction")]
    last_action: Option<DecisionAction>,
    #[serde(rename = "lastRiskScore")]
    last_risk_score: u8,
    #[serde(rename = "sendPolicy", skip_serializing_if = "Option::is_none")]
    send_policy: Option<SendPolicyOverride>,
    #[serde(rename = "groupActivation", skip_serializing_if = "Option::is_none")]
    group_activation: Option<GroupActivationMode>,
    #[serde(rename = "queueMode", skip_serializing_if = "Option::is_none")]
    queue_mode: Option<SessionQueueMode>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SessionSummary {
    #[serde(rename = "totalSessions")]
    total_sessions: u64,
    #[serde(rename = "totalRequests")]
    total_requests: u64,
    #[serde(rename = "updatedAtMs")]
    updated_at_ms: u64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SessionsListParams {
    limit: Option<usize>,
    #[serde(rename = "activeMinutes", alias = "active_minutes")]
    active_minutes: Option<u64>,
    #[serde(rename = "includeGlobal", alias = "include_global")]
    include_global: Option<bool>,
    #[serde(rename = "includeUnknown", alias = "include_unknown")]
    include_unknown: Option<bool>,
    #[serde(rename = "agentId", alias = "agent_id")]
    agent_id: Option<String>,
    search: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct UsageCostParams {
    #[serde(rename = "startDate", alias = "start_date")]
    start_date: Option<String>,
    #[serde(rename = "endDate", alias = "end_date")]
    end_date: Option<String>,
    days: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SessionsPreviewParams {
    keys: Option<Vec<String>>,
    limit: Option<usize>,
    #[serde(rename = "maxChars", alias = "max_chars")]
    max_chars: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct SessionsPatchParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: String,
    #[serde(rename = "sendPolicy", alias = "send_policy")]
    send_policy: Option<String>,
    #[serde(rename = "groupActivation", alias = "group_activation")]
    group_activation: Option<String>,
    #[serde(rename = "queueMode", alias = "queue_mode")]
    queue_mode: Option<String>,
    label: Option<String>,
    #[serde(rename = "spawnedBy", alias = "spawned_by")]
    spawned_by: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SessionsResolveParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
    key: Option<String>,
    #[serde(rename = "sessionId", alias = "session_id")]
    session_id: Option<String>,
    label: Option<String>,
    #[serde(rename = "agentId", alias = "agent_id")]
    agent_id: Option<String>,
    #[serde(rename = "spawnedBy", alias = "spawned_by")]
    spawned_by: Option<String>,
    #[serde(rename = "includeGlobal", alias = "include_global")]
    include_global: Option<bool>,
    #[serde(rename = "includeUnknown", alias = "include_unknown")]
    include_unknown: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SessionsResetParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
    key: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SessionsDeleteParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
    key: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SessionsCompactParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
    key: Option<String>,
    #[serde(rename = "maxLines", alias = "max_lines")]
    max_lines: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SessionsUsageParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
    key: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SessionsUsageTimeseriesParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
    key: Option<String>,
    #[serde(rename = "maxPoints", alias = "max_points")]
    max_points: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SessionsUsageLogsParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
    key: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SessionsHistoryParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct SessionsSendParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: String,
    #[serde(rename = "message", alias = "text", alias = "prompt", alias = "input")]
    message: Option<String>,
    command: Option<String>,
    #[serde(rename = "requestId", alias = "request_id")]
    request_id: Option<String>,
    source: Option<String>,
    channel: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SessionStatusParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
}

fn decode_params<T>(value: &Value) -> Result<T, serde_json::Error>
where
    T: for<'de> Deserialize<'de>,
{
    if value.is_null() {
        serde_json::from_value(json!({}))
    } else {
        serde_json::from_value(value.clone())
    }
}

fn parse_send_policy(value: &str) -> Option<SendPolicyOverride> {
    match normalize(value).as_str() {
        "allow" => Some(SendPolicyOverride::Allow),
        "deny" => Some(SendPolicyOverride::Deny),
        "inherit" => Some(SendPolicyOverride::Inherit),
        _ => None,
    }
}

fn parse_group_activation_mode(value: &str) -> Option<GroupActivationMode> {
    match normalize(value).as_str() {
        "mention" => Some(GroupActivationMode::Mention),
        "always" => Some(GroupActivationMode::Always),
        _ => None,
    }
}

fn parse_queue_mode(value: &str) -> Option<SessionQueueMode> {
    match normalize(value).as_str() {
        "followup" => Some(SessionQueueMode::Followup),
        "steer" => Some(SessionQueueMode::Steer),
        "collect" => Some(SessionQueueMode::Collect),
        _ => None,
    }
}

fn is_global_session(entry: &SessionEntry) -> bool {
    entry.key.eq_ignore_ascii_case("global") || entry.kind == SessionKind::Main
}

fn normalize_optional_text(value: Option<String>, max_len: usize) -> Option<String> {
    let value = value?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() <= max_len {
        return Some(trimmed.to_owned());
    }
    let mut end = max_len;
    while end > 0 && !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = trimmed[..end].to_owned();
    out.push_str("...");
    Some(out)
}

fn truncate_text(value: &str, max_len: usize) -> String {
    if value.len() <= max_len {
        return value.to_owned();
    }
    let mut end = max_len;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = value[..end].to_owned();
    out.push_str("...");
    out
}

fn format_utc_date(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

fn normalize_usage_range(
    start_date: Option<String>,
    end_date: Option<String>,
    days: Option<u32>,
) -> Value {
    let today = format_utc_date(now_ms());
    let normalized_start = normalize_date_yyyy_mm_dd(start_date);
    let normalized_end = normalize_date_yyyy_mm_dd(end_date);

    let (start, end) = match (normalized_start, normalized_end) {
        (Some(start), Some(end)) => {
            let start_days = parse_date_to_days(&start).unwrap_or(0);
            let end_days = parse_date_to_days(&end).unwrap_or(0);
            if start_days <= end_days {
                (start, end)
            } else {
                (end, start)
            }
        }
        (Some(start), None) => (start, today.clone()),
        (None, Some(end)) => {
            let span = days.unwrap_or(30).max(1);
            let end_days = parse_date_to_days(&end).unwrap_or(0);
            let start_days = end_days.saturating_sub((span - 1) as i64);
            let (y, m, d) = civil_from_days(start_days);
            (format!("{y:04}-{m:02}-{d:02}"), end)
        }
        (None, None) => {
            let span = days.unwrap_or(30).max(1);
            let end_days = parse_date_to_days(&today).unwrap_or(0);
            let start_days = end_days.saturating_sub((span - 1) as i64);
            let (y, m, d) = civil_from_days(start_days);
            (format!("{y:04}-{m:02}-{d:02}"), today)
        }
    };

    let start_days = parse_date_to_days(&start).unwrap_or(0);
    let end_days = parse_date_to_days(&end).unwrap_or(start_days);
    let day_span = end_days.saturating_sub(start_days) + 1;
    json!({
        "startDate": start,
        "endDate": end,
        "days": if day_span > 0 { day_span } else { 1 }
    })
}

fn normalize_date_yyyy_mm_dd(value: Option<String>) -> Option<String> {
    let raw = value?.trim().to_owned();
    let days = parse_date_to_days(&raw)?;
    let (y, m, d) = civil_from_days(days);
    let normalized = format!("{y:04}-{m:02}-{d:02}");
    if normalized == raw {
        Some(normalized)
    } else {
        None
    }
}

fn parse_date_to_days(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year = value[0..4].parse::<i32>().ok()?;
    let month = value[5..7].parse::<u32>().ok()?;
    let day = value[8..10].parse::<u32>().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = civil_to_days(year, month, day);
    let (cy, cm, cd) = civil_from_days(days);
    if cy == year && cm == month && cd == day {
        Some(days)
    } else {
        None
    }
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32, day as u32)
}

fn civil_to_days(year: i32, month: u32, day: u32) -> i64 {
    let y = year as i64 - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = month as i64;
    let d = day as i64;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn normalize(method: &str) -> String {
    method.trim().to_ascii_lowercase()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use crate::protocol::MethodFamily;
    use crate::types::{ActionRequest, Decision, DecisionAction};

    use super::{MethodRegistry, RpcDispatchOutcome, RpcDispatcher, RpcRequestFrame};

    #[test]
    fn resolves_known_method() {
        let registry = MethodRegistry::default_registry();
        let resolved = registry.resolve("sessions.patch");
        assert!(resolved.known);
        let spec = resolved.spec.expect("spec");
        assert_eq!(spec.family, MethodFamily::Sessions);
        assert!(spec.requires_auth);
    }

    #[test]
    fn flags_unknown_method() {
        let registry = MethodRegistry::default_registry();
        let resolved = registry.resolve("foo.bar");
        assert!(!resolved.known);
        assert!(resolved.spec.is_none());
    }

    #[tokio::test]
    async fn dispatcher_patches_and_lists_sessions() {
        let dispatcher = RpcDispatcher::new();
        let patch = RpcRequestFrame {
            id: "req-1".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g1",
                "sendPolicy": "deny",
                "groupActivation": "mention",
                "queueMode": "steer"
            }),
        };
        let out = dispatcher.handle_request(&patch).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/session/key")
                        .and_then(serde_json::Value::as_str),
                    Some("agent:main:discord:group:g1")
                );
                assert_eq!(
                    payload
                        .pointer("/session/sendPolicy")
                        .and_then(serde_json::Value::as_str),
                    Some("deny")
                );
            }
            _ => panic!("expected handled patch"),
        }

        let list = RpcRequestFrame {
            id: "req-2".to_owned(),
            method: "sessions.list".to_owned(),
            params: serde_json::json!({"limit": 10}),
        };
        let out = dispatcher.handle_request(&list).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/sessions/0/key")
                        .and_then(serde_json::Value::as_str),
                    Some("agent:main:discord:group:g1")
                );
            }
            _ => panic!("expected handled list"),
        }
    }

    #[tokio::test]
    async fn dispatcher_rejects_invalid_patch_params() {
        let dispatcher = RpcDispatcher::new();
        let patch = RpcRequestFrame {
            id: "req-1".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g1",
                "queueMode": "invalid"
            }),
        };
        let out = dispatcher.handle_request(&patch).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));
    }

    #[tokio::test]
    async fn dispatcher_status_returns_not_found_for_unknown_session() {
        let dispatcher = RpcDispatcher::new();
        let req = RpcRequestFrame {
            id: "req-1".to_owned(),
            method: "session.status".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:missing"
            }),
        };
        let out = dispatcher.handle_request(&req).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 404, .. }));
    }

    #[tokio::test]
    async fn dispatcher_send_and_history_roundtrip() {
        let dispatcher = RpcDispatcher::new();
        let send = RpcRequestFrame {
            id: "req-send".to_owned(),
            method: "sessions.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g2",
                "message": "hello from rpc",
                "requestId": "out-1",
                "channel": "discord"
            }),
        };
        let out = dispatcher.handle_request(&send).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/accepted")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/recorded/kind")
                        .and_then(serde_json::Value::as_str),
                    Some("send")
                );
            }
            _ => panic!("expected handled send"),
        }

        let history = RpcRequestFrame {
            id: "req-history".to_owned(),
            method: "sessions.history".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g2",
                "limit": 5
            }),
        };
        let out = dispatcher.handle_request(&history).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/count")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                assert_eq!(
                    payload
                        .pointer("/history/0/sessionKey")
                        .and_then(serde_json::Value::as_str),
                    Some("agent:main:discord:group:g2")
                );
                assert_eq!(
                    payload
                        .pointer("/history/0/text")
                        .and_then(serde_json::Value::as_str),
                    Some("hello from rpc")
                );
            }
            _ => panic!("expected handled history"),
        }
    }

    #[tokio::test]
    async fn dispatcher_history_includes_recorded_decisions() {
        let dispatcher = RpcDispatcher::new();
        let request = ActionRequest {
            id: "req-42".to_owned(),
            source: "agent".to_owned(),
            session_id: Some("agent:main:discord:group:g3".to_owned()),
            prompt: Some("review me".to_owned()),
            command: Some("rm -rf /tmp".to_owned()),
            tool_name: Some("exec".to_owned()),
            channel: Some("discord".to_owned()),
            url: None,
            file_path: None,
            raw: serde_json::json!({}),
        };
        let decision = Decision {
            action: DecisionAction::Review,
            risk_score: 71,
            reasons: vec!["unsafe".to_owned()],
            tags: vec!["risk".to_owned()],
            source: "openclaw-agent-rs".to_owned(),
        };
        dispatcher.record_decision(&request, &decision).await;

        let history = RpcRequestFrame {
            id: "req-history".to_owned(),
            method: "sessions.history".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g3",
                "limit": 5
            }),
        };
        let out = dispatcher.handle_request(&history).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/history/0/kind")
                        .and_then(serde_json::Value::as_str),
                    Some("decision")
                );
                assert_eq!(
                    payload
                        .pointer("/history/0/action")
                        .and_then(serde_json::Value::as_str),
                    Some("review")
                );
                assert_eq!(
                    payload
                        .pointer("/history/0/riskScore")
                        .and_then(serde_json::Value::as_u64),
                    Some(71)
                );
            }
            _ => panic!("expected handled history"),
        }
    }

    #[tokio::test]
    async fn dispatcher_rejects_sessions_send_without_payload() {
        let dispatcher = RpcDispatcher::new();
        let send = RpcRequestFrame {
            id: "req-send".to_owned(),
            method: "sessions.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g2"
            }),
        };
        let out = dispatcher.handle_request(&send).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));
    }

    #[tokio::test]
    async fn dispatcher_resolve_finds_existing_session_key() {
        let dispatcher = RpcDispatcher::new();
        let patch = RpcRequestFrame {
            id: "req-patch".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-resolve",
                "queueMode": "followup"
            }),
        };
        let _ = dispatcher.handle_request(&patch).await;

        let resolve = RpcRequestFrame {
            id: "req-resolve".to_owned(),
            method: "sessions.resolve".to_owned(),
            params: serde_json::json!({
                "sessionId": "agent:main:discord:group:g-resolve"
            }),
        };
        let out = dispatcher.handle_request(&resolve).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload.pointer("/key").and_then(serde_json::Value::as_str),
                    Some("agent:main:discord:group:g-resolve")
                );
            }
            _ => panic!("expected resolve handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_resolve_supports_label_agent_and_spawn_filters() {
        let dispatcher = RpcDispatcher::new();
        for (id, key, label, spawned_by) in [
            (
                "req-patch-a",
                "agent:ops:discord:group:resolved-a",
                "deploy",
                "main",
            ),
            ("req-patch-b", "custom:other:resolved-b", "deploy", "other"),
        ] {
            let patch = RpcRequestFrame {
                id: id.to_owned(),
                method: "sessions.patch".to_owned(),
                params: serde_json::json!({
                    "sessionKey": key,
                    "label": label,
                    "spawnedBy": spawned_by
                }),
            };
            let _ = dispatcher.handle_request(&patch).await;
        }

        let resolve = RpcRequestFrame {
            id: "req-resolve-filtered".to_owned(),
            method: "sessions.resolve".to_owned(),
            params: serde_json::json!({
                "label": "deploy",
                "agentId": "ops",
                "spawnedBy": "main",
                "includeUnknown": false,
                "includeGlobal": false
            }),
        };
        let out = dispatcher.handle_request(&resolve).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload.pointer("/key").and_then(serde_json::Value::as_str),
                    Some("agent:ops:discord:group:resolved-a")
                );
            }
            _ => panic!("expected filtered resolve handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_reset_clears_session_counters() {
        let dispatcher = RpcDispatcher::new();
        let request = ActionRequest {
            id: "req-reset".to_owned(),
            source: "agent".to_owned(),
            session_id: Some("agent:main:discord:group:g-reset".to_owned()),
            prompt: Some("hello".to_owned()),
            command: None,
            tool_name: None,
            channel: Some("discord".to_owned()),
            url: None,
            file_path: None,
            raw: serde_json::json!({}),
        };
        let decision = Decision {
            action: DecisionAction::Allow,
            risk_score: 2,
            reasons: vec!["ok".to_owned()],
            tags: vec![],
            source: "openclaw-agent-rs".to_owned(),
        };
        dispatcher.record_decision(&request, &decision).await;

        let reset = RpcRequestFrame {
            id: "req-reset".to_owned(),
            method: "sessions.reset".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-reset",
                "reason": "new"
            }),
        };
        let out = dispatcher.handle_request(&reset).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/session/totalRequests")
                        .and_then(serde_json::Value::as_u64),
                    Some(0)
                );
                assert_eq!(
                    payload
                        .pointer("/reason")
                        .and_then(serde_json::Value::as_str),
                    Some("new")
                );
            }
            _ => panic!("expected reset handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_delete_removes_session_and_blocks_main() {
        let dispatcher = RpcDispatcher::new();
        let patch = RpcRequestFrame {
            id: "req-patch".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-delete",
            }),
        };
        let _ = dispatcher.handle_request(&patch).await;

        let delete = RpcRequestFrame {
            id: "req-delete".to_owned(),
            method: "sessions.delete".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-delete"
            }),
        };
        let out = dispatcher.handle_request(&delete).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/deleted")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
            }
            _ => panic!("expected delete handled"),
        }

        let deny_main = RpcRequestFrame {
            id: "req-main-delete".to_owned(),
            method: "sessions.delete".to_owned(),
            params: serde_json::json!({"sessionKey": "main"}),
        };
        let out = dispatcher.handle_request(&deny_main).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));
    }

    #[tokio::test]
    async fn dispatcher_preview_returns_items_for_requested_keys() {
        let dispatcher = RpcDispatcher::new();
        let send = RpcRequestFrame {
            id: "req-send-preview".to_owned(),
            method: "sessions.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-preview",
                "message": "preview payload that is long enough",
                "requestId": "preview-1"
            }),
        };
        let _ = dispatcher.handle_request(&send).await;

        let preview = RpcRequestFrame {
            id: "req-preview".to_owned(),
            method: "sessions.preview".to_owned(),
            params: serde_json::json!({
                "keys": ["agent:main:discord:group:g-preview", "agent:main:discord:group:missing"],
                "limit": 10,
                "maxChars": 12
            }),
        };
        let out = dispatcher.handle_request(&preview).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/previews/0/status")
                        .and_then(serde_json::Value::as_str),
                    Some("ok")
                );
                let preview_text = payload
                    .pointer("/previews/0/items/0/text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                assert!(preview_text.starts_with("preview payload"));
                assert!(preview_text.ends_with("..."));
                assert_eq!(
                    payload
                        .pointer("/previews/1/status")
                        .and_then(serde_json::Value::as_str),
                    Some("missing")
                );
            }
            _ => panic!("expected preview handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_compact_trims_history_buffer() {
        let dispatcher = RpcDispatcher::new();
        for idx in 0..5 {
            let send = RpcRequestFrame {
                id: format!("req-send-{idx}"),
                method: "sessions.send".to_owned(),
                params: serde_json::json!({
                    "sessionKey": "agent:main:discord:group:g-compact",
                    "message": format!("msg-{idx}"),
                }),
            };
            let _ = dispatcher.handle_request(&send).await;
        }

        let compact = RpcRequestFrame {
            id: "req-compact".to_owned(),
            method: "sessions.compact".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-compact",
                "maxLines": 2
            }),
        };
        let out = dispatcher.handle_request(&compact).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/compacted")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload.pointer("/kept").and_then(serde_json::Value::as_u64),
                    Some(2)
                );
                assert_eq!(
                    payload
                        .pointer("/removed")
                        .and_then(serde_json::Value::as_u64),
                    Some(3)
                );
            }
            _ => panic!("expected compact handled"),
        }

        let history = RpcRequestFrame {
            id: "req-history-after-compact".to_owned(),
            method: "sessions.history".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-compact",
                "limit": 10
            }),
        };
        let out = dispatcher.handle_request(&history).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/count")
                        .and_then(serde_json::Value::as_u64),
                    Some(2)
                );
            }
            _ => panic!("expected history handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_usage_reports_action_counters() {
        let dispatcher = RpcDispatcher::new();
        let make_request = |id: &str, action: DecisionAction| {
            let request = ActionRequest {
                id: id.to_owned(),
                source: "agent".to_owned(),
                session_id: Some("agent:main:discord:group:g-usage".to_owned()),
                prompt: Some("usage".to_owned()),
                command: None,
                tool_name: None,
                channel: Some("discord".to_owned()),
                url: None,
                file_path: None,
                raw: serde_json::json!({}),
            };
            let decision = Decision {
                action,
                risk_score: 10,
                reasons: vec![],
                tags: vec![],
                source: "openclaw-agent-rs".to_owned(),
            };
            (request, decision)
        };

        for (id, action) in [
            ("u1", DecisionAction::Allow),
            ("u2", DecisionAction::Review),
            ("u3", DecisionAction::Block),
        ] {
            let (request, decision) = make_request(id, action);
            dispatcher.record_decision(&request, &decision).await;
        }

        let usage = RpcRequestFrame {
            id: "req-usage".to_owned(),
            method: "sessions.usage".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-usage",
                "limit": 5
            }),
        };
        let out = dispatcher.handle_request(&usage).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/sessions/0/totalRequests")
                        .and_then(serde_json::Value::as_u64),
                    Some(3)
                );
                assert_eq!(
                    payload
                        .pointer("/sessions/0/allowedCount")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                assert_eq!(
                    payload
                        .pointer("/sessions/0/reviewCount")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                assert_eq!(
                    payload
                        .pointer("/sessions/0/blockedCount")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
            }
            _ => panic!("expected usage handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_usage_timeseries_and_logs_from_history() {
        let dispatcher = RpcDispatcher::new();
        let session_key = "agent:main:discord:group:g-usage-detail";

        let send = RpcRequestFrame {
            id: "req-send-ud".to_owned(),
            method: "sessions.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": session_key,
                "message": "hello"
            }),
        };
        let _ = dispatcher.handle_request(&send).await;

        let request = ActionRequest {
            id: "req-dec-ud".to_owned(),
            source: "agent".to_owned(),
            session_id: Some(session_key.to_owned()),
            prompt: Some("do this".to_owned()),
            command: Some("git status".to_owned()),
            tool_name: Some("exec".to_owned()),
            channel: Some("discord".to_owned()),
            url: None,
            file_path: None,
            raw: serde_json::json!({}),
        };
        let decision = Decision {
            action: DecisionAction::Review,
            risk_score: 55,
            reasons: vec!["risk".to_owned()],
            tags: vec!["tag".to_owned()],
            source: "openclaw-agent-rs".to_owned(),
        };
        dispatcher.record_decision(&request, &decision).await;

        let logs = RpcRequestFrame {
            id: "req-usage-logs".to_owned(),
            method: "sessions.usage.logs".to_owned(),
            params: serde_json::json!({
                "key": session_key,
                "limit": 10
            }),
        };
        let out = dispatcher.handle_request(&logs).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/count")
                        .and_then(serde_json::Value::as_u64),
                    Some(2)
                );
                assert_eq!(
                    payload
                        .pointer("/logs/0/kind")
                        .and_then(serde_json::Value::as_str),
                    Some("decision")
                );
            }
            _ => panic!("expected usage logs handled"),
        }

        let timeseries = RpcRequestFrame {
            id: "req-usage-ts".to_owned(),
            method: "sessions.usage.timeseries".to_owned(),
            params: serde_json::json!({
                "sessionKey": session_key,
                "maxPoints": 20
            }),
        };
        let out = dispatcher.handle_request(&timeseries).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/count")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                assert_eq!(
                    payload
                        .pointer("/points/0/sendEvents")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                assert_eq!(
                    payload
                        .pointer("/points/0/decisionEvents")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                assert_eq!(
                    payload
                        .pointer("/points/0/reviewCount")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
            }
            _ => panic!("expected usage timeseries handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_list_applies_agent_unknown_and_global_filters() {
        let dispatcher = RpcDispatcher::new();
        for session_key in [
            "agent:ops:discord:group:help",
            "custom:other:session",
            "main",
        ] {
            let patch = RpcRequestFrame {
                id: format!("req-{session_key}"),
                method: "sessions.patch".to_owned(),
                params: serde_json::json!({
                    "sessionKey": session_key
                }),
            };
            let _ = dispatcher.handle_request(&patch).await;
        }

        let filtered = RpcRequestFrame {
            id: "req-list-filtered".to_owned(),
            method: "sessions.list".to_owned(),
            params: serde_json::json!({
                "includeUnknown": false,
                "includeGlobal": false,
                "agentId": "ops",
                "search": "help",
                "limit": 20
            }),
        };
        let out = dispatcher.handle_request(&filtered).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/count")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                assert_eq!(
                    payload
                        .pointer("/sessions/0/key")
                        .and_then(serde_json::Value::as_str),
                    Some("agent:ops:discord:group:help")
                );
                assert_eq!(
                    payload
                        .pointer("/sessions/0/agentId")
                        .and_then(serde_json::Value::as_str),
                    Some("ops")
                );
            }
            _ => panic!("expected filtered list handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_health_and_status_return_runtime_metadata() {
        let dispatcher = RpcDispatcher::new();
        let health = RpcRequestFrame {
            id: "req-health".to_owned(),
            method: "health".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&health).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/service")
                        .and_then(serde_json::Value::as_str),
                    Some("openclaw-agent-rs")
                );
            }
            _ => panic!("expected health handled"),
        }

        let status = RpcRequestFrame {
            id: "req-status".to_owned(),
            method: "status".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&status).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/runtime/name")
                        .and_then(serde_json::Value::as_str),
                    Some("openclaw-agent-rs")
                );
                assert!(
                    payload
                        .pointer("/rpc/count")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0)
                        >= 10
                );
            }
            _ => panic!("expected status handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_usage_status_and_cost_return_totals_and_range() {
        let dispatcher = RpcDispatcher::new();
        let request = ActionRequest {
            id: "req-usage-cost-1".to_owned(),
            source: "agent".to_owned(),
            session_id: Some("agent:main:discord:group:g-usage-cost".to_owned()),
            prompt: Some("hello".to_owned()),
            command: None,
            tool_name: None,
            channel: Some("discord".to_owned()),
            url: None,
            file_path: None,
            raw: serde_json::json!({}),
        };
        let decision = Decision {
            action: DecisionAction::Block,
            risk_score: 90,
            reasons: vec![],
            tags: vec![],
            source: "openclaw-agent-rs".to_owned(),
        };
        dispatcher.record_decision(&request, &decision).await;

        let usage_status = RpcRequestFrame {
            id: "req-usage-status".to_owned(),
            method: "usage.status".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&usage_status).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/totals/blockedCount")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
            }
            _ => panic!("expected usage.status handled"),
        }

        let usage_cost = RpcRequestFrame {
            id: "req-usage-cost".to_owned(),
            method: "usage.cost".to_owned(),
            params: serde_json::json!({
                "startDate": "2026-01-01",
                "endDate": "2026-01-15"
            }),
        };
        let out = dispatcher.handle_request(&usage_cost).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/range/startDate")
                        .and_then(serde_json::Value::as_str),
                    Some("2026-01-01")
                );
                assert_eq!(
                    payload
                        .pointer("/actions/block")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
            }
            _ => panic!("expected usage.cost handled"),
        }
    }
}
