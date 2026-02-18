use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;
use url::Url;

use crate::channels::{ChannelCapabilities, DriverRegistry};
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
                    name: "last-heartbeat",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "set-heartbeats",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "system-presence",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "system-event",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "wake",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "talk.config",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "talk.mode",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "models.list",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "agents.list",
                    family: MethodFamily::Agent,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "agents.create",
                    family: MethodFamily::Agent,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "agents.update",
                    family: MethodFamily::Agent,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "agents.delete",
                    family: MethodFamily::Agent,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "agents.files.list",
                    family: MethodFamily::Agent,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "agents.files.get",
                    family: MethodFamily::Agent,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "agents.files.set",
                    family: MethodFamily::Agent,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "skills.status",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "skills.bins",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "skills.install",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "skills.update",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "channels.status",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "channels.logout",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "config.get",
                    family: MethodFamily::Config,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "config.set",
                    family: MethodFamily::Config,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "config.patch",
                    family: MethodFamily::Config,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "config.apply",
                    family: MethodFamily::Config,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "config.schema",
                    family: MethodFamily::Config,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "logs.tail",
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
                    name: "cron.list",
                    family: MethodFamily::Cron,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "cron.status",
                    family: MethodFamily::Cron,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "cron.update",
                    family: MethodFamily::Cron,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "cron.remove",
                    family: MethodFamily::Cron,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "cron.run",
                    family: MethodFamily::Cron,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "cron.runs",
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
    system: SystemRegistry,
    talk: TalkRegistry,
    models: ModelRegistry,
    agents: AgentRegistry,
    skills: SkillsRegistry,
    cron: CronRegistry,
    config: ConfigRegistry,
    channel_capabilities: Vec<ChannelCapabilities>,
    started_at_ms: u64,
}

const MAX_SESSION_HISTORY_PER_SESSION: usize = 400;
const MAX_SYSTEM_LOG_LINES: usize = 20_000;
const RUNTIME_NAME: &str = "openclaw-agent-rs";
const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");
const SESSION_STORE_PATH: &str = "memory://session-registry";
const SYSTEM_LOG_PATH: &str = "memory://gateway.log";
const DEFAULT_AGENT_ID: &str = "main";
const DEFAULT_AGENT_SCOPE: &str = "per-sender";
const DEFAULT_AGENT_WORKSPACE: &str = "memory://agents/main";
const DEFAULT_MAIN_KEY: &str = "main";
const DEFAULT_AGENT_NAME: &str = "Main";
const DEFAULT_AGENT_IDENTITY_NAME: &str = "OpenClaw";
const DEFAULT_AGENT_IDENTITY_THEME: &str = "default";
const DEFAULT_AGENT_IDENTITY_EMOJI: &str = "claw";
const DEFAULT_AGENT_IDENTITY_AVATAR: &str = "openclaw";
const DEFAULT_AGENT_IDENTITY_AVATAR_URL: &str = "memory://agents/main/avatar";
const AGENT_BOOTSTRAP_FILE_NAMES: &[&str] = &[
    "AGENTS.md",
    "SOUL.md",
    "TOOLS.md",
    "IDENTITY.md",
    "USER.md",
    "HEARTBEAT.md",
    "BOOTSTRAP.md",
];
const AGENT_PRIMARY_MEMORY_FILE_NAME: &str = "MEMORY.md";
const AGENT_ALT_MEMORY_FILE_NAME: &str = "memory.md";
const CRON_STORE_PATH: &str = "memory://cron/jobs.json";
const MAX_CRON_RUN_LOGS_PER_JOB: usize = 500;
static SESSION_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static CRON_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const SUPPORTED_RPC_METHODS: &[&str] = &[
    "health",
    "status",
    "usage.status",
    "usage.cost",
    "last-heartbeat",
    "set-heartbeats",
    "system-presence",
    "system-event",
    "wake",
    "talk.config",
    "talk.mode",
    "models.list",
    "agents.list",
    "agents.create",
    "agents.update",
    "agents.delete",
    "agents.files.list",
    "agents.files.get",
    "agents.files.set",
    "skills.status",
    "skills.bins",
    "skills.install",
    "skills.update",
    "cron.list",
    "cron.status",
    "cron.add",
    "cron.update",
    "cron.remove",
    "cron.run",
    "cron.runs",
    "channels.status",
    "channels.logout",
    "config.get",
    "config.set",
    "config.patch",
    "config.apply",
    "config.schema",
    "logs.tail",
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
        let channel_capabilities = DriverRegistry::default_registry()
            .capabilities()
            .into_iter()
            .filter(|cap| cap.name != "generic")
            .collect::<Vec<_>>();
        Self {
            sessions: SessionRegistry::new(),
            system: SystemRegistry::new(),
            talk: TalkRegistry::new(),
            models: ModelRegistry::new(),
            agents: AgentRegistry::new(),
            skills: SkillsRegistry::new(),
            cron: CronRegistry::new(),
            config: ConfigRegistry::new(),
            channel_capabilities,
            started_at_ms: now_ms(),
        }
    }

    pub async fn handle_request(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        match normalize(&req.method).as_str() {
            "health" => self.handle_health().await,
            "status" => self.handle_status().await,
            "usage.status" => self.handle_usage_status().await,
            "usage.cost" => self.handle_usage_cost(req).await,
            "last-heartbeat" | "heartbeat" => self.handle_last_heartbeat().await,
            "set-heartbeats" => self.handle_set_heartbeats(req).await,
            "system-presence" | "presence" => self.handle_system_presence().await,
            "system-event" => self.handle_system_event(req).await,
            "wake" => self.handle_wake(req).await,
            "talk.config" => self.handle_talk_config(req).await,
            "talk.mode" => self.handle_talk_mode(req).await,
            "models.list" => self.handle_models_list(req).await,
            "agents.list" => self.handle_agents_list(req).await,
            "agents.create" => self.handle_agents_create(req).await,
            "agents.update" => self.handle_agents_update(req).await,
            "agents.delete" => self.handle_agents_delete(req).await,
            "agents.files.list" => self.handle_agents_files_list(req).await,
            "agents.files.get" => self.handle_agents_files_get(req).await,
            "agents.files.set" => self.handle_agents_files_set(req).await,
            "skills.status" => self.handle_skills_status(req).await,
            "skills.bins" => self.handle_skills_bins(req).await,
            "skills.install" => self.handle_skills_install(req).await,
            "skills.update" => self.handle_skills_update(req).await,
            "cron.list" => self.handle_cron_list(req).await,
            "cron.status" => self.handle_cron_status(req).await,
            "cron.add" => self.handle_cron_add(req).await,
            "cron.update" => self.handle_cron_update(req).await,
            "cron.remove" => self.handle_cron_remove(req).await,
            "cron.run" => self.handle_cron_run(req).await,
            "cron.runs" => self.handle_cron_runs(req).await,
            "channels.status" => self.handle_channels_status(req).await,
            "channels.logout" => self.handle_channels_logout(req).await,
            "config.get" => self.handle_config_get(req).await,
            "config.set" => self.handle_config_set(req).await,
            "config.patch" => self.handle_config_patch(req).await,
            "config.apply" => self.handle_config_apply(req).await,
            "config.schema" => self.handle_config_schema(req).await,
            "logs.tail" => self.handle_logs_tail(req).await,
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

    pub async fn ingest_event_frame(&self, frame: &Value) {
        let Some(event) = frame.get("event").and_then(Value::as_str) else {
            return;
        };
        let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
        match normalize(event).as_str() {
            "heartbeat" => {
                self.system.update_last_heartbeat(payload).await;
            }
            "presence" => {
                self.system.replace_presence(payload).await;
            }
            _ => {}
        }
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

    async fn handle_last_heartbeat(&self) -> RpcDispatchOutcome {
        let heartbeat = self.system.last_heartbeat().await;
        RpcDispatchOutcome::Handled(json!(heartbeat))
    }

    async fn handle_set_heartbeats(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SetHeartbeatsParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let Some(enabled) = params.enabled else {
            return RpcDispatchOutcome::bad_request(
                "invalid set-heartbeats params: enabled (boolean) required",
            );
        };
        self.system.set_heartbeats_enabled(enabled).await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "enabled": enabled
        }))
    }

    async fn handle_system_presence(&self) -> RpcDispatchOutcome {
        let presence = self.system.presence().await;
        RpcDispatchOutcome::Handled(json!(presence))
    }

    async fn handle_system_event(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SystemEventParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let Some(text) = normalize_optional_text(params.text, 2_048) else {
            return RpcDispatchOutcome::bad_request("text required");
        };
        self.system
            .upsert_presence(SystemPresenceUpdate {
                text,
                device_id: normalize_optional_text(params.device_id, 128),
                instance_id: normalize_optional_text(params.instance_id, 128),
                host: normalize_optional_text(params.host, 256),
                ip: normalize_optional_text(params.ip, 64),
                mode: normalize_optional_text(params.mode, 64),
                version: normalize_optional_text(params.version, 64),
                platform: normalize_optional_text(params.platform, 64),
                device_family: normalize_optional_text(params.device_family, 64),
                model_identifier: normalize_optional_text(params.model_identifier, 64),
                last_input_seconds: normalize_optional_seconds(params.last_input_seconds),
                reason: normalize_optional_text(params.reason, 128),
                roles: normalize_string_list(params.roles, 64, 32),
                scopes: normalize_string_list(params.scopes, 64, 64),
                tags: normalize_string_list(params.tags, 64, 64),
            })
            .await;
        RpcDispatchOutcome::Handled(json!({ "ok": true }))
    }

    async fn handle_wake(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<WakeParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let mode = match parse_wake_mode(params.mode) {
            Ok(mode) => mode,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let Some(text) = normalize_optional_text(params.text, 2_048) else {
            return RpcDispatchOutcome::bad_request("invalid wake params: text required");
        };

        self.system
            .upsert_presence(SystemPresenceUpdate {
                text: text.clone(),
                device_id: None,
                instance_id: None,
                host: Some("gateway".to_owned()),
                ip: None,
                mode: Some(mode.to_owned()),
                version: Some(RUNTIME_VERSION.to_owned()),
                platform: None,
                device_family: None,
                model_identifier: None,
                last_input_seconds: None,
                reason: Some("wake".to_owned()),
                roles: Vec::new(),
                scopes: Vec::new(),
                tags: vec!["wake".to_owned()],
            })
            .await;
        if mode == "now" {
            self.system
                .update_last_heartbeat(json!({
                    "status": "wake-requested",
                    "reason": "wake",
                    "mode": mode,
                    "preview": text
                }))
                .await;
        }

        RpcDispatchOutcome::Handled(json!({ "ok": true }))
    }

    async fn handle_talk_config(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<TalkConfigParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let mut talk = serde_json::Map::new();
        talk.insert("outputFormat".to_owned(), Value::String("pcm16".to_owned()));
        talk.insert("interruptOnSpeech".to_owned(), Value::Bool(true));
        if params.include_secrets.unwrap_or(false) {
            talk.insert("apiKey".to_owned(), Value::String("redacted".to_owned()));
        }
        RpcDispatchOutcome::Handled(json!({
            "config": {
                "talk": Value::Object(talk),
                "session": { "mainKey": "main" },
                "ui": { "seamColor": "#4b5563" }
            }
        }))
    }

    async fn handle_talk_mode(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<TalkModeParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let Some(enabled) = params.enabled else {
            return RpcDispatchOutcome::bad_request(
                "invalid talk.mode params: enabled (boolean) required",
            );
        };
        let phase = normalize_optional_text(params.phase, 64);
        let state = self.talk.set_mode(enabled, phase).await;
        self.system
            .log_line(format!(
                "talk.mode enabled={} phase={}",
                state.enabled,
                state.phase.clone().unwrap_or_else(|| "null".to_owned())
            ))
            .await;
        RpcDispatchOutcome::Handled(json!({
            "enabled": state.enabled,
            "phase": state.phase,
            "ts": state.updated_at_ms
        }))
    }

    async fn handle_models_list(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        if let Err(err) = decode_params::<ModelsListParams>(&req.params) {
            return RpcDispatchOutcome::bad_request(format!("invalid models.list params: {err}"));
        }
        RpcDispatchOutcome::Handled(json!({
            "models": self.models.list()
        }))
    }

    async fn handle_agents_list(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        if let Err(err) = decode_params::<AgentsListParams>(&req.params) {
            return RpcDispatchOutcome::bad_request(format!("invalid agents.list params: {err}"));
        }
        let snapshot = self.agents.list().await;
        RpcDispatchOutcome::Handled(json!({
            "defaultId": snapshot.default_id,
            "mainKey": snapshot.main_key,
            "scope": snapshot.scope,
            "agents": snapshot.agents
        }))
    }

    async fn handle_agents_create(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<AgentsCreateParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid agents.create params: {err}"
                ));
            }
        };
        let created = match self.agents.create(params).await {
            Ok(created) => created,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        self.system
            .log_line(format!("agents.create id={}", created.agent_id))
            .await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "agentId": created.agent_id,
            "name": created.name,
            "workspace": created.workspace
        }))
    }

    async fn handle_agents_update(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<AgentsUpdateParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid agents.update params: {err}"
                ));
            }
        };
        let agent_id = match self.agents.update(params).await {
            Ok(agent_id) => agent_id,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        self.system
            .log_line(format!("agents.update id={agent_id}"))
            .await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "agentId": agent_id
        }))
    }

    async fn handle_agents_delete(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<AgentsDeleteParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid agents.delete params: {err}"
                ));
            }
        };
        let removed = match self.agents.delete(params).await {
            Ok(removed) => removed,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        self.system
            .log_line(format!("agents.delete id={}", removed.agent_id))
            .await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "agentId": removed.agent_id,
            "removedBindings": removed.removed_bindings
        }))
    }

    async fn handle_agents_files_list(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<AgentsFilesListParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid agents.files.list params: {err}"
                ));
            }
        };
        let (agent_id, workspace, files) = match self.agents.list_files(params).await {
            Ok(result) => result,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        RpcDispatchOutcome::Handled(json!({
            "agentId": agent_id,
            "workspace": workspace,
            "files": files
        }))
    }

    async fn handle_agents_files_get(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<AgentsFilesGetParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid agents.files.get params: {err}"
                ));
            }
        };
        let (agent_id, workspace, file) = match self.agents.get_file(params).await {
            Ok(result) => result,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        RpcDispatchOutcome::Handled(json!({
            "agentId": agent_id,
            "workspace": workspace,
            "file": file
        }))
    }

    async fn handle_agents_files_set(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<AgentsFilesSetParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid agents.files.set params: {err}"
                ));
            }
        };
        let (agent_id, workspace, file) = match self.agents.set_file(params).await {
            Ok(result) => result,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        self.system
            .log_line(format!("agents.files.set id={agent_id} name={}", file.name))
            .await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "agentId": agent_id,
            "workspace": workspace,
            "file": file
        }))
    }

    async fn handle_skills_status(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SkillsStatusParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid skills.status params: {err}"
                ));
            }
        };
        let requested_agent = normalize_optional_text(params.agent_id, 64);
        let agent_id = match requested_agent {
            Some(raw) => {
                if !self.agents.contains(&raw).await {
                    return RpcDispatchOutcome::bad_request(format!("unknown agent id \"{raw}\""));
                }
                normalize_agent_id(&raw)
            }
            None => DEFAULT_AGENT_ID.to_owned(),
        };
        let workspace = self
            .agents
            .workspace_for(&agent_id)
            .await
            .unwrap_or_else(|| DEFAULT_AGENT_WORKSPACE.to_owned());
        let report = self.skills.status(&workspace, &agent_id).await;
        RpcDispatchOutcome::Handled(json!(report))
    }

    async fn handle_skills_bins(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        if let Err(err) = decode_params::<SkillsBinsParams>(&req.params) {
            return RpcDispatchOutcome::bad_request(format!("invalid skills.bins params: {err}"));
        }
        let bins = self.skills.bins().await;
        RpcDispatchOutcome::Handled(json!({
            "bins": bins
        }))
    }

    async fn handle_skills_install(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SkillsInstallParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid skills.install params: {err}"
                ));
            }
        };
        if matches!(params.timeout_ms, Some(timeout_ms) if timeout_ms < 1_000) {
            return RpcDispatchOutcome::bad_request(
                "invalid skills.install params: timeoutMs must be >= 1000",
            );
        }
        let result = self.skills.install(params).await;
        self.system
            .log_line(format!(
                "skills.install skillKey={} installId={}",
                result.skill_key, result.install_id
            ))
            .await;
        RpcDispatchOutcome::Handled(json!(result))
    }

    async fn handle_skills_update(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SkillsUpdateParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid skills.update params: {err}"
                ));
            }
        };
        let result = match self.skills.update(params).await {
            Ok(result) => result,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        self.system
            .log_line(format!("skills.update skillKey={}", result.skill_key))
            .await;
        RpcDispatchOutcome::Handled(json!(result))
    }

    async fn handle_cron_list(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<CronListParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!("invalid cron.list params: {err}"));
            }
        };
        let jobs = self
            .cron
            .list(params.include_disabled.unwrap_or(false))
            .await;
        RpcDispatchOutcome::Handled(json!({
            "jobs": jobs
        }))
    }

    async fn handle_cron_status(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        if let Err(err) = decode_params::<CronStatusParams>(&req.params) {
            return RpcDispatchOutcome::bad_request(format!("invalid cron.status params: {err}"));
        }
        let status = self.cron.status().await;
        RpcDispatchOutcome::Handled(json!(status))
    }

    async fn handle_cron_add(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<CronAddParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!("invalid cron.add params: {err}"));
            }
        };
        let job = match self.cron.add(params).await {
            Ok(job) => job,
            Err(CronRegistryError::NotFound(message)) => {
                return RpcDispatchOutcome::not_found(message)
            }
            Err(CronRegistryError::Invalid(message)) => {
                return RpcDispatchOutcome::bad_request(message);
            }
        };
        self.system
            .log_line(format!("cron.add id={} name={}", job.id, job.name))
            .await;
        RpcDispatchOutcome::Handled(json!(job))
    }

    async fn handle_cron_update(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<CronUpdateParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid cron.update params: {err}"
                ));
            }
        };
        let job_id = match resolve_cron_job_id(params.id, params.job_id, "cron.update") {
            Ok(id) => id,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let job = match self.cron.update(&job_id, params.patch).await {
            Ok(job) => job,
            Err(CronRegistryError::NotFound(message)) => {
                return RpcDispatchOutcome::not_found(message)
            }
            Err(CronRegistryError::Invalid(message)) => {
                return RpcDispatchOutcome::bad_request(message);
            }
        };
        self.system
            .log_line(format!("cron.update id={job_id}"))
            .await;
        RpcDispatchOutcome::Handled(json!(job))
    }

    async fn handle_cron_remove(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<CronRemoveParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid cron.remove params: {err}"
                ));
            }
        };
        let job_id = match resolve_cron_job_id(params.id, params.job_id, "cron.remove") {
            Ok(id) => id,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let removed = match self.cron.remove(&job_id).await {
            Some(removed) => removed,
            None => return RpcDispatchOutcome::not_found(format!("cron job not found: {job_id}")),
        };
        self.system
            .log_line(format!("cron.remove id={job_id}"))
            .await;
        RpcDispatchOutcome::Handled(json!(removed))
    }

    async fn handle_cron_run(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<CronRunParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!("invalid cron.run params: {err}"));
            }
        };
        let job_id = match resolve_cron_job_id(params.id, params.job_id, "cron.run") {
            Ok(id) => id,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let mode = match parse_cron_run_mode(params.mode) {
            Ok(mode) => mode,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let run = match self.cron.run(&job_id, mode).await {
            Ok(run) => run,
            Err(CronRegistryError::NotFound(message)) => {
                return RpcDispatchOutcome::not_found(message)
            }
            Err(CronRegistryError::Invalid(message)) => {
                return RpcDispatchOutcome::bad_request(message);
            }
        };
        if let Some(text) = run.system_event_text {
            self.system
                .upsert_presence(SystemPresenceUpdate {
                    text,
                    device_id: None,
                    instance_id: None,
                    host: None,
                    ip: None,
                    mode: None,
                    version: None,
                    platform: None,
                    device_family: None,
                    model_identifier: None,
                    last_input_seconds: None,
                    reason: Some("cron".to_owned()),
                    roles: Vec::new(),
                    scopes: Vec::new(),
                    tags: vec!["cron".to_owned()],
                })
                .await;
        }
        self.system.log_line(format!("cron.run id={job_id}")).await;
        RpcDispatchOutcome::Handled(json!(run.entry))
    }

    async fn handle_cron_runs(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<CronRunsParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!("invalid cron.runs params: {err}"));
            }
        };
        let job_id = match resolve_cron_job_id(params.id, params.job_id, "cron.runs") {
            Ok(id) => id,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let limit = params.limit.unwrap_or(50).clamp(1, 5_000);
        let entries = match self.cron.runs(&job_id, limit).await {
            Ok(entries) => entries,
            Err(CronRegistryError::NotFound(message)) => {
                return RpcDispatchOutcome::not_found(message)
            }
            Err(CronRegistryError::Invalid(message)) => {
                return RpcDispatchOutcome::bad_request(message);
            }
        };
        RpcDispatchOutcome::Handled(json!({
            "entries": entries
        }))
    }

    async fn handle_channels_status(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<ChannelsStatusParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let probe = params.probe.unwrap_or(false);
        let timeout_ms = params.timeout_ms.unwrap_or(10_000).max(1_000);

        let mut channel_order = Vec::new();
        let mut channel_labels = serde_json::Map::new();
        let mut channel_detail_labels = serde_json::Map::new();
        let mut channel_meta = Vec::new();
        let mut channels = serde_json::Map::new();
        let mut channel_accounts = serde_json::Map::new();
        let mut channel_default_account_id = serde_json::Map::new();

        for capability in &self.channel_capabilities {
            let id = capability.name.to_owned();
            let label = channel_label(capability.name);
            channel_order.push(id.clone());
            channel_labels.insert(id.clone(), Value::String(label.clone()));
            channel_detail_labels.insert(id.clone(), Value::String(label.clone()));
            channel_meta.push(json!({
                "id": id,
                "label": label,
                "detailLabel": label
            }));
            channels.insert(
                id.clone(),
                json!({
                    "configured": true,
                    "enabled": true,
                    "linked": true,
                    "running": false,
                    "connected": false,
                    "supports": {
                        "edit": capability.supports_edit,
                        "delete": capability.supports_delete,
                        "reactions": capability.supports_reactions,
                        "threads": capability.supports_threads,
                        "polls": capability.supports_polls,
                        "media": capability.supports_media,
                        "dmPairing": capability.default_dm_pairing
                    }
                }),
            );
            let mut account = json!({
                "accountId": "default",
                "name": "default",
                "enabled": true,
                "configured": true,
                "linked": true,
                "running": false,
                "connected": false,
                "mode": "polling"
            });
            if probe {
                account["probe"] = json!({
                    "ok": true,
                    "source": "rust-parity",
                    "timeoutMs": timeout_ms
                });
            }
            channel_accounts.insert(id.clone(), Value::Array(vec![account]));
            channel_default_account_id.insert(id, Value::String("default".to_owned()));
        }

        RpcDispatchOutcome::Handled(json!({
            "ts": now_ms(),
            "channelOrder": channel_order,
            "channelLabels": channel_labels,
            "channelDetailLabels": channel_detail_labels,
            "channelMeta": channel_meta,
            "channels": channels,
            "channelAccounts": channel_accounts,
            "channelDefaultAccountId": channel_default_account_id
        }))
    }

    async fn handle_channels_logout(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<ChannelsLogoutParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let Some(channel) = normalize_optional_text(params.channel, 64).map(|v| normalize(&v))
        else {
            return RpcDispatchOutcome::bad_request("invalid channels.logout channel");
        };
        let supported = self
            .channel_capabilities
            .iter()
            .any(|cap| cap.name.eq_ignore_ascii_case(&channel));
        if !supported {
            return RpcDispatchOutcome::bad_request("invalid channels.logout channel");
        }
        let account_id =
            normalize_optional_text(params.account_id, 64).unwrap_or_else(|| "default".to_owned());
        self.system
            .log_line(format!(
                "channels.logout channel={channel} account={account_id}"
            ))
            .await;
        RpcDispatchOutcome::Handled(json!({
            "channel": channel,
            "accountId": account_id,
            "cleared": false,
            "loggedOut": false,
            "supported": false
        }))
    }

    async fn handle_config_get(&self, _req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let snapshot = self.config.get_snapshot().await;
        RpcDispatchOutcome::Handled(json!({
            "exists": true,
            "valid": true,
            "path": snapshot.path,
            "raw": snapshot.raw,
            "config": snapshot.config,
            "hash": snapshot.hash,
            "updatedAtMs": snapshot.updated_at_ms
        }))
    }

    async fn handle_config_schema(&self, _req: &RpcRequestFrame) -> RpcDispatchOutcome {
        RpcDispatchOutcome::Handled(self.config.schema())
    }

    async fn handle_config_set(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<ConfigWriteParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let Some(raw) = params.raw else {
            return RpcDispatchOutcome::bad_request(
                "invalid config.set params: raw (string) required",
            );
        };
        let updated = match self.config.set(raw, params.base_hash).await {
            Ok(value) => value,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        self.system.log_line("config.set applied".to_owned()).await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "path": updated.path,
            "config": updated.config,
            "hash": updated.hash
        }))
    }

    async fn handle_config_patch(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<ConfigWriteParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let Some(raw) = params.raw else {
            return RpcDispatchOutcome::bad_request(
                "invalid config.patch params: raw (string) required",
            );
        };
        let updated = match self.config.patch(raw, params.base_hash).await {
            Ok(value) => value,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        self.system
            .log_line("config.patch applied".to_owned())
            .await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "path": updated.path,
            "config": updated.config,
            "hash": updated.hash
        }))
    }

    async fn handle_config_apply(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<ConfigWriteParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let Some(raw) = params.raw else {
            return RpcDispatchOutcome::bad_request(
                "invalid config.apply params: raw (string) required",
            );
        };
        let updated = match self.config.patch(raw, params.base_hash.clone()).await {
            Ok(value) => value,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        self.system
            .log_line("config.apply requested".to_owned())
            .await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "path": updated.path,
            "config": updated.config,
            "hash": updated.hash,
            "restart": {
                "requested": true,
                "sessionKey": normalize_optional_text(params.session_key, 256),
                "note": normalize_optional_text(params.note, 512),
                "restartDelayMs": params.restart_delay_ms.unwrap_or(0)
            }
        }))
    }

    async fn handle_logs_tail(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<LogsTailParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let limit = params.limit.unwrap_or(500).clamp(1, 5_000);
        let max_bytes = params.max_bytes.unwrap_or(250_000).clamp(1, 1_000_000);
        let tail = self.system.tail_logs(params.cursor, limit, max_bytes).await;
        RpcDispatchOutcome::Handled(json!({
            "file": tail.file,
            "cursor": tail.cursor,
            "size": tail.size,
            "lines": tail.lines,
            "truncated": tail.truncated,
            "reset": tail.reset
        }))
    }

    async fn handle_sessions_list(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsListParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let label = match parse_optional_label_filter(params.label) {
            Ok(value) => value,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
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
                label,
                spawned_by: normalize_optional_text(params.spawned_by, 128),
                include_derived_titles: params.include_derived_titles.unwrap_or(false),
                include_last_message: params.include_last_message.unwrap_or(false),
            })
            .await;
        RpcDispatchOutcome::Handled(json!({
            "ts": now_ms(),
            "path": SESSION_STORE_PATH,
            "defaults": {
                "modelProvider": Value::Null,
                "model": Value::Null,
                "contextTokens": Value::Null
            },
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
                let requested = v.trim().to_owned();
                if requested.is_empty() {
                    None
                } else {
                    Some(requested)
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
        let lookup_keys = keys
            .iter()
            .map(|key| canonicalize_session_key(key))
            .collect::<Vec<_>>();
        let mut previews = self.sessions.preview(&lookup_keys, limit, max_chars).await;
        for (preview, requested) in previews.iter_mut().zip(keys.iter()) {
            preview.key = requested.clone();
        }
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
        let session_key = normalize_session_key_input(params.key.or(params.session_key));
        let Some(session_key) = session_key else {
            return RpcDispatchOutcome::bad_request("sessionKey|key is required");
        };

        let send_policy = match parse_patch_send_policy(param_patch_value(
            &req.params,
            &["sendPolicy", "send_policy"],
        )) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let group_activation = match parse_patch_group_activation(param_patch_value(
            &req.params,
            &["groupActivation", "group_activation"],
        )) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let queue_mode = match parse_patch_queue_mode(param_patch_value(
            &req.params,
            &["queueMode", "queue_mode"],
        )) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let label = match parse_patch_text(param_patch_value(&req.params, &["label"]), "label", 64)
        {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let spawned_by = match parse_patch_text(
            param_patch_value(&req.params, &["spawnedBy", "spawned_by"]),
            "spawnedBy",
            128,
        ) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let spawn_depth = match parse_patch_u32(param_patch_value(
            &req.params,
            &["spawnDepth", "spawn_depth"],
        )) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let thinking_level = match parse_patch_thinking_level(param_patch_value(
            &req.params,
            &["thinkingLevel", "thinking_level"],
        )) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let verbose_level = match parse_patch_verbose_level(param_patch_value(
            &req.params,
            &["verboseLevel", "verbose_level"],
        )) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let reasoning_level = match parse_patch_reasoning_level(param_patch_value(
            &req.params,
            &["reasoningLevel", "reasoning_level"],
        )) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let response_usage = match parse_patch_response_usage(param_patch_value(
            &req.params,
            &["responseUsage", "response_usage"],
        )) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let elevated_level = match parse_patch_elevated_level(param_patch_value(
            &req.params,
            &["elevatedLevel", "elevated_level"],
        )) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let exec_host =
            match parse_patch_exec_host(param_patch_value(&req.params, &["execHost", "exec_host"]))
            {
                Ok(v) => v,
                Err(err) => return RpcDispatchOutcome::bad_request(err),
            };
        let exec_security = match parse_patch_exec_security(param_patch_value(
            &req.params,
            &["execSecurity", "exec_security"],
        )) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let exec_ask =
            match parse_patch_exec_ask(param_patch_value(&req.params, &["execAsk", "exec_ask"])) {
                Ok(v) => v,
                Err(err) => return RpcDispatchOutcome::bad_request(err),
            };
        let exec_node = match parse_patch_text(
            param_patch_value(&req.params, &["execNode", "exec_node"]),
            "execNode",
            64,
        ) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let model_override = match parse_patch_model(param_patch_value(&req.params, &["model"])) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };

        let patched = match self
            .sessions
            .patch(SessionPatch {
                session_key: session_key.clone(),
                send_policy,
                group_activation,
                queue_mode,
                label,
                spawned_by,
                spawn_depth,
                thinking_level,
                verbose_level,
                reasoning_level,
                response_usage,
                elevated_level,
                exec_host,
                exec_security,
                exec_ask,
                exec_node,
                model_override,
            })
            .await
        {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let resolved_model_provider = patched.provider_override.clone();
        let resolved_model = patched.model_override.clone();
        let entry = patched.clone();
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "path": SESSION_STORE_PATH,
            "key": session_key,
            "entry": entry,
            "resolved": {
                "modelProvider": resolved_model_provider,
                "model": resolved_model
            },
            "session": patched
        }))
    }

    async fn handle_sessions_resolve(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsResolveParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let candidate = normalize_session_key_input(params.session_key.or(params.key));
        if let Some(candidate) = candidate {
            if let Some(key) = self.sessions.resolve_key(&candidate).await {
                return RpcDispatchOutcome::Handled(json!({
                    "ok": true,
                    "key": key
                }));
            }
            return RpcDispatchOutcome::not_found("session not found");
        }
        if let Some(session_id) = params
            .session_id
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
        {
            if let Some(key) = self.sessions.resolve_session_id(&session_id).await {
                return RpcDispatchOutcome::Handled(json!({
                    "ok": true,
                    "key": key
                }));
            }
            return RpcDispatchOutcome::not_found("session not found");
        }

        let label = match parse_optional_label_filter(params.label) {
            Ok(value) => value,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
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
        let session_key = normalize_session_key_input(params.session_key.or(params.key));
        let Some(session_key) = session_key else {
            return RpcDispatchOutcome::bad_request("sessionKey|key is required");
        };

        let reset = self
            .sessions
            .reset(
                &session_key,
                match parse_reset_reason(params.reason) {
                    Ok(value) => value,
                    Err(err) => return RpcDispatchOutcome::bad_request(err),
                },
            )
            .await;
        let entry = reset.session.clone();
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "key": session_key,
            "reset": true,
            "entry": entry,
            "session": reset.session,
            "reason": reset.reason
        }))
    }

    async fn handle_sessions_delete(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsDeleteParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let session_key = normalize_session_key_input(params.session_key.or(params.key));
        let Some(session_key) = session_key else {
            return RpcDispatchOutcome::bad_request("sessionKey|key is required");
        };
        if parse_session_key(&session_key).kind == SessionKind::Main {
            return RpcDispatchOutcome::bad_request("cannot delete main session");
        }

        let deleted = self.sessions.delete(&session_key).await;
        let archived = if deleted && params.delete_transcript.unwrap_or(true) {
            vec![format!(
                "{SESSION_STORE_PATH}/archives/{session_key}.deleted"
            )]
        } else {
            Vec::new()
        };
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "path": SESSION_STORE_PATH,
            "key": session_key,
            "deleted": deleted,
            "archived": archived
        }))
    }

    async fn handle_sessions_compact(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsCompactParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let session_key = normalize_session_key_input(params.session_key.or(params.key));
        let Some(session_key) = session_key else {
            return RpcDispatchOutcome::bad_request("sessionKey|key is required");
        };
        let max_lines = match params.max_lines {
            Some(0) => return RpcDispatchOutcome::bad_request("maxLines must be >= 1"),
            Some(value) => value.min(100_000),
            None => 400,
        };
        let compacted = self.sessions.compact(&session_key, max_lines).await;
        let archived = if compacted.compacted {
            vec![format!(
                "{SESSION_STORE_PATH}/archives/{session_key}.compact"
            )]
        } else {
            Vec::new()
        };
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "path": SESSION_STORE_PATH,
            "key": session_key,
            "compacted": compacted.compacted,
            "kept": compacted.kept,
            "removed": compacted.removed,
            "reason": compacted.reason,
            "archived": archived
        }))
    }

    async fn handle_sessions_usage(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsUsageParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let session_key = normalize_session_key_input(params.session_key.or(params.key));
        let window = resolve_usage_window(params.start_date, params.end_date, None);
        let usage = self
            .sessions
            .usage(
                session_key.as_deref(),
                params.limit,
                Some((window.start_day, window.end_day)),
                params.include_context_weight.unwrap_or(false),
            )
            .await;
        let total_tokens = usage.iter().map(|item| item.total_requests).sum::<u64>();
        let total_allow = usage.iter().map(|item| item.allowed_count).sum::<u64>();
        let total_review = usage.iter().map(|item| item.review_count).sum::<u64>();
        let total_block = usage.iter().map(|item| item.blocked_count).sum::<u64>();

        let mut by_agent_totals = HashMap::<String, u64>::new();
        let mut by_channel_totals = HashMap::<String, u64>::new();
        for item in &usage {
            if let Some(agent_id) = &item.agent_id {
                let next = by_agent_totals.entry(agent_id.clone()).or_insert(0);
                *next += item.total_requests;
            }
            if let Some(channel) = &item.channel {
                let next = by_channel_totals.entry(channel.clone()).or_insert(0);
                *next += item.total_requests;
            }
        }
        let by_agent = by_agent_totals
            .into_iter()
            .map(|(agent_id, total_tokens)| {
                json!({
                    "agentId": agent_id,
                    "totals": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "totalTokens": total_tokens,
                        "totalCost": 0.0,
                        "inputCost": 0.0,
                        "outputCost": 0.0,
                        "cacheReadCost": 0.0,
                        "cacheWriteCost": 0.0,
                        "missingCostEntries": 0
                    }
                })
            })
            .collect::<Vec<_>>();
        let by_channel = by_channel_totals
            .into_iter()
            .map(|(channel, total_tokens)| {
                json!({
                    "channel": channel,
                    "totals": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "totalTokens": total_tokens,
                        "totalCost": 0.0,
                        "inputCost": 0.0,
                        "outputCost": 0.0,
                        "cacheReadCost": 0.0,
                        "cacheWriteCost": 0.0,
                        "missingCostEntries": 0
                    }
                })
            })
            .collect::<Vec<_>>();

        let updated_at = now_ms();
        RpcDispatchOutcome::Handled(json!({
            "updatedAt": updated_at,
            "generatedAtMs": updated_at,
            "sessionKey": session_key,
            "startDate": window.start_date,
            "endDate": window.end_date,
            "range": {
                "startDate": window.start_date,
                "endDate": window.end_date,
                "days": window.days
            },
            "totals": {
                "input": 0,
                "output": 0,
                "cacheRead": 0,
                "cacheWrite": 0,
                "totalTokens": total_tokens,
                "totalCost": 0.0,
                "inputCost": 0.0,
                "outputCost": 0.0,
                "cacheReadCost": 0.0,
                "cacheWriteCost": 0.0,
                "missingCostEntries": 0
            },
            "aggregates": {
                "messages": {
                    "total": total_tokens,
                    "user": 0,
                    "assistant": 0,
                    "toolCalls": 0,
                    "toolResults": 0,
                    "errors": 0
                },
                "tools": {
                    "totalCalls": 0,
                    "uniqueTools": 0,
                    "tools": []
                },
                "byModel": [],
                "byProvider": [],
                "byAgent": by_agent,
                "byChannel": by_channel,
                "daily": []
            },
            "actions": {
                "allow": total_allow,
                "review": total_review,
                "block": total_block
            },
            "sessions": usage,
            "count": usage.len()
        }))
    }

    async fn handle_sessions_usage_timeseries(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<SessionsUsageTimeseriesParams>(&req.params) {
            Ok(v) => v,
            Err(err) => return RpcDispatchOutcome::bad_request(format!("invalid params: {err}")),
        };
        let session_key = normalize_session_key_input(params.session_key.or(params.key));
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
        let session_key = normalize_session_key_input(params.session_key.or(params.key));
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

        let session_key = match params
            .session_key
            .or(params.key)
            .map(|value| canonicalize_session_key(&value))
        {
            Some(value) if value.is_empty() => {
                return RpcDispatchOutcome::bad_request("sessionKey|key cannot be empty");
            }
            Some(value) => Some(value),
            None => {
                if let Some(session_id) = params
                    .session_id
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty())
                {
                    let Some(resolved) = self.sessions.resolve_session_id(&session_id).await else {
                        return RpcDispatchOutcome::not_found("session not found");
                    };
                    Some(resolved)
                } else {
                    None
                }
            }
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
        let session_key = canonicalize_session_key(&params.session_key);
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
                to: normalize_optional_text(params.to, 256),
                account_id: normalize_optional_text(params.account_id, 128),
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
        if let Some(session_key) = normalize_session_key_input(params.session_key) {
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

struct SystemRegistry {
    state: Mutex<SystemState>,
}

#[derive(Debug, Clone)]
struct SystemState {
    heartbeats_enabled: bool,
    last_heartbeat: Option<Value>,
    presence: HashMap<String, Value>,
    logs: VecDeque<String>,
    log_base_cursor: u64,
    log_next_cursor: u64,
}

#[derive(Debug, Clone)]
struct SystemPresenceUpdate {
    text: String,
    device_id: Option<String>,
    instance_id: Option<String>,
    host: Option<String>,
    ip: Option<String>,
    mode: Option<String>,
    version: Option<String>,
    platform: Option<String>,
    device_family: Option<String>,
    model_identifier: Option<String>,
    last_input_seconds: Option<u64>,
    reason: Option<String>,
    roles: Vec<String>,
    scopes: Vec<String>,
    tags: Vec<String>,
}

#[derive(Debug, Clone)]
struct LogTailSnapshot {
    file: String,
    cursor: u64,
    size: u64,
    lines: Vec<String>,
    truncated: bool,
    reset: bool,
}

impl SystemRegistry {
    fn new() -> Self {
        Self {
            state: Mutex::new(SystemState {
                heartbeats_enabled: true,
                last_heartbeat: None,
                presence: HashMap::new(),
                logs: VecDeque::new(),
                log_base_cursor: 0,
                log_next_cursor: 0,
            }),
        }
    }

    async fn set_heartbeats_enabled(&self, enabled: bool) {
        let mut guard = self.state.lock().await;
        guard.heartbeats_enabled = enabled;
        append_system_log(&mut guard, format!("heartbeats enabled={enabled}"));
    }

    async fn log_line(&self, line: String) {
        let mut guard = self.state.lock().await;
        append_system_log(&mut guard, line);
    }

    async fn last_heartbeat(&self) -> Option<Value> {
        let guard = self.state.lock().await;
        guard.last_heartbeat.clone()
    }

    async fn presence(&self) -> Vec<Value> {
        let guard = self.state.lock().await;
        let mut entries = guard
            .presence
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Vec<_>>();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries.into_iter().map(|(_, value)| value).collect()
    }

    async fn update_last_heartbeat(&self, payload: Value) {
        let mut heartbeat = match payload {
            Value::Object(mut raw) => {
                raw.entry("ts".to_owned())
                    .or_insert_with(|| json!(now_ms()));
                Value::Object(raw)
            }
            Value::Null => json!({
                "ts": now_ms(),
                "status": "unknown"
            }),
            raw => json!({
                "ts": now_ms(),
                "status": "unknown",
                "payload": raw
            }),
        };
        if let Some(status) = heartbeat
            .get("status")
            .and_then(Value::as_str)
            .and_then(|value| normalize_optional_text(Some(value.to_owned()), 64))
        {
            if let Some(map) = heartbeat.as_object_mut() {
                map.insert("status".to_owned(), Value::String(status));
            }
        }
        let mut guard = self.state.lock().await;
        let status = heartbeat
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        guard.last_heartbeat = Some(heartbeat);
        append_system_log(&mut guard, format!("heartbeat status={status}"));
    }

    async fn replace_presence(&self, payload: Value) {
        let mut guard = self.state.lock().await;
        guard.presence.clear();
        for (index, entry) in extract_presence_entries(payload).into_iter().enumerate() {
            if !entry.is_object() {
                continue;
            }
            let key = presence_key_from_value(&entry, index);
            guard.presence.insert(key, entry);
        }
        let count = guard.presence.len();
        append_system_log(&mut guard, format!("presence replaced count={count}"));
    }

    async fn upsert_presence(&self, update: SystemPresenceUpdate) {
        let now = now_ms();
        let mut entry = serde_json::Map::new();
        entry.insert("ts".to_owned(), json!(now));
        entry.insert("text".to_owned(), Value::String(update.text));
        if let Some(value) = update.device_id {
            entry.insert("deviceId".to_owned(), Value::String(value));
        }
        if let Some(value) = update.instance_id {
            entry.insert("instanceId".to_owned(), Value::String(value));
        }
        if let Some(value) = update.host {
            entry.insert("host".to_owned(), Value::String(value));
        }
        if let Some(value) = update.ip {
            entry.insert("ip".to_owned(), Value::String(value));
        }
        if let Some(value) = update.mode {
            entry.insert("mode".to_owned(), Value::String(value));
        }
        if let Some(value) = update.version {
            entry.insert("version".to_owned(), Value::String(value));
        }
        if let Some(value) = update.platform {
            entry.insert("platform".to_owned(), Value::String(value));
        }
        if let Some(value) = update.device_family {
            entry.insert("deviceFamily".to_owned(), Value::String(value));
        }
        if let Some(value) = update.model_identifier {
            entry.insert("modelIdentifier".to_owned(), Value::String(value));
        }
        if let Some(value) = update.last_input_seconds {
            entry.insert("lastInputSeconds".to_owned(), json!(value));
        }
        if let Some(value) = update.reason {
            entry.insert("reason".to_owned(), Value::String(value));
        }
        if !update.roles.is_empty() {
            entry.insert("roles".to_owned(), json!(update.roles));
        }
        if !update.scopes.is_empty() {
            entry.insert("scopes".to_owned(), json!(update.scopes));
        }
        if !update.tags.is_empty() {
            entry.insert("tags".to_owned(), json!(update.tags));
        }
        let key = build_presence_key(&entry, &format!("ts:{now}"));
        let mut guard = self.state.lock().await;
        guard.presence.insert(key, Value::Object(entry));
        let count = guard.presence.len();
        append_system_log(&mut guard, format!("system-event ingested count={count}"));
    }

    async fn tail_logs(
        &self,
        cursor: Option<u64>,
        limit: usize,
        max_bytes: usize,
    ) -> LogTailSnapshot {
        let guard = self.state.lock().await;
        let limit = limit.clamp(1, 5_000);
        let max_bytes = max_bytes.clamp(1, 1_000_000);
        let base = guard.log_base_cursor;
        let next = guard.log_next_cursor;
        let mut reset = false;
        let mut start_cursor = cursor.unwrap_or(base);
        if cursor.is_none() {
            start_cursor = next.saturating_sub(limit as u64);
        } else if start_cursor < base || start_cursor > next {
            reset = true;
            start_cursor = next.saturating_sub(limit as u64);
        }

        let start_index = start_cursor.saturating_sub(base) as usize;
        let mut lines = guard
            .logs
            .iter()
            .skip(start_index)
            .cloned()
            .collect::<Vec<_>>();
        let mut truncated = false;
        if lines.len() > limit {
            lines = lines.split_off(lines.len() - limit);
            truncated = true;
            reset = reset || cursor.is_some();
        }
        let mut bytes = lines
            .iter()
            .map(|line| line.len().saturating_add(1))
            .sum::<usize>();
        if bytes > max_bytes {
            truncated = true;
            while bytes > max_bytes && !lines.is_empty() {
                let removed = lines.remove(0);
                bytes = bytes.saturating_sub(removed.len().saturating_add(1));
            }
            reset = reset || cursor.is_some();
        }

        LogTailSnapshot {
            file: SYSTEM_LOG_PATH.to_owned(),
            cursor: next,
            size: guard
                .logs
                .iter()
                .map(|line| line.len().saturating_add(1) as u64)
                .sum(),
            lines,
            truncated,
            reset,
        }
    }
}

fn append_system_log(state: &mut SystemState, line: String) {
    if state.logs.len() >= MAX_SYSTEM_LOG_LINES {
        let _ = state.logs.pop_front();
        state.log_base_cursor = state.log_base_cursor.saturating_add(1);
    }
    state.logs.push_back(line);
    state.log_next_cursor = state.log_next_cursor.saturating_add(1);
}

fn extract_presence_entries(payload: Value) -> Vec<Value> {
    if let Some(entries) = payload.get("presence").and_then(Value::as_array).cloned() {
        return entries;
    }
    payload.as_array().cloned().unwrap_or_default()
}

fn build_presence_key(entry: &serde_json::Map<String, Value>, fallback: &str) -> String {
    let candidates = ["instanceId", "deviceId", "host", "ip", "text"];
    for field in candidates {
        if let Some(key) = entry
            .get(field)
            .and_then(Value::as_str)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            return format!("presence:{}", normalize(key));
        }
    }
    format!("presence:{}", normalize(fallback))
}

fn presence_key_from_value(value: &Value, index: usize) -> String {
    let Some(map) = value.as_object() else {
        return format!("presence:idx:{index}");
    };
    build_presence_key(map, &format!("idx:{index}"))
}

struct TalkRegistry {
    state: Mutex<TalkState>,
}

#[derive(Debug, Clone)]
struct TalkState {
    enabled: bool,
    phase: Option<String>,
    updated_at_ms: u64,
}

impl TalkRegistry {
    fn new() -> Self {
        Self {
            state: Mutex::new(TalkState {
                enabled: false,
                phase: None,
                updated_at_ms: now_ms(),
            }),
        }
    }

    async fn set_mode(&self, enabled: bool, phase: Option<String>) -> TalkState {
        let mut guard = self.state.lock().await;
        guard.enabled = enabled;
        guard.phase = phase;
        guard.updated_at_ms = now_ms();
        guard.clone()
    }
}

struct ModelRegistry {
    models: Vec<ModelChoice>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct ModelChoice {
    id: String,
    name: String,
    provider: String,
    #[serde(rename = "contextWindow", skip_serializing_if = "Option::is_none")]
    context_window: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<bool>,
}

impl ModelRegistry {
    fn new() -> Self {
        let mut models = vec![
            ModelChoice {
                id: "claude-sonnet-4-5".to_owned(),
                name: "Claude Sonnet 4.5".to_owned(),
                provider: "anthropic".to_owned(),
                context_window: Some(200_000),
                reasoning: Some(true),
            },
            ModelChoice {
                id: "claude-haiku-4-5".to_owned(),
                name: "Claude Haiku 4.5".to_owned(),
                provider: "anthropic".to_owned(),
                context_window: Some(200_000),
                reasoning: None,
            },
            ModelChoice {
                id: "gpt-5.3".to_owned(),
                name: "gpt-5.3".to_owned(),
                provider: "openai".to_owned(),
                context_window: Some(200_000),
                reasoning: Some(true),
            },
            ModelChoice {
                id: "gpt-5.3-codex".to_owned(),
                name: "gpt-5.3-codex".to_owned(),
                provider: "openai-codex".to_owned(),
                context_window: Some(200_000),
                reasoning: Some(true),
            },
        ];
        models.sort_by(|a, b| {
            let provider = a.provider.cmp(&b.provider);
            if provider != std::cmp::Ordering::Equal {
                return provider;
            }
            let name = a.name.cmp(&b.name);
            if name != std::cmp::Ordering::Equal {
                return name;
            }
            a.id.cmp(&b.id)
        });
        Self { models }
    }

    fn list(&self) -> Vec<ModelChoice> {
        self.models.clone()
    }
}

struct AgentRegistry {
    state: Mutex<AgentState>,
}

#[derive(Debug, Clone)]
struct AgentState {
    default_id: String,
    main_key: String,
    scope: String,
    entries: HashMap<String, AgentEntry>,
}

#[derive(Debug, Clone)]
struct AgentEntry {
    id: String,
    name: Option<String>,
    workspace: String,
    model: Option<String>,
    identity: Option<AgentIdentityState>,
    files: HashMap<String, AgentFileState>,
}

#[derive(Debug, Clone)]
struct AgentIdentityState {
    name: Option<String>,
    theme: Option<String>,
    emoji: Option<String>,
    avatar: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Debug, Clone)]
struct AgentFileState {
    content: String,
    updated_at_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
struct AgentListSnapshot {
    #[serde(rename = "defaultId")]
    default_id: String,
    #[serde(rename = "mainKey")]
    main_key: String,
    scope: String,
    agents: Vec<AgentSummaryView>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct AgentSummaryView {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: Option<AgentIdentityView>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct AgentIdentityView {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    theme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar: Option<String>,
    #[serde(rename = "avatarUrl", skip_serializing_if = "Option::is_none")]
    avatar_url: Option<String>,
}

#[derive(Debug, Clone)]
struct AgentCreatedResult {
    agent_id: String,
    name: String,
    workspace: String,
}

#[derive(Debug, Clone)]
struct AgentDeleteResult {
    agent_id: String,
    removed_bindings: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
struct AgentFileView {
    name: String,
    path: String,
    missing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(rename = "updatedAtMs", skip_serializing_if = "Option::is_none")]
    updated_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

impl AgentRegistry {
    fn new() -> Self {
        let mut entries = HashMap::new();
        entries.insert(
            DEFAULT_AGENT_ID.to_owned(),
            AgentEntry {
                id: DEFAULT_AGENT_ID.to_owned(),
                name: Some(DEFAULT_AGENT_NAME.to_owned()),
                workspace: DEFAULT_AGENT_WORKSPACE.to_owned(),
                model: None,
                identity: Some(AgentIdentityState {
                    name: Some(DEFAULT_AGENT_IDENTITY_NAME.to_owned()),
                    theme: Some(DEFAULT_AGENT_IDENTITY_THEME.to_owned()),
                    emoji: Some(DEFAULT_AGENT_IDENTITY_EMOJI.to_owned()),
                    avatar: Some(DEFAULT_AGENT_IDENTITY_AVATAR.to_owned()),
                    avatar_url: Some(DEFAULT_AGENT_IDENTITY_AVATAR_URL.to_owned()),
                }),
                files: HashMap::new(),
            },
        );
        Self {
            state: Mutex::new(AgentState {
                default_id: DEFAULT_AGENT_ID.to_owned(),
                main_key: DEFAULT_MAIN_KEY.to_owned(),
                scope: DEFAULT_AGENT_SCOPE.to_owned(),
                entries,
            }),
        }
    }

    async fn contains(&self, raw_agent_id: &str) -> bool {
        let agent_id = normalize_agent_id(raw_agent_id);
        let guard = self.state.lock().await;
        guard.entries.contains_key(&agent_id)
    }

    async fn workspace_for(&self, raw_agent_id: &str) -> Option<String> {
        let agent_id = normalize_agent_id(raw_agent_id);
        let guard = self.state.lock().await;
        guard
            .entries
            .get(&agent_id)
            .map(|entry| entry.workspace.clone())
    }

    async fn list(&self) -> AgentListSnapshot {
        let guard = self.state.lock().await;
        let mut ids = guard.entries.keys().cloned().collect::<Vec<_>>();
        ids.sort_by(|a, b| {
            if a.eq_ignore_ascii_case(&guard.default_id) {
                return std::cmp::Ordering::Less;
            }
            if b.eq_ignore_ascii_case(&guard.default_id) {
                return std::cmp::Ordering::Greater;
            }
            a.cmp(b)
        });
        let agents = ids
            .into_iter()
            .filter_map(|id| guard.entries.get(&id))
            .map(agent_summary_from_entry)
            .collect::<Vec<_>>();
        AgentListSnapshot {
            default_id: guard.default_id.clone(),
            main_key: guard.main_key.clone(),
            scope: guard.scope.clone(),
            agents,
        }
    }

    async fn create(&self, params: AgentsCreateParams) -> Result<AgentCreatedResult, String> {
        let name = normalize_optional_text(Some(params.name), 128)
            .ok_or_else(|| "name is required".to_owned())?;
        let workspace = normalize_optional_text(Some(params.workspace), 512)
            .ok_or_else(|| "workspace is required".to_owned())?;
        let agent_id = normalize_agent_id(&name);
        if agent_id.eq_ignore_ascii_case(DEFAULT_AGENT_ID) {
            return Err(format!("\"{DEFAULT_AGENT_ID}\" is reserved"));
        }

        let mut guard = self.state.lock().await;
        if guard.entries.contains_key(&agent_id) {
            return Err(format!("agent \"{agent_id}\" already exists"));
        }
        let identity = AgentIdentityState {
            name: Some(name.clone()),
            theme: None,
            emoji: normalize_optional_text(params.emoji, 32),
            avatar: normalize_optional_text(params.avatar, 128),
            avatar_url: None,
        };
        guard.entries.insert(
            agent_id.clone(),
            AgentEntry {
                id: agent_id.clone(),
                name: Some(name.clone()),
                workspace: workspace.clone(),
                model: None,
                identity: Some(identity),
                files: HashMap::new(),
            },
        );
        Ok(AgentCreatedResult {
            agent_id,
            name,
            workspace,
        })
    }

    async fn update(&self, params: AgentsUpdateParams) -> Result<String, String> {
        let agent_id = normalize_agent_id(&params.agent_id);
        let mut guard = self.state.lock().await;
        let Some(entry) = guard.entries.get_mut(&agent_id) else {
            return Err(format!("agent \"{agent_id}\" not found"));
        };

        if let Some(name) = normalize_optional_text(params.name, 128) {
            entry.name = Some(name.clone());
            upsert_agent_identity(entry, |identity| {
                identity.name = Some(name.clone());
            });
        }
        if let Some(workspace) = params.workspace {
            let normalized = normalize_optional_text(Some(workspace), 512)
                .ok_or_else(|| "workspace must be a non-empty string".to_owned())?;
            entry.workspace = normalized;
        }
        if let Some(model) = normalize_optional_text(params.model, 256) {
            entry.model = Some(model);
        }
        if let Some(avatar) = normalize_optional_text(params.avatar, 256) {
            upsert_agent_identity(entry, |identity| {
                identity.avatar = Some(avatar.clone());
            });
        }
        Ok(agent_id)
    }

    async fn delete(&self, params: AgentsDeleteParams) -> Result<AgentDeleteResult, String> {
        let agent_id = normalize_agent_id(&params.agent_id);
        if agent_id.eq_ignore_ascii_case(DEFAULT_AGENT_ID) {
            return Err(format!("\"{DEFAULT_AGENT_ID}\" cannot be deleted"));
        }
        let _delete_files = params.delete_files.unwrap_or(true);

        let mut guard = self.state.lock().await;
        if guard.entries.remove(&agent_id).is_none() {
            return Err(format!("agent \"{agent_id}\" not found"));
        }
        Ok(AgentDeleteResult {
            agent_id,
            removed_bindings: 1,
        })
    }

    async fn list_files(
        &self,
        params: AgentsFilesListParams,
    ) -> Result<(String, String, Vec<AgentFileView>), String> {
        let agent_id = normalize_agent_id(&params.agent_id);
        let guard = self.state.lock().await;
        let Some(entry) = guard.entries.get(&agent_id) else {
            return Err("unknown agent id".to_owned());
        };

        let mut files = Vec::new();
        for name in AGENT_BOOTSTRAP_FILE_NAMES {
            files.push(agent_file_view_from_state(entry, name, false));
        }
        if entry.files.contains_key(AGENT_PRIMARY_MEMORY_FILE_NAME) {
            files.push(agent_file_view_from_state(
                entry,
                AGENT_PRIMARY_MEMORY_FILE_NAME,
                false,
            ));
        } else if entry.files.contains_key(AGENT_ALT_MEMORY_FILE_NAME) {
            files.push(agent_file_view_from_state(
                entry,
                AGENT_ALT_MEMORY_FILE_NAME,
                false,
            ));
        } else {
            files.push(agent_file_view_from_state(
                entry,
                AGENT_PRIMARY_MEMORY_FILE_NAME,
                false,
            ));
        }

        Ok((agent_id, entry.workspace.clone(), files))
    }

    async fn get_file(
        &self,
        params: AgentsFilesGetParams,
    ) -> Result<(String, String, AgentFileView), String> {
        let agent_id = normalize_agent_id(&params.agent_id);
        let name = normalize_optional_text(Some(params.name), 128)
            .ok_or_else(|| "unsupported file \"\"".to_owned())?;
        if !is_allowed_agent_file_name(&name) {
            return Err(format!("unsupported file \"{name}\""));
        }

        let guard = self.state.lock().await;
        let Some(entry) = guard.entries.get(&agent_id) else {
            return Err("unknown agent id".to_owned());
        };
        let file = agent_file_view_from_state(entry, &name, true);
        Ok((agent_id, entry.workspace.clone(), file))
    }

    async fn set_file(
        &self,
        params: AgentsFilesSetParams,
    ) -> Result<(String, String, AgentFileView), String> {
        let agent_id = normalize_agent_id(&params.agent_id);
        let name = normalize_optional_text(Some(params.name), 128)
            .ok_or_else(|| "unsupported file \"\"".to_owned())?;
        if !is_allowed_agent_file_name(&name) {
            return Err(format!("unsupported file \"{name}\""));
        }

        let mut guard = self.state.lock().await;
        let Some(entry) = guard.entries.get_mut(&agent_id) else {
            return Err("unknown agent id".to_owned());
        };
        let now = now_ms();
        entry.files.insert(
            name.clone(),
            AgentFileState {
                content: params.content,
                updated_at_ms: now,
            },
        );
        let file = agent_file_view_from_state(entry, &name, true);
        Ok((agent_id, entry.workspace.clone(), file))
    }
}

fn upsert_agent_identity<F>(entry: &mut AgentEntry, mut mutate: F)
where
    F: FnMut(&mut AgentIdentityState),
{
    let mut identity = entry.identity.clone().unwrap_or(AgentIdentityState {
        name: None,
        theme: None,
        emoji: None,
        avatar: None,
        avatar_url: None,
    });
    mutate(&mut identity);
    entry.identity = Some(identity);
}

fn agent_summary_from_entry(entry: &AgentEntry) -> AgentSummaryView {
    let _has_model_override = entry.model.is_some();
    AgentSummaryView {
        id: entry.id.clone(),
        name: entry.name.clone(),
        identity: entry.identity.as_ref().map(|identity| AgentIdentityView {
            name: identity.name.clone(),
            theme: identity.theme.clone(),
            emoji: identity.emoji.clone(),
            avatar: identity.avatar.clone(),
            avatar_url: identity.avatar_url.clone(),
        }),
    }
}

fn agent_file_view_from_state(
    entry: &AgentEntry,
    name: &str,
    include_content: bool,
) -> AgentFileView {
    let path = agent_workspace_file_path(&entry.workspace, name);
    if let Some(file) = entry.files.get(name) {
        return AgentFileView {
            name: name.to_owned(),
            path,
            missing: false,
            size: Some(file.content.len() as u64),
            updated_at_ms: Some(file.updated_at_ms),
            content: include_content.then(|| file.content.clone()),
        };
    }
    AgentFileView {
        name: name.to_owned(),
        path,
        missing: true,
        size: None,
        updated_at_ms: None,
        content: None,
    }
}

fn agent_workspace_file_path(workspace: &str, name: &str) -> String {
    let trimmed = workspace
        .trim()
        .trim_end_matches('/')
        .trim_end_matches('\\')
        .to_owned();
    if trimmed.is_empty() {
        return name.to_owned();
    }
    format!("{trimmed}/{name}")
}

fn is_allowed_agent_file_name(name: &str) -> bool {
    AGENT_BOOTSTRAP_FILE_NAMES
        .iter()
        .any(|candidate| *candidate == name)
        || name == AGENT_PRIMARY_MEMORY_FILE_NAME
        || name == AGENT_ALT_MEMORY_FILE_NAME
}

fn normalize_agent_id(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return DEFAULT_AGENT_ID.to_owned();
    }
    let lowered = trimmed.to_ascii_lowercase();
    if is_valid_agent_id(&lowered) {
        return lowered;
    }
    let mut normalized = String::with_capacity(lowered.len());
    let mut last_dash = false;
    for ch in lowered.chars() {
        let valid = ch.is_ascii_alphanumeric() || ch == '_' || ch == '-';
        if valid {
            normalized.push(ch);
            last_dash = false;
            continue;
        }
        if !last_dash {
            normalized.push('-');
            last_dash = true;
        }
    }
    let trimmed_dash = normalized.trim_matches('-');
    let output = trimmed_dash.chars().take(64).collect::<String>();
    if output.is_empty() {
        DEFAULT_AGENT_ID.to_owned()
    } else {
        output
    }
}

fn is_valid_agent_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

struct CronRegistry {
    state: Mutex<CronState>,
}

#[derive(Debug, Clone)]
struct CronState {
    enabled: bool,
    jobs: HashMap<String, CronJob>,
    run_logs: HashMap<String, VecDeque<CronRunLogEntry>>,
}

#[derive(Debug, Clone)]
enum CronRegistryError {
    NotFound(String),
    Invalid(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CronRunMode {
    Due,
    Force,
}

#[derive(Debug, Clone)]
struct CronRunExecution {
    entry: CronRunLogEntry,
    system_event_text: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind")]
enum CronSchedule {
    #[serde(rename = "at")]
    At { at: String },
    #[serde(rename = "every")]
    Every {
        #[serde(rename = "everyMs")]
        every_ms: u64,
        #[serde(rename = "anchorMs", skip_serializing_if = "Option::is_none")]
        anchor_ms: Option<u64>,
    },
    #[serde(rename = "cron")]
    Cron {
        expr: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tz: Option<String>,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind")]
enum CronPayload {
    #[serde(rename = "systemEvent")]
    SystemEvent { text: String },
    #[serde(rename = "agentTurn")]
    AgentTurn {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        thinking: Option<String>,
        #[serde(rename = "timeoutSeconds", skip_serializing_if = "Option::is_none")]
        timeout_seconds: Option<u64>,
        #[serde(
            rename = "allowUnsafeExternalContent",
            skip_serializing_if = "Option::is_none"
        )]
        allow_unsafe_external_content: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        deliver: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        channel: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        to: Option<String>,
        #[serde(rename = "bestEffortDeliver", skip_serializing_if = "Option::is_none")]
        best_effort_deliver: Option<bool>,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CronDelivery {
    mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    to: Option<String>,
    #[serde(rename = "bestEffort", skip_serializing_if = "Option::is_none")]
    best_effort: Option<bool>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, deny_unknown_fields)]
struct CronJobState {
    #[serde(rename = "nextRunAtMs", skip_serializing_if = "Option::is_none")]
    next_run_at_ms: Option<u64>,
    #[serde(rename = "runningAtMs", skip_serializing_if = "Option::is_none")]
    running_at_ms: Option<u64>,
    #[serde(rename = "lastRunAtMs", skip_serializing_if = "Option::is_none")]
    last_run_at_ms: Option<u64>,
    #[serde(rename = "lastStatus", skip_serializing_if = "Option::is_none")]
    last_status: Option<CronRunStatus>,
    #[serde(rename = "lastError", skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    #[serde(rename = "lastDurationMs", skip_serializing_if = "Option::is_none")]
    last_duration_ms: Option<u64>,
    #[serde(rename = "consecutiveErrors", skip_serializing_if = "Option::is_none")]
    consecutive_errors: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum CronRunStatus {
    Ok,
    Error,
    Skipped,
}

#[derive(Debug, Clone, serde::Serialize)]
struct CronRunLogEntry {
    ts: u64,
    #[serde(rename = "jobId")]
    job_id: String,
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<CronRunStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(rename = "sessionKey", skip_serializing_if = "Option::is_none")]
    session_key: Option<String>,
    #[serde(rename = "runAtMs", skip_serializing_if = "Option::is_none")]
    run_at_ms: Option<u64>,
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(rename = "nextRunAtMs", skip_serializing_if = "Option::is_none")]
    next_run_at_ms: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct CronJob {
    id: String,
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    #[serde(rename = "sessionKey", skip_serializing_if = "Option::is_none")]
    session_key: Option<String>,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    enabled: bool,
    #[serde(rename = "deleteAfterRun", skip_serializing_if = "Option::is_none")]
    delete_after_run: Option<bool>,
    #[serde(rename = "createdAtMs")]
    created_at_ms: u64,
    #[serde(rename = "updatedAtMs")]
    updated_at_ms: u64,
    schedule: CronSchedule,
    #[serde(rename = "sessionTarget")]
    session_target: String,
    #[serde(rename = "wakeMode")]
    wake_mode: String,
    payload: CronPayload,
    #[serde(skip_serializing_if = "Option::is_none")]
    delivery: Option<CronDelivery>,
    state: CronJobState,
}

#[derive(Debug, Clone, serde::Serialize)]
struct CronRemoveResult {
    ok: bool,
    id: String,
    removed: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
struct CronStatusSnapshot {
    enabled: bool,
    jobs: usize,
    #[serde(rename = "nextWakeAtMs", skip_serializing_if = "Option::is_none")]
    next_wake_at_ms: Option<u64>,
    #[serde(rename = "storePath")]
    store_path: String,
}

impl CronRegistry {
    fn new() -> Self {
        Self {
            state: Mutex::new(CronState {
                enabled: true,
                jobs: HashMap::new(),
                run_logs: HashMap::new(),
            }),
        }
    }

    async fn list(&self, include_disabled: bool) -> Vec<CronJob> {
        let guard = self.state.lock().await;
        let mut jobs = guard
            .jobs
            .values()
            .filter(|job| include_disabled || job.enabled)
            .cloned()
            .collect::<Vec<_>>();
        jobs.sort_by(|a, b| {
            a.created_at_ms
                .cmp(&b.created_at_ms)
                .then_with(|| a.id.cmp(&b.id))
        });
        jobs
    }

    async fn status(&self) -> CronStatusSnapshot {
        let guard = self.state.lock().await;
        let next_wake_at_ms = guard
            .jobs
            .values()
            .filter(|job| job.enabled)
            .filter_map(|job| job.state.next_run_at_ms)
            .min();
        CronStatusSnapshot {
            enabled: guard.enabled,
            jobs: guard.jobs.len(),
            next_wake_at_ms,
            store_path: CRON_STORE_PATH.to_owned(),
        }
    }

    async fn add(&self, params: CronAddParams) -> Result<CronJob, CronRegistryError> {
        let name = normalize_optional_text(Some(params.name), 128)
            .ok_or_else(|| CronRegistryError::Invalid("cron.add name is required".to_owned()))?;
        let schedule = normalize_cron_schedule(params.schedule)?;
        let session_target = parse_cron_session_target(params.session_target)?;
        let wake_mode = parse_cron_wake_mode(params.wake_mode)?;
        let payload = normalize_cron_payload(params.payload)?;
        let mut delivery = match params.delivery {
            Some(raw) => Some(normalize_cron_delivery(raw, "cron.add")?),
            None => None,
        };
        if delivery.is_none() {
            delivery = legacy_cron_delivery_from_payload(&payload);
        }
        let now = now_ms();
        let id = next_cron_job_id();
        let job = CronJob {
            id: id.clone(),
            agent_id: normalize_optional_text(params.agent_id.flatten(), 64),
            session_key: normalize_session_key_input(params.session_key.flatten()),
            name,
            description: normalize_optional_text(params.description, 512),
            enabled: params.enabled.unwrap_or(true),
            delete_after_run: params.delete_after_run,
            created_at_ms: now,
            updated_at_ms: now,
            schedule: schedule.clone(),
            session_target,
            wake_mode,
            payload,
            delivery,
            state: CronJobState {
                next_run_at_ms: estimate_next_run_at_ms(&schedule, now),
                ..CronJobState::default()
            },
        };
        let mut guard = self.state.lock().await;
        guard.jobs.insert(id, job.clone());
        Ok(job)
    }

    async fn update(
        &self,
        job_id: &str,
        patch: CronUpdatePatchInput,
    ) -> Result<CronJob, CronRegistryError> {
        let now = now_ms();
        let mut guard = self.state.lock().await;
        let Some(job) = guard.jobs.get_mut(job_id) else {
            return Err(CronRegistryError::NotFound(format!(
                "cron job not found: {job_id}"
            )));
        };
        if let Some(value) = patch.name {
            job.name = normalize_optional_text(Some(value), 128).ok_or_else(|| {
                CronRegistryError::Invalid("cron.update patch.name cannot be empty".to_owned())
            })?;
        }
        if let Some(value) = patch.agent_id {
            job.agent_id = normalize_optional_text(value, 64);
        }
        if let Some(value) = patch.session_key {
            job.session_key = normalize_session_key_input(value);
        }
        if let Some(value) = patch.description {
            job.description = normalize_optional_text(value, 512);
        }
        if let Some(value) = patch.enabled {
            job.enabled = value;
        }
        if let Some(value) = patch.delete_after_run {
            job.delete_after_run = Some(value);
        }
        if let Some(value) = patch.schedule {
            let schedule = normalize_cron_schedule(value)?;
            job.schedule = schedule.clone();
            job.state.next_run_at_ms = estimate_next_run_at_ms(&schedule, now);
        }
        if let Some(value) = patch.session_target {
            job.session_target = parse_cron_session_target(Some(value))?;
        }
        if let Some(value) = patch.wake_mode {
            job.wake_mode = parse_cron_wake_mode(Some(value))?;
        }
        if let Some(payload_patch) = patch.payload {
            let (payload, legacy_delivery) = apply_cron_payload_patch(&job.payload, payload_patch)?;
            job.payload = payload;
            if patch.delivery.is_none() {
                if let Some(raw) = legacy_delivery {
                    job.delivery = Some(normalize_cron_delivery(raw, "cron.update")?);
                }
            }
        }
        if let Some(delivery_patch) = patch.delivery {
            job.delivery = apply_cron_delivery_patch(job.delivery.clone(), delivery_patch)?;
        }
        if let Some(state_patch) = patch.state {
            apply_cron_job_state_patch(&mut job.state, state_patch)?;
        }
        job.updated_at_ms = now;
        Ok(job.clone())
    }

    async fn remove(&self, job_id: &str) -> Option<CronRemoveResult> {
        let mut guard = self.state.lock().await;
        guard.jobs.remove(job_id)?;
        Some(CronRemoveResult {
            ok: true,
            id: job_id.to_owned(),
            removed: true,
        })
    }

    async fn run(
        &self,
        job_id: &str,
        mode: CronRunMode,
    ) -> Result<CronRunExecution, CronRegistryError> {
        let now = now_ms();
        let mut guard = self.state.lock().await;
        let (entry, system_event_text, should_disable, should_delete) = {
            let Some(job) = guard.jobs.get_mut(job_id) else {
                return Err(CronRegistryError::NotFound(format!(
                    "cron job not found: {job_id}"
                )));
            };
            let mut status = CronRunStatus::Ok;
            if !job.enabled {
                status = CronRunStatus::Skipped;
            } else if mode == CronRunMode::Due {
                if let Some(next) = job.state.next_run_at_ms {
                    if next > now {
                        status = CronRunStatus::Skipped;
                    }
                }
            }

            let summary = match (&status, &job.payload) {
                (CronRunStatus::Ok, CronPayload::SystemEvent { text }) => {
                    Some(truncate_text(text, 256))
                }
                (CronRunStatus::Ok, CronPayload::AgentTurn { message, .. }) => {
                    Some(truncate_text(message, 256))
                }
                (CronRunStatus::Skipped, _) if !job.enabled => Some("job disabled".to_owned()),
                (CronRunStatus::Skipped, _) => Some("not due".to_owned()),
                (CronRunStatus::Error, _) => None,
            };

            let system_event_text = if matches!(status, CronRunStatus::Ok) {
                match &job.payload {
                    CronPayload::SystemEvent { text } => Some(text.clone()),
                    _ => None,
                }
            } else {
                None
            };

            job.state.running_at_ms = None;
            job.state.last_run_at_ms = Some(now);
            job.state.last_duration_ms = Some(0);
            job.state.last_status = Some(status.clone());
            if matches!(status, CronRunStatus::Error) {
                let current = job.state.consecutive_errors.unwrap_or(0);
                job.state.consecutive_errors = Some(current.saturating_add(1));
            } else {
                job.state.consecutive_errors = Some(0);
                job.state.last_error = None;
            }

            if matches!(status, CronRunStatus::Ok) {
                match &job.schedule {
                    CronSchedule::Every { every_ms, .. } => {
                        job.state.next_run_at_ms = Some(now.saturating_add(*every_ms));
                    }
                    CronSchedule::At { .. } => {
                        job.state.next_run_at_ms = None;
                    }
                    CronSchedule::Cron { .. } => {}
                }
            }
            job.updated_at_ms = now;
            let entry = CronRunLogEntry {
                ts: now,
                job_id: job_id.to_owned(),
                action: "finished".to_owned(),
                status: Some(status),
                error: None,
                summary,
                session_id: None,
                session_key: job.session_key.clone(),
                run_at_ms: Some(now),
                duration_ms: Some(0),
                next_run_at_ms: job.state.next_run_at_ms,
            };
            (
                entry,
                system_event_text,
                matches!(&job.schedule, CronSchedule::At { .. }),
                job.delete_after_run.unwrap_or(false),
            )
        };

        let logs = guard
            .run_logs
            .entry(job_id.to_owned())
            .or_insert_with(VecDeque::new);
        if logs.len() >= MAX_CRON_RUN_LOGS_PER_JOB {
            let _ = logs.pop_front();
        }
        logs.push_back(entry.clone());

        if should_delete {
            let _ = guard.jobs.remove(job_id);
        } else if should_disable {
            if let Some(job) = guard.jobs.get_mut(job_id) {
                job.enabled = false;
                job.updated_at_ms = now;
            }
        }

        Ok(CronRunExecution {
            entry,
            system_event_text,
        })
    }

    async fn runs(
        &self,
        job_id: &str,
        limit: usize,
    ) -> Result<Vec<CronRunLogEntry>, CronRegistryError> {
        let guard = self.state.lock().await;
        if !guard.jobs.contains_key(job_id) && !guard.run_logs.contains_key(job_id) {
            return Err(CronRegistryError::NotFound(format!(
                "cron job not found: {job_id}"
            )));
        }
        let mut entries = guard
            .run_logs
            .get(job_id)
            .map(|logs| logs.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        if entries.len() > limit {
            entries = entries.split_off(entries.len() - limit);
        }
        Ok(entries)
    }
}

struct SkillsRegistry {
    state: Mutex<SkillsState>,
}

#[derive(Debug, Clone)]
struct SkillsState {
    managed_skills_dir: String,
    entries: HashMap<String, SkillConfigState>,
    virtual_skills: HashMap<String, VirtualSkillEntry>,
}

#[derive(Debug, Clone, Default)]
struct SkillConfigState {
    enabled: Option<bool>,
    api_key: Option<String>,
    env: HashMap<String, String>,
}

#[derive(Debug, Clone)]
struct VirtualSkillEntry {
    name: String,
    description: String,
}

#[derive(Debug, Clone)]
struct DiscoveredSkill {
    name: String,
    description: String,
    source: String,
    file_path: String,
    base_dir: String,
    skill_key: String,
    bundled: bool,
    primary_env: Option<String>,
    emoji: Option<String>,
    homepage: Option<String>,
    requirements: SkillRequirementSet,
    install: Vec<SkillInstallOption>,
}

#[derive(Debug, Clone, Default)]
struct SkillRequirementSet {
    bins: Vec<String>,
    env: Vec<String>,
    config: Vec<String>,
    os: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SkillsStatusConfigCheck {
    path: String,
    satisfied: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SkillInstallOption {
    id: String,
    kind: String,
    label: String,
    bins: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SkillStatusRequirements {
    bins: Vec<String>,
    env: Vec<String>,
    config: Vec<String>,
    os: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SkillStatusEntryView {
    name: String,
    description: String,
    source: String,
    #[serde(rename = "filePath")]
    file_path: String,
    #[serde(rename = "baseDir")]
    base_dir: String,
    #[serde(rename = "skillKey")]
    skill_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    bundled: Option<bool>,
    #[serde(rename = "primaryEnv", skip_serializing_if = "Option::is_none")]
    primary_env: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    homepage: Option<String>,
    always: bool,
    disabled: bool,
    #[serde(rename = "blockedByAllowlist")]
    blocked_by_allowlist: bool,
    eligible: bool,
    requirements: SkillStatusRequirements,
    missing: SkillStatusRequirements,
    #[serde(rename = "configChecks")]
    config_checks: Vec<SkillsStatusConfigCheck>,
    install: Vec<SkillInstallOption>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SkillsStatusReport {
    #[serde(rename = "workspaceDir")]
    workspace_dir: String,
    #[serde(rename = "managedSkillsDir")]
    managed_skills_dir: String,
    skills: Vec<SkillStatusEntryView>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SkillConfigView {
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(rename = "apiKey", skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    env: HashMap<String, String>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SkillsUpdateResult {
    ok: bool,
    #[serde(rename = "skillKey")]
    skill_key: String,
    config: SkillConfigView,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SkillsInstallResult {
    ok: bool,
    #[serde(rename = "skillKey")]
    skill_key: String,
    name: String,
    #[serde(rename = "installId")]
    install_id: String,
    installed: bool,
    message: String,
}

impl SkillsRegistry {
    fn new() -> Self {
        let managed_skills_dir = default_codex_skills_dir().to_string_lossy().to_string();
        Self {
            state: Mutex::new(SkillsState {
                managed_skills_dir,
                entries: HashMap::new(),
                virtual_skills: HashMap::new(),
            }),
        }
    }

    async fn status(&self, workspace_dir: &str, _agent_id: &str) -> SkillsStatusReport {
        let snapshot = {
            let guard = self.state.lock().await;
            (
                guard.managed_skills_dir.clone(),
                guard.entries.clone(),
                guard.virtual_skills.clone(),
            )
        };
        let discovered = discover_skills(Path::new(&snapshot.0), &snapshot.1, &snapshot.2);
        let skills = discovered
            .into_iter()
            .map(|skill| {
                let cfg = snapshot
                    .1
                    .get(&skill.skill_key)
                    .cloned()
                    .unwrap_or_default();
                build_skill_status_entry(skill, cfg)
            })
            .collect::<Vec<_>>();
        SkillsStatusReport {
            workspace_dir: workspace_dir.to_owned(),
            managed_skills_dir: snapshot.0,
            skills,
        }
    }

    async fn bins(&self) -> Vec<String> {
        let snapshot = {
            let guard = self.state.lock().await;
            (
                guard.managed_skills_dir.clone(),
                guard.entries.clone(),
                guard.virtual_skills.clone(),
            )
        };
        let discovered = discover_skills(Path::new(&snapshot.0), &snapshot.1, &snapshot.2);
        let mut bins = Vec::new();
        for skill in discovered {
            bins.extend(skill.requirements.bins);
            for install in skill.install {
                bins.extend(install.bins);
            }
        }
        sort_and_dedup_strings(&mut bins);
        bins
    }

    async fn install(&self, params: SkillsInstallParams) -> SkillsInstallResult {
        let name = params.name.trim().to_owned();
        let install_id = params.install_id.trim().to_owned();
        let skill_key = skill_key_from_name(&name);
        let mut guard = self.state.lock().await;
        guard
            .virtual_skills
            .entry(skill_key.clone())
            .or_insert_with(|| VirtualSkillEntry {
                name: name.clone(),
                description: "User-managed skill".to_owned(),
            });
        SkillsInstallResult {
            ok: true,
            skill_key,
            name: name.clone(),
            install_id: install_id.clone(),
            installed: true,
            message: format!("Installed {name} ({install_id})"),
        }
    }

    async fn update(&self, params: SkillsUpdateParams) -> Result<SkillsUpdateResult, String> {
        let skill_key = normalize_optional_text(Some(params.skill_key), 128)
            .ok_or_else(|| "skillKey is required".to_owned())?;
        let mut guard = self.state.lock().await;
        let config_view = {
            let entry = guard
                .entries
                .entry(skill_key.clone())
                .or_insert_with(SkillConfigState::default);
            if let Some(enabled) = params.enabled {
                entry.enabled = Some(enabled);
            }
            if let Some(api_key) = params.api_key {
                let normalized = normalize_secret_input(&api_key);
                if normalized.is_empty() {
                    entry.api_key = None;
                } else {
                    entry.api_key = Some(normalized);
                }
            }
            if let Some(env) = params.env {
                for (raw_key, raw_value) in env {
                    let key = raw_key.trim();
                    if key.is_empty() {
                        continue;
                    }
                    let value = raw_value.trim();
                    if value.is_empty() {
                        entry.env.remove(key);
                    } else {
                        entry.env.insert(key.to_owned(), value.to_owned());
                    }
                }
            }
            SkillConfigView {
                enabled: entry.enabled,
                api_key: entry.api_key.clone(),
                env: entry.env.clone(),
            }
        };
        guard
            .virtual_skills
            .entry(skill_key.clone())
            .or_insert_with(|| VirtualSkillEntry {
                name: skill_key.clone(),
                description: "User-managed skill".to_owned(),
            });
        Ok(SkillsUpdateResult {
            ok: true,
            skill_key,
            config: config_view,
        })
    }
}

fn discover_skills(
    base_dir: &Path,
    config_entries: &HashMap<String, SkillConfigState>,
    virtual_skills: &HashMap<String, VirtualSkillEntry>,
) -> Vec<DiscoveredSkill> {
    let mut by_key = HashMap::new();
    if base_dir.exists() {
        let mut stack = vec![(base_dir.to_path_buf(), 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            if depth > 6 {
                continue;
            }
            let read_dir = match std::fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in read_dir.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push((path, depth + 1));
                    continue;
                }
                let is_skill_file = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(|value| value.eq_ignore_ascii_case("SKILL.md"))
                    .unwrap_or(false);
                if !is_skill_file {
                    continue;
                }
                if let Some(skill) = parse_skill_file(&path) {
                    by_key.insert(skill.skill_key.clone(), skill);
                    if by_key.len() >= 512 {
                        break;
                    }
                }
            }
            if by_key.len() >= 512 {
                break;
            }
        }
    }

    for (skill_key, virtual_skill) in virtual_skills {
        by_key
            .entry(skill_key.clone())
            .or_insert_with(|| DiscoveredSkill {
                name: virtual_skill.name.clone(),
                description: virtual_skill.description.clone(),
                source: "virtual".to_owned(),
                file_path: String::new(),
                base_dir: String::new(),
                skill_key: skill_key.clone(),
                bundled: false,
                primary_env: None,
                emoji: None,
                homepage: None,
                requirements: SkillRequirementSet::default(),
                install: Vec::new(),
            });
    }

    for skill_key in config_entries.keys() {
        by_key
            .entry(skill_key.clone())
            .or_insert_with(|| DiscoveredSkill {
                name: skill_key.clone(),
                description: "Configured skill".to_owned(),
                source: "config".to_owned(),
                file_path: String::new(),
                base_dir: String::new(),
                skill_key: skill_key.clone(),
                bundled: false,
                primary_env: None,
                emoji: None,
                homepage: None,
                requirements: SkillRequirementSet::default(),
                install: Vec::new(),
            });
    }

    let mut values = by_key.into_values().collect::<Vec<_>>();
    values.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
            .then_with(|| a.skill_key.cmp(&b.skill_key))
    });
    values
}

fn parse_skill_file(path: &Path) -> Option<DiscoveredSkill> {
    let raw = std::fs::read_to_string(path).ok()?;
    let mut frontmatter = HashMap::new();
    let mut lines = raw.lines();
    if matches!(lines.next().map(str::trim), Some("---")) {
        for line in lines {
            let trimmed = line.trim();
            if trimmed == "---" {
                break;
            }
            if let Some((key, value)) = trimmed.split_once(':') {
                frontmatter.insert(
                    key.trim().to_ascii_lowercase(),
                    value.trim().trim_matches('"').to_owned(),
                );
            }
        }
    }

    let parent = path.parent()?;
    let fallback_name = parent
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("skill")
        .to_owned();
    let name = frontmatter
        .get("name")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_name.clone());
    let description = frontmatter
        .get("description")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Installed skill".to_owned());
    let skill_key = skill_key_from_name(&name);
    let source = if path.to_string_lossy().contains(".system") {
        "system".to_owned()
    } else {
        "local".to_owned()
    };
    Some(DiscoveredSkill {
        name,
        description,
        source,
        file_path: path.to_string_lossy().to_string(),
        base_dir: parent.to_string_lossy().to_string(),
        skill_key,
        bundled: path.to_string_lossy().contains(".system"),
        primary_env: frontmatter.get("primary_env").cloned(),
        emoji: frontmatter.get("emoji").cloned(),
        homepage: frontmatter.get("homepage").cloned(),
        requirements: SkillRequirementSet::default(),
        install: Vec::new(),
    })
}

fn build_skill_status_entry(skill: DiscoveredSkill, cfg: SkillConfigState) -> SkillStatusEntryView {
    let mut missing_env = skill
        .requirements
        .env
        .iter()
        .filter(|key| !cfg.env.contains_key(*key))
        .filter(|key| std::env::var(key.as_str()).is_err())
        .cloned()
        .collect::<Vec<_>>();
    sort_and_dedup_strings(&mut missing_env);

    let mut missing_config = skill
        .requirements
        .config
        .iter()
        .filter(|path| path.trim().is_empty())
        .cloned()
        .collect::<Vec<_>>();
    sort_and_dedup_strings(&mut missing_config);

    let config_checks = skill
        .requirements
        .config
        .iter()
        .map(|path| SkillsStatusConfigCheck {
            path: path.clone(),
            satisfied: !path.trim().is_empty(),
        })
        .collect::<Vec<_>>();

    SkillStatusEntryView {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        file_path: skill.file_path,
        base_dir: skill.base_dir,
        skill_key: skill.skill_key,
        bundled: skill.bundled.then_some(true),
        primary_env: skill.primary_env,
        emoji: skill.emoji,
        homepage: skill.homepage,
        always: false,
        disabled: matches!(cfg.enabled, Some(false)),
        blocked_by_allowlist: false,
        eligible: true,
        requirements: SkillStatusRequirements {
            bins: skill.requirements.bins.clone(),
            env: skill.requirements.env.clone(),
            config: skill.requirements.config.clone(),
            os: skill.requirements.os.clone(),
        },
        missing: SkillStatusRequirements {
            bins: Vec::new(),
            env: missing_env,
            config: missing_config,
            os: Vec::new(),
        },
        config_checks,
        install: skill.install,
    }
}

fn default_codex_skills_dir() -> PathBuf {
    if let Some(value) = std::env::var_os("CODEX_HOME") {
        return PathBuf::from(value).join("skills");
    }
    if cfg!(windows) {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            return PathBuf::from(home).join(".codex").join("skills");
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".codex").join("skills");
    }
    PathBuf::from(".codex").join("skills")
}

fn skill_key_from_name(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in name.trim().chars() {
        let lower = ch.to_ascii_lowercase();
        let keep = lower.is_ascii_alphanumeric() || lower == '_' || lower == '-';
        if keep {
            out.push(lower);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_owned();
    if trimmed.is_empty() {
        "skill".to_owned()
    } else {
        trimmed
    }
}

fn normalize_secret_input(value: &str) -> String {
    value
        .chars()
        .filter(|ch| *ch != '\r' && *ch != '\n')
        .collect::<String>()
        .trim()
        .to_owned()
}

fn sort_and_dedup_strings(values: &mut Vec<String>) {
    values.sort();
    values.dedup();
}

struct ConfigRegistry {
    state: Mutex<ConfigState>,
}

#[derive(Debug, Clone)]
struct ConfigState {
    path: String,
    config: Value,
    hash: String,
    updated_at_ms: u64,
}

#[derive(Debug, Clone)]
struct ConfigSnapshot {
    path: String,
    raw: String,
    config: Value,
    hash: String,
    updated_at_ms: u64,
}

#[derive(Debug, Clone)]
struct ConfigUpdateResult {
    path: String,
    config: Value,
    hash: String,
}

impl ConfigRegistry {
    fn new() -> Self {
        let config = json!({
            "session": { "mainKey": "main" },
            "talk": {
                "outputFormat": "pcm16",
                "interruptOnSpeech": true
            },
            "ui": { "seamColor": "#4b5563" }
        });
        let hash = hash_json_value(&config);
        Self {
            state: Mutex::new(ConfigState {
                path: "memory://config.json".to_owned(),
                config,
                hash,
                updated_at_ms: now_ms(),
            }),
        }
    }

    fn schema(&self) -> Value {
        json!({
            "schema": {
                "type": "object"
            },
            "uiHints": {},
            "version": "rust-parity-1",
            "generatedAt": now_ms().to_string()
        })
    }

    async fn get_snapshot(&self) -> ConfigSnapshot {
        let guard = self.state.lock().await;
        ConfigSnapshot {
            path: guard.path.clone(),
            raw: serde_json::to_string_pretty(&guard.config).unwrap_or_else(|_| "{}".to_owned()),
            config: guard.config.clone(),
            hash: guard.hash.clone(),
            updated_at_ms: guard.updated_at_ms,
        }
    }

    async fn set(
        &self,
        raw: String,
        base_hash: Option<String>,
    ) -> Result<ConfigUpdateResult, String> {
        let parsed = parse_config_raw(raw, "config.set")?;
        let mut guard = self.state.lock().await;
        require_base_hash(base_hash, &guard)?;
        guard.config = parsed;
        guard.hash = hash_json_value(&guard.config);
        guard.updated_at_ms = now_ms();
        Ok(ConfigUpdateResult {
            path: guard.path.clone(),
            config: guard.config.clone(),
            hash: guard.hash.clone(),
        })
    }

    async fn patch(
        &self,
        raw: String,
        base_hash: Option<String>,
    ) -> Result<ConfigUpdateResult, String> {
        let patch = parse_config_patch_raw(raw)?;
        let mut guard = self.state.lock().await;
        require_base_hash(base_hash, &guard)?;
        guard.config = apply_merge_patch(guard.config.clone(), patch);
        guard.hash = hash_json_value(&guard.config);
        guard.updated_at_ms = now_ms();
        Ok(ConfigUpdateResult {
            path: guard.path.clone(),
            config: guard.config.clone(),
            hash: guard.hash.clone(),
        })
    }
}

fn parse_config_raw(raw: String, method: &str) -> Result<Value, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("invalid {method} params: raw (string) required"));
    }
    let parsed: Value =
        serde_json::from_str(trimmed).map_err(|err| format!("invalid config: {err}"))?;
    if !parsed.is_object() {
        return Err("invalid config: root must be object".to_owned());
    }
    Ok(parsed)
}

fn parse_config_patch_raw(raw: String) -> Result<Value, String> {
    let patch = parse_config_raw(raw, "config.patch")?;
    if !patch.is_object() {
        return Err("config.patch raw must be an object".to_owned());
    }
    Ok(patch)
}

fn require_base_hash(base_hash: Option<String>, state: &ConfigState) -> Result<(), String> {
    let Some(base_hash) = normalize_optional_text(base_hash, 128) else {
        return Err("config base hash required; re-run config.get and retry".to_owned());
    };
    if !base_hash.eq_ignore_ascii_case(&state.hash) {
        return Err("config changed since last load; re-run config.get and retry".to_owned());
    }
    Ok(())
}

fn hash_json_value(value: &Value) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    let payload = serde_json::to_vec(value).unwrap_or_default();
    hasher.update(payload);
    format!("{:x}", hasher.finalize())
}

fn apply_merge_patch(target: Value, patch: Value) -> Value {
    let Some(patch_obj) = patch.as_object() else {
        return patch;
    };
    let mut target_obj = target.as_object().cloned().unwrap_or_default();
    for (key, patch_value) in patch_obj {
        if patch_value.is_null() {
            target_obj.remove(key);
            continue;
        }
        let existing = target_obj.get(key).cloned().unwrap_or(Value::Null);
        target_obj.insert(
            key.clone(),
            apply_merge_patch(existing, patch_value.clone()),
        );
    }
    Value::Object(target_obj)
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
    label: Option<String>,
    spawned_by: Option<String>,
    include_derived_titles: bool,
    include_last_message: bool,
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
            .map(|value| canonicalize_session_key(&value))
            .filter(|value| !value.is_empty())
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
        let SessionSend {
            session_key,
            request_id,
            message,
            command,
            source,
            channel,
            to,
            account_id,
        } = send;
        let now = now_ms();
        let mut guard = self.entries.lock().await;
        let entry = guard
            .entry(session_key.clone())
            .or_insert_with(|| SessionEntry::new(&session_key));
        entry.updated_at_ms = now;
        if channel.is_some() {
            entry.channel = channel.clone();
        }
        if to.is_some() {
            entry.last_to = to.clone();
        }
        if account_id.is_some() {
            entry.last_account_id = account_id.clone();
        }

        let event = SessionHistoryEvent {
            at_ms: now,
            kind: SessionHistoryKind::Send,
            request_id,
            text: message,
            command,
            action: None,
            risk_score: None,
            source: Some(source),
            channel: channel.or_else(|| entry.channel.clone()),
        };
        entry.push_history(event.clone());

        let record = SessionHistoryRecord::from_event(&entry.key, event);
        (entry.to_view(false, false), record)
    }

    async fn patch(&self, patch: SessionPatch) -> Result<SessionView, String> {
        let now = now_ms();
        let mut guard = self.entries.lock().await;
        if let PatchValue::Set(label) = &patch.label {
            let duplicate = guard.iter().any(|(key, existing)| {
                key != &patch.session_key
                    && existing
                        .label
                        .as_deref()
                        .map(|v| v.eq_ignore_ascii_case(label))
                        .unwrap_or(false)
            });
            if duplicate {
                return Err(format!("label already in use: {label}"));
            }
        }
        let entry = guard
            .entry(patch.session_key.clone())
            .or_insert_with(|| SessionEntry::new(&patch.session_key));
        entry.updated_at_ms = now;
        if let PatchValue::Clear = &patch.spawned_by {
            if entry.spawned_by.is_some() {
                return Err("spawnedBy cannot be cleared once set".to_owned());
            }
        }
        if let PatchValue::Set(spawned_by) = &patch.spawned_by {
            if !is_subagent_session_key(&patch.session_key) {
                return Err("spawnedBy is only supported for subagent sessions".to_owned());
            }
            if let Some(existing) = entry.spawned_by.as_deref() {
                if !existing.eq_ignore_ascii_case(spawned_by) {
                    return Err("spawnedBy cannot be changed once set".to_owned());
                }
            }
        }
        if let PatchValue::Clear = &patch.spawn_depth {
            if entry.spawn_depth.is_some() {
                return Err("spawnDepth cannot be cleared once set".to_owned());
            }
        }
        if let PatchValue::Set(spawn_depth) = &patch.spawn_depth {
            if !is_subagent_session_key(&patch.session_key) {
                return Err("spawnDepth is only supported for subagent sessions".to_owned());
            }
            if let Some(existing) = entry.spawn_depth {
                if existing != *spawn_depth {
                    return Err("spawnDepth cannot be changed once set".to_owned());
                }
            }
        }
        apply_patch_value(&mut entry.send_policy, patch.send_policy);
        apply_patch_value(&mut entry.group_activation, patch.group_activation);
        apply_patch_value(&mut entry.queue_mode, patch.queue_mode);
        apply_patch_value(&mut entry.label, patch.label);
        apply_patch_value(&mut entry.spawned_by, patch.spawned_by);
        apply_patch_value(&mut entry.spawn_depth, patch.spawn_depth);
        apply_patch_value(&mut entry.thinking_level, patch.thinking_level);
        apply_patch_value(&mut entry.verbose_level, patch.verbose_level);
        apply_patch_value(&mut entry.reasoning_level, patch.reasoning_level);
        apply_patch_value(&mut entry.response_usage, patch.response_usage);
        apply_patch_value(&mut entry.elevated_level, patch.elevated_level);
        apply_patch_value(&mut entry.exec_host, patch.exec_host);
        apply_patch_value(&mut entry.exec_security, patch.exec_security);
        apply_patch_value(&mut entry.exec_ask, patch.exec_ask);
        apply_patch_value(&mut entry.exec_node, patch.exec_node);
        match patch.model_override {
            PatchValue::Keep => {}
            PatchValue::Clear => {
                entry.model_override = None;
                entry.provider_override = None;
            }
            PatchValue::Set(model) => {
                entry.model_override = Some(model.model_override);
                entry.provider_override = model.provider_override;
            }
        }
        Ok(entry.to_view(false, false))
    }

    async fn get(&self, session_key: &str) -> Option<SessionView> {
        let guard = self.entries.lock().await;
        guard
            .get(session_key)
            .map(|entry| entry.to_view(false, false))
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

    async fn resolve_session_id(&self, session_id: &str) -> Option<String> {
        let guard = self.entries.lock().await;
        guard
            .values()
            .find(|entry| entry.session_id.eq_ignore_ascii_case(session_id))
            .map(|entry| entry.key.clone())
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
        if let Some(label) = query.label {
            items.retain(|entry| {
                entry
                    .label
                    .as_deref()
                    .map(|v| v.eq_ignore_ascii_case(&label))
                    .unwrap_or(false)
            });
        }
        if let Some(spawned_by) = query.spawned_by {
            items.retain(|entry| {
                entry
                    .spawned_by
                    .as_deref()
                    .map(|v| v.eq_ignore_ascii_case(&spawned_by))
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
            .map(|entry| entry.to_view(query.include_derived_titles, query.include_last_message))
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
        entry.session_id = next_session_id();
        entry.history.clear();
        SessionReset {
            session: entry.to_view(false, false),
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
        let max_lines = max_lines.clamp(1, 100_000);
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
        window: Option<(i64, i64)>,
        include_context_weight: bool,
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
            .filter_map(|entry| {
                let (
                    total_requests,
                    allowed_count,
                    review_count,
                    blocked_count,
                    last_action,
                    last_risk_score,
                    updated_at_ms,
                ) = if let Some((start_day, end_day)) = window {
                    let mut total_requests = 0_u64;
                    let mut allowed_count = 0_u64;
                    let mut review_count = 0_u64;
                    let mut blocked_count = 0_u64;
                    let mut last_action = None;
                    let mut last_risk_score = 0_u8;
                    let mut updated_at_ms = entry.updated_at_ms;
                    for event in &entry.history {
                        let day = (event.at_ms / 86_400_000) as i64;
                        if day < start_day || day > end_day {
                            continue;
                        }
                        if event.kind != SessionHistoryKind::Decision {
                            continue;
                        }
                        total_requests += 1;
                        match event.action {
                            Some(DecisionAction::Allow) => allowed_count += 1,
                            Some(DecisionAction::Review) => review_count += 1,
                            Some(DecisionAction::Block) => blocked_count += 1,
                            None => {}
                        }
                        last_action = event.action;
                        last_risk_score = event.risk_score.unwrap_or(0);
                        updated_at_ms = event.at_ms;
                    }
                    if total_requests == 0 && session_key.is_none() {
                        return None;
                    }
                    (
                        total_requests,
                        allowed_count,
                        review_count,
                        blocked_count,
                        last_action,
                        last_risk_score,
                        updated_at_ms,
                    )
                } else {
                    (
                        entry.total_requests,
                        entry.allowed_count,
                        entry.review_count,
                        entry.blocked_count,
                        entry.last_action,
                        entry.last_risk_score,
                        entry.updated_at_ms,
                    )
                };

                Some(SessionUsageView {
                    key: entry.key,
                    kind: entry.kind,
                    agent_id: entry.agent_id,
                    channel: entry.channel,
                    label: entry.label,
                    spawned_by: entry.spawned_by,
                    total_requests,
                    allowed_count,
                    review_count,
                    blocked_count,
                    last_action,
                    last_risk_score,
                    updated_at_ms,
                    context_weight: include_context_weight.then_some(Value::Null),
                })
            })
            .take(lim)
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
    session_id: String,
    kind: SessionKind,
    agent_id: Option<String>,
    channel: Option<String>,
    last_to: Option<String>,
    last_account_id: Option<String>,
    label: Option<String>,
    spawned_by: Option<String>,
    spawn_depth: Option<u32>,
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
    thinking_level: Option<String>,
    verbose_level: Option<String>,
    reasoning_level: Option<String>,
    response_usage: Option<ResponseUsageMode>,
    elevated_level: Option<String>,
    exec_host: Option<String>,
    exec_security: Option<String>,
    exec_ask: Option<String>,
    exec_node: Option<String>,
    model_override: Option<String>,
    provider_override: Option<String>,
    history: VecDeque<SessionHistoryEvent>,
}

impl SessionEntry {
    fn new(session_key: &str) -> Self {
        let parsed = parse_session_key(session_key);
        Self {
            key: session_key.to_owned(),
            session_id: next_session_id(),
            kind: parsed.kind,
            agent_id: parsed.agent_id,
            channel: parsed.channel,
            last_to: None,
            last_account_id: None,
            label: None,
            spawned_by: None,
            spawn_depth: None,
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
            thinking_level: None,
            verbose_level: None,
            reasoning_level: None,
            response_usage: None,
            elevated_level: None,
            exec_host: None,
            exec_security: None,
            exec_ask: None,
            exec_node: None,
            model_override: None,
            provider_override: None,
            history: VecDeque::new(),
        }
    }

    fn to_view(&self, include_derived_title: bool, include_last_message: bool) -> SessionView {
        let derived_title = if include_derived_title {
            self.derived_title()
        } else {
            None
        };
        let display_name = self
            .label
            .clone()
            .or_else(|| derived_title.clone())
            .map(|v| truncate_text(&v, 120));
        let last_message_preview = if include_last_message {
            self.last_message_preview()
        } else {
            None
        };
        SessionView {
            key: self.key.clone(),
            session_id: self.session_id.clone(),
            kind: self.kind,
            agent_id: self.agent_id.clone(),
            display_name,
            derived_title,
            last_message_preview,
            channel: self.channel.clone(),
            last_account_id: self.last_account_id.clone(),
            delivery_context: SessionDeliveryContext::from_parts(
                self.channel.clone(),
                self.last_to.clone(),
                self.last_account_id.clone(),
            ),
            total_tokens: None,
            total_tokens_fresh: false,
            label: self.label.clone(),
            spawned_by: self.spawned_by.clone(),
            spawn_depth: self.spawn_depth,
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
            thinking_level: self.thinking_level.clone(),
            verbose_level: self.verbose_level.clone(),
            reasoning_level: self.reasoning_level.clone(),
            response_usage: self.response_usage,
            elevated_level: self.elevated_level.clone(),
            exec_host: self.exec_host.clone(),
            exec_security: self.exec_security.clone(),
            exec_ask: self.exec_ask.clone(),
            exec_node: self.exec_node.clone(),
            model_override: self.model_override.clone(),
            provider_override: self.provider_override.clone(),
        }
    }

    fn derived_title(&self) -> Option<String> {
        let from_send = self.history.iter().find_map(|event| {
            (event.kind == SessionHistoryKind::Send)
                .then(|| event_preview_text(event, 120))
                .flatten()
        });
        from_send.or_else(|| {
            self.history
                .iter()
                .find_map(|event| event_preview_text(event, 120))
        })
    }

    fn last_message_preview(&self) -> Option<String> {
        self.history
            .iter()
            .rev()
            .find_map(|event| event_preview_text(event, 160))
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
    send_policy: PatchValue<SendPolicyOverride>,
    group_activation: PatchValue<GroupActivationMode>,
    queue_mode: PatchValue<SessionQueueMode>,
    label: PatchValue<String>,
    spawned_by: PatchValue<String>,
    spawn_depth: PatchValue<u32>,
    thinking_level: PatchValue<String>,
    verbose_level: PatchValue<String>,
    reasoning_level: PatchValue<String>,
    response_usage: PatchValue<ResponseUsageMode>,
    elevated_level: PatchValue<String>,
    exec_host: PatchValue<String>,
    exec_security: PatchValue<String>,
    exec_ask: PatchValue<String>,
    exec_node: PatchValue<String>,
    model_override: PatchValue<ModelOverridePatch>,
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
    to: Option<String>,
    account_id: Option<String>,
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
    #[serde(rename = "contextWeight", skip_serializing_if = "Option::is_none")]
    context_weight: Option<Value>,
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResponseUsageMode {
    Off,
    Tokens,
    Full,
}

#[derive(Debug, Clone)]
enum PatchValue<T> {
    Keep,
    Clear,
    Set(T),
}

#[derive(Debug, Clone)]
struct ModelOverridePatch {
    provider_override: Option<String>,
    model_override: String,
}

#[derive(Debug, Clone, serde::Serialize)]
struct SessionDeliveryContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    to: Option<String>,
    #[serde(rename = "accountId", skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
}

impl SessionDeliveryContext {
    fn from_parts(
        channel: Option<String>,
        to: Option<String>,
        account_id: Option<String>,
    ) -> Option<Self> {
        if channel.is_none() && to.is_none() && account_id.is_none() {
            return None;
        }
        Some(Self {
            channel,
            to,
            account_id,
        })
    }
}

#[derive(Debug, Clone, serde::Serialize)]
struct SessionView {
    key: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    kind: SessionKind,
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(rename = "derivedTitle", skip_serializing_if = "Option::is_none")]
    derived_title: Option<String>,
    #[serde(rename = "lastMessagePreview", skip_serializing_if = "Option::is_none")]
    last_message_preview: Option<String>,
    channel: Option<String>,
    #[serde(rename = "lastAccountId", skip_serializing_if = "Option::is_none")]
    last_account_id: Option<String>,
    #[serde(rename = "deliveryContext", skip_serializing_if = "Option::is_none")]
    delivery_context: Option<SessionDeliveryContext>,
    #[serde(rename = "totalTokens", skip_serializing_if = "Option::is_none")]
    total_tokens: Option<u64>,
    #[serde(rename = "totalTokensFresh")]
    total_tokens_fresh: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(rename = "spawnedBy", skip_serializing_if = "Option::is_none")]
    spawned_by: Option<String>,
    #[serde(rename = "spawnDepth", skip_serializing_if = "Option::is_none")]
    spawn_depth: Option<u32>,
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
    #[serde(rename = "thinkingLevel", skip_serializing_if = "Option::is_none")]
    thinking_level: Option<String>,
    #[serde(rename = "verboseLevel", skip_serializing_if = "Option::is_none")]
    verbose_level: Option<String>,
    #[serde(rename = "reasoningLevel", skip_serializing_if = "Option::is_none")]
    reasoning_level: Option<String>,
    #[serde(rename = "responseUsage", skip_serializing_if = "Option::is_none")]
    response_usage: Option<ResponseUsageMode>,
    #[serde(rename = "elevatedLevel", skip_serializing_if = "Option::is_none")]
    elevated_level: Option<String>,
    #[serde(rename = "execHost", skip_serializing_if = "Option::is_none")]
    exec_host: Option<String>,
    #[serde(rename = "execSecurity", skip_serializing_if = "Option::is_none")]
    exec_security: Option<String>,
    #[serde(rename = "execAsk", skip_serializing_if = "Option::is_none")]
    exec_ask: Option<String>,
    #[serde(rename = "execNode", skip_serializing_if = "Option::is_none")]
    exec_node: Option<String>,
    #[serde(rename = "modelOverride", skip_serializing_if = "Option::is_none")]
    model_override: Option<String>,
    #[serde(rename = "providerOverride", skip_serializing_if = "Option::is_none")]
    provider_override: Option<String>,
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
    #[serde(rename = "includeDerivedTitles", alias = "include_derived_titles")]
    include_derived_titles: Option<bool>,
    #[serde(rename = "includeLastMessage", alias = "include_last_message")]
    include_last_message: Option<bool>,
    label: Option<String>,
    #[serde(rename = "spawnedBy", alias = "spawned_by")]
    spawned_by: Option<String>,
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
struct SetHeartbeatsParams {
    enabled: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SystemEventParams {
    text: Option<String>,
    #[serde(rename = "deviceId", alias = "device_id")]
    device_id: Option<String>,
    #[serde(rename = "instanceId", alias = "instance_id")]
    instance_id: Option<String>,
    host: Option<String>,
    ip: Option<String>,
    mode: Option<String>,
    version: Option<String>,
    platform: Option<String>,
    #[serde(rename = "deviceFamily", alias = "device_family")]
    device_family: Option<String>,
    #[serde(rename = "modelIdentifier", alias = "model_identifier")]
    model_identifier: Option<String>,
    #[serde(rename = "lastInputSeconds", alias = "last_input_seconds")]
    last_input_seconds: Option<f64>,
    reason: Option<String>,
    roles: Option<Vec<String>>,
    scopes: Option<Vec<String>>,
    tags: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct WakeParams {
    mode: Option<String>,
    text: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct TalkConfigParams {
    #[serde(rename = "includeSecrets", alias = "include_secrets")]
    include_secrets: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct TalkModeParams {
    enabled: Option<bool>,
    phase: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ModelsListParams {}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct AgentsListParams {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentsCreateParams {
    name: String,
    workspace: String,
    emoji: Option<String>,
    avatar: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentsUpdateParams {
    #[serde(rename = "agentId", alias = "agent_id")]
    agent_id: String,
    name: Option<String>,
    workspace: Option<String>,
    model: Option<String>,
    avatar: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentsDeleteParams {
    #[serde(rename = "agentId", alias = "agent_id")]
    agent_id: String,
    #[serde(rename = "deleteFiles", alias = "delete_files")]
    delete_files: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentsFilesListParams {
    #[serde(rename = "agentId", alias = "agent_id")]
    agent_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentsFilesGetParams {
    #[serde(rename = "agentId", alias = "agent_id")]
    agent_id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentsFilesSetParams {
    #[serde(rename = "agentId", alias = "agent_id")]
    agent_id: String,
    name: String,
    content: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct SkillsStatusParams {
    #[serde(rename = "agentId", alias = "agent_id")]
    agent_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct SkillsBinsParams {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillsInstallParams {
    name: String,
    #[serde(rename = "installId", alias = "install_id")]
    install_id: String,
    #[serde(rename = "timeoutMs", alias = "timeout_ms")]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillsUpdateParams {
    #[serde(rename = "skillKey", alias = "skill_key")]
    skill_key: String,
    enabled: Option<bool>,
    #[serde(rename = "apiKey", alias = "api_key")]
    api_key: Option<String>,
    env: Option<HashMap<String, String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct CronListParams {
    #[serde(rename = "includeDisabled", alias = "include_disabled")]
    include_disabled: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct CronStatusParams {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CronAddParams {
    name: String,
    #[serde(rename = "agentId", alias = "agent_id")]
    agent_id: Option<Option<String>>,
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<Option<String>>,
    description: Option<String>,
    enabled: Option<bool>,
    #[serde(rename = "deleteAfterRun", alias = "delete_after_run")]
    delete_after_run: Option<bool>,
    schedule: CronSchedule,
    #[serde(rename = "sessionTarget", alias = "session_target")]
    session_target: Option<String>,
    #[serde(rename = "wakeMode", alias = "wake_mode")]
    wake_mode: Option<String>,
    payload: CronPayload,
    delivery: Option<CronDelivery>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CronUpdateParams {
    id: Option<String>,
    #[serde(rename = "jobId", alias = "job_id")]
    job_id: Option<String>,
    patch: CronUpdatePatchInput,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CronUpdatePatchInput {
    name: Option<String>,
    #[serde(rename = "agentId", alias = "agent_id")]
    agent_id: Option<Option<String>>,
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<Option<String>>,
    description: Option<Option<String>>,
    enabled: Option<bool>,
    #[serde(rename = "deleteAfterRun", alias = "delete_after_run")]
    delete_after_run: Option<bool>,
    schedule: Option<CronSchedule>,
    #[serde(rename = "sessionTarget", alias = "session_target")]
    session_target: Option<String>,
    #[serde(rename = "wakeMode", alias = "wake_mode")]
    wake_mode: Option<String>,
    payload: Option<CronPayloadPatchInput>,
    delivery: Option<CronDeliveryPatchInput>,
    state: Option<CronJobStatePatchInput>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CronPayloadPatchInput {
    kind: Option<String>,
    text: Option<String>,
    message: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    #[serde(rename = "timeoutSeconds", alias = "timeout_seconds")]
    timeout_seconds: Option<u64>,
    #[serde(
        rename = "allowUnsafeExternalContent",
        alias = "allow_unsafe_external_content"
    )]
    allow_unsafe_external_content: Option<bool>,
    deliver: Option<bool>,
    channel: Option<String>,
    to: Option<String>,
    #[serde(rename = "bestEffortDeliver", alias = "best_effort_deliver")]
    best_effort_deliver: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CronDeliveryPatchInput {
    mode: Option<Option<String>>,
    channel: Option<Option<String>>,
    to: Option<Option<String>>,
    #[serde(rename = "bestEffort", alias = "best_effort")]
    best_effort: Option<Option<bool>>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CronJobStatePatchInput {
    #[serde(rename = "nextRunAtMs", alias = "next_run_at_ms")]
    next_run_at_ms: Option<Option<u64>>,
    #[serde(rename = "runningAtMs", alias = "running_at_ms")]
    running_at_ms: Option<Option<u64>>,
    #[serde(rename = "lastRunAtMs", alias = "last_run_at_ms")]
    last_run_at_ms: Option<Option<u64>>,
    #[serde(rename = "lastStatus", alias = "last_status")]
    last_status: Option<Option<CronRunStatus>>,
    #[serde(rename = "lastError", alias = "last_error")]
    last_error: Option<Option<String>>,
    #[serde(rename = "lastDurationMs", alias = "last_duration_ms")]
    last_duration_ms: Option<Option<u64>>,
    #[serde(rename = "consecutiveErrors", alias = "consecutive_errors")]
    consecutive_errors: Option<Option<u64>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct CronRemoveParams {
    id: Option<String>,
    #[serde(rename = "jobId", alias = "job_id")]
    job_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct CronRunParams {
    id: Option<String>,
    #[serde(rename = "jobId", alias = "job_id")]
    job_id: Option<String>,
    mode: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct CronRunsParams {
    id: Option<String>,
    #[serde(rename = "jobId", alias = "job_id")]
    job_id: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ChannelsStatusParams {
    probe: Option<bool>,
    #[serde(rename = "timeoutMs", alias = "timeout_ms")]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ChannelsLogoutParams {
    channel: Option<String>,
    #[serde(rename = "accountId", alias = "account_id")]
    account_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ConfigWriteParams {
    raw: Option<String>,
    #[serde(rename = "baseHash", alias = "base_hash")]
    base_hash: Option<String>,
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
    note: Option<String>,
    #[serde(rename = "restartDelayMs", alias = "restart_delay_ms")]
    restart_delay_ms: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct LogsTailParams {
    cursor: Option<u64>,
    limit: Option<usize>,
    #[serde(rename = "maxBytes", alias = "max_bytes")]
    max_bytes: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SessionsPreviewParams {
    keys: Option<Vec<String>>,
    limit: Option<usize>,
    #[serde(rename = "maxChars", alias = "max_chars")]
    max_chars: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SessionsPatchParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
    key: Option<String>,
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
    #[serde(rename = "deleteTranscript", alias = "delete_transcript")]
    delete_transcript: Option<bool>,
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
    #[serde(rename = "startDate", alias = "start_date")]
    start_date: Option<String>,
    #[serde(rename = "endDate", alias = "end_date")]
    end_date: Option<String>,
    #[serde(rename = "includeContextWeight", alias = "include_context_weight")]
    include_context_weight: Option<bool>,
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
    key: Option<String>,
    #[serde(rename = "sessionId", alias = "session_id")]
    session_id: Option<String>,
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
    to: Option<String>,
    #[serde(rename = "accountId", alias = "account_id")]
    account_id: Option<String>,
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

fn param_patch_value(params: &Value, keys: &[&str]) -> Option<Option<Value>> {
    let map = params.as_object()?;
    for key in keys {
        if let Some(value) = map.get(*key) {
            if value.is_null() {
                return Some(None);
            }
            return Some(Some(value.clone()));
        }
    }
    None
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

fn parse_reset_reason(value: Option<String>) -> Result<String, String> {
    let normalized = normalize_optional_text(value, 16).unwrap_or_else(|| "reset".to_owned());
    match normalize(&normalized).as_str() {
        "new" => Ok("new".to_owned()),
        "reset" => Ok("reset".to_owned()),
        _ => Err("reason must be new|reset".to_owned()),
    }
}

fn parse_wake_mode(value: Option<String>) -> Result<&'static str, String> {
    let Some(mode) = normalize_optional_text(value, 32) else {
        return Err("invalid wake params: mode required".to_owned());
    };
    match normalize(&mode).as_str() {
        "now" => Ok("now"),
        "next-heartbeat" => Ok("next-heartbeat"),
        _ => Err("invalid wake params: mode must be now|next-heartbeat".to_owned()),
    }
}

fn resolve_cron_job_id(
    id: Option<String>,
    job_id: Option<String>,
    method_name: &str,
) -> Result<String, String> {
    normalize_optional_text(id.or(job_id), 128)
        .ok_or_else(|| format!("invalid {method_name} params: missing id"))
}

fn parse_cron_run_mode(value: Option<String>) -> Result<CronRunMode, String> {
    let Some(mode) = normalize_optional_text(value, 32) else {
        return Ok(CronRunMode::Force);
    };
    match normalize(&mode).as_str() {
        "force" => Ok(CronRunMode::Force),
        "due" => Ok(CronRunMode::Due),
        _ => Err("invalid cron.run params: mode must be force|due".to_owned()),
    }
}

fn parse_cron_session_target(value: Option<String>) -> Result<String, CronRegistryError> {
    let normalized = normalize_optional_text(value, 32).unwrap_or_else(|| "main".to_owned());
    match normalize(&normalized).as_str() {
        "main" => Ok("main".to_owned()),
        "isolated" => Ok("isolated".to_owned()),
        _ => Err(CronRegistryError::Invalid(
            "sessionTarget must be main|isolated".to_owned(),
        )),
    }
}

fn parse_cron_wake_mode(value: Option<String>) -> Result<String, CronRegistryError> {
    let normalized =
        normalize_optional_text(value, 32).unwrap_or_else(|| "next-heartbeat".to_owned());
    match normalize(&normalized).as_str() {
        "now" => Ok("now".to_owned()),
        "next-heartbeat" => Ok("next-heartbeat".to_owned()),
        _ => Err(CronRegistryError::Invalid(
            "wakeMode must be now|next-heartbeat".to_owned(),
        )),
    }
}

fn normalize_cron_schedule(schedule: CronSchedule) -> Result<CronSchedule, CronRegistryError> {
    match schedule {
        CronSchedule::At { at } => {
            let at = normalize_optional_text(Some(at), 128).ok_or_else(|| {
                CronRegistryError::Invalid("schedule.at is required for kind=at".to_owned())
            })?;
            Ok(CronSchedule::At { at })
        }
        CronSchedule::Every {
            every_ms,
            anchor_ms,
        } => {
            if every_ms == 0 {
                return Err(CronRegistryError::Invalid(
                    "schedule.everyMs must be greater than 0".to_owned(),
                ));
            }
            Ok(CronSchedule::Every {
                every_ms,
                anchor_ms,
            })
        }
        CronSchedule::Cron { expr, tz } => {
            let expr = normalize_optional_text(Some(expr), 256).ok_or_else(|| {
                CronRegistryError::Invalid("schedule.expr is required for kind=cron".to_owned())
            })?;
            Ok(CronSchedule::Cron {
                expr,
                tz: normalize_optional_text(tz, 64),
            })
        }
    }
}

fn normalize_cron_payload(payload: CronPayload) -> Result<CronPayload, CronRegistryError> {
    match payload {
        CronPayload::SystemEvent { text } => {
            let text = normalize_optional_text(Some(text), 4096).ok_or_else(|| {
                CronRegistryError::Invalid(
                    "payload.kind=systemEvent requires non-empty text".to_owned(),
                )
            })?;
            Ok(CronPayload::SystemEvent { text })
        }
        CronPayload::AgentTurn {
            message,
            model,
            thinking,
            timeout_seconds,
            allow_unsafe_external_content,
            deliver,
            channel,
            to,
            best_effort_deliver,
        } => {
            let message = normalize_optional_text(Some(message), 4096).ok_or_else(|| {
                CronRegistryError::Invalid(
                    "payload.kind=agentTurn requires non-empty message".to_owned(),
                )
            })?;
            if matches!(timeout_seconds, Some(0)) {
                return Err(CronRegistryError::Invalid(
                    "payload.timeoutSeconds must be >= 1".to_owned(),
                ));
            }
            Ok(CronPayload::AgentTurn {
                message,
                model: normalize_optional_text(model, 256),
                thinking: normalize_optional_text(thinking, 64),
                timeout_seconds,
                allow_unsafe_external_content,
                deliver,
                channel: normalize_optional_text(channel, 64),
                to: normalize_optional_text(to, 1024),
                best_effort_deliver,
            })
        }
    }
}

fn normalize_cron_delivery(
    delivery: CronDelivery,
    context: &str,
) -> Result<CronDelivery, CronRegistryError> {
    let mode = normalize_optional_text(Some(delivery.mode), 32)
        .ok_or_else(|| CronRegistryError::Invalid(format!("invalid {context} delivery.mode")))?;
    let mode = match normalize(&mode).as_str() {
        "none" => "none",
        "announce" => "announce",
        "webhook" => "webhook",
        _ => {
            return Err(CronRegistryError::Invalid(format!(
                "invalid {context} delivery.mode: expected none|announce|webhook"
            )))
        }
    };
    let normalized = CronDelivery {
        mode: mode.to_owned(),
        channel: normalize_optional_text(delivery.channel, 64),
        to: normalize_optional_text(delivery.to, 1024),
        best_effort: delivery.best_effort,
    };
    if normalized.mode == "webhook" {
        let to = normalized.to.clone().ok_or_else(|| {
            CronRegistryError::Invalid(format!(
                "invalid {context} delivery.to: required for webhook"
            ))
        })?;
        let parsed = Url::parse(&to).map_err(|_| {
            CronRegistryError::Invalid(format!("invalid {context} delivery.to URL"))
        })?;
        let scheme = parsed.scheme();
        if scheme != "http" && scheme != "https" {
            return Err(CronRegistryError::Invalid(format!(
                "invalid {context} delivery.to URL scheme"
            )));
        }
    }
    Ok(normalized)
}

fn legacy_cron_delivery_from_payload(payload: &CronPayload) -> Option<CronDelivery> {
    let CronPayload::AgentTurn {
        deliver,
        channel,
        to,
        best_effort_deliver,
        ..
    } = payload
    else {
        return None;
    };
    let has_legacy_fields = deliver.is_some()
        || channel.as_ref().is_some()
        || to.as_ref().is_some()
        || best_effort_deliver.is_some();
    if !has_legacy_fields {
        return None;
    }
    let mode = if matches!(deliver, Some(false)) {
        "none"
    } else {
        "announce"
    };
    Some(CronDelivery {
        mode: mode.to_owned(),
        channel: normalize_optional_text(channel.clone(), 64),
        to: normalize_optional_text(to.clone(), 1024),
        best_effort: *best_effort_deliver,
    })
}

fn apply_cron_payload_patch(
    current: &CronPayload,
    patch: CronPayloadPatchInput,
) -> Result<(CronPayload, Option<CronDelivery>), CronRegistryError> {
    let explicit_kind = match patch.kind.as_deref().map(normalize) {
        None => None,
        Some(kind) if kind == "systemevent" || kind == "system-event" || kind == "system_event" => {
            Some("systemEvent")
        }
        Some(kind) if kind == "agentturn" || kind == "agent-turn" || kind == "agent_turn" => {
            Some("agentTurn")
        }
        _ => {
            return Err(CronRegistryError::Invalid(
                "invalid cron.update patch.payload.kind".to_owned(),
            ))
        }
    };

    let current_kind = match current {
        CronPayload::SystemEvent { .. } => "systemEvent",
        CronPayload::AgentTurn { .. } => "agentTurn",
    };
    if let Some(kind) = explicit_kind {
        if kind != current_kind {
            return Err(CronRegistryError::Invalid(
                "payload kind cannot be changed in cron.update".to_owned(),
            ));
        }
    }

    match current {
        CronPayload::SystemEvent { text } => {
            if patch.message.is_some()
                || patch.model.is_some()
                || patch.thinking.is_some()
                || patch.timeout_seconds.is_some()
                || patch.allow_unsafe_external_content.is_some()
                || patch.deliver.is_some()
                || patch.channel.is_some()
                || patch.to.is_some()
                || patch.best_effort_deliver.is_some()
            {
                return Err(CronRegistryError::Invalid(
                    "patch.payload for systemEvent cannot include agentTurn fields".to_owned(),
                ));
            }
            let next = normalize_cron_payload(CronPayload::SystemEvent {
                text: patch.text.unwrap_or_else(|| text.clone()),
            })?;
            Ok((next, None))
        }
        CronPayload::AgentTurn {
            message,
            model,
            thinking,
            timeout_seconds,
            allow_unsafe_external_content,
            deliver,
            channel,
            to,
            best_effort_deliver,
        } => {
            if patch.text.is_some() {
                return Err(CronRegistryError::Invalid(
                    "patch.payload for agentTurn cannot include systemEvent text".to_owned(),
                ));
            }
            let next = normalize_cron_payload(CronPayload::AgentTurn {
                message: patch.message.unwrap_or_else(|| message.clone()),
                model: patch.model.or_else(|| model.clone()),
                thinking: patch.thinking.or_else(|| thinking.clone()),
                timeout_seconds: patch.timeout_seconds.or(*timeout_seconds),
                allow_unsafe_external_content: patch
                    .allow_unsafe_external_content
                    .or(*allow_unsafe_external_content),
                deliver: patch.deliver.or(*deliver),
                channel: patch.channel.or_else(|| channel.clone()),
                to: patch.to.or_else(|| to.clone()),
                best_effort_deliver: patch.best_effort_deliver.or(*best_effort_deliver),
            })?;
            let legacy_delivery = legacy_cron_delivery_from_payload(&next);
            Ok((next, legacy_delivery))
        }
    }
}

fn apply_cron_delivery_patch(
    current: Option<CronDelivery>,
    patch: CronDeliveryPatchInput,
) -> Result<Option<CronDelivery>, CronRegistryError> {
    let mut delivery = current.unwrap_or(CronDelivery {
        mode: "none".to_owned(),
        channel: None,
        to: None,
        best_effort: None,
    });
    if let Some(mode) = patch.mode {
        delivery.mode = mode.unwrap_or_else(|| "none".to_owned());
    }
    if let Some(channel) = patch.channel {
        delivery.channel = channel;
    }
    if let Some(to) = patch.to {
        delivery.to = to;
    }
    if let Some(best_effort) = patch.best_effort {
        delivery.best_effort = best_effort;
    }
    let normalized = normalize_cron_delivery(delivery, "cron.update")?;
    Ok(Some(normalized))
}

fn apply_cron_job_state_patch(
    state: &mut CronJobState,
    patch: CronJobStatePatchInput,
) -> Result<(), CronRegistryError> {
    if let Some(value) = patch.next_run_at_ms {
        state.next_run_at_ms = value;
    }
    if let Some(value) = patch.running_at_ms {
        state.running_at_ms = value;
    }
    if let Some(value) = patch.last_run_at_ms {
        state.last_run_at_ms = value;
    }
    if let Some(value) = patch.last_status {
        state.last_status = value;
    }
    if let Some(value) = patch.last_error {
        state.last_error = value.and_then(|v| normalize_optional_text(Some(v), 256));
    }
    if let Some(value) = patch.last_duration_ms {
        state.last_duration_ms = value;
    }
    if let Some(value) = patch.consecutive_errors {
        state.consecutive_errors = value;
    }
    if matches!(
        (&state.last_status, &state.last_error),
        (Some(CronRunStatus::Error), None)
    ) {
        return Err(CronRegistryError::Invalid(
            "state.lastError is required when state.lastStatus=error".to_owned(),
        ));
    }
    Ok(())
}

fn estimate_next_run_at_ms(schedule: &CronSchedule, now: u64) -> Option<u64> {
    match schedule {
        CronSchedule::At { .. } => Some(now),
        CronSchedule::Every {
            every_ms,
            anchor_ms,
        } => {
            let every_ms = *every_ms;
            let anchor = anchor_ms.unwrap_or(now);
            if anchor >= now {
                return Some(anchor);
            }
            let elapsed = now.saturating_sub(anchor);
            let periods = elapsed / every_ms + 1;
            Some(anchor.saturating_add(periods.saturating_mul(every_ms)))
        }
        CronSchedule::Cron { .. } => None,
    }
}

fn next_cron_job_id() -> String {
    let sequence = CRON_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("cron-{sequence:08x}-{}", now_ms())
}

fn channel_label(id: &str) -> String {
    match normalize(id).as_str() {
        "whatsapp" => "WhatsApp".to_owned(),
        "telegram" => "Telegram".to_owned(),
        "slack" => "Slack".to_owned(),
        "discord" => "Discord".to_owned(),
        other => {
            let mut chars = other.chars();
            let Some(first) = chars.next() else {
                return String::new();
            };
            let mut out = first.to_uppercase().collect::<String>();
            out.push_str(chars.as_str());
            out
        }
    }
}

fn parse_patch_text(
    value: Option<Option<Value>>,
    field_name: &str,
    max_len: usize,
) -> Result<PatchValue<String>, String> {
    match value {
        None => Ok(PatchValue::Keep),
        Some(None) => Ok(PatchValue::Clear),
        Some(Some(Value::Null)) => Ok(PatchValue::Clear),
        Some(Some(Value::String(raw))) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(format!("{field_name} cannot be empty"));
            }
            if trimmed.chars().count() > max_len {
                return Err(format!("{field_name} too long (max {max_len})"));
            }
            Ok(PatchValue::Set(trimmed.to_owned()))
        }
        Some(_) => Err(format!("{field_name} must be string or null")),
    }
}

fn parse_patch_u32(value: Option<Option<Value>>) -> Result<PatchValue<u32>, String> {
    match value {
        None => Ok(PatchValue::Keep),
        Some(None) => Ok(PatchValue::Clear),
        Some(Some(Value::Null)) => Ok(PatchValue::Clear),
        Some(Some(Value::Number(raw))) => raw
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .map(PatchValue::Set)
            .ok_or_else(|| "spawnDepth must be a non-negative integer or null".to_owned()),
        Some(_) => Err("spawnDepth must be a non-negative integer or null".to_owned()),
    }
}

fn parse_patch_send_policy(
    value: Option<Option<Value>>,
) -> Result<PatchValue<SendPolicyOverride>, String> {
    match value {
        None => Ok(PatchValue::Keep),
        Some(None) => Ok(PatchValue::Clear),
        Some(Some(Value::Null)) => Ok(PatchValue::Clear),
        Some(Some(Value::String(v))) => match normalize(&v).as_str() {
            "allow" => Ok(PatchValue::Set(SendPolicyOverride::Allow)),
            "deny" => Ok(PatchValue::Set(SendPolicyOverride::Deny)),
            _ => Err("sendPolicy must be allow|deny|null".to_owned()),
        },
        Some(_) => Err("sendPolicy must be string or null".to_owned()),
    }
}

fn parse_patch_group_activation(
    value: Option<Option<Value>>,
) -> Result<PatchValue<GroupActivationMode>, String> {
    match value {
        None => Ok(PatchValue::Keep),
        Some(None) => Ok(PatchValue::Clear),
        Some(Some(Value::Null)) => Ok(PatchValue::Clear),
        Some(Some(Value::String(v))) => parse_group_activation_mode(&v)
            .map(PatchValue::Set)
            .ok_or_else(|| "groupActivation must be mention|always|null".to_owned()),
        Some(_) => Err("groupActivation must be string or null".to_owned()),
    }
}

fn parse_patch_queue_mode(
    value: Option<Option<Value>>,
) -> Result<PatchValue<SessionQueueMode>, String> {
    match value {
        None => Ok(PatchValue::Keep),
        Some(None) => Ok(PatchValue::Clear),
        Some(Some(Value::Null)) => Ok(PatchValue::Clear),
        Some(Some(Value::String(v))) => parse_queue_mode(&v)
            .map(PatchValue::Set)
            .ok_or_else(|| "queueMode must be followup|steer|collect|null".to_owned()),
        Some(_) => Err("queueMode must be string or null".to_owned()),
    }
}

fn normalize_thinking_level(value: &str) -> Option<&'static str> {
    let key = normalize(value);
    let collapsed = key.replace([' ', '_', '-'], "");
    if collapsed == "xhigh" || collapsed == "extrahigh" {
        return Some("xhigh");
    }
    match key.as_str() {
        "off" => Some("off"),
        "on" | "enable" | "enabled" => Some("low"),
        "min" | "minimal" | "think" => Some("minimal"),
        "low" | "thinkhard" | "think-hard" | "think_hard" => Some("low"),
        "mid" | "med" | "medium" | "thinkharder" | "think-harder" | "harder" => Some("medium"),
        "high" | "ultra" | "ultrathink" | "thinkhardest" | "highest" | "max" => Some("high"),
        _ => None,
    }
}

fn parse_patch_thinking_level(value: Option<Option<Value>>) -> Result<PatchValue<String>, String> {
    match value {
        None => Ok(PatchValue::Keep),
        Some(None) | Some(Some(Value::Null)) => Ok(PatchValue::Clear),
        Some(Some(Value::String(raw))) => normalize_thinking_level(&raw)
            .map(|v| PatchValue::Set(v.to_owned()))
            .ok_or_else(|| {
                "thinkingLevel must be off|minimal|low|medium|high|xhigh|null".to_owned()
            }),
        Some(_) => Err("thinkingLevel must be string or null".to_owned()),
    }
}

fn normalize_verbose_level(value: &str) -> Option<&'static str> {
    match normalize(value).as_str() {
        "off" | "false" | "no" | "0" => Some("off"),
        "full" | "all" | "everything" => Some("full"),
        "on" | "minimal" | "true" | "yes" | "1" => Some("on"),
        _ => None,
    }
}

fn parse_patch_verbose_level(value: Option<Option<Value>>) -> Result<PatchValue<String>, String> {
    match value {
        None => Ok(PatchValue::Keep),
        Some(None) | Some(Some(Value::Null)) => Ok(PatchValue::Clear),
        Some(Some(Value::String(raw))) => normalize_verbose_level(&raw)
            .map(|v| PatchValue::Set(v.to_owned()))
            .ok_or_else(|| "verboseLevel must be on|off|full|null".to_owned()),
        Some(_) => Err("verboseLevel must be string or null".to_owned()),
    }
}

fn normalize_reasoning_level(value: &str) -> Option<&'static str> {
    match normalize(value).as_str() {
        "off" | "false" | "no" | "0" | "hide" | "hidden" | "disable" | "disabled" => Some("off"),
        "on" | "true" | "yes" | "1" | "show" | "visible" | "enable" | "enabled" => Some("on"),
        "stream" | "streaming" | "draft" | "live" => Some("stream"),
        _ => None,
    }
}

fn parse_patch_reasoning_level(value: Option<Option<Value>>) -> Result<PatchValue<String>, String> {
    match value {
        None => Ok(PatchValue::Keep),
        Some(None) | Some(Some(Value::Null)) => Ok(PatchValue::Clear),
        Some(Some(Value::String(raw))) => normalize_reasoning_level(&raw)
            .map(|v| {
                if v == "off" {
                    PatchValue::Clear
                } else {
                    PatchValue::Set(v.to_owned())
                }
            })
            .ok_or_else(|| "reasoningLevel must be on|off|stream|null".to_owned()),
        Some(_) => Err("reasoningLevel must be string or null".to_owned()),
    }
}

fn parse_response_usage_mode(value: &str) -> Option<ResponseUsageMode> {
    match normalize(value).as_str() {
        "off" => Some(ResponseUsageMode::Off),
        "tokens" | "token" | "tok" | "minimal" | "min" | "on" | "true" | "yes" | "1" | "enable"
        | "enabled" => Some(ResponseUsageMode::Tokens),
        "full" | "session" => Some(ResponseUsageMode::Full),
        _ => None,
    }
}

fn parse_patch_response_usage(
    value: Option<Option<Value>>,
) -> Result<PatchValue<ResponseUsageMode>, String> {
    match value {
        None => Ok(PatchValue::Keep),
        Some(None) => Ok(PatchValue::Clear),
        Some(Some(Value::Null)) => Ok(PatchValue::Clear),
        Some(Some(Value::String(v))) => parse_response_usage_mode(&v)
            .map(|mode| match mode {
                ResponseUsageMode::Off => PatchValue::Clear,
                _ => PatchValue::Set(mode),
            })
            .ok_or_else(|| "responseUsage must be off|tokens|full|on|null".to_owned()),
        Some(_) => Err("responseUsage must be string or null".to_owned()),
    }
}

fn normalize_elevated_level(value: &str) -> Option<&'static str> {
    match normalize(value).as_str() {
        "off" | "false" | "no" | "0" => Some("off"),
        "full" | "auto" | "autoapprove" | "auto-approve" => Some("full"),
        "ask" | "prompt" | "approval" | "approve" => Some("ask"),
        "on" | "true" | "yes" | "1" => Some("on"),
        _ => None,
    }
}

fn parse_patch_elevated_level(value: Option<Option<Value>>) -> Result<PatchValue<String>, String> {
    match value {
        None => Ok(PatchValue::Keep),
        Some(None) | Some(Some(Value::Null)) => Ok(PatchValue::Clear),
        Some(Some(Value::String(raw))) => normalize_elevated_level(&raw)
            .map(|v| PatchValue::Set(v.to_owned()))
            .ok_or_else(|| "elevatedLevel must be on|off|ask|full|null".to_owned()),
        Some(_) => Err("elevatedLevel must be string or null".to_owned()),
    }
}

fn parse_patch_exec_host(value: Option<Option<Value>>) -> Result<PatchValue<String>, String> {
    match value {
        None => Ok(PatchValue::Keep),
        Some(None) | Some(Some(Value::Null)) => Ok(PatchValue::Clear),
        Some(Some(Value::String(raw))) => match normalize(raw.as_str()).as_str() {
            "sandbox" => Ok(PatchValue::Set("sandbox".to_owned())),
            "gateway" => Ok(PatchValue::Set("gateway".to_owned())),
            "node" => Ok(PatchValue::Set("node".to_owned())),
            _ => Err("execHost must be sandbox|gateway|node|null".to_owned()),
        },
        Some(_) => Err("execHost must be string or null".to_owned()),
    }
}

fn parse_patch_exec_security(value: Option<Option<Value>>) -> Result<PatchValue<String>, String> {
    match value {
        None => Ok(PatchValue::Keep),
        Some(None) | Some(Some(Value::Null)) => Ok(PatchValue::Clear),
        Some(Some(Value::String(raw))) => match normalize(raw.as_str()).as_str() {
            "deny" => Ok(PatchValue::Set("deny".to_owned())),
            "allowlist" => Ok(PatchValue::Set("allowlist".to_owned())),
            "full" => Ok(PatchValue::Set("full".to_owned())),
            _ => Err("execSecurity must be deny|allowlist|full|null".to_owned()),
        },
        Some(_) => Err("execSecurity must be string or null".to_owned()),
    }
}

fn parse_patch_exec_ask(value: Option<Option<Value>>) -> Result<PatchValue<String>, String> {
    match value {
        None => Ok(PatchValue::Keep),
        Some(None) | Some(Some(Value::Null)) => Ok(PatchValue::Clear),
        Some(Some(Value::String(raw))) => match normalize(raw.as_str()).as_str() {
            "off" => Ok(PatchValue::Set("off".to_owned())),
            "on-miss" => Ok(PatchValue::Set("on-miss".to_owned())),
            "always" => Ok(PatchValue::Set("always".to_owned())),
            _ => Err("execAsk must be off|on-miss|always|null".to_owned()),
        },
        Some(_) => Err("execAsk must be string or null".to_owned()),
    }
}

fn parse_patch_model(
    value: Option<Option<Value>>,
) -> Result<PatchValue<ModelOverridePatch>, String> {
    match value {
        None => Ok(PatchValue::Keep),
        Some(None) => Ok(PatchValue::Clear),
        Some(Some(Value::Null)) => Ok(PatchValue::Clear),
        Some(Some(Value::String(raw))) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err("model cannot be empty".to_owned());
            }
            if let Some((provider, model)) = trimmed.split_once('/') {
                let provider = provider.trim();
                let model = model.trim();
                if provider.is_empty() || model.is_empty() {
                    return Err("model must be 'provider/model' or 'model'".to_owned());
                }
                return Ok(PatchValue::Set(ModelOverridePatch {
                    provider_override: Some(provider.to_owned()),
                    model_override: model.to_owned(),
                }));
            }
            Ok(PatchValue::Set(ModelOverridePatch {
                provider_override: None,
                model_override: trimmed.to_owned(),
            }))
        }
        Some(_) => Err("model must be string or null".to_owned()),
    }
}

fn is_global_session(entry: &SessionEntry) -> bool {
    entry.key.eq_ignore_ascii_case("global") || entry.kind == SessionKind::Main
}

fn is_subagent_session_key(session_key: &str) -> bool {
    normalize(session_key).contains(":subagent:")
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

fn normalize_optional_seconds(value: Option<f64>) -> Option<u64> {
    let raw = value?;
    if !raw.is_finite() || raw < 0.0 {
        return None;
    }
    Some(raw.floor() as u64)
}

fn normalize_string_list(
    value: Option<Vec<String>>,
    max_items: usize,
    max_len: usize,
) -> Vec<String> {
    let mut out = Vec::new();
    for item in value.unwrap_or_default() {
        let Some(normalized) = normalize_optional_text(Some(item), max_len) else {
            continue;
        };
        if out
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(&normalized))
        {
            continue;
        }
        out.push(normalized);
        if out.len() >= max_items {
            break;
        }
    }
    out
}

fn apply_patch_value<T>(target: &mut Option<T>, patch: PatchValue<T>) {
    match patch {
        PatchValue::Keep => {}
        PatchValue::Clear => *target = None,
        PatchValue::Set(value) => *target = Some(value),
    }
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

fn event_preview_text(event: &SessionHistoryEvent, max_len: usize) -> Option<String> {
    let value = event
        .text
        .as_deref()
        .or(event.command.as_deref())
        .map(str::trim)
        .filter(|v| !v.is_empty())?;
    Some(truncate_text(value, max_len))
}

fn format_utc_date(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

#[derive(Debug, Clone)]
struct UsageWindow {
    start_date: String,
    end_date: String,
    start_day: i64,
    end_day: i64,
    days: u32,
}

fn resolve_usage_window(
    start_date: Option<String>,
    end_date: Option<String>,
    days: Option<u32>,
) -> UsageWindow {
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

    let start_day = parse_date_to_days(&start).unwrap_or(0);
    let end_day = parse_date_to_days(&end).unwrap_or(start_day);
    let day_span = end_day.saturating_sub(start_day) + 1;
    UsageWindow {
        start_date: start,
        end_date: end,
        start_day,
        end_day,
        days: day_span.max(1) as u32,
    }
}

fn normalize_usage_range(
    start_date: Option<String>,
    end_date: Option<String>,
    days: Option<u32>,
) -> Value {
    let window = resolve_usage_window(start_date, end_date, days);
    json!({
        "startDate": window.start_date,
        "endDate": window.end_date,
        "days": window.days
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

fn canonicalize_session_key(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lowered = trimmed.to_ascii_lowercase();
    if lowered == "global" {
        return "global".to_owned();
    }
    if lowered == "main" {
        return "agent:main:main".to_owned();
    }
    if lowered.starts_with("agent:")
        || lowered.starts_with("cron:")
        || lowered.starts_with("hook:")
        || lowered.starts_with("node-")
    {
        return trimmed.to_owned();
    }
    if trimmed.contains(':') {
        return format!("agent:main:{trimmed}");
    }
    trimmed.to_owned()
}

fn normalize_session_key_input(raw: Option<String>) -> Option<String> {
    raw.map(|value| canonicalize_session_key(&value))
        .filter(|value| !value.is_empty())
}

fn parse_optional_label_filter(value: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > 64 {
        return Err("label too long (max 64)".to_owned());
    }
    Ok(Some(trimmed.to_owned()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn next_session_id() -> String {
    let sequence = SESSION_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("sess-{}-{sequence}", now_ms())
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
                "key": "agent:main:discord:group:g1",
                "sendPolicy": "deny",
                "groupActivation": "mention",
                "queueMode": "steer"
            }),
        };
        let out = dispatcher.handle_request(&patch).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload.pointer("/key").and_then(serde_json::Value::as_str),
                    Some("agent:main:discord:group:g1")
                );
                assert_eq!(
                    payload
                        .pointer("/entry/key")
                        .and_then(serde_json::Value::as_str),
                    Some("agent:main:discord:group:g1")
                );
                assert_eq!(
                    payload
                        .pointer("/entry/sendPolicy")
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
                    payload.pointer("/path").and_then(serde_json::Value::as_str),
                    Some(super::SESSION_STORE_PATH)
                );
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
        for (idx, params) in [
            serde_json::json!({
                "sessionKey": "agent:main:discord:group:g1",
                "queueMode": "invalid"
            }),
            serde_json::json!({
                "key": "agent:main:discord:group:g1",
                "thinkingLevel": "banana"
            }),
            serde_json::json!({
                "key": "agent:main:discord:group:g1",
                "reasoningLevel": "mystery"
            }),
            serde_json::json!({
                "key": "agent:main:discord:group:g1",
                "execHost": "remote"
            }),
            serde_json::json!({
                "key": "agent:main:discord:group:g1",
                "sendPolicy": "inherit"
            }),
            serde_json::json!({
                "key": "agent:main:discord:group:g1",
                "label": "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklm"
            }),
        ]
        .into_iter()
        .enumerate()
        {
            let patch = RpcRequestFrame {
                id: format!("req-invalid-{idx}"),
                method: "sessions.patch".to_owned(),
                params,
            };
            let out = dispatcher.handle_request(&patch).await;
            assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));
        }
    }

    #[tokio::test]
    async fn dispatcher_patch_supports_extended_fields_and_null_clear() {
        let dispatcher = RpcDispatcher::new();
        let key = "agent:main:discord:subagent:g-extended";

        let patch_set = RpcRequestFrame {
            id: "req-patch-extended-set".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "key": key,
                "sendPolicy": "deny",
                "groupActivation": "mention",
                "queueMode": "steer",
                "thinkingLevel": "medium",
                "verboseLevel": "off",
                "reasoningLevel": "stream",
                "responseUsage": "tokens",
                "elevatedLevel": "ask",
                "execHost": "sandbox",
                "execSecurity": "allowlist",
                "execAsk": "on-miss",
                "execNode": "node-a",
                "model": "openai/gpt-4o-mini",
                "spawnDepth": 2
            }),
        };
        let out = dispatcher.handle_request(&patch_set).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/entry/thinkingLevel")
                        .and_then(serde_json::Value::as_str),
                    Some("medium")
                );
                assert_eq!(
                    payload
                        .pointer("/entry/modelOverride")
                        .and_then(serde_json::Value::as_str),
                    Some("gpt-4o-mini")
                );
                assert_eq!(
                    payload
                        .pointer("/entry/providerOverride")
                        .and_then(serde_json::Value::as_str),
                    Some("openai")
                );
                assert_eq!(
                    payload
                        .pointer("/resolved/model")
                        .and_then(serde_json::Value::as_str),
                    Some("gpt-4o-mini")
                );
                assert_eq!(
                    payload
                        .pointer("/entry/spawnDepth")
                        .and_then(serde_json::Value::as_u64),
                    Some(2)
                );
            }
            _ => panic!("expected extended patch handled"),
        }

        let patch_clear = RpcRequestFrame {
            id: "req-patch-extended-clear".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "key": key,
                "sendPolicy": null,
                "groupActivation": null,
                "queueMode": null,
                "verboseLevel": null,
                "responseUsage": null,
                "model": null
            }),
        };
        let out = dispatcher.handle_request(&patch_clear).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert!(payload.pointer("/entry/sendPolicy").is_none());
                assert!(payload.pointer("/entry/groupActivation").is_none());
                assert!(payload.pointer("/entry/queueMode").is_none());
                assert!(payload.pointer("/entry/verboseLevel").is_none());
                assert!(payload.pointer("/entry/responseUsage").is_none());
                assert_eq!(
                    payload
                        .pointer("/entry/spawnDepth")
                        .and_then(serde_json::Value::as_u64),
                    Some(2)
                );
                assert!(payload.pointer("/entry/modelOverride").is_none());
                assert!(payload.pointer("/entry/providerOverride").is_none());
            }
            _ => panic!("expected clear patch handled"),
        }

        let patch_toggle_off = RpcRequestFrame {
            id: "req-patch-extended-off-clears".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "key": key,
                "reasoningLevel": "off",
                "responseUsage": "off"
            }),
        };
        let out = dispatcher.handle_request(&patch_toggle_off).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert!(payload.pointer("/entry/reasoningLevel").is_none());
                assert!(payload.pointer("/entry/responseUsage").is_none());
            }
            _ => panic!("expected off-clear patch handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_patch_enforces_spawned_by_and_spawn_depth_rules() {
        let dispatcher = RpcDispatcher::new();

        let non_subagent = RpcRequestFrame {
            id: "req-patch-non-subagent".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "key": "agent:main:discord:group:g-rules",
                "spawnedBy": "agent:main:main"
            }),
        };
        let out = dispatcher.handle_request(&non_subagent).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let key = "agent:main:discord:subagent:g-rules";
        let initial = RpcRequestFrame {
            id: "req-patch-subagent-init".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "key": key,
                "spawnedBy": "agent:main:main",
                "spawnDepth": 1
            }),
        };
        let out = dispatcher.handle_request(&initial).await;
        assert!(matches!(out, RpcDispatchOutcome::Handled(_)));

        let change_spawned_by = RpcRequestFrame {
            id: "req-patch-subagent-change-spawned".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "key": key,
                "spawnedBy": "agent:main:other"
            }),
        };
        let out = dispatcher.handle_request(&change_spawned_by).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let change_spawn_depth = RpcRequestFrame {
            id: "req-patch-subagent-change-depth".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "key": key,
                "spawnDepth": 2
            }),
        };
        let out = dispatcher.handle_request(&change_spawn_depth).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let clear_spawned_by = RpcRequestFrame {
            id: "req-patch-subagent-clear-spawned".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "key": key,
                "spawnedBy": null
            }),
        };
        let out = dispatcher.handle_request(&clear_spawned_by).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let clear_spawn_depth = RpcRequestFrame {
            id: "req-patch-subagent-clear-depth".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "key": key,
                "spawnDepth": null
            }),
        };
        let out = dispatcher.handle_request(&clear_spawn_depth).await;
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
    async fn dispatcher_history_supports_key_alias_and_session_id() {
        let dispatcher = RpcDispatcher::new();
        let session_key = "agent:main:discord:group:g-history-id";
        let send = RpcRequestFrame {
            id: "req-send-history-id".to_owned(),
            method: "sessions.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": session_key,
                "message": "hello from history id"
            }),
        };
        let _ = dispatcher.handle_request(&send).await;

        let status = RpcRequestFrame {
            id: "req-status-history-id".to_owned(),
            method: "session.status".to_owned(),
            params: serde_json::json!({
                "sessionKey": session_key
            }),
        };
        let session_id = match dispatcher.handle_request(&status).await {
            RpcDispatchOutcome::Handled(payload) => payload
                .pointer("/session/sessionId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .expect("missing session id"),
            _ => panic!("expected status handled"),
        };

        let history_by_key = RpcRequestFrame {
            id: "req-history-by-key".to_owned(),
            method: "sessions.history".to_owned(),
            params: serde_json::json!({
                "key": "discord:group:g-history-id",
                "limit": 5
            }),
        };
        let out = dispatcher.handle_request(&history_by_key).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/history/0/sessionKey")
                        .and_then(serde_json::Value::as_str),
                    Some(session_key)
                );
            }
            _ => panic!("expected history by key handled"),
        }

        let history_by_session_id = RpcRequestFrame {
            id: "req-history-by-session-id".to_owned(),
            method: "sessions.history".to_owned(),
            params: serde_json::json!({
                "sessionId": session_id,
                "limit": 5
            }),
        };
        let out = dispatcher.handle_request(&history_by_session_id).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/history/0/sessionKey")
                        .and_then(serde_json::Value::as_str),
                    Some(session_key)
                );
            }
            _ => panic!("expected history by session id handled"),
        }

        let missing = RpcRequestFrame {
            id: "req-history-missing-session-id".to_owned(),
            method: "sessions.history".to_owned(),
            params: serde_json::json!({
                "sessionId": "sess-missing",
                "limit": 5
            }),
        };
        let out = dispatcher.handle_request(&missing).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 404, .. }));
    }

    #[tokio::test]
    async fn dispatcher_list_includes_delivery_context_fields() {
        let dispatcher = RpcDispatcher::new();
        let send = RpcRequestFrame {
            id: "req-send-delivery".to_owned(),
            method: "sessions.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:whatsapp:dm:+15551234567",
                "message": "hello delivery context",
                "channel": "whatsapp",
                "to": "+15551234567",
                "accountId": "work"
            }),
        };
        let _ = dispatcher.handle_request(&send).await;

        let list = RpcRequestFrame {
            id: "req-list-delivery".to_owned(),
            method: "sessions.list".to_owned(),
            params: serde_json::json!({
                "limit": 10,
                "includeGlobal": false,
                "includeUnknown": true
            }),
        };
        let out = dispatcher.handle_request(&list).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/sessions/0/key")
                        .and_then(serde_json::Value::as_str),
                    Some("agent:main:whatsapp:dm:+15551234567")
                );
                assert_eq!(
                    payload
                        .pointer("/sessions/0/lastAccountId")
                        .and_then(serde_json::Value::as_str),
                    Some("work")
                );
                assert_eq!(
                    payload
                        .pointer("/sessions/0/deliveryContext/channel")
                        .and_then(serde_json::Value::as_str),
                    Some("whatsapp")
                );
                assert_eq!(
                    payload
                        .pointer("/sessions/0/deliveryContext/to")
                        .and_then(serde_json::Value::as_str),
                    Some("+15551234567")
                );
                assert_eq!(
                    payload
                        .pointer("/sessions/0/deliveryContext/accountId")
                        .and_then(serde_json::Value::as_str),
                    Some("work")
                );
                assert_eq!(
                    payload
                        .pointer("/sessions/0/totalTokensFresh")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
                assert!(payload.pointer("/sessions/0/totalTokens").is_none());
            }
            _ => panic!("expected delivery context list handled"),
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
        let patch_out = dispatcher.handle_request(&patch).await;
        let session_id = match patch_out {
            RpcDispatchOutcome::Handled(payload) => payload
                .pointer("/session/sessionId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .expect("missing session id"),
            _ => panic!("expected patch handled"),
        };

        let resolve = RpcRequestFrame {
            id: "req-resolve".to_owned(),
            method: "sessions.resolve".to_owned(),
            params: serde_json::json!({
                "sessionId": session_id
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
    async fn dispatcher_normalizes_alias_and_short_session_keys() {
        let dispatcher = RpcDispatcher::new();

        let patch_main = RpcRequestFrame {
            id: "req-patch-main".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "key": "main",
                "queueMode": "followup"
            }),
        };
        let out = dispatcher.handle_request(&patch_main).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/key").and_then(serde_json::Value::as_str),
                    Some("agent:main:main")
                );
                assert_eq!(
                    payload
                        .pointer("/session/key")
                        .and_then(serde_json::Value::as_str),
                    Some("agent:main:main")
                );
            }
            _ => panic!("expected main patch handled"),
        }

        let patch_short = RpcRequestFrame {
            id: "req-patch-short".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "key": "discord:group:g-short",
                "queueMode": "followup"
            }),
        };
        let out = dispatcher.handle_request(&patch_short).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/key").and_then(serde_json::Value::as_str),
                    Some("agent:main:discord:group:g-short")
                );
            }
            _ => panic!("expected short patch handled"),
        }

        let resolve_short = RpcRequestFrame {
            id: "req-resolve-short".to_owned(),
            method: "sessions.resolve".to_owned(),
            params: serde_json::json!({
                "key": "discord:group:g-short"
            }),
        };
        let out = dispatcher.handle_request(&resolve_short).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/key").and_then(serde_json::Value::as_str),
                    Some("agent:main:discord:group:g-short")
                );
            }
            _ => panic!("expected short resolve handled"),
        }

        let status_short = RpcRequestFrame {
            id: "req-status-short".to_owned(),
            method: "session.status".to_owned(),
            params: serde_json::json!({
                "sessionKey": "discord:group:g-short"
            }),
        };
        let out = dispatcher.handle_request(&status_short).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/session/key")
                        .and_then(serde_json::Value::as_str),
                    Some("agent:main:discord:group:g-short")
                );
            }
            _ => panic!("expected short status handled"),
        }

        let delete_short = RpcRequestFrame {
            id: "req-delete-short".to_owned(),
            method: "sessions.delete".to_owned(),
            params: serde_json::json!({
                "key": "discord:group:g-short"
            }),
        };
        let out = dispatcher.handle_request(&delete_short).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/key").and_then(serde_json::Value::as_str),
                    Some("agent:main:discord:group:g-short")
                );
                assert_eq!(
                    payload
                        .pointer("/deleted")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
            }
            _ => panic!("expected short delete handled"),
        }

        let list = RpcRequestFrame {
            id: "req-list-canon".to_owned(),
            method: "sessions.list".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&list).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                let keys = payload
                    .pointer("/sessions")
                    .and_then(serde_json::Value::as_array)
                    .map(|sessions| {
                        sessions
                            .iter()
                            .filter_map(|session| {
                                session.get("key").and_then(serde_json::Value::as_str)
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                assert!(keys.iter().any(|key| *key == "agent:main:main"));
                assert!(keys.iter().all(|key| *key != "main"));
            }
            _ => panic!("expected canonical list handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_resolve_supports_label_agent_and_spawn_filters() {
        let dispatcher = RpcDispatcher::new();
        for (id, key, label, spawned_by) in [
            (
                "req-patch-a",
                "agent:ops:discord:subagent:resolved-a",
                "deploy",
                "main",
            ),
            (
                "req-patch-b",
                "agent:ops:discord:subagent:resolved-b",
                "deploy",
                "other",
            ),
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
                "includeUnknown": true,
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
                    Some("agent:ops:discord:subagent:resolved-a")
                );
            }
            _ => panic!("expected filtered resolve handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_reset_clears_session_counters() {
        let dispatcher = RpcDispatcher::new();
        let session_key = "agent:main:discord:group:g-reset";
        let request = ActionRequest {
            id: "req-reset".to_owned(),
            source: "agent".to_owned(),
            session_id: Some(session_key.to_owned()),
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

        let status = RpcRequestFrame {
            id: "req-status-before-reset".to_owned(),
            method: "session.status".to_owned(),
            params: serde_json::json!({
                "sessionKey": session_key
            }),
        };
        let before_reset = dispatcher.handle_request(&status).await;
        let before_session_id = match before_reset {
            RpcDispatchOutcome::Handled(payload) => payload
                .pointer("/session/sessionId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .expect("missing pre-reset session id"),
            _ => panic!("expected status handled"),
        };

        let reset = RpcRequestFrame {
            id: "req-reset".to_owned(),
            method: "sessions.reset".to_owned(),
            params: serde_json::json!({
                "sessionKey": session_key,
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
                let after_session_id = payload
                    .pointer("/session/sessionId")
                    .and_then(serde_json::Value::as_str)
                    .expect("missing post-reset session id");
                assert_ne!(after_session_id, before_session_id);
            }
            _ => panic!("expected reset handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_reset_rejects_invalid_reason() {
        let dispatcher = RpcDispatcher::new();
        let reset = RpcRequestFrame {
            id: "req-reset-invalid".to_owned(),
            method: "sessions.reset".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-reset-invalid",
                "reason": "banana"
            }),
        };
        let out = dispatcher.handle_request(&reset).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));
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
                    payload.pointer("/path").and_then(serde_json::Value::as_str),
                    Some(super::SESSION_STORE_PATH)
                );
                assert_eq!(
                    payload
                        .pointer("/deleted")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/archived/0")
                        .and_then(serde_json::Value::as_str),
                    Some("memory://session-registry/archives/agent:main:discord:group:g-delete.deleted")
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
    async fn dispatcher_delete_honors_delete_transcript_flag() {
        let dispatcher = RpcDispatcher::new();
        let patch = RpcRequestFrame {
            id: "req-patch-delete-flag".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-delete-flag",
            }),
        };
        let _ = dispatcher.handle_request(&patch).await;

        let delete = RpcRequestFrame {
            id: "req-delete-flag".to_owned(),
            method: "sessions.delete".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-delete-flag",
                "deleteTranscript": false
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
                assert_eq!(
                    payload
                        .pointer("/archived")
                        .and_then(serde_json::Value::as_array)
                        .map(Vec::len),
                    Some(0)
                );
            }
            _ => panic!("expected delete handled"),
        }
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
    async fn dispatcher_preview_preserves_requested_alias_key() {
        let dispatcher = RpcDispatcher::new();
        let send = RpcRequestFrame {
            id: "req-send-preview-alias".to_owned(),
            method: "sessions.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-preview-alias",
                "message": "preview alias payload",
            }),
        };
        let _ = dispatcher.handle_request(&send).await;

        let preview = RpcRequestFrame {
            id: "req-preview-alias".to_owned(),
            method: "sessions.preview".to_owned(),
            params: serde_json::json!({
                "keys": ["discord:group:g-preview-alias"],
                "limit": 10,
                "maxChars": 32
            }),
        };
        let out = dispatcher.handle_request(&preview).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/previews/0/key")
                        .and_then(serde_json::Value::as_str),
                    Some("discord:group:g-preview-alias")
                );
                assert_eq!(
                    payload
                        .pointer("/previews/0/status")
                        .and_then(serde_json::Value::as_str),
                    Some("ok")
                );
            }
            _ => panic!("expected preview alias handled"),
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
                    payload.pointer("/path").and_then(serde_json::Value::as_str),
                    Some(super::SESSION_STORE_PATH)
                );
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
                assert_eq!(
                    payload
                        .pointer("/archived/0")
                        .and_then(serde_json::Value::as_str),
                    Some("memory://session-registry/archives/agent:main:discord:group:g-compact.compact")
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
    async fn dispatcher_compact_defaults_to_400_lines() {
        let dispatcher = RpcDispatcher::new();
        for idx in 0..120 {
            let send = RpcRequestFrame {
                id: format!("req-send-default-{idx}"),
                method: "sessions.send".to_owned(),
                params: serde_json::json!({
                    "sessionKey": "agent:main:discord:group:g-compact-default",
                    "message": format!("msg-default-{idx}"),
                }),
            };
            let _ = dispatcher.handle_request(&send).await;
        }

        let compact = RpcRequestFrame {
            id: "req-compact-default".to_owned(),
            method: "sessions.compact".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-compact-default"
            }),
        };
        let out = dispatcher.handle_request(&compact).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/compacted")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
                assert_eq!(
                    payload.pointer("/kept").and_then(serde_json::Value::as_u64),
                    Some(120)
                );
                assert_eq!(
                    payload
                        .pointer("/reason")
                        .and_then(serde_json::Value::as_str),
                    Some("below limit")
                );
            }
            _ => panic!("expected compact handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_compact_rejects_zero_max_lines() {
        let dispatcher = RpcDispatcher::new();
        let compact = RpcRequestFrame {
            id: "req-compact-zero".to_owned(),
            method: "sessions.compact".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-compact-zero",
                "maxLines": 0
            }),
        };
        let out = dispatcher.handle_request(&compact).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));
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
    async fn dispatcher_usage_honors_range_and_context_weight_flag() {
        let dispatcher = RpcDispatcher::new();
        let request = ActionRequest {
            id: "req-usage-range-1".to_owned(),
            source: "agent".to_owned(),
            session_id: Some("agent:main:discord:group:g-usage-range".to_owned()),
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
            risk_score: 5,
            reasons: vec![],
            tags: vec![],
            source: "openclaw-agent-rs".to_owned(),
        };
        dispatcher.record_decision(&request, &decision).await;

        let today = super::format_utc_date(super::now_ms());
        let usage = RpcRequestFrame {
            id: "req-usage-range".to_owned(),
            method: "sessions.usage".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-usage-range",
                "startDate": today,
                "endDate": today,
                "includeContextWeight": true
            }),
        };
        let out = dispatcher.handle_request(&usage).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/range/startDate")
                        .and_then(serde_json::Value::as_str),
                    payload
                        .pointer("/range/endDate")
                        .and_then(serde_json::Value::as_str)
                );
                assert_eq!(
                    payload
                        .pointer("/startDate")
                        .and_then(serde_json::Value::as_str),
                    payload
                        .pointer("/endDate")
                        .and_then(serde_json::Value::as_str)
                );
                assert!(
                    payload
                        .pointer("/updatedAt")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0)
                        > 0
                );
                assert_eq!(
                    payload
                        .pointer("/totals/totalTokens")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                assert_eq!(
                    payload
                        .pointer("/aggregates/messages/total")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                assert!(payload.pointer("/sessions/0/contextWeight").is_some());
            }
            _ => panic!("expected ranged usage handled"),
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
    async fn dispatcher_list_supports_label_spawn_filters_and_message_hints() {
        let dispatcher = RpcDispatcher::new();
        let key = "agent:main:discord:subagent:g-label";
        let patch = RpcRequestFrame {
            id: "req-list-label-patch".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "key": key,
                "label": "Briefing",
                "spawnedBy": "agent:main:main"
            }),
        };
        let _ = dispatcher.handle_request(&patch).await;

        let send = RpcRequestFrame {
            id: "req-list-label-send".to_owned(),
            method: "sessions.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": key,
                "message": "first operator update",
                "requestId": "req-list-label-send-1"
            }),
        };
        let _ = dispatcher.handle_request(&send).await;

        let list = RpcRequestFrame {
            id: "req-list-label".to_owned(),
            method: "sessions.list".to_owned(),
            params: serde_json::json!({
                "label": "Briefing",
                "spawnedBy": "agent:main:main",
                "includeDerivedTitles": true,
                "includeLastMessage": true,
                "limit": 5
            }),
        };
        let out = dispatcher.handle_request(&list).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/path").and_then(serde_json::Value::as_str),
                    Some(super::SESSION_STORE_PATH)
                );
                assert_eq!(
                    payload
                        .pointer("/defaults/modelProvider")
                        .and_then(|v| if v.is_null() { Some(()) } else { None }),
                    Some(())
                );
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
                    Some(key)
                );
                assert_eq!(
                    payload
                        .pointer("/sessions/0/displayName")
                        .and_then(serde_json::Value::as_str),
                    Some("Briefing")
                );
                assert_eq!(
                    payload
                        .pointer("/sessions/0/derivedTitle")
                        .and_then(serde_json::Value::as_str),
                    Some("first operator update")
                );
                assert_eq!(
                    payload
                        .pointer("/sessions/0/lastMessagePreview")
                        .and_then(serde_json::Value::as_str),
                    Some("first operator update")
                );
            }
            _ => panic!("expected filtered list handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_rejects_overlong_label_filters() {
        let dispatcher = RpcDispatcher::new();
        let too_long_label = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklm";

        let list = RpcRequestFrame {
            id: "req-list-long-label".to_owned(),
            method: "sessions.list".to_owned(),
            params: serde_json::json!({
                "label": too_long_label
            }),
        };
        let out = dispatcher.handle_request(&list).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let resolve = RpcRequestFrame {
            id: "req-resolve-long-label".to_owned(),
            method: "sessions.resolve".to_owned(),
            params: serde_json::json!({
                "label": too_long_label
            }),
        };
        let out = dispatcher.handle_request(&resolve).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));
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

    #[tokio::test]
    async fn dispatcher_system_methods_toggle_heartbeats_and_read_last_event() {
        let dispatcher = RpcDispatcher::new();

        let missing_enabled = RpcRequestFrame {
            id: "req-set-heartbeats-missing".to_owned(),
            method: "set-heartbeats".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&missing_enabled).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let toggle_off = RpcRequestFrame {
            id: "req-set-heartbeats-off".to_owned(),
            method: "set-heartbeats".to_owned(),
            params: serde_json::json!({ "enabled": false }),
        };
        let out = dispatcher.handle_request(&toggle_off).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/enabled")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
            }
            _ => panic!("expected set-heartbeats handled"),
        }

        let last_heartbeat = RpcRequestFrame {
            id: "req-last-heartbeat-empty".to_owned(),
            method: "last-heartbeat".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&last_heartbeat).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => assert!(payload.is_null()),
            _ => panic!("expected null last-heartbeat before events"),
        }

        dispatcher
            .ingest_event_frame(&serde_json::json!({
                "type": "event",
                "event": "heartbeat",
                "payload": {
                    "status": "sent",
                    "to": "+123"
                }
            }))
            .await;

        let out = dispatcher.handle_request(&last_heartbeat).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("sent")
                );
                assert!(payload
                    .pointer("/ts")
                    .and_then(serde_json::Value::as_u64)
                    .is_some());
            }
            _ => panic!("expected populated last-heartbeat"),
        }
    }

    #[tokio::test]
    async fn dispatcher_system_event_requires_text_and_updates_presence() {
        let dispatcher = RpcDispatcher::new();

        let invalid = RpcRequestFrame {
            id: "req-system-event-invalid".to_owned(),
            method: "system-event".to_owned(),
            params: serde_json::json!({
                "text": "   "
            }),
        };
        let out = dispatcher.handle_request(&invalid).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let valid = RpcRequestFrame {
            id: "req-system-event-valid".to_owned(),
            method: "system-event".to_owned(),
            params: serde_json::json!({
                "text": "Node: node-a online",
                "host": "node-a",
                "mode": "daemon",
                "version": "1.2.3",
                "roles": ["operator", "operator"],
                "scopes": ["operator.read", "operator.write"],
                "tags": ["prod"],
                "lastInputSeconds": 12.7
            }),
        };
        let out = dispatcher.handle_request(&valid).await;
        assert!(matches!(out, RpcDispatchOutcome::Handled(_)));

        let presence = RpcRequestFrame {
            id: "req-system-presence".to_owned(),
            method: "system-presence".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&presence).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                let entries = payload.as_array().expect("presence array");
                assert_eq!(entries.len(), 1);
                assert_eq!(
                    entries[0].get("host").and_then(serde_json::Value::as_str),
                    Some("node-a")
                );
                assert_eq!(
                    entries[0]
                        .get("lastInputSeconds")
                        .and_then(serde_json::Value::as_u64),
                    Some(12)
                );
                let roles = entries[0]
                    .get("roles")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                assert_eq!(roles.len(), 1);
            }
            _ => panic!("expected system-presence handled"),
        }

        let alias_presence = RpcRequestFrame {
            id: "req-presence-alias".to_owned(),
            method: "presence".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&alias_presence).await;
        assert!(matches!(out, RpcDispatchOutcome::Handled(_)));
    }

    #[tokio::test]
    async fn dispatcher_ingests_presence_events_from_gateway() {
        let dispatcher = RpcDispatcher::new();
        dispatcher
            .ingest_event_frame(&serde_json::json!({
                "type": "event",
                "event": "presence",
                "payload": {
                    "presence": [
                        { "host": "node-a", "ts": 1 },
                        { "instanceId": "abc", "ts": 2 }
                    ]
                }
            }))
            .await;

        let system_presence = RpcRequestFrame {
            id: "req-system-presence-ingested".to_owned(),
            method: "system-presence".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&system_presence).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                let entries = payload.as_array().expect("presence array");
                assert_eq!(entries.len(), 2);
                assert!(entries.iter().any(|entry| entry
                    .get("host")
                    .and_then(serde_json::Value::as_str)
                    == Some("node-a")));
                assert!(entries.iter().any(|entry| {
                    entry.get("instanceId").and_then(serde_json::Value::as_str) == Some("abc")
                }));
            }
            _ => panic!("expected system-presence handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_wake_validates_mode_and_updates_heartbeat() {
        let dispatcher = RpcDispatcher::new();

        let missing_mode = RpcRequestFrame {
            id: "req-wake-missing-mode".to_owned(),
            method: "wake".to_owned(),
            params: serde_json::json!({
                "text": "ping"
            }),
        };
        let out = dispatcher.handle_request(&missing_mode).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let wake = RpcRequestFrame {
            id: "req-wake-now".to_owned(),
            method: "wake".to_owned(),
            params: serde_json::json!({
                "mode": "now",
                "text": "wake now"
            }),
        };
        let out = dispatcher.handle_request(&wake).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
            }
            _ => panic!("expected wake handled"),
        }

        let last_heartbeat = RpcRequestFrame {
            id: "req-wake-last-heartbeat".to_owned(),
            method: "last-heartbeat".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&last_heartbeat).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("wake-requested")
                );
                assert_eq!(
                    payload.pointer("/mode").and_then(serde_json::Value::as_str),
                    Some("now")
                );
            }
            _ => panic!("expected last-heartbeat after wake"),
        }
    }

    #[tokio::test]
    async fn dispatcher_talk_methods_return_config_and_track_mode() {
        let dispatcher = RpcDispatcher::new();

        let config = RpcRequestFrame {
            id: "req-talk-config".to_owned(),
            method: "talk.config".to_owned(),
            params: serde_json::json!({
                "includeSecrets": false
            }),
        };
        let out = dispatcher.handle_request(&config).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/config/talk/outputFormat")
                        .and_then(serde_json::Value::as_str),
                    Some("pcm16")
                );
                assert_eq!(
                    payload
                        .pointer("/config/session/mainKey")
                        .and_then(serde_json::Value::as_str),
                    Some("main")
                );
            }
            _ => panic!("expected talk.config handled"),
        }

        let invalid_mode = RpcRequestFrame {
            id: "req-talk-mode-invalid".to_owned(),
            method: "talk.mode".to_owned(),
            params: serde_json::json!({
                "phase": "listen"
            }),
        };
        let out = dispatcher.handle_request(&invalid_mode).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let set_mode = RpcRequestFrame {
            id: "req-talk-mode-valid".to_owned(),
            method: "talk.mode".to_owned(),
            params: serde_json::json!({
                "enabled": true,
                "phase": "listen"
            }),
        };
        let out = dispatcher.handle_request(&set_mode).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/enabled")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/phase")
                        .and_then(serde_json::Value::as_str),
                    Some("listen")
                );
                assert!(payload
                    .pointer("/ts")
                    .and_then(serde_json::Value::as_u64)
                    .is_some());
            }
            _ => panic!("expected talk.mode handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_channels_methods_report_status_and_validate_logout() {
        let dispatcher = RpcDispatcher::new();

        let status = RpcRequestFrame {
            id: "req-channels-status".to_owned(),
            method: "channels.status".to_owned(),
            params: serde_json::json!({
                "probe": true,
                "timeoutMs": 2500
            }),
        };
        let out = dispatcher.handle_request(&status).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                let order = payload
                    .pointer("/channelOrder")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                assert!(!order.is_empty());
                assert!(order.iter().any(|v| v.as_str() == Some("discord")));
                assert_eq!(
                    payload
                        .pointer("/channelDefaultAccountId/discord")
                        .and_then(serde_json::Value::as_str),
                    Some("default")
                );
                assert!(payload
                    .pointer("/channelAccounts/discord/0/probe/ok")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false));
            }
            _ => panic!("expected channels.status handled"),
        }

        let invalid_logout = RpcRequestFrame {
            id: "req-channels-logout-invalid".to_owned(),
            method: "channels.logout".to_owned(),
            params: serde_json::json!({
                "channel": "unknown"
            }),
        };
        let out = dispatcher.handle_request(&invalid_logout).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let valid_logout = RpcRequestFrame {
            id: "req-channels-logout-valid".to_owned(),
            method: "channels.logout".to_owned(),
            params: serde_json::json!({
                "channel": "discord"
            }),
        };
        let out = dispatcher.handle_request(&valid_logout).await;
        match out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/channel")
                        .and_then(serde_json::Value::as_str),
                    Some("discord")
                );
                assert_eq!(
                    payload
                        .pointer("/accountId")
                        .and_then(serde_json::Value::as_str),
                    Some("default")
                );
                assert_eq!(
                    payload
                        .pointer("/supported")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
            }
            _ => panic!("expected channels.logout handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_config_methods_enforce_base_hash_and_apply_updates() {
        let dispatcher = RpcDispatcher::new();

        let get = RpcRequestFrame {
            id: "req-config-get".to_owned(),
            method: "config.get".to_owned(),
            params: serde_json::json!({}),
        };
        let initial_hash = match dispatcher.handle_request(&get).await {
            RpcDispatchOutcome::Handled(payload) => payload
                .pointer("/hash")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
                .expect("hash"),
            _ => panic!("expected config.get handled"),
        };

        let set_missing_hash = RpcRequestFrame {
            id: "req-config-set-missing-hash".to_owned(),
            method: "config.set".to_owned(),
            params: serde_json::json!({
                "raw": "{\"session\":{\"mainKey\":\"main2\"}}"
            }),
        };
        let out = dispatcher.handle_request(&set_missing_hash).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let set = RpcRequestFrame {
            id: "req-config-set".to_owned(),
            method: "config.set".to_owned(),
            params: serde_json::json!({
                "baseHash": initial_hash,
                "raw": "{\"session\":{\"mainKey\":\"primary\"},\"talk\":{\"outputFormat\":\"pcm16\"}}"
            }),
        };
        let set_hash = match dispatcher.handle_request(&set).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/config/session/mainKey")
                        .and_then(serde_json::Value::as_str),
                    Some("primary")
                );
                payload
                    .pointer("/hash")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .expect("set hash")
            }
            _ => panic!("expected config.set handled"),
        };

        let patch = RpcRequestFrame {
            id: "req-config-patch".to_owned(),
            method: "config.patch".to_owned(),
            params: serde_json::json!({
                "baseHash": set_hash,
                "raw": "{\"talk\":{\"interruptOnSpeech\":false}}"
            }),
        };
        let patch_hash = match dispatcher.handle_request(&patch).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/config/talk/interruptOnSpeech")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
                payload
                    .pointer("/hash")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .expect("patch hash")
            }
            _ => panic!("expected config.patch handled"),
        };

        let apply = RpcRequestFrame {
            id: "req-config-apply".to_owned(),
            method: "config.apply".to_owned(),
            params: serde_json::json!({
                "baseHash": patch_hash,
                "raw": "{\"ui\":{\"seamColor\":\"#111111\"}}",
                "sessionKey": "agent:main:main",
                "note": "apply-now",
                "restartDelayMs": 0
            }),
        };
        match dispatcher.handle_request(&apply).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/config/ui/seamColor")
                        .and_then(serde_json::Value::as_str),
                    Some("#111111")
                );
                assert_eq!(
                    payload
                        .pointer("/restart/requested")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/restart/sessionKey")
                        .and_then(serde_json::Value::as_str),
                    Some("agent:main:main")
                );
            }
            _ => panic!("expected config.apply handled"),
        }

        let schema = RpcRequestFrame {
            id: "req-config-schema".to_owned(),
            method: "config.schema".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&schema).await;
        assert!(matches!(out, RpcDispatchOutcome::Handled(_)));
    }

    #[tokio::test]
    async fn dispatcher_logs_tail_returns_bounded_lines_and_cursor() {
        let dispatcher = RpcDispatcher::new();
        let first = RpcRequestFrame {
            id: "req-system-event-log-1".to_owned(),
            method: "system-event".to_owned(),
            params: serde_json::json!({
                "text": "first event"
            }),
        };
        let second = RpcRequestFrame {
            id: "req-system-event-log-2".to_owned(),
            method: "system-event".to_owned(),
            params: serde_json::json!({
                "text": "second event"
            }),
        };
        let _ = dispatcher.handle_request(&first).await;
        let _ = dispatcher.handle_request(&second).await;

        let tail = RpcRequestFrame {
            id: "req-logs-tail".to_owned(),
            method: "logs.tail".to_owned(),
            params: serde_json::json!({
                "limit": 2,
                "maxBytes": 2048
            }),
        };
        let cursor = match dispatcher.handle_request(&tail).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/file").and_then(serde_json::Value::as_str),
                    Some(super::SYSTEM_LOG_PATH)
                );
                let lines = payload
                    .pointer("/lines")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                assert!(!lines.is_empty());
                payload
                    .pointer("/cursor")
                    .and_then(serde_json::Value::as_u64)
                    .expect("cursor")
            }
            _ => panic!("expected logs.tail handled"),
        };

        let next_event = RpcRequestFrame {
            id: "req-talk-mode-log".to_owned(),
            method: "talk.mode".to_owned(),
            params: serde_json::json!({
                "enabled": true,
                "phase": "listen"
            }),
        };
        let _ = dispatcher.handle_request(&next_event).await;

        let tail_from_cursor = RpcRequestFrame {
            id: "req-logs-tail-cursor".to_owned(),
            method: "logs.tail".to_owned(),
            params: serde_json::json!({
                "cursor": cursor,
                "limit": 5
            }),
        };
        match dispatcher.handle_request(&tail_from_cursor).await {
            RpcDispatchOutcome::Handled(payload) => {
                let lines = payload
                    .pointer("/lines")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                assert!(!lines.is_empty());
                assert!(lines.iter().any(|line| {
                    line.as_str()
                        .map(|text| text.contains("talk.mode enabled=true"))
                        .unwrap_or(false)
                }));
            }
            _ => panic!("expected logs.tail cursor handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_models_list_returns_catalog_and_rejects_unknown_params() {
        let dispatcher = RpcDispatcher::new();

        let invalid = RpcRequestFrame {
            id: "req-models-list-invalid".to_owned(),
            method: "models.list".to_owned(),
            params: serde_json::json!({
                "extra": true
            }),
        };
        let out = dispatcher.handle_request(&invalid).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let valid = RpcRequestFrame {
            id: "req-models-list".to_owned(),
            method: "models.list".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&valid).await {
            RpcDispatchOutcome::Handled(payload) => {
                let models = payload
                    .pointer("/models")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                assert!(!models.is_empty());
                assert!(models.iter().all(|entry| {
                    entry
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .is_some()
                        && entry
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .is_some()
                        && entry
                            .get("provider")
                            .and_then(serde_json::Value::as_str)
                            .is_some()
                }));
                let providers = models
                    .iter()
                    .filter_map(|entry| {
                        entry
                            .get("provider")
                            .and_then(serde_json::Value::as_str)
                            .map(ToOwned::to_owned)
                    })
                    .collect::<Vec<_>>();
                let mut sorted = providers.clone();
                sorted.sort();
                assert_eq!(providers, sorted);
            }
            _ => panic!("expected models.list handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_agents_methods_manage_agents_and_workspace_files() {
        let dispatcher = RpcDispatcher::new();

        let invalid_list = RpcRequestFrame {
            id: "req-agents-list-invalid".to_owned(),
            method: "agents.list".to_owned(),
            params: serde_json::json!({
                "extra": true
            }),
        };
        let out = dispatcher.handle_request(&invalid_list).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let list = RpcRequestFrame {
            id: "req-agents-list".to_owned(),
            method: "agents.list".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&list).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/defaultId")
                        .and_then(serde_json::Value::as_str),
                    Some(super::DEFAULT_AGENT_ID)
                );
                assert_eq!(
                    payload
                        .pointer("/mainKey")
                        .and_then(serde_json::Value::as_str),
                    Some(super::DEFAULT_MAIN_KEY)
                );
                let agents = payload
                    .pointer("/agents")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                assert!(agents.iter().any(|agent| {
                    agent.get("id").and_then(serde_json::Value::as_str)
                        == Some(super::DEFAULT_AGENT_ID)
                }));
            }
            _ => panic!("expected agents.list handled"),
        }

        let create = RpcRequestFrame {
            id: "req-agents-create".to_owned(),
            method: "agents.create".to_owned(),
            params: serde_json::json!({
                "name": "Ops Bot",
                "workspace": "memory://agents/ops",
                "emoji": "ops"
            }),
        };
        let created_agent_id = match dispatcher.handle_request(&create).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                payload
                    .pointer("/agentId")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .expect("agentId")
            }
            _ => panic!("expected agents.create handled"),
        };
        assert_eq!(created_agent_id, "ops-bot");

        let duplicate = RpcRequestFrame {
            id: "req-agents-create-duplicate".to_owned(),
            method: "agents.create".to_owned(),
            params: serde_json::json!({
                "name": "Ops Bot",
                "workspace": "memory://agents/ops-2"
            }),
        };
        let out = dispatcher.handle_request(&duplicate).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let update = RpcRequestFrame {
            id: "req-agents-update".to_owned(),
            method: "agents.update".to_owned(),
            params: serde_json::json!({
                "agentId": "ops-bot",
                "name": "Ops Prime",
                "model": "gpt-5.3",
                "avatar": "ops.png"
            }),
        };
        let out = dispatcher.handle_request(&update).await;
        assert!(matches!(out, RpcDispatchOutcome::Handled(_)));

        let files_list = RpcRequestFrame {
            id: "req-agents-files-list".to_owned(),
            method: "agents.files.list".to_owned(),
            params: serde_json::json!({
                "agentId": "ops-bot"
            }),
        };
        match dispatcher.handle_request(&files_list).await {
            RpcDispatchOutcome::Handled(payload) => {
                let files = payload
                    .pointer("/files")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                assert!(files.iter().any(|file| {
                    file.get("name").and_then(serde_json::Value::as_str) == Some("AGENTS.md")
                }));
            }
            _ => panic!("expected agents.files.list handled"),
        }

        let unsupported_file = RpcRequestFrame {
            id: "req-agents-files-get-unsupported".to_owned(),
            method: "agents.files.get".to_owned(),
            params: serde_json::json!({
                "agentId": "ops-bot",
                "name": "README.md"
            }),
        };
        let out = dispatcher.handle_request(&unsupported_file).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let set_file = RpcRequestFrame {
            id: "req-agents-files-set".to_owned(),
            method: "agents.files.set".to_owned(),
            params: serde_json::json!({
                "agentId": "ops-bot",
                "name": "AGENTS.md",
                "content": "# Ops"
            }),
        };
        match dispatcher.handle_request(&set_file).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/file/missing")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
                assert_eq!(
                    payload
                        .pointer("/file/content")
                        .and_then(serde_json::Value::as_str),
                    Some("# Ops")
                );
            }
            _ => panic!("expected agents.files.set handled"),
        }

        let get_file = RpcRequestFrame {
            id: "req-agents-files-get".to_owned(),
            method: "agents.files.get".to_owned(),
            params: serde_json::json!({
                "agentId": "ops-bot",
                "name": "AGENTS.md"
            }),
        };
        match dispatcher.handle_request(&get_file).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/file/missing")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
                assert_eq!(
                    payload
                        .pointer("/file/content")
                        .and_then(serde_json::Value::as_str),
                    Some("# Ops")
                );
            }
            _ => panic!("expected agents.files.get handled"),
        }

        let delete_main = RpcRequestFrame {
            id: "req-agents-delete-main".to_owned(),
            method: "agents.delete".to_owned(),
            params: serde_json::json!({
                "agentId": "main"
            }),
        };
        let out = dispatcher.handle_request(&delete_main).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let delete = RpcRequestFrame {
            id: "req-agents-delete".to_owned(),
            method: "agents.delete".to_owned(),
            params: serde_json::json!({
                "agentId": "ops-bot",
                "deleteFiles": true
            }),
        };
        match dispatcher.handle_request(&delete).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/removedBindings")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
            }
            _ => panic!("expected agents.delete handled"),
        }

        let list_after_delete = RpcRequestFrame {
            id: "req-agents-list-post-delete".to_owned(),
            method: "agents.list".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&list_after_delete).await {
            RpcDispatchOutcome::Handled(payload) => {
                let agents = payload
                    .pointer("/agents")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                assert!(!agents.iter().any(|agent| {
                    agent.get("id").and_then(serde_json::Value::as_str) == Some("ops-bot")
                }));
            }
            _ => panic!("expected agents.list handled after delete"),
        }
    }

    #[tokio::test]
    async fn dispatcher_skills_methods_report_status_update_and_install() {
        let dispatcher = RpcDispatcher::new();

        let invalid_status = RpcRequestFrame {
            id: "req-skills-status-invalid".to_owned(),
            method: "skills.status".to_owned(),
            params: serde_json::json!({
                "extra": true
            }),
        };
        let out = dispatcher.handle_request(&invalid_status).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let status = RpcRequestFrame {
            id: "req-skills-status".to_owned(),
            method: "skills.status".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&status).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/workspaceDir")
                        .and_then(serde_json::Value::as_str),
                    Some(super::DEFAULT_AGENT_WORKSPACE)
                );
                assert!(payload
                    .pointer("/managedSkillsDir")
                    .and_then(serde_json::Value::as_str)
                    .is_some());
            }
            _ => panic!("expected skills.status handled"),
        }

        let update = RpcRequestFrame {
            id: "req-skills-update".to_owned(),
            method: "skills.update".to_owned(),
            params: serde_json::json!({
                "skillKey": "brave-search",
                "enabled": false,
                "apiKey": "abc\r\ndef",
                "env": {
                    " BRAVE_API_KEY ": " secret ",
                    "REMOVE_ME": " ",
                    "": "skip"
                }
            }),
        };
        match dispatcher.handle_request(&update).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/config/apiKey")
                        .and_then(serde_json::Value::as_str),
                    Some("abcdef")
                );
                assert_eq!(
                    payload
                        .pointer("/config/enabled")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
                assert_eq!(
                    payload
                        .pointer("/config/env/BRAVE_API_KEY")
                        .and_then(serde_json::Value::as_str),
                    Some("secret")
                );
                assert!(payload.pointer("/config/env/REMOVE_ME").is_none());
            }
            _ => panic!("expected skills.update handled"),
        }

        match dispatcher.handle_request(&status).await {
            RpcDispatchOutcome::Handled(payload) => {
                let skills = payload
                    .pointer("/skills")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let configured = skills
                    .iter()
                    .find(|entry| {
                        entry
                            .pointer("/skillKey")
                            .and_then(serde_json::Value::as_str)
                            == Some("brave-search")
                    })
                    .expect("configured skill present");
                assert_eq!(
                    configured
                        .pointer("/disabled")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
            }
            _ => panic!("expected skills.status handled"),
        }

        let invalid_install = RpcRequestFrame {
            id: "req-skills-install-invalid".to_owned(),
            method: "skills.install".to_owned(),
            params: serde_json::json!({
                "name": "Brave Search",
                "installId": "uv:brave-search",
                "timeoutMs": 500
            }),
        };
        let out = dispatcher.handle_request(&invalid_install).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let install = RpcRequestFrame {
            id: "req-skills-install".to_owned(),
            method: "skills.install".to_owned(),
            params: serde_json::json!({
                "name": "Brave Search",
                "installId": "uv:brave-search",
                "timeoutMs": 120000
            }),
        };
        match dispatcher.handle_request(&install).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/installed")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
            }
            _ => panic!("expected skills.install handled"),
        }

        let bins = RpcRequestFrame {
            id: "req-skills-bins".to_owned(),
            method: "skills.bins".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&bins).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert!(payload
                    .pointer("/bins")
                    .and_then(serde_json::Value::as_array)
                    .is_some());
            }
            _ => panic!("expected skills.bins handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_skills_status_rejects_unknown_agent_id() {
        let dispatcher = RpcDispatcher::new();
        let req = RpcRequestFrame {
            id: "req-skills-status-unknown-agent".to_owned(),
            method: "skills.status".to_owned(),
            params: serde_json::json!({
                "agentId": "missing-agent"
            }),
        };
        let out = dispatcher.handle_request(&req).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));
    }

    #[tokio::test]
    async fn dispatcher_cron_methods_manage_jobs_and_runs() {
        let dispatcher = RpcDispatcher::new();

        let invalid_list = RpcRequestFrame {
            id: "req-cron-list-invalid".to_owned(),
            method: "cron.list".to_owned(),
            params: serde_json::json!({
                "extra": true
            }),
        };
        let out = dispatcher.handle_request(&invalid_list).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let add = RpcRequestFrame {
            id: "req-cron-add".to_owned(),
            method: "cron.add".to_owned(),
            params: serde_json::json!({
                "name": "Ops Reminder",
                "enabled": true,
                "schedule": {
                    "kind": "every",
                    "everyMs": 60_000
                },
                "sessionTarget": "isolated",
                "wakeMode": "next-heartbeat",
                "payload": {
                    "kind": "agentTurn",
                    "message": "run periodic check",
                    "deliver": true,
                    "channel": "telegram",
                    "to": "42",
                    "bestEffortDeliver": true
                }
            }),
        };
        let job_id = match dispatcher.handle_request(&add).await {
            RpcDispatchOutcome::Handled(payload) => {
                let id = payload
                    .pointer("/id")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .expect("cron job id");
                assert_eq!(
                    payload
                        .pointer("/delivery/mode")
                        .and_then(serde_json::Value::as_str),
                    Some("announce")
                );
                assert_eq!(
                    payload
                        .pointer("/delivery/channel")
                        .and_then(serde_json::Value::as_str),
                    Some("telegram")
                );
                id
            }
            _ => panic!("expected cron.add handled"),
        };

        let status = RpcRequestFrame {
            id: "req-cron-status".to_owned(),
            method: "cron.status".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&status).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/enabled")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload.pointer("/jobs").and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                assert_eq!(
                    payload
                        .pointer("/storePath")
                        .and_then(serde_json::Value::as_str),
                    Some(super::CRON_STORE_PATH)
                );
            }
            _ => panic!("expected cron.status handled"),
        }

        let update = RpcRequestFrame {
            id: "req-cron-update".to_owned(),
            method: "cron.update".to_owned(),
            params: serde_json::json!({
                "jobId": job_id.clone(),
                "patch": {
                    "enabled": false,
                    "payload": {
                        "model": "anthropic/claude-sonnet-4-5"
                    }
                }
            }),
        };
        let out = dispatcher.handle_request(&update).await;
        assert!(matches!(out, RpcDispatchOutcome::Handled(_)));

        let run_disabled = RpcRequestFrame {
            id: "req-cron-run-disabled".to_owned(),
            method: "cron.run".to_owned(),
            params: serde_json::json!({
                "id": job_id.clone(),
                "mode": "due"
            }),
        };
        match dispatcher.handle_request(&run_disabled).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("skipped")
                );
            }
            _ => panic!("expected cron.run handled for disabled job"),
        }

        let enable = RpcRequestFrame {
            id: "req-cron-enable".to_owned(),
            method: "cron.update".to_owned(),
            params: serde_json::json!({
                "id": job_id.clone(),
                "patch": {
                    "enabled": true
                }
            }),
        };
        let out = dispatcher.handle_request(&enable).await;
        assert!(matches!(out, RpcDispatchOutcome::Handled(_)));

        let run = RpcRequestFrame {
            id: "req-cron-run".to_owned(),
            method: "cron.run".to_owned(),
            params: serde_json::json!({
                "id": job_id.clone(),
                "mode": "force"
            }),
        };
        match dispatcher.handle_request(&run).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("ok")
                );
                assert_eq!(
                    payload
                        .pointer("/action")
                        .and_then(serde_json::Value::as_str),
                    Some("finished")
                );
            }
            _ => panic!("expected cron.run handled"),
        }

        let runs = RpcRequestFrame {
            id: "req-cron-runs".to_owned(),
            method: "cron.runs".to_owned(),
            params: serde_json::json!({
                "id": job_id.clone(),
                "limit": 50
            }),
        };
        match dispatcher.handle_request(&runs).await {
            RpcDispatchOutcome::Handled(payload) => {
                let entries = payload
                    .pointer("/entries")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                assert!(!entries.is_empty());
                assert_eq!(
                    entries
                        .last()
                        .and_then(|entry| entry.pointer("/jobId"))
                        .and_then(serde_json::Value::as_str),
                    Some(job_id.as_str())
                );
            }
            _ => panic!("expected cron.runs handled"),
        }

        let remove = RpcRequestFrame {
            id: "req-cron-remove".to_owned(),
            method: "cron.remove".to_owned(),
            params: serde_json::json!({
                "id": job_id.clone()
            }),
        };
        match dispatcher.handle_request(&remove).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/removed")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
            }
            _ => panic!("expected cron.remove handled"),
        }

        let list_after_remove = RpcRequestFrame {
            id: "req-cron-list-after-remove".to_owned(),
            method: "cron.list".to_owned(),
            params: serde_json::json!({
                "includeDisabled": true
            }),
        };
        match dispatcher.handle_request(&list_after_remove).await {
            RpcDispatchOutcome::Handled(payload) => {
                let jobs = payload
                    .pointer("/jobs")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                assert!(jobs.is_empty());
            }
            _ => panic!("expected cron.list handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_cron_update_rejects_payload_kind_change_and_invalid_webhook() {
        let dispatcher = RpcDispatcher::new();

        let add = RpcRequestFrame {
            id: "req-cron-kind-add".to_owned(),
            method: "cron.add".to_owned(),
            params: serde_json::json!({
                "name": "System Event Job",
                "schedule": {
                    "kind": "every",
                    "everyMs": 30_000
                },
                "sessionTarget": "main",
                "wakeMode": "next-heartbeat",
                "payload": {
                    "kind": "systemEvent",
                    "text": "hello"
                }
            }),
        };
        let job_id = match dispatcher.handle_request(&add).await {
            RpcDispatchOutcome::Handled(payload) => payload
                .pointer("/id")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
                .expect("cron id"),
            _ => panic!("expected cron.add handled"),
        };

        let kind_change = RpcRequestFrame {
            id: "req-cron-kind-update".to_owned(),
            method: "cron.update".to_owned(),
            params: serde_json::json!({
                "id": job_id.clone(),
                "patch": {
                    "payload": {
                        "kind": "agentTurn",
                        "message": "not allowed"
                    }
                }
            }),
        };
        let out = dispatcher.handle_request(&kind_change).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let invalid_webhook = RpcRequestFrame {
            id: "req-cron-webhook-invalid".to_owned(),
            method: "cron.add".to_owned(),
            params: serde_json::json!({
                "name": "Invalid webhook",
                "schedule": {
                    "kind": "every",
                    "everyMs": 60_000
                },
                "sessionTarget": "main",
                "wakeMode": "next-heartbeat",
                "payload": {
                    "kind": "systemEvent",
                    "text": "x"
                },
                "delivery": {
                    "mode": "webhook",
                    "to": "ftp://example.invalid"
                }
            }),
        };
        let out = dispatcher.handle_request(&invalid_webhook).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));
    }
}
