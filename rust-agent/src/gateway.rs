use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};
use unicode_normalization::UnicodeNormalization;
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
                    name: "tts.status",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "tts.enable",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "tts.disable",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "tts.convert",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "tts.setprovider",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "tts.providers",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "voicewake.get",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "voicewake.set",
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
                    name: "agent",
                    family: MethodFamily::Agent,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "agent.identity.get",
                    family: MethodFamily::Agent,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "agent.wait",
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
                    name: "update.run",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "web.login.start",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "web.login.wait",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "wizard.start",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "wizard.next",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "wizard.cancel",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "wizard.status",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "device.pair.list",
                    family: MethodFamily::Pairing,
                    requires_auth: true,
                    min_role: "owner",
                },
                MethodSpec {
                    name: "device.pair.approve",
                    family: MethodFamily::Pairing,
                    requires_auth: true,
                    min_role: "owner",
                },
                MethodSpec {
                    name: "device.pair.reject",
                    family: MethodFamily::Pairing,
                    requires_auth: true,
                    min_role: "owner",
                },
                MethodSpec {
                    name: "device.pair.remove",
                    family: MethodFamily::Pairing,
                    requires_auth: true,
                    min_role: "owner",
                },
                MethodSpec {
                    name: "device.token.rotate",
                    family: MethodFamily::Pairing,
                    requires_auth: true,
                    min_role: "owner",
                },
                MethodSpec {
                    name: "device.token.revoke",
                    family: MethodFamily::Pairing,
                    requires_auth: true,
                    min_role: "owner",
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
                    name: "node.pair.request",
                    family: MethodFamily::Node,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "node.pair.list",
                    family: MethodFamily::Node,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "node.pair.approve",
                    family: MethodFamily::Node,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "node.pair.reject",
                    family: MethodFamily::Node,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "node.pair.verify",
                    family: MethodFamily::Node,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "node.rename",
                    family: MethodFamily::Node,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "node.list",
                    family: MethodFamily::Node,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "node.describe",
                    family: MethodFamily::Node,
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
                    name: "node.invoke.result",
                    family: MethodFamily::Node,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "node.event",
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
                    name: "chat.history",
                    family: MethodFamily::Message,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "send",
                    family: MethodFamily::Message,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "poll",
                    family: MethodFamily::Message,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "chat.send",
                    family: MethodFamily::Message,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "chat.abort",
                    family: MethodFamily::Message,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "chat.inject",
                    family: MethodFamily::Message,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "browser.request",
                    family: MethodFamily::Browser,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "exec.approvals.get",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "owner",
                },
                MethodSpec {
                    name: "exec.approvals.set",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "owner",
                },
                MethodSpec {
                    name: "exec.approvals.node.get",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "owner",
                },
                MethodSpec {
                    name: "exec.approvals.node.set",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "owner",
                },
                MethodSpec {
                    name: "exec.approval.request",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "exec.approval.waitdecision",
                    family: MethodFamily::Gateway,
                    requires_auth: true,
                    min_role: "client",
                },
                MethodSpec {
                    name: "exec.approval.resolve",
                    family: MethodFamily::Gateway,
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
    tts: TtsRegistry,
    voicewake: VoiceWakeRegistry,
    models: ModelRegistry,
    agents: AgentRegistry,
    agent_runs: AgentRunRegistry,
    nodes: NodePairRegistry,
    node_runtime: NodeRuntimeRegistry,
    exec_approvals: ExecApprovalsRegistry,
    exec_approval: ExecApprovalRegistry,
    chat: ChatRegistry,
    send: SendRegistry,
    skills: SkillsRegistry,
    cron: CronRegistry,
    config: ConfigRegistry,
    web_login: WebLoginRegistry,
    wizard: WizardRegistry,
    devices: DeviceRegistry,
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
const EXEC_APPROVALS_GLOBAL_PATH: &str = "memory://exec-approvals.json";
const EXEC_APPROVALS_SOCKET_PATH: &str = "memory://exec-approvals.sock";
const MAX_EXEC_APPROVALS_NODE_SNAPSHOTS: usize = 512;
const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS: u64 = 120_000;
const MAX_EXEC_APPROVAL_PENDING: usize = 4_096;
const EXEC_APPROVAL_RESOLVED_GRACE_MS: u64 = 15_000;
const AGENT_RUN_COMPLETE_DELAY_MS: u64 = 25;
const MAX_CHAT_RUNS: usize = 4_096;
const CHAT_RUN_COMPLETE_DELAY_MS: u64 = 25;
const MAX_SEND_CACHE_ENTRIES: usize = 4_096;
const DEFAULT_SEND_CHANNEL: &str = "whatsapp";
const TTS_PREFS_PATH: &str = "memory://tts/prefs.json";
const TTS_OPENAI_MODELS: &[&str] = &["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];
const TTS_OPENAI_VOICES: &[&str] = &[
    "alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "juniper", "marin", "onyx",
    "nova", "sage", "shimmer", "verse",
];
const TTS_ELEVENLABS_MODELS: &[&str] = &[
    "eleven_multilingual_v2",
    "eleven_turbo_v2_5",
    "eleven_monolingual_v1",
];
const DEFAULT_VOICEWAKE_TRIGGERS: &[&str] = &["openclaw", "claude", "computer"];
static SESSION_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static CRON_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static WEB_LOGIN_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static WIZARD_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static DEVICE_TOKEN_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static NODE_PAIR_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static NODE_TOKEN_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static NODE_INVOKE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static EXEC_APPROVAL_TOKEN_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static EXEC_APPROVAL_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static CHAT_INJECT_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static SEND_MESSAGE_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static POLL_ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static TTS_AUDIO_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const SUPPORTED_RPC_METHODS: &[&str] = &[
    "connect",
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
    "tts.status",
    "tts.enable",
    "tts.disable",
    "tts.convert",
    "tts.setProvider",
    "tts.providers",
    "voicewake.get",
    "voicewake.set",
    "models.list",
    "agents.list",
    "agents.create",
    "agents.update",
    "agents.delete",
    "agents.files.list",
    "agents.files.get",
    "agents.files.set",
    "agent",
    "agent.identity.get",
    "agent.wait",
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
    "update.run",
    "web.login.start",
    "web.login.wait",
    "wizard.start",
    "wizard.next",
    "wizard.cancel",
    "wizard.status",
    "device.pair.list",
    "device.pair.approve",
    "device.pair.reject",
    "device.pair.remove",
    "device.token.rotate",
    "device.token.revoke",
    "node.pair.request",
    "node.pair.list",
    "node.pair.approve",
    "node.pair.reject",
    "node.pair.verify",
    "node.rename",
    "node.list",
    "node.describe",
    "node.invoke",
    "node.invoke.result",
    "node.event",
    "browser.request",
    "exec.approvals.get",
    "exec.approvals.set",
    "exec.approvals.node.get",
    "exec.approvals.node.set",
    "exec.approval.request",
    "exec.approval.waitDecision",
    "exec.approval.resolve",
    "chat.history",
    "send",
    "poll",
    "chat.send",
    "chat.abort",
    "chat.inject",
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
            tts: TtsRegistry::new(),
            voicewake: VoiceWakeRegistry::new(),
            models: ModelRegistry::new(),
            agents: AgentRegistry::new(),
            agent_runs: AgentRunRegistry::new(),
            nodes: NodePairRegistry::new(),
            node_runtime: NodeRuntimeRegistry::new(),
            exec_approvals: ExecApprovalsRegistry::new(),
            exec_approval: ExecApprovalRegistry::new(),
            chat: ChatRegistry::new(),
            send: SendRegistry::new(),
            skills: SkillsRegistry::new(),
            cron: CronRegistry::new(),
            config: ConfigRegistry::new(),
            web_login: WebLoginRegistry::new(),
            wizard: WizardRegistry::new(),
            devices: DeviceRegistry::new(),
            channel_capabilities,
            started_at_ms: now_ms(),
        }
    }

    pub async fn handle_request(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        match normalize(&req.method).as_str() {
            "connect" => self.handle_connect().await,
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
            "tts.status" => self.handle_tts_status(req).await,
            "tts.enable" => self.handle_tts_enable(req).await,
            "tts.disable" => self.handle_tts_disable(req).await,
            "tts.convert" => self.handle_tts_convert(req).await,
            "tts.setprovider" => self.handle_tts_set_provider(req).await,
            "tts.providers" => self.handle_tts_providers(req).await,
            "voicewake.get" => self.handle_voicewake_get(req).await,
            "voicewake.set" => self.handle_voicewake_set(req).await,
            "models.list" => self.handle_models_list(req).await,
            "agents.list" => self.handle_agents_list(req).await,
            "agents.create" => self.handle_agents_create(req).await,
            "agents.update" => self.handle_agents_update(req).await,
            "agents.delete" => self.handle_agents_delete(req).await,
            "agents.files.list" => self.handle_agents_files_list(req).await,
            "agents.files.get" => self.handle_agents_files_get(req).await,
            "agents.files.set" => self.handle_agents_files_set(req).await,
            "agent" => self.handle_agent(req).await,
            "agent.identity.get" => self.handle_agent_identity_get(req).await,
            "agent.wait" => self.handle_agent_wait(req).await,
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
            "update.run" => self.handle_update_run(req).await,
            "web.login.start" => self.handle_web_login_start(req).await,
            "web.login.wait" => self.handle_web_login_wait(req).await,
            "wizard.start" => self.handle_wizard_start(req).await,
            "wizard.next" => self.handle_wizard_next(req).await,
            "wizard.cancel" => self.handle_wizard_cancel(req).await,
            "wizard.status" => self.handle_wizard_status(req).await,
            "device.pair.list" => self.handle_device_pair_list(req).await,
            "device.pair.approve" => self.handle_device_pair_approve(req).await,
            "device.pair.reject" => self.handle_device_pair_reject(req).await,
            "device.pair.remove" => self.handle_device_pair_remove(req).await,
            "device.token.rotate" => self.handle_device_token_rotate(req).await,
            "device.token.revoke" => self.handle_device_token_revoke(req).await,
            "node.pair.request" => self.handle_node_pair_request(req).await,
            "node.pair.list" => self.handle_node_pair_list(req).await,
            "node.pair.approve" => self.handle_node_pair_approve(req).await,
            "node.pair.reject" => self.handle_node_pair_reject(req).await,
            "node.pair.verify" => self.handle_node_pair_verify(req).await,
            "node.rename" => self.handle_node_rename(req).await,
            "node.list" => self.handle_node_list(req).await,
            "node.describe" => self.handle_node_describe(req).await,
            "node.invoke" => self.handle_node_invoke(req).await,
            "node.invoke.result" => self.handle_node_invoke_result(req).await,
            "node.event" => self.handle_node_event(req).await,
            "browser.request" => self.handle_browser_request(req).await,
            "exec.approvals.get" => self.handle_exec_approvals_get(req).await,
            "exec.approvals.set" => self.handle_exec_approvals_set(req).await,
            "exec.approvals.node.get" => self.handle_exec_approvals_node_get(req).await,
            "exec.approvals.node.set" => self.handle_exec_approvals_node_set(req).await,
            "exec.approval.request" => self.handle_exec_approval_request(req).await,
            "exec.approval.waitdecision" => self.handle_exec_approval_wait_decision(req).await,
            "exec.approval.resolve" => self.handle_exec_approval_resolve(req).await,
            "chat.history" => self.handle_chat_history(req).await,
            "send" => self.handle_send(req).await,
            "poll" => self.handle_poll(req).await,
            "chat.send" => self.handle_chat_send(req).await,
            "chat.abort" => self.handle_chat_abort(req).await,
            "chat.inject" => self.handle_chat_inject(req).await,
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
            "device.pair.requested" => {
                self.devices.ingest_pair_requested(payload).await;
            }
            "device.pair.resolved" => {
                self.devices.ingest_pair_resolved(payload).await;
            }
            "node.pair.requested" => {
                self.nodes.ingest_pair_requested(payload).await;
            }
            "node.pair.resolved" => {
                self.nodes.ingest_pair_resolved(payload).await;
            }
            _ => {}
        }
    }

    async fn handle_connect(&self) -> RpcDispatchOutcome {
        RpcDispatchOutcome::bad_request("connect is only valid as the first request")
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

    async fn handle_tts_status(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        if let Err(err) = decode_params::<TtsStatusParams>(&req.params) {
            return RpcDispatchOutcome::bad_request(format!("invalid tts.status params: {err}"));
        }
        let state = self.tts.snapshot().await;
        let fallback_providers = tts_fallback_providers(&state.provider);
        let fallback_provider = fallback_providers.first().cloned();
        RpcDispatchOutcome::Handled(json!({
            "enabled": state.enabled,
            "auto": state.auto_mode,
            "provider": state.provider,
            "fallbackProvider": fallback_provider,
            "fallbackProviders": fallback_providers,
            "prefsPath": TTS_PREFS_PATH,
            "hasOpenAIKey": false,
            "hasElevenLabsKey": false,
            "edgeEnabled": true
        }))
    }

    async fn handle_tts_enable(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        if let Err(err) = decode_params::<TtsToggleParams>(&req.params) {
            return RpcDispatchOutcome::bad_request(format!("invalid tts.enable params: {err}"));
        }
        let state = self.tts.set_enabled(true).await;
        RpcDispatchOutcome::Handled(json!({
            "enabled": state.enabled
        }))
    }

    async fn handle_tts_disable(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        if let Err(err) = decode_params::<TtsToggleParams>(&req.params) {
            return RpcDispatchOutcome::bad_request(format!("invalid tts.disable params: {err}"));
        }
        let state = self.tts.set_enabled(false).await;
        RpcDispatchOutcome::Handled(json!({
            "enabled": state.enabled
        }))
    }

    async fn handle_tts_convert(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<TtsConvertParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid tts.convert params: {err}"
                ));
            }
        };
        let Some(text) = normalize_optional_text(params.text, 16_000) else {
            return RpcDispatchOutcome::bad_request("tts.convert requires text");
        };
        let channel = normalize_optional_text(params.channel, 64).map(|value| normalize(&value));
        let state = self.tts.snapshot().await;
        let (output_format, extension, voice_compatible) = if channel.as_deref() == Some("telegram")
        {
            ("opus", ".opus", true)
        } else {
            ("mp3", ".mp3", false)
        };
        let audio_path = next_tts_audio_path(extension);
        self.system
            .log_line(format!(
                "tts.convert provider={} channel={} chars={}",
                state.provider,
                channel.unwrap_or_else(|| "default".to_owned()),
                text.chars().count()
            ))
            .await;
        RpcDispatchOutcome::Handled(json!({
            "audioPath": audio_path,
            "provider": state.provider,
            "outputFormat": output_format,
            "voiceCompatible": voice_compatible
        }))
    }

    async fn handle_tts_set_provider(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<TtsSetProviderParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid tts.setProvider params: {err}"
                ));
            }
        };
        let provider = normalize_optional_text(params.provider, 32)
            .map(|value| normalize(&value))
            .unwrap_or_default();
        if !is_supported_tts_provider(&provider) {
            return RpcDispatchOutcome::bad_request(
                "Invalid provider. Use openai, elevenlabs, or edge.",
            );
        }
        let state = self.tts.set_provider(provider.clone()).await;
        RpcDispatchOutcome::Handled(json!({
            "provider": state.provider
        }))
    }

    async fn handle_tts_providers(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        if let Err(err) = decode_params::<TtsProvidersParams>(&req.params) {
            return RpcDispatchOutcome::bad_request(format!("invalid tts.providers params: {err}"));
        }
        let active = self.tts.snapshot().await.provider;
        RpcDispatchOutcome::Handled(json!({
            "providers": [
                {
                    "id": "openai",
                    "name": "OpenAI",
                    "configured": false,
                    "models": TTS_OPENAI_MODELS,
                    "voices": TTS_OPENAI_VOICES
                },
                {
                    "id": "elevenlabs",
                    "name": "ElevenLabs",
                    "configured": false,
                    "models": TTS_ELEVENLABS_MODELS
                },
                {
                    "id": "edge",
                    "name": "Edge TTS",
                    "configured": true,
                    "models": []
                }
            ],
            "active": active
        }))
    }

    async fn handle_voicewake_get(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        if let Err(err) = decode_params::<VoiceWakeGetParams>(&req.params) {
            return RpcDispatchOutcome::bad_request(format!("invalid voicewake.get params: {err}"));
        }
        let state = self.voicewake.snapshot().await;
        RpcDispatchOutcome::Handled(json!({
            "triggers": state.triggers
        }))
    }

    async fn handle_voicewake_set(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<VoiceWakeSetParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid voicewake.set params: {err}"
                ));
            }
        };
        let Some(triggers_raw) = params.triggers else {
            return RpcDispatchOutcome::bad_request("voicewake.set requires triggers: string[]");
        };
        let Some(values) = triggers_raw.as_array() else {
            return RpcDispatchOutcome::bad_request("voicewake.set requires triggers: string[]");
        };
        let normalized = normalize_voicewake_triggers(values);
        let state = self.voicewake.set_triggers(normalized.clone()).await;
        let payload_json = serde_json::to_string(&json!({ "triggers": normalized }))
            .ok()
            .filter(|value| !value.is_empty());
        self.node_runtime
            .record_event("voicewake.changed".to_owned(), payload_json)
            .await;
        self.system
            .log_line(format!("voicewake.set triggers={}", state.triggers.len()))
            .await;
        RpcDispatchOutcome::Handled(json!({
            "triggers": state.triggers
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

    async fn handle_agent(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<AgentParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!("invalid agent params: {err}"))
            }
        };
        let _ = (
            params.agent_id.as_deref(),
            params.session_id.as_deref(),
            params.thinking.as_deref(),
            params.deliver,
            params.thread_id.as_deref(),
            params.group_id.as_deref(),
            params.group_channel.as_deref(),
            params.group_space.as_deref(),
            params.timeout,
            params.lane.as_deref(),
            params.extra_system_prompt.as_deref(),
            params.input_provenance.as_ref(),
            params.label.as_deref(),
            params.spawned_by.as_deref(),
        );
        let Some(run_id) = normalize_optional_text(Some(params.idempotency_key), 256) else {
            return RpcDispatchOutcome::bad_request(
                "invalid agent params: idempotencyKey is required",
            );
        };
        match self.agent_runs.start_run(&run_id).await {
            AgentRunStartOutcome::InFlight => {
                return RpcDispatchOutcome::Handled(json!({
                    "runId": run_id,
                    "status": "in_flight"
                }));
            }
            AgentRunStartOutcome::Completed => {
                return RpcDispatchOutcome::Handled(json!({
                    "runId": run_id,
                    "status": "ok"
                }));
            }
            AgentRunStartOutcome::Started => {}
        }
        let session_key = normalize_optional_text(params.session_key, 512)
            .map(|value| canonicalize_session_key(&value))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| canonicalize_session_key(DEFAULT_MAIN_KEY));
        if session_key.is_empty() {
            return RpcDispatchOutcome::bad_request("invalid agent params: sessionKey is required");
        }
        let sanitized_message = match sanitize_chat_send_message_input(&params.message) {
            Ok(value) => value,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let has_attachments = params
            .attachments
            .as_ref()
            .map(|value| !value.is_empty())
            .unwrap_or(false);
        let message = normalize_optional_text(Some(sanitized_message.clone()), 12_000);
        if message.is_none() && !has_attachments {
            return RpcDispatchOutcome::bad_request("invalid agent params: message is required");
        }
        let reset_command = if has_attachments {
            None
        } else {
            parse_agent_reset_command(&sanitized_message)
        };
        let channel = normalize_optional_text(params.reply_channel.or(params.channel), 128);
        let to = normalize_optional_text(params.reply_to.or(params.to), 256);
        let account_id =
            normalize_optional_text(params.reply_account_id.or(params.account_id), 128);
        let mut reset_payload = None;
        let stored_message = if let Some((reason, followup_message)) = reset_command {
            let reset = self.sessions.reset(&session_key, reason.to_owned()).await;
            reset_payload = Some(json!({
                "key": session_key.clone(),
                "reason": reason,
                "sessionId": reset.session.session_id
            }));
            followup_message.and_then(|value| normalize_optional_text(Some(value), 12_000))
        } else {
            message
        }
        .or_else(|| has_attachments.then(|| "[attachment]".to_owned()));
        if stored_message.is_some() {
            let _ = self
                .sessions
                .record_send(SessionSend {
                    session_key,
                    request_id: Some(run_id.clone()),
                    message: stored_message,
                    command: None,
                    source: "agent".to_owned(),
                    channel,
                    to,
                    account_id,
                })
                .await;
        }
        let agent_runs = self.agent_runs.clone();
        let complete_run_id = run_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(AGENT_RUN_COMPLETE_DELAY_MS)).await;
            agent_runs.complete_ok(complete_run_id).await;
        });
        let mut payload = json!({
            "runId": run_id,
            "status": "started"
        });
        if let Some(reset) = reset_payload {
            payload["reset"] = reset;
        }
        RpcDispatchOutcome::Handled(payload)
    }

    async fn handle_agent_identity_get(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<AgentIdentityParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid agent.identity.get params: {err}"
                ));
            }
        };
        let explicit_agent_id = params
            .agent_id
            .and_then(|value| normalize_optional_text(Some(value), 64))
            .map(|value| normalize_agent_id(&value));
        let session_agent_id = match params
            .session_key
            .and_then(|value| normalize_optional_text(Some(value), 512))
        {
            Some(session_key) => match resolve_agent_id_from_session_key_input(&session_key) {
                Ok(agent_id) => Some(agent_id),
                Err(err) => return RpcDispatchOutcome::bad_request(err),
            },
            None => None,
        };
        if let (Some(explicit), Some(from_session)) = (&explicit_agent_id, &session_agent_id) {
            if !explicit.eq_ignore_ascii_case(from_session) {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid agent.identity.get params: agent \"{explicit}\" does not match session key agent \"{from_session}\""
                ));
            }
        }
        let identity = match self
            .agents
            .identity(explicit_agent_id.or(session_agent_id))
            .await
        {
            Ok(value) => value,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        RpcDispatchOutcome::Handled(json!(identity))
    }

    async fn handle_agent_wait(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<AgentWaitParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid agent.wait params: {err}"
                ));
            }
        };
        let run_id = match normalize_optional_text(Some(params.run_id), 256) {
            Some(value) => value,
            None => {
                return RpcDispatchOutcome::bad_request(
                    "invalid agent.wait params: runId is required",
                );
            }
        };
        let timeout_ms = params.timeout_ms.unwrap_or(30_000);
        let snapshot = self.agent_runs.wait(&run_id, timeout_ms).await;
        if let Some(snapshot) = snapshot {
            return RpcDispatchOutcome::Handled(json!({
                "runId": run_id,
                "status": snapshot.status,
                "startedAt": snapshot.started_at,
                "endedAt": snapshot.ended_at,
                "error": snapshot.error
            }));
        }
        RpcDispatchOutcome::Handled(json!({
            "runId": run_id,
            "status": "timeout"
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

    async fn handle_update_run(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<UpdateRunParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid update.run params: {err}"
                ));
            }
        };

        let session_key = normalize_optional_text(params.session_key, 256);
        let note = normalize_optional_text(params.note, 512);
        let restart_delay_ms = params.restart_delay_ms.unwrap_or(0);
        let timeout_ms = params
            .timeout_ms
            .map(|value| value.max(1_000))
            .unwrap_or(30_000);
        let (delivery_context, thread_id) = extract_update_delivery_info(session_key.as_deref());

        let step = json!({
            "name": "noop",
            "command": "rust-agent parity update stub",
            "cwd": ".",
            "durationMs": 0,
            "log": {
                "stdoutTail": Value::Null,
                "stderrTail": Value::Null,
                "exitCode": 0
            }
        });
        let result = json!({
            "status": "ok",
            "mode": "rust-parity",
            "root": "memory://openclaw-rust-agent",
            "before": Value::Null,
            "after": Value::Null,
            "steps": [step.clone()],
            "durationMs": 0
        });
        let sentinel_payload = json!({
            "kind": "update",
            "status": "ok",
            "ts": now_ms(),
            "sessionKey": session_key,
            "deliveryContext": delivery_context,
            "threadId": thread_id,
            "message": note,
            "doctorHint": "Run `openclaw doctor --non-interactive` after restart.",
            "stats": {
                "mode": "rust-parity",
                "root": "memory://openclaw-rust-agent",
                "before": Value::Null,
                "after": Value::Null,
                "steps": [step],
                "reason": Value::Null,
                "durationMs": 0,
                "timeoutMs": timeout_ms
            }
        });
        let sentinel_path = format!("memory://restart-sentinel/update-{}", now_ms());
        self.system
            .log_line(format!(
                "update.run status=ok restartDelayMs={restart_delay_ms}"
            ))
            .await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "result": result,
            "restart": {
                "scheduled": true,
                "delayMs": restart_delay_ms,
                "reason": "update.run",
                "signal": "SIGUSR1"
            },
            "sentinel": {
                "path": sentinel_path,
                "payload": sentinel_payload
            }
        }))
    }

    async fn handle_web_login_start(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<WebLoginStartParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid web.login.start params: {err}"
                ));
            }
        };
        let Some(provider_id) = resolve_web_login_provider(&self.channel_capabilities) else {
            return RpcDispatchOutcome::bad_request("web login provider is not available");
        };
        let start = self
            .web_login
            .start(WebLoginStartInput {
                provider_id: provider_id.clone(),
                account_id: normalize_optional_text(params.account_id, 64)
                    .unwrap_or_else(|| "default".to_owned()),
                force: params.force.unwrap_or(false),
                verbose: params.verbose.unwrap_or(false),
                timeout_ms: params.timeout_ms.unwrap_or(30_000),
            })
            .await;
        self.system
            .log_line(format!(
                "web.login.start provider={} account={}",
                start.provider_id, start.account_id
            ))
            .await;
        RpcDispatchOutcome::Handled(json!(start))
    }

    async fn handle_web_login_wait(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<WebLoginWaitParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid web.login.wait params: {err}"
                ));
            }
        };
        let Some(provider_id) = resolve_web_login_provider(&self.channel_capabilities) else {
            return RpcDispatchOutcome::bad_request("web login provider is not available");
        };
        let wait = self
            .web_login
            .wait(WebLoginWaitInput {
                provider_id: provider_id.clone(),
                account_id: normalize_optional_text(params.account_id, 64)
                    .unwrap_or_else(|| "default".to_owned()),
                timeout_ms: params.timeout_ms.unwrap_or(120_000),
            })
            .await;
        self.system
            .log_line(format!(
                "web.login.wait provider={} account={} connected={}",
                wait.provider_id, wait.account_id, wait.connected
            ))
            .await;
        RpcDispatchOutcome::Handled(json!(wait))
    }

    async fn handle_wizard_start(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<WizardStartParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid wizard.start params: {err}"
                ));
            }
        };
        let mode = match parse_wizard_mode(params.mode) {
            Ok(mode) => mode,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let workspace = normalize_optional_text(params.workspace, 1_024);
        let result = match self.wizard.start(mode, workspace).await {
            Ok(v) => v,
            Err(WizardRegistryError::Unavailable(message)) => {
                return RpcDispatchOutcome::Error {
                    code: 503,
                    message,
                    details: None,
                };
            }
            Err(WizardRegistryError::Invalid(message)) => {
                return RpcDispatchOutcome::bad_request(message);
            }
        };
        self.system.log_line("wizard.start".to_owned()).await;
        RpcDispatchOutcome::Handled(result)
    }

    async fn handle_wizard_next(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<WizardNextParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid wizard.next params: {err}"
                ));
            }
        };
        let result = match self.wizard.next(params).await {
            Ok(v) => v,
            Err(WizardRegistryError::Unavailable(message)) => {
                return RpcDispatchOutcome::Error {
                    code: 503,
                    message,
                    details: None,
                };
            }
            Err(WizardRegistryError::Invalid(message)) => {
                return RpcDispatchOutcome::bad_request(message);
            }
        };
        self.system.log_line("wizard.next".to_owned()).await;
        RpcDispatchOutcome::Handled(result)
    }

    async fn handle_wizard_cancel(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<WizardSessionParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid wizard.cancel params: {err}"
                ));
            }
        };
        let Some(session_id) = normalize_optional_text(params.session_id, 128) else {
            return RpcDispatchOutcome::bad_request(
                "invalid wizard.cancel params: sessionId required",
            );
        };
        let result = match self.wizard.cancel(&session_id).await {
            Ok(v) => v,
            Err(WizardRegistryError::Unavailable(message)) => {
                return RpcDispatchOutcome::Error {
                    code: 503,
                    message,
                    details: None,
                };
            }
            Err(WizardRegistryError::Invalid(message)) => {
                return RpcDispatchOutcome::bad_request(message);
            }
        };
        self.system.log_line("wizard.cancel".to_owned()).await;
        RpcDispatchOutcome::Handled(result)
    }

    async fn handle_wizard_status(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<WizardSessionParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid wizard.status params: {err}"
                ));
            }
        };
        let Some(session_id) = normalize_optional_text(params.session_id, 128) else {
            return RpcDispatchOutcome::bad_request(
                "invalid wizard.status params: sessionId required",
            );
        };
        let result = match self.wizard.status(&session_id).await {
            Ok(v) => v,
            Err(WizardRegistryError::Unavailable(message)) => {
                return RpcDispatchOutcome::Error {
                    code: 503,
                    message,
                    details: None,
                };
            }
            Err(WizardRegistryError::Invalid(message)) => {
                return RpcDispatchOutcome::bad_request(message);
            }
        };
        RpcDispatchOutcome::Handled(result)
    }

    async fn handle_device_pair_list(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        if let Err(err) = decode_params::<DevicePairListParams>(&req.params) {
            return RpcDispatchOutcome::bad_request(format!(
                "invalid device.pair.list params: {err}"
            ));
        }
        let list = self.devices.list().await;
        RpcDispatchOutcome::Handled(json!(list))
    }

    async fn handle_device_pair_approve(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<DevicePairApproveParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid device.pair.approve params: {err}"
                ));
            }
        };
        let Some(request_id) = normalize_optional_text(Some(params.request_id), 128) else {
            return RpcDispatchOutcome::bad_request(
                "invalid device.pair.approve params: requestId required",
            );
        };
        let Some(approved) = self.devices.approve(&request_id).await else {
            return RpcDispatchOutcome::bad_request("unknown requestId");
        };
        self.system
            .log_line(format!(
                "device pairing approved device={} role={}",
                approved.device.device_id,
                approved.device.role.as_deref().unwrap_or("unknown")
            ))
            .await;
        RpcDispatchOutcome::Handled(json!(approved))
    }

    async fn handle_device_pair_reject(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<DevicePairRejectParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid device.pair.reject params: {err}"
                ));
            }
        };
        let Some(request_id) = normalize_optional_text(Some(params.request_id), 128) else {
            return RpcDispatchOutcome::bad_request(
                "invalid device.pair.reject params: requestId required",
            );
        };
        let Some(rejected) = self.devices.reject(&request_id).await else {
            return RpcDispatchOutcome::bad_request("unknown requestId");
        };
        RpcDispatchOutcome::Handled(json!(rejected))
    }

    async fn handle_device_pair_remove(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<DevicePairRemoveParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid device.pair.remove params: {err}"
                ));
            }
        };
        let Some(device_id) = normalize_optional_text(Some(params.device_id), 128) else {
            return RpcDispatchOutcome::bad_request(
                "invalid device.pair.remove params: deviceId required",
            );
        };
        let Some(removed) = self.devices.remove(&device_id).await else {
            return RpcDispatchOutcome::bad_request("unknown deviceId");
        };
        self.system
            .log_line(format!(
                "device pairing removed device={}",
                removed.device_id
            ))
            .await;
        RpcDispatchOutcome::Handled(json!(removed))
    }

    async fn handle_device_token_rotate(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<DeviceTokenRotateParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid device.token.rotate params: {err}"
                ));
            }
        };
        let Some(device_id) = normalize_optional_text(Some(params.device_id), 128) else {
            return RpcDispatchOutcome::bad_request(
                "invalid device.token.rotate params: deviceId required",
            );
        };
        let Some(role) = normalize_optional_text(Some(params.role), 64) else {
            return RpcDispatchOutcome::bad_request(
                "invalid device.token.rotate params: role required",
            );
        };
        let Some(token) = self
            .devices
            .rotate_token(&device_id, &role, params.scopes)
            .await
        else {
            return RpcDispatchOutcome::bad_request("unknown deviceId/role");
        };
        self.system
            .log_line(format!(
                "device token rotated device={} role={} scopes={}",
                device_id,
                token.role,
                token.scopes.join(",")
            ))
            .await;
        RpcDispatchOutcome::Handled(json!({
            "deviceId": device_id,
            "role": token.role,
            "token": token.token,
            "scopes": token.scopes,
            "rotatedAtMs": token.rotated_at_ms.unwrap_or(token.created_at_ms),
        }))
    }

    async fn handle_device_token_revoke(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<DeviceTokenRevokeParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid device.token.revoke params: {err}"
                ));
            }
        };
        let Some(device_id) = normalize_optional_text(Some(params.device_id), 128) else {
            return RpcDispatchOutcome::bad_request(
                "invalid device.token.revoke params: deviceId required",
            );
        };
        let Some(role) = normalize_optional_text(Some(params.role), 64) else {
            return RpcDispatchOutcome::bad_request(
                "invalid device.token.revoke params: role required",
            );
        };
        let Some(token) = self.devices.revoke_token(&device_id, &role).await else {
            return RpcDispatchOutcome::bad_request("unknown deviceId/role");
        };
        self.system
            .log_line(format!(
                "device token revoked device={} role={}",
                device_id, role
            ))
            .await;
        RpcDispatchOutcome::Handled(json!({
            "deviceId": device_id,
            "role": token.role,
            "revokedAtMs": token.revoked_at_ms.unwrap_or_else(now_ms)
        }))
    }

    async fn handle_node_pair_request(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<NodePairRequestParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid node.pair.request params: {err}"
                ));
            }
        };
        let request = match self.nodes.request(params).await {
            Ok(value) => value,
            Err(message) => return RpcDispatchOutcome::bad_request(message),
        };
        self.system
            .log_line(format!(
                "node.pair.request node={} created={}",
                request.request.node_id, request.created
            ))
            .await;
        RpcDispatchOutcome::Handled(json!(request))
    }

    async fn handle_node_pair_list(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        if let Err(err) = decode_params::<NodePairListParams>(&req.params) {
            return RpcDispatchOutcome::bad_request(format!(
                "invalid node.pair.list params: {err}"
            ));
        }
        let list = self.nodes.list().await;
        RpcDispatchOutcome::Handled(json!(list))
    }

    async fn handle_node_pair_approve(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<NodePairApproveParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid node.pair.approve params: {err}"
                ));
            }
        };
        let Some(request_id) = normalize_optional_text(Some(params.request_id), 128) else {
            return RpcDispatchOutcome::bad_request(
                "invalid node.pair.approve params: requestId required",
            );
        };
        let Some(approved) = self.nodes.approve(&request_id).await else {
            return RpcDispatchOutcome::bad_request("unknown requestId");
        };
        self.system
            .log_line(format!(
                "node pairing approved node={}",
                approved.node.node_id
            ))
            .await;
        RpcDispatchOutcome::Handled(json!(approved))
    }

    async fn handle_node_pair_reject(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<NodePairRejectParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid node.pair.reject params: {err}"
                ));
            }
        };
        let Some(request_id) = normalize_optional_text(Some(params.request_id), 128) else {
            return RpcDispatchOutcome::bad_request(
                "invalid node.pair.reject params: requestId required",
            );
        };
        let Some(rejected) = self.nodes.reject(&request_id).await else {
            return RpcDispatchOutcome::bad_request("unknown requestId");
        };
        RpcDispatchOutcome::Handled(json!(rejected))
    }

    async fn handle_node_pair_verify(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<NodePairVerifyParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid node.pair.verify params: {err}"
                ));
            }
        };
        let Some(node_id) = normalize_optional_text(Some(params.node_id), 128) else {
            return RpcDispatchOutcome::bad_request(
                "invalid node.pair.verify params: nodeId required",
            );
        };
        let Some(token) = normalize_optional_text(Some(params.token), 256) else {
            return RpcDispatchOutcome::bad_request(
                "invalid node.pair.verify params: token required",
            );
        };
        let verified = self.nodes.verify(&node_id, &token).await;
        RpcDispatchOutcome::Handled(json!(verified))
    }

    async fn handle_node_rename(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<NodeRenameParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid node.rename params: {err}"
                ));
            }
        };
        let Some(node_id) = normalize_optional_text(Some(params.node_id), 128) else {
            return RpcDispatchOutcome::bad_request("invalid node.rename params: nodeId required");
        };
        let Some(display_name) = normalize_optional_text(Some(params.display_name), 128) else {
            return RpcDispatchOutcome::bad_request("displayName required");
        };
        let Some(renamed) = self.nodes.rename(&node_id, &display_name).await else {
            return RpcDispatchOutcome::bad_request("unknown nodeId");
        };
        RpcDispatchOutcome::Handled(json!(renamed))
    }

    async fn handle_node_list(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        if let Err(err) = decode_params::<NodeListParams>(&req.params) {
            return RpcDispatchOutcome::bad_request(format!("invalid node.list params: {err}"));
        }
        let nodes = self.nodes.list_nodes().await;
        RpcDispatchOutcome::Handled(json!({
            "ts": now_ms(),
            "nodes": nodes
        }))
    }

    async fn handle_node_describe(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<NodeDescribeParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid node.describe params: {err}"
                ));
            }
        };
        let Some(node_id) = normalize_optional_text(Some(params.node_id), 128) else {
            return RpcDispatchOutcome::bad_request("nodeId required");
        };
        let Some(node) = self.nodes.describe_node(&node_id).await else {
            return RpcDispatchOutcome::bad_request("unknown nodeId");
        };
        RpcDispatchOutcome::Handled(json!({
            "ts": now_ms(),
            "nodeId": node.node_id,
            "displayName": node.display_name,
            "platform": node.platform,
            "version": node.version,
            "coreVersion": node.core_version,
            "uiVersion": node.ui_version,
            "deviceFamily": node.device_family,
            "modelIdentifier": node.model_identifier,
            "remoteIp": node.remote_ip,
            "caps": node.caps,
            "commands": node.commands,
            "pathEnv": node.path_env,
            "permissions": node.permissions,
            "connectedAtMs": node.connected_at_ms,
            "paired": node.paired,
            "connected": node.connected
        }))
    }

    async fn handle_node_invoke(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<NodeInvokeParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid node.invoke params: {err}"
                ));
            }
        };
        let Some(node_id) = normalize_optional_text(Some(params.node_id), 128) else {
            return RpcDispatchOutcome::bad_request("nodeId and command required");
        };
        let Some(command) = normalize_optional_text(Some(params.command), 160) else {
            return RpcDispatchOutcome::bad_request("nodeId and command required");
        };
        let Some(idempotency_key) = normalize_optional_text(Some(params.idempotency_key), 256)
        else {
            return RpcDispatchOutcome::bad_request(
                "invalid node.invoke params: idempotencyKey required",
            );
        };
        if command == "system.execApprovals.get" || command == "system.execApprovals.set" {
            return RpcDispatchOutcome::bad_request(
                "node.invoke does not allow system.execApprovals.*; use exec.approvals.node.*",
            );
        }
        let Some(node) = self.nodes.paired_node(&node_id).await else {
            return RpcDispatchOutcome::Error {
                code: 503,
                message: "node not connected".to_owned(),
                details: Some(json!({
                    "code": "NOT_CONNECTED"
                })),
            };
        };
        if !node_command_allowed(&node, &command) {
            return RpcDispatchOutcome::Error {
                code: 400,
                message: "node command not allowed".to_owned(),
                details: Some(json!({
                    "reason": "command-not-declared",
                    "command": command
                })),
            };
        }

        let invoke_id = self
            .node_runtime
            .begin_invoke(&node_id, &command, params.timeout_ms, &idempotency_key)
            .await;
        self.system
            .log_line(format!(
                "node.invoke node={} command={} id={}",
                node_id, command, invoke_id
            ))
            .await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "nodeId": node_id,
            "command": command,
            "payload": {
                "status": "queued",
                "invokeId": invoke_id,
                "idempotencyKey": idempotency_key,
                "mode": "rust-parity",
                "params": params.params,
                "timeoutMs": params.timeout_ms
            },
            "payloadJSON": Value::Null
        }))
    }

    async fn handle_node_invoke_result(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let normalized = normalize_node_invoke_result_params(req.params.clone());
        let params = match decode_params::<NodeInvokeResultParams>(&normalized) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid node.invoke.result params: {err}"
                ));
            }
        };
        let result = self.node_runtime.complete_invoke(params).await;
        match result {
            NodeInvokeCompleteResult::Completed => RpcDispatchOutcome::Handled(json!({
                "ok": true
            })),
            NodeInvokeCompleteResult::Ignored => RpcDispatchOutcome::Handled(json!({
                "ok": true,
                "ignored": true
            })),
            NodeInvokeCompleteResult::NodeMismatch => {
                RpcDispatchOutcome::bad_request("nodeId mismatch")
            }
        }
    }

    async fn handle_node_event(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<NodeEventParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid node.event params: {err}"
                ));
            }
        };
        let Some(event) = normalize_optional_text(Some(params.event), 160) else {
            return RpcDispatchOutcome::bad_request("invalid node.event params: event required");
        };
        let payload_json = params.payload_json.or_else(|| {
            params
                .payload
                .as_ref()
                .and_then(|value| serde_json::to_string(value).ok())
        });
        self.node_runtime
            .record_event(event.clone(), payload_json.clone())
            .await;
        self.system
            .log_line(format!(
                "node.event event={} payloadBytes={}",
                event,
                payload_json.as_ref().map_or(0, |value| value.len())
            ))
            .await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true
        }))
    }

    async fn handle_browser_request(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = req.params.as_object();
        let method = params
            .and_then(|value| value.get("method"))
            .and_then(Value::as_str)
            .map(|value| value.trim().to_ascii_uppercase())
            .unwrap_or_default();
        let path = params
            .and_then(|value| value.get("path"))
            .and_then(Value::as_str)
            .map(|value| value.trim().to_owned())
            .unwrap_or_default();
        let timeout_ms = params
            .and_then(|value| value.get("timeoutMs").or_else(|| value.get("timeout_ms")))
            .and_then(json_value_as_timeout_ms);
        let query = params
            .and_then(|value| value.get("query"))
            .filter(|value| value.is_object())
            .cloned();

        if method.is_empty() || path.is_empty() {
            return RpcDispatchOutcome::bad_request("method and path are required");
        }
        if !matches!(method.as_str(), "GET" | "POST" | "DELETE") {
            return RpcDispatchOutcome::bad_request("method must be GET, POST, or DELETE");
        }

        self.system
            .log_line(format!(
                "browser.request method={} path={} timeoutMs={}",
                method,
                truncate_text(&path, 256),
                timeout_ms.unwrap_or(0)
            ))
            .await;

        RpcDispatchOutcome::Error {
            code: 503,
            message: "browser control is disabled".to_owned(),
            details: Some(json!({
                "method": method,
                "path": path,
                "query": query
            })),
        }
    }

    async fn handle_exec_approvals_get(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        if let Err(err) = decode_params::<ExecApprovalsGetParams>(&req.params) {
            return RpcDispatchOutcome::bad_request(format!(
                "invalid exec.approvals.get params: {err}"
            ));
        }
        let snapshot = self.exec_approvals.get_global().await;
        RpcDispatchOutcome::Handled(json!(snapshot))
    }

    async fn handle_exec_approvals_set(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<ExecApprovalsSetParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid exec.approvals.set params: {err}"
                ));
            }
        };
        let Some(file) = params.file else {
            return RpcDispatchOutcome::bad_request("exec approvals file is required");
        };
        if !file.is_object() {
            return RpcDispatchOutcome::bad_request("exec approvals file is required");
        }
        let snapshot = match self.exec_approvals.set_global(file, params.base_hash).await {
            Ok(value) => value,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        RpcDispatchOutcome::Handled(json!(snapshot))
    }

    async fn handle_exec_approvals_node_get(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<ExecApprovalsNodeGetParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid exec.approvals.node.get params: {err}"
                ));
            }
        };
        let Some(node_id) = normalize_optional_text(Some(params.node_id), 128) else {
            return RpcDispatchOutcome::bad_request("nodeId required");
        };
        if self.nodes.paired_node(&node_id).await.is_none() {
            return RpcDispatchOutcome::Error {
                code: 503,
                message: "node not connected".to_owned(),
                details: Some(json!({
                    "code": "NOT_CONNECTED"
                })),
            };
        }
        let snapshot = self.exec_approvals.get_node(&node_id).await;
        RpcDispatchOutcome::Handled(json!(snapshot))
    }

    async fn handle_exec_approvals_node_set(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<ExecApprovalsNodeSetParams>(&req.params) {
            Ok(v) => v,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid exec.approvals.node.set params: {err}"
                ));
            }
        };
        let Some(node_id) = normalize_optional_text(Some(params.node_id), 128) else {
            return RpcDispatchOutcome::bad_request("nodeId required");
        };
        let Some(file) = params.file else {
            return RpcDispatchOutcome::bad_request("exec approvals file is required");
        };
        if !file.is_object() {
            return RpcDispatchOutcome::bad_request("exec approvals file is required");
        }
        if self.nodes.paired_node(&node_id).await.is_none() {
            return RpcDispatchOutcome::Error {
                code: 503,
                message: "node not connected".to_owned(),
                details: Some(json!({
                    "code": "NOT_CONNECTED"
                })),
            };
        }
        let snapshot = match self
            .exec_approvals
            .set_node(&node_id, file, params.base_hash)
            .await
        {
            Ok(value) => value,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        RpcDispatchOutcome::Handled(json!(snapshot))
    }

    async fn handle_exec_approval_request(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<ExecApprovalRequestParams>(&req.params) {
            Ok(value) => value,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid exec.approval.request params: {err}"
                ));
            }
        };
        let Some(command) = normalize_optional_text(Some(params.command), 2_048) else {
            return RpcDispatchOutcome::bad_request("command required");
        };
        let timeout_ms = params
            .timeout_ms
            .unwrap_or(DEFAULT_EXEC_APPROVAL_TIMEOUT_MS)
            .max(1);
        let _request_payload = json!({
            "command": command,
            "cwd": normalize_optional_text(params.cwd, 1_024),
            "host": normalize_optional_text(params.host, 128),
            "security": normalize_optional_text(params.security, 64),
            "ask": normalize_optional_text(params.ask, 64),
            "agentId": normalize_optional_text(params.agent_id, 128),
            "resolvedPath": normalize_optional_text(params.resolved_path, 2_048),
            "sessionKey": normalize_optional_text(params.session_key, 512)
        });
        let create = match self
            .exec_approval
            .create(timeout_ms, normalize_optional_text(params.id, 128))
            .await
        {
            Ok(value) => value,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        if params.two_phase.unwrap_or(false) {
            return RpcDispatchOutcome::Handled(json!({
                "status": "accepted",
                "id": create.id,
                "createdAtMs": create.created_at_ms,
                "expiresAtMs": create.expires_at_ms
            }));
        }
        let decision = create.receiver.await.ok().flatten();
        RpcDispatchOutcome::Handled(json!({
            "id": create.id,
            "decision": decision,
            "createdAtMs": create.created_at_ms,
            "expiresAtMs": create.expires_at_ms
        }))
    }

    async fn handle_exec_approval_wait_decision(
        &self,
        req: &RpcRequestFrame,
    ) -> RpcDispatchOutcome {
        let params = match decode_params::<ExecApprovalWaitDecisionParams>(&req.params) {
            Ok(value) => value,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid exec.approval.waitDecision params: {err}"
                ));
            }
        };
        let Some(id) = normalize_optional_text(params.id, 128) else {
            return RpcDispatchOutcome::bad_request("id is required");
        };
        match self.exec_approval.wait_decision(&id).await {
            ExecApprovalWaitOutcome::Missing => {
                RpcDispatchOutcome::bad_request("approval expired or not found")
            }
            ExecApprovalWaitOutcome::Ready {
                decision,
                created_at_ms,
                expires_at_ms,
            } => RpcDispatchOutcome::Handled(json!({
                "id": id,
                "decision": decision,
                "createdAtMs": created_at_ms,
                "expiresAtMs": expires_at_ms
            })),
            ExecApprovalWaitOutcome::Pending {
                receiver,
                created_at_ms,
                expires_at_ms,
            } => {
                let decision = receiver.await.ok().flatten();
                RpcDispatchOutcome::Handled(json!({
                    "id": id,
                    "decision": decision,
                    "createdAtMs": created_at_ms,
                    "expiresAtMs": expires_at_ms
                }))
            }
        }
    }

    async fn handle_exec_approval_resolve(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<ExecApprovalResolveParams>(&req.params) {
            Ok(value) => value,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid exec.approval.resolve params: {err}"
                ));
            }
        };
        let Some(id) = normalize_optional_text(Some(params.id), 128) else {
            return RpcDispatchOutcome::bad_request("id is required");
        };
        let Some(decision_raw) = normalize_optional_text(Some(params.decision), 32) else {
            return RpcDispatchOutcome::bad_request("invalid decision");
        };
        let decision = normalize(&decision_raw);
        if !matches!(decision.as_str(), "allow-once" | "allow-always" | "deny") {
            return RpcDispatchOutcome::bad_request("invalid decision");
        }
        let ok = self.exec_approval.resolve(&id, decision).await;
        if !ok {
            return RpcDispatchOutcome::bad_request("unknown approval id");
        }
        RpcDispatchOutcome::Handled(json!({
            "ok": true
        }))
    }

    async fn handle_chat_history(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<ChatHistoryParams>(&req.params) {
            Ok(value) => value,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid chat.history params: {err}"
                ));
            }
        };
        let session_key = canonicalize_session_key(&params.session_key);
        if session_key.is_empty() {
            return RpcDispatchOutcome::bad_request("sessionKey is required");
        }
        let limit = params.limit.unwrap_or(200).clamp(1, 1_000);
        let mut messages = self
            .sessions
            .history(Some(&session_key), Some(limit))
            .await
            .into_iter()
            .filter_map(|record| match record.kind {
                SessionHistoryKind::Send => {
                    let text = normalize_optional_text(record.text.or(record.command), 12_000)?;
                    let role = if record
                        .source
                        .as_deref()
                        .map(|value| value.eq_ignore_ascii_case("chat.inject"))
                        .unwrap_or(false)
                    {
                        "assistant"
                    } else {
                        "user"
                    };
                    Some(json!({
                        "role": role,
                        "timestamp": record.at_ms,
                        "content": text
                    }))
                }
                SessionHistoryKind::Decision => None,
            })
            .collect::<Vec<_>>();
        messages.reverse();
        let meta = self.sessions.chat_meta(&session_key).await;
        RpcDispatchOutcome::Handled(json!({
            "sessionKey": session_key,
            "sessionId": meta.as_ref().map(|value| value.session_id.clone()),
            "messages": messages,
            "thinkingLevel": meta.as_ref().and_then(|value| value.thinking_level.clone()),
            "verboseLevel": meta.as_ref().and_then(|value| value.verbose_level.clone())
        }))
    }

    async fn handle_send(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<GatewaySendParams>(&req.params) {
            Ok(value) => value,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!("invalid send params: {err}"));
            }
        };
        let Some(idempotency_key) = normalize_optional_text(Some(params.idempotency_key), 256)
        else {
            return RpcDispatchOutcome::bad_request(
                "invalid send params: idempotencyKey is required",
            );
        };
        if let Some(cached) = self.send.get(&idempotency_key).await {
            return RpcDispatchOutcome::Handled(cached);
        }
        let run_id = idempotency_key;
        let _gif_playback = params.gif_playback.unwrap_or(false);

        let Some(to) = normalize_optional_text(Some(params.to), 512) else {
            return RpcDispatchOutcome::bad_request("invalid send params: to is required");
        };
        let message = normalize_optional_text(params.message, 12_000);
        let media_url = normalize_optional_text(params.media_url, 2_048);
        let mut media_urls = params
            .media_urls
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| normalize_optional_text(Some(value), 2_048))
            .collect::<Vec<_>>();
        if let Some(url) = media_url {
            media_urls.push(url);
        }
        if message.is_none() && media_urls.is_empty() {
            return RpcDispatchOutcome::bad_request(
                "invalid send params: text or media is required",
            );
        }

        let channel_input = normalize_optional_text(params.channel.clone(), 64);
        if channel_input
            .as_deref()
            .map(|value| value.eq_ignore_ascii_case("webchat"))
            .unwrap_or(false)
        {
            return RpcDispatchOutcome::bad_request(
                "unsupported channel: webchat (internal-only). Use `chat.send` for WebChat UI messages or choose a deliverable channel.",
            );
        }
        let channel = channel_input.unwrap_or_else(|| DEFAULT_SEND_CHANNEL.to_owned());
        let supported_channel = self
            .channel_capabilities
            .iter()
            .any(|capability| capability.name.eq_ignore_ascii_case(&channel));
        if !supported_channel {
            let unsupported = params.channel.unwrap_or(channel.clone());
            return RpcDispatchOutcome::bad_request(format!("unsupported channel: {unsupported}"));
        }

        let account_id = normalize_optional_text(params.account_id, 128);
        let thread_id = normalize_optional_text(params.thread_id, 128);
        let session_key = normalize_optional_text(params.session_key, 256)
            .and_then(|value| {
                let canonical = canonicalize_session_key(&value);
                (!canonical.is_empty()).then_some(canonical)
            })
            .unwrap_or_else(|| derive_outbound_session_key(&channel, &to));
        let mirrored_message = message.clone().or_else(|| {
            (!media_urls.is_empty()).then(|| format!("[media] {}", media_urls.join(" ")))
        });
        let _ = self
            .sessions
            .record_send(SessionSend {
                session_key,
                request_id: Some(run_id.clone()),
                message: mirrored_message,
                command: None,
                source: "send".to_owned(),
                channel: Some(channel.clone()),
                to: Some(to),
                account_id: account_id.clone(),
            })
            .await;

        let message_id = next_send_message_id();
        let mut payload = json!({
            "runId": run_id,
            "messageId": message_id,
            "channel": channel
        });
        if let Some(account_id) = account_id {
            payload["accountId"] = json!(account_id);
        }
        if let Some(thread_id) = thread_id {
            payload["threadId"] = json!(thread_id);
        }
        let cache_key = payload
            .pointer("/runId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        self.send.set(cache_key, payload.clone()).await;
        RpcDispatchOutcome::Handled(payload)
    }

    async fn handle_poll(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<GatewayPollParams>(&req.params) {
            Ok(value) => value,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!("invalid poll params: {err}"));
            }
        };
        let Some(idempotency_key) = normalize_optional_text(Some(params.idempotency_key), 256)
        else {
            return RpcDispatchOutcome::bad_request(
                "invalid poll params: idempotencyKey is required",
            );
        };
        let cache_key = format!("poll:{idempotency_key}");
        if let Some(cached) = self.send.get(&cache_key).await {
            return RpcDispatchOutcome::Handled(cached);
        }
        let run_id = idempotency_key;

        let Some(to) = normalize_optional_text(Some(params.to), 512) else {
            return RpcDispatchOutcome::bad_request("invalid poll params: to is required");
        };
        let Some(question) = normalize_optional_text(Some(params.question), 2_048) else {
            return RpcDispatchOutcome::bad_request("invalid poll params: question is required");
        };
        let options = params
            .options
            .into_iter()
            .filter_map(|value| normalize_optional_text(Some(value), 1_024))
            .collect::<Vec<_>>();
        if !(2..=12).contains(&options.len()) {
            return RpcDispatchOutcome::bad_request(
                "invalid poll params: options must contain between 2 and 12 entries",
            );
        }
        if let Some(max_selections) = params.max_selections {
            if max_selections == 0 || max_selections > 12 {
                return RpcDispatchOutcome::bad_request(
                    "invalid poll params: maxSelections must be between 1 and 12",
                );
            }
            if max_selections > options.len() {
                return RpcDispatchOutcome::bad_request(
                    "invalid poll params: maxSelections cannot exceed options length",
                );
            }
        }
        if let Some(duration_hours) = params.duration_hours {
            if duration_hours == 0 {
                return RpcDispatchOutcome::bad_request(
                    "invalid poll params: durationHours must be >= 1",
                );
            }
        }

        let channel_input = normalize_optional_text(params.channel.clone(), 64);
        let requested_channel = channel_input.unwrap_or_else(|| DEFAULT_SEND_CHANNEL.to_owned());
        let Some(capability) = self
            .channel_capabilities
            .iter()
            .find(|capability| capability.name.eq_ignore_ascii_case(&requested_channel))
        else {
            let unsupported = params.channel.unwrap_or(requested_channel);
            return RpcDispatchOutcome::bad_request(format!(
                "unsupported poll channel: {unsupported}"
            ));
        };
        let channel = capability.name.to_owned();
        if !capability.supports_polls {
            return RpcDispatchOutcome::bad_request(format!("unsupported poll channel: {channel}"));
        }
        if params.duration_seconds.is_some() && !channel.eq_ignore_ascii_case("telegram") {
            return RpcDispatchOutcome::bad_request(
                "durationSeconds is only supported for Telegram polls",
            );
        }
        if params.is_anonymous.is_some() && !channel.eq_ignore_ascii_case("telegram") {
            return RpcDispatchOutcome::bad_request(
                "isAnonymous is only supported for Telegram polls",
            );
        }
        if let Some(duration_seconds) = params.duration_seconds {
            if duration_seconds == 0 || duration_seconds > 604_800 {
                return RpcDispatchOutcome::bad_request(
                    "invalid poll params: durationSeconds must be between 1 and 604800",
                );
            }
        }

        let _silent = params.silent.unwrap_or(false);
        let account_id = normalize_optional_text(params.account_id, 128);
        let thread_id = normalize_optional_text(params.thread_id, 128);
        let _ = self
            .sessions
            .record_send(SessionSend {
                session_key: derive_outbound_session_key(&channel, &to),
                request_id: Some(run_id.clone()),
                message: Some(format!("[poll] {question}")),
                command: None,
                source: "poll".to_owned(),
                channel: Some(channel.clone()),
                to: Some(to),
                account_id: account_id.clone(),
            })
            .await;

        let message_id = next_send_message_id();
        let poll_id = next_poll_id();
        let mut payload = json!({
            "runId": run_id,
            "messageId": message_id,
            "channel": channel,
            "pollId": poll_id
        });
        if let Some(account_id) = account_id {
            payload["accountId"] = json!(account_id);
        }
        if let Some(thread_id) = thread_id {
            payload["threadId"] = json!(thread_id);
        }
        self.send.set(cache_key, payload.clone()).await;
        RpcDispatchOutcome::Handled(payload)
    }

    async fn handle_chat_send(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<ChatSendParams>(&req.params) {
            Ok(value) => value,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!("invalid chat.send params: {err}"));
            }
        };
        let session_key = canonicalize_session_key(&params.session_key);
        if session_key.is_empty() {
            return RpcDispatchOutcome::bad_request("sessionKey is required");
        }
        let run_id = normalize_optional_text(Some(params.idempotency_key), 256);
        let Some(run_id) = run_id else {
            return RpcDispatchOutcome::bad_request("idempotencyKey is required");
        };
        let _thinking = normalize_optional_text(params.thinking, 128);
        let _deliver = params.deliver.unwrap_or(false);
        let sanitized_message = match sanitize_chat_send_message_input(&params.message) {
            Ok(value) => value,
            Err(err) => return RpcDispatchOutcome::bad_request(err),
        };
        let stop_command = is_chat_stop_command_text(&sanitized_message);
        let message = normalize_optional_text(Some(sanitized_message), 12_000);
        let has_attachments = params
            .attachments
            .as_ref()
            .map(|value| !value.is_empty())
            .unwrap_or(false);
        if message.is_none() && !has_attachments {
            return RpcDispatchOutcome::bad_request("message or attachment required");
        }
        if stop_command {
            let run_ids = self.chat.abort_session(&session_key).await;
            return RpcDispatchOutcome::Handled(json!({
                "ok": true,
                "aborted": !run_ids.is_empty(),
                "runIds": run_ids
            }));
        }
        let timeout_ms = params.timeout_ms.unwrap_or(30_000);
        match self.chat.start_run(&session_key, &run_id, timeout_ms).await {
            ChatRunStartOutcome::InFlight => {
                return RpcDispatchOutcome::Handled(json!({
                    "runId": run_id,
                    "status": "in_flight"
                }));
            }
            ChatRunStartOutcome::Completed => {
                return RpcDispatchOutcome::Handled(json!({
                    "runId": run_id,
                    "status": "ok"
                }));
            }
            ChatRunStartOutcome::Aborted => {
                return RpcDispatchOutcome::Handled(json!({
                    "runId": run_id,
                    "status": "aborted"
                }));
            }
            ChatRunStartOutcome::Started => {}
        }

        let stored_message = message.or_else(|| has_attachments.then(|| "[attachment]".to_owned()));
        let _ = self
            .sessions
            .record_send(SessionSend {
                session_key,
                request_id: Some(run_id.clone()),
                message: stored_message,
                command: None,
                source: "chat".to_owned(),
                channel: Some("webchat".to_owned()),
                to: None,
                account_id: None,
            })
            .await;

        RpcDispatchOutcome::Handled(json!({
            "runId": run_id,
            "status": "started"
        }))
    }

    async fn handle_chat_abort(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<ChatAbortParams>(&req.params) {
            Ok(value) => value,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid chat.abort params: {err}"
                ));
            }
        };
        let session_key = canonicalize_session_key(&params.session_key);
        if session_key.is_empty() {
            return RpcDispatchOutcome::bad_request("sessionKey is required");
        }
        let run_id = normalize_optional_text(params.run_id, 256);
        if let Some(run_id) = run_id {
            return match self.chat.abort_run(&session_key, &run_id).await {
                ChatAbortRunOutcome::SessionMismatch => {
                    RpcDispatchOutcome::bad_request("runId does not match sessionKey")
                }
                ChatAbortRunOutcome::NotFound => RpcDispatchOutcome::Handled(json!({
                    "ok": true,
                    "aborted": false,
                    "runIds": []
                })),
                ChatAbortRunOutcome::Aborted => RpcDispatchOutcome::Handled(json!({
                    "ok": true,
                    "aborted": true,
                    "runIds": [run_id]
                })),
            };
        }
        let run_ids = self.chat.abort_session(&session_key).await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "aborted": !run_ids.is_empty(),
            "runIds": run_ids
        }))
    }

    async fn handle_chat_inject(&self, req: &RpcRequestFrame) -> RpcDispatchOutcome {
        let params = match decode_params::<ChatInjectParams>(&req.params) {
            Ok(value) => value,
            Err(err) => {
                return RpcDispatchOutcome::bad_request(format!(
                    "invalid chat.inject params: {err}"
                ));
            }
        };
        let requested_session_key = canonicalize_session_key(&params.session_key);
        if requested_session_key.is_empty() {
            return RpcDispatchOutcome::bad_request("sessionKey is required");
        }
        let Some(session_key) = self.sessions.resolve_key(&requested_session_key).await else {
            return RpcDispatchOutcome::bad_request("session not found");
        };
        let Some(message) = normalize_optional_text(Some(params.message), 12_000) else {
            return RpcDispatchOutcome::bad_request("message is required");
        };
        let label = normalize_optional_text(params.label, 64);
        let message_id = next_chat_inject_message_id();
        let rendered_message = if let Some(label) = label {
            format!("[{label}] {message}")
        } else {
            message
        };
        let _ = self
            .sessions
            .record_send(SessionSend {
                session_key,
                request_id: Some(format!("inject-{message_id}")),
                message: Some(rendered_message),
                command: None,
                source: "chat.inject".to_owned(),
                channel: Some("webchat".to_owned()),
                to: None,
                account_id: None,
            })
            .await;
        RpcDispatchOutcome::Handled(json!({
            "ok": true,
            "messageId": message_id
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
        let channel = normalize_optional_text(params.channel, 128);
        if channel
            .as_deref()
            .map(|value| value.eq_ignore_ascii_case("webchat"))
            .unwrap_or(false)
        {
            return RpcDispatchOutcome::bad_request(
                "unsupported channel: webchat (internal-only). Use `chat.send` for WebChat UI messages or choose a deliverable channel.",
            );
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
                channel,
                to: normalize_optional_text(params.to, 256),
                account_id: normalize_optional_text(params.account_id, 128),
            })
            .await;
        if let Some(run_id) = recorded
            .request_id
            .clone()
            .and_then(|value| normalize_optional_text(Some(value), 256))
        {
            self.agent_runs.complete_ok(run_id).await;
        }
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

struct TtsRegistry {
    state: Mutex<TtsState>,
}

#[derive(Debug, Clone)]
struct TtsState {
    enabled: bool,
    auto_mode: String,
    provider: String,
    updated_at_ms: u64,
}

impl TtsRegistry {
    fn new() -> Self {
        Self {
            state: Mutex::new(TtsState {
                enabled: false,
                auto_mode: "off".to_owned(),
                provider: "edge".to_owned(),
                updated_at_ms: now_ms(),
            }),
        }
    }

    async fn snapshot(&self) -> TtsState {
        let guard = self.state.lock().await;
        guard.clone()
    }

    async fn set_enabled(&self, enabled: bool) -> TtsState {
        let mut guard = self.state.lock().await;
        guard.enabled = enabled;
        guard.updated_at_ms = now_ms();
        guard.clone()
    }

    async fn set_provider(&self, provider: String) -> TtsState {
        let mut guard = self.state.lock().await;
        guard.provider = provider;
        guard.updated_at_ms = now_ms();
        guard.clone()
    }
}

struct VoiceWakeRegistry {
    state: Mutex<VoiceWakeState>,
}

#[derive(Debug, Clone)]
struct VoiceWakeState {
    triggers: Vec<String>,
    updated_at_ms: u64,
}

impl VoiceWakeRegistry {
    fn new() -> Self {
        Self {
            state: Mutex::new(VoiceWakeState {
                triggers: DEFAULT_VOICEWAKE_TRIGGERS
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect(),
                updated_at_ms: 0,
            }),
        }
    }

    async fn snapshot(&self) -> VoiceWakeState {
        let guard = self.state.lock().await;
        guard.clone()
    }

    async fn set_triggers(&self, triggers: Vec<String>) -> VoiceWakeState {
        let mut guard = self.state.lock().await;
        guard.triggers = triggers;
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

    async fn identity(&self, requested_agent_id: Option<String>) -> Result<Value, String> {
        let agent_id = requested_agent_id
            .map(|value| normalize_agent_id(&value))
            .unwrap_or_else(|| DEFAULT_AGENT_ID.to_owned());
        let guard = self.state.lock().await;
        let Some(entry) = guard.entries.get(&agent_id) else {
            return Err(format!(
                "invalid agent.identity.get params: unknown agent id \"{agent_id}\""
            ));
        };
        let name = entry
            .identity
            .as_ref()
            .and_then(|identity| identity.name.clone())
            .or_else(|| entry.name.clone());
        let emoji = entry
            .identity
            .as_ref()
            .and_then(|identity| identity.emoji.clone());
        let avatar = entry
            .identity
            .as_ref()
            .and_then(|identity| identity.avatar_url.clone())
            .or_else(|| {
                entry
                    .identity
                    .as_ref()
                    .and_then(|identity| identity.avatar.clone())
            });
        let mut payload = serde_json::Map::new();
        payload.insert("agentId".to_owned(), Value::String(agent_id));
        if let Some(name) = name {
            payload.insert("name".to_owned(), Value::String(name));
        }
        if let Some(avatar) = avatar {
            payload.insert("avatar".to_owned(), Value::String(avatar));
        }
        if let Some(emoji) = emoji {
            payload.insert("emoji".to_owned(), Value::String(emoji));
        }
        Ok(Value::Object(payload))
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

fn resolve_agent_id_from_session_key_input(session_key: &str) -> Result<String, String> {
    let trimmed = session_key.trim();
    if trimmed.is_empty() {
        return Ok(DEFAULT_AGENT_ID.to_owned());
    }
    let parsed = parse_session_key(trimmed);
    if normalize(trimmed).starts_with("agent:") {
        let malformed_agent = parsed
            .agent_id
            .as_ref()
            .map(|value| value.trim().is_empty())
            .unwrap_or(true);
        let malformed_shape = matches!(parsed.kind, SessionKind::Other)
            && parsed
                .scope_id
                .as_ref()
                .map(|value| value.trim().is_empty())
                .unwrap_or(true)
            && parsed
                .channel
                .as_ref()
                .map(|value| value.trim().is_empty())
                .unwrap_or(true);
        if malformed_agent || malformed_shape {
            return Err(format!(
                "invalid agent.identity.get params: malformed session key \"{trimmed}\""
            ));
        }
    }
    Ok(parsed
        .agent_id
        .map(|value| normalize_agent_id(&value))
        .unwrap_or_else(|| DEFAULT_AGENT_ID.to_owned()))
}

#[derive(Clone)]
struct AgentRunRegistry {
    state: Arc<Mutex<AgentRunState>>,
}

#[derive(Debug, Clone)]
struct AgentRunState {
    entries: HashMap<String, AgentRunSnapshot>,
}

#[derive(Debug, Clone)]
struct AgentRunSnapshot {
    status: String,
    started_at: u64,
    ended_at: u64,
    error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentRunStartOutcome {
    Started,
    InFlight,
    Completed,
}

impl AgentRunRegistry {
    fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(AgentRunState {
                entries: HashMap::new(),
            })),
        }
    }

    async fn start_run(&self, run_id: &str) -> AgentRunStartOutcome {
        let run_key = run_id.trim();
        if run_key.is_empty() {
            return AgentRunStartOutcome::Completed;
        }
        let mut guard = self.state.lock().await;
        if let Some(snapshot) = guard.entries.get(run_key) {
            if normalize(&snapshot.status) == "ok" {
                return AgentRunStartOutcome::Completed;
            }
            return AgentRunStartOutcome::InFlight;
        }
        let now = now_ms();
        guard.entries.insert(
            run_key.to_owned(),
            AgentRunSnapshot {
                status: "in_flight".to_owned(),
                started_at: now,
                ended_at: 0,
                error: None,
            },
        );
        AgentRunStartOutcome::Started
    }

    async fn complete_ok(&self, run_id: String) {
        let now = now_ms();
        let mut guard = self.state.lock().await;
        if let Some(entry) = guard.entries.get_mut(&run_id) {
            entry.status = "ok".to_owned();
            if entry.started_at == 0 {
                entry.started_at = now;
            }
            entry.ended_at = now;
            entry.error = None;
        } else {
            guard.entries.insert(
                run_id,
                AgentRunSnapshot {
                    status: "ok".to_owned(),
                    started_at: now,
                    ended_at: now,
                    error: None,
                },
            );
        }
        if guard.entries.len() > 4_096 {
            let mut oldest_key: Option<String> = None;
            let mut oldest = u64::MAX;
            for (entry_key, entry) in &guard.entries {
                if entry.ended_at < oldest {
                    oldest = entry.ended_at;
                    oldest_key = Some(entry_key.clone());
                }
            }
            if let Some(oldest_key) = oldest_key {
                let _ = guard.entries.remove(&oldest_key);
            }
        }
    }

    async fn wait(&self, run_id: &str, timeout_ms: u64) -> Option<AgentRunSnapshot> {
        let run_key = run_id.trim();
        if run_key.is_empty() {
            return None;
        }
        {
            let guard = self.state.lock().await;
            if let Some(snapshot) = guard.entries.get(run_key) {
                return Some(snapshot.clone());
            }
        }
        if timeout_ms == 0 {
            return None;
        }
        let guard = self.state.lock().await;
        guard.entries.get(run_key).cloned()
    }
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

struct NodePairRegistry {
    state: Mutex<NodePairState>,
}

#[derive(Debug, Clone, Default)]
struct NodePairState {
    pending_by_id: HashMap<String, NodePairPendingRequest>,
    paired_by_node_id: HashMap<String, PairedNodeEntry>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct NodePairRequestResult {
    status: &'static str,
    request: NodePairPendingRequest,
    created: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
struct NodePairListResult {
    pending: Vec<NodePairPendingRequest>,
    paired: Vec<PairedNodeEntry>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct NodePairApproveResult {
    #[serde(rename = "requestId")]
    request_id: String,
    node: PairedNodeEntry,
}

#[derive(Debug, Clone, serde::Serialize)]
struct NodePairRejectResult {
    #[serde(rename = "requestId")]
    request_id: String,
    #[serde(rename = "nodeId")]
    node_id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
struct NodePairVerifyResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    node: Option<PairedNodeEntry>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct NodeRenameResult {
    #[serde(rename = "nodeId")]
    node_id: String,
    #[serde(rename = "displayName")]
    display_name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
struct NodeInventoryEntry {
    #[serde(rename = "nodeId")]
    node_id: String,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(rename = "coreVersion", skip_serializing_if = "Option::is_none")]
    core_version: Option<String>,
    #[serde(rename = "uiVersion", skip_serializing_if = "Option::is_none")]
    ui_version: Option<String>,
    #[serde(rename = "deviceFamily", skip_serializing_if = "Option::is_none")]
    device_family: Option<String>,
    #[serde(rename = "modelIdentifier", skip_serializing_if = "Option::is_none")]
    model_identifier: Option<String>,
    #[serde(rename = "remoteIp", skip_serializing_if = "Option::is_none")]
    remote_ip: Option<String>,
    caps: Vec<String>,
    commands: Vec<String>,
    #[serde(rename = "pathEnv", skip_serializing_if = "Option::is_none")]
    path_env: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permissions: Option<Value>,
    #[serde(rename = "connectedAtMs", skip_serializing_if = "Option::is_none")]
    connected_at_ms: Option<u64>,
    paired: bool,
    connected: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct NodePairPendingRequest {
    #[serde(rename = "requestId")]
    request_id: String,
    #[serde(rename = "nodeId")]
    node_id: String,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(rename = "coreVersion", skip_serializing_if = "Option::is_none")]
    core_version: Option<String>,
    #[serde(rename = "uiVersion", skip_serializing_if = "Option::is_none")]
    ui_version: Option<String>,
    #[serde(rename = "deviceFamily", skip_serializing_if = "Option::is_none")]
    device_family: Option<String>,
    #[serde(rename = "modelIdentifier", skip_serializing_if = "Option::is_none")]
    model_identifier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    caps: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commands: Option<Vec<String>>,
    #[serde(rename = "remoteIp", skip_serializing_if = "Option::is_none")]
    remote_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    silent: Option<bool>,
    #[serde(rename = "isRepair", skip_serializing_if = "Option::is_none")]
    is_repair: Option<bool>,
    ts: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PairedNodeEntry {
    #[serde(rename = "nodeId")]
    node_id: String,
    token: String,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(rename = "coreVersion", skip_serializing_if = "Option::is_none")]
    core_version: Option<String>,
    #[serde(rename = "uiVersion", skip_serializing_if = "Option::is_none")]
    ui_version: Option<String>,
    #[serde(rename = "deviceFamily", skip_serializing_if = "Option::is_none")]
    device_family: Option<String>,
    #[serde(rename = "modelIdentifier", skip_serializing_if = "Option::is_none")]
    model_identifier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    caps: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commands: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bins: Option<Vec<String>>,
    #[serde(rename = "remoteIp", skip_serializing_if = "Option::is_none")]
    remote_ip: Option<String>,
    #[serde(rename = "createdAtMs")]
    created_at_ms: u64,
    #[serde(rename = "approvedAtMs")]
    approved_at_ms: u64,
    #[serde(rename = "lastConnectedAtMs", skip_serializing_if = "Option::is_none")]
    last_connected_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
struct NodePairRequestedEventPayload {
    #[serde(rename = "requestId", alias = "request_id")]
    request_id: Option<String>,
    #[serde(rename = "nodeId", alias = "node_id")]
    node_id: Option<String>,
    #[serde(rename = "displayName", alias = "display_name")]
    display_name: Option<String>,
    platform: Option<String>,
    version: Option<String>,
    #[serde(rename = "coreVersion", alias = "core_version")]
    core_version: Option<String>,
    #[serde(rename = "uiVersion", alias = "ui_version")]
    ui_version: Option<String>,
    #[serde(rename = "deviceFamily", alias = "device_family")]
    device_family: Option<String>,
    #[serde(rename = "modelIdentifier", alias = "model_identifier")]
    model_identifier: Option<String>,
    caps: Option<Vec<String>>,
    commands: Option<Vec<String>>,
    #[serde(rename = "remoteIp", alias = "remote_ip")]
    remote_ip: Option<String>,
    silent: Option<bool>,
    #[serde(rename = "isRepair", alias = "is_repair")]
    is_repair: Option<bool>,
    ts: Option<u64>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
struct NodePairResolvedEventPayload {
    #[serde(rename = "requestId", alias = "request_id")]
    request_id: Option<String>,
}

impl NodePairRegistry {
    fn new() -> Self {
        Self {
            state: Mutex::new(NodePairState::default()),
        }
    }

    async fn request(
        &self,
        params: NodePairRequestParams,
    ) -> Result<NodePairRequestResult, String> {
        let Some(node_id) = normalize_optional_text(Some(params.node_id), 128) else {
            return Err("invalid node.pair.request params: nodeId required".to_owned());
        };
        let now = now_ms();
        let mut guard = self.state.lock().await;
        if let Some(existing) = guard
            .pending_by_id
            .values()
            .find(|entry| entry.node_id == node_id)
            .cloned()
        {
            return Ok(NodePairRequestResult {
                status: "pending",
                request: existing,
                created: false,
            });
        }
        let request = NodePairPendingRequest {
            request_id: next_node_pair_request_id(),
            node_id: node_id.clone(),
            display_name: normalize_optional_text(params.display_name, 128),
            platform: normalize_optional_text(params.platform, 128),
            version: normalize_optional_text(params.version, 128),
            core_version: normalize_optional_text(params.core_version, 128),
            ui_version: normalize_optional_text(params.ui_version, 128),
            device_family: normalize_optional_text(params.device_family, 128),
            model_identifier: normalize_optional_text(params.model_identifier, 128),
            caps: {
                let values = normalize_string_list(params.caps, 128, 128);
                (!values.is_empty()).then_some(values)
            },
            commands: {
                let values = normalize_string_list(params.commands, 256, 160);
                (!values.is_empty()).then_some(values)
            },
            remote_ip: normalize_optional_text(params.remote_ip, 128),
            silent: params.silent,
            is_repair: Some(guard.paired_by_node_id.contains_key(&node_id)),
            ts: now,
        };
        guard
            .pending_by_id
            .insert(request.request_id.clone(), request.clone());
        prune_oldest_node_pending(&mut guard.pending_by_id, 512);
        Ok(NodePairRequestResult {
            status: "pending",
            request,
            created: true,
        })
    }

    async fn list(&self) -> NodePairListResult {
        let guard = self.state.lock().await;
        let mut pending = guard
            .pending_by_id
            .values()
            .cloned()
            .collect::<Vec<NodePairPendingRequest>>();
        pending.sort_by(|a, b| {
            b.ts.cmp(&a.ts)
                .then_with(|| a.request_id.cmp(&b.request_id))
        });
        let mut paired = guard
            .paired_by_node_id
            .values()
            .cloned()
            .collect::<Vec<PairedNodeEntry>>();
        paired.sort_by(|a, b| {
            b.approved_at_ms
                .cmp(&a.approved_at_ms)
                .then_with(|| a.node_id.cmp(&b.node_id))
        });
        NodePairListResult { pending, paired }
    }

    async fn approve(&self, request_id: &str) -> Option<NodePairApproveResult> {
        let mut guard = self.state.lock().await;
        let request = guard.pending_by_id.remove(request_id)?;
        let now = now_ms();
        let existing = guard.paired_by_node_id.get(&request.node_id).cloned();
        let node = PairedNodeEntry {
            node_id: request.node_id.clone(),
            token: next_node_pair_token(&request.node_id),
            display_name: request.display_name,
            platform: request.platform,
            version: request.version,
            core_version: request.core_version,
            ui_version: request.ui_version,
            device_family: request.device_family,
            model_identifier: request.model_identifier,
            caps: request.caps,
            commands: request.commands,
            bins: None,
            remote_ip: request.remote_ip,
            created_at_ms: existing.as_ref().map_or(now, |value| value.created_at_ms),
            approved_at_ms: now,
            last_connected_at_ms: existing.and_then(|value| value.last_connected_at_ms),
        };
        guard
            .paired_by_node_id
            .insert(node.node_id.clone(), node.clone());
        prune_oldest_node_pairs(&mut guard.paired_by_node_id, 2_048);
        Some(NodePairApproveResult {
            request_id: request_id.to_owned(),
            node,
        })
    }

    async fn reject(&self, request_id: &str) -> Option<NodePairRejectResult> {
        let mut guard = self.state.lock().await;
        let request = guard.pending_by_id.remove(request_id)?;
        Some(NodePairRejectResult {
            request_id: request_id.to_owned(),
            node_id: request.node_id,
        })
    }

    async fn verify(&self, node_id: &str, token: &str) -> NodePairVerifyResult {
        let normalized_node_id = node_id.trim();
        if normalized_node_id.is_empty() || token.trim().is_empty() {
            return NodePairVerifyResult {
                ok: false,
                node: None,
            };
        }
        let guard = self.state.lock().await;
        let Some(node) = guard.paired_by_node_id.get(normalized_node_id).cloned() else {
            return NodePairVerifyResult {
                ok: false,
                node: None,
            };
        };
        if node.token == token {
            NodePairVerifyResult {
                ok: true,
                node: Some(node),
            }
        } else {
            NodePairVerifyResult {
                ok: false,
                node: None,
            }
        }
    }

    async fn rename(&self, node_id: &str, display_name: &str) -> Option<NodeRenameResult> {
        let normalized_node_id = node_id.trim();
        if normalized_node_id.is_empty() {
            return None;
        }
        let trimmed_name = display_name.trim();
        if trimmed_name.is_empty() {
            return None;
        }
        let mut guard = self.state.lock().await;
        let node = guard.paired_by_node_id.get_mut(normalized_node_id)?;
        node.display_name = Some(trimmed_name.to_owned());
        Some(NodeRenameResult {
            node_id: normalized_node_id.to_owned(),
            display_name: trimmed_name.to_owned(),
        })
    }

    async fn list_nodes(&self) -> Vec<NodeInventoryEntry> {
        let guard = self.state.lock().await;
        let mut nodes = guard
            .paired_by_node_id
            .values()
            .map(node_inventory_from_paired)
            .collect::<Vec<_>>();
        nodes.sort_by(|a, b| {
            if a.connected != b.connected {
                return if a.connected {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Greater
                };
            }
            let a_key = a.display_name.as_ref().map_or_else(
                || a.node_id.to_ascii_lowercase(),
                |value| value.to_ascii_lowercase(),
            );
            let b_key = b.display_name.as_ref().map_or_else(
                || b.node_id.to_ascii_lowercase(),
                |value| value.to_ascii_lowercase(),
            );
            a_key.cmp(&b_key).then_with(|| a.node_id.cmp(&b.node_id))
        });
        nodes
    }

    async fn describe_node(&self, node_id: &str) -> Option<NodeInventoryEntry> {
        let normalized_node_id = node_id.trim();
        if normalized_node_id.is_empty() {
            return None;
        }
        let guard = self.state.lock().await;
        let node = guard.paired_by_node_id.get(normalized_node_id)?;
        Some(node_inventory_from_paired(node))
    }

    async fn paired_node(&self, node_id: &str) -> Option<PairedNodeEntry> {
        let normalized_node_id = node_id.trim();
        if normalized_node_id.is_empty() {
            return None;
        }
        let guard = self.state.lock().await;
        guard.paired_by_node_id.get(normalized_node_id).cloned()
    }

    async fn ingest_pair_requested(&self, payload: Value) {
        let Ok(event) = serde_json::from_value::<NodePairRequestedEventPayload>(payload) else {
            return;
        };
        let Some(request_id) = normalize_optional_text(event.request_id, 128) else {
            return;
        };
        let Some(node_id) = normalize_optional_text(event.node_id, 128) else {
            return;
        };
        let request = NodePairPendingRequest {
            request_id: request_id.clone(),
            node_id: node_id.clone(),
            display_name: normalize_optional_text(event.display_name, 128),
            platform: normalize_optional_text(event.platform, 128),
            version: normalize_optional_text(event.version, 128),
            core_version: normalize_optional_text(event.core_version, 128),
            ui_version: normalize_optional_text(event.ui_version, 128),
            device_family: normalize_optional_text(event.device_family, 128),
            model_identifier: normalize_optional_text(event.model_identifier, 128),
            caps: {
                let values = normalize_string_list(event.caps, 128, 128);
                (!values.is_empty()).then_some(values)
            },
            commands: {
                let values = normalize_string_list(event.commands, 256, 160);
                (!values.is_empty()).then_some(values)
            },
            remote_ip: normalize_optional_text(event.remote_ip, 128),
            silent: event.silent,
            is_repair: event.is_repair,
            ts: event.ts.unwrap_or_else(now_ms),
        };
        let mut guard = self.state.lock().await;
        guard
            .pending_by_id
            .retain(|key, pending| key == &request_id || pending.node_id != node_id);
        guard.pending_by_id.insert(request_id, request);
        prune_oldest_node_pending(&mut guard.pending_by_id, 512);
    }

    async fn ingest_pair_resolved(&self, payload: Value) {
        let Ok(event) = serde_json::from_value::<NodePairResolvedEventPayload>(payload) else {
            return;
        };
        let Some(request_id) = normalize_optional_text(event.request_id, 128) else {
            return;
        };
        let mut guard = self.state.lock().await;
        let _ = guard.pending_by_id.remove(&request_id);
    }
}

fn node_inventory_from_paired(node: &PairedNodeEntry) -> NodeInventoryEntry {
    NodeInventoryEntry {
        node_id: node.node_id.clone(),
        display_name: node.display_name.clone(),
        platform: node.platform.clone(),
        version: node.version.clone(),
        core_version: node.core_version.clone(),
        ui_version: node.ui_version.clone(),
        device_family: node.device_family.clone(),
        model_identifier: node.model_identifier.clone(),
        remote_ip: node.remote_ip.clone(),
        caps: node.caps.clone().unwrap_or_default(),
        commands: node.commands.clone().unwrap_or_default(),
        path_env: None,
        permissions: None,
        connected_at_ms: node.last_connected_at_ms,
        paired: true,
        connected: false,
    }
}

fn prune_oldest_node_pending(
    pending_by_id: &mut HashMap<String, NodePairPendingRequest>,
    max_pending: usize,
) {
    while pending_by_id.len() > max_pending {
        let Some(oldest_key) = pending_by_id
            .iter()
            .min_by_key(|(_, pending)| pending.ts)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        let _ = pending_by_id.remove(&oldest_key);
    }
}

fn prune_oldest_node_pairs(
    paired_by_node_id: &mut HashMap<String, PairedNodeEntry>,
    max_pairs: usize,
) {
    while paired_by_node_id.len() > max_pairs {
        let Some(oldest_key) = paired_by_node_id
            .iter()
            .min_by_key(|(_, node)| node.approved_at_ms)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        let _ = paired_by_node_id.remove(&oldest_key);
    }
}

fn next_node_pair_request_id() -> String {
    let sequence = NODE_PAIR_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("node-pair-{}-{sequence}", now_ms())
}

fn next_node_pair_token(node_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let sequence = NODE_TOKEN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut hasher = Sha256::new();
    hasher.update(node_id.as_bytes());
    hasher.update(now_ms().to_le_bytes());
    hasher.update(sequence.to_le_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("ntk_{}", &digest[..48])
}

fn node_command_allowed(node: &PairedNodeEntry, command: &str) -> bool {
    let normalized = command.trim();
    if normalized.is_empty() {
        return false;
    }
    let Some(commands) = &node.commands else {
        return true;
    };
    if commands.is_empty() {
        return true;
    }
    commands
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(normalized))
}

struct NodeRuntimeRegistry {
    state: Mutex<NodeRuntimeState>,
}

#[derive(Debug, Clone, Default)]
struct NodeRuntimeState {
    pending_invokes: HashMap<String, NodeInvokePendingEntry>,
    recent_results: VecDeque<Value>,
    recent_events: VecDeque<Value>,
}

#[derive(Debug, Clone)]
struct NodeInvokePendingEntry {
    id: String,
    node_id: String,
    command: String,
    idempotency_key: String,
    created_at_ms: u64,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum NodeInvokeCompleteResult {
    Completed,
    Ignored,
    NodeMismatch,
}

impl NodeRuntimeRegistry {
    fn new() -> Self {
        Self {
            state: Mutex::new(NodeRuntimeState::default()),
        }
    }

    async fn begin_invoke(
        &self,
        node_id: &str,
        command: &str,
        timeout_ms: Option<u64>,
        idempotency_key: &str,
    ) -> String {
        let now = now_ms();
        let invoke_id = next_node_invoke_id();
        let entry = NodeInvokePendingEntry {
            id: invoke_id.clone(),
            node_id: node_id.to_owned(),
            command: command.to_owned(),
            idempotency_key: idempotency_key.to_owned(),
            created_at_ms: now,
            timeout_ms,
        };
        let mut guard = self.state.lock().await;
        guard.pending_invokes.insert(invoke_id.clone(), entry);
        prune_oldest_node_invoke_pending(&mut guard.pending_invokes, 4_096);
        invoke_id
    }

    async fn complete_invoke(&self, params: NodeInvokeResultParams) -> NodeInvokeCompleteResult {
        let mut guard = self.state.lock().await;
        let Some(pending) = guard.pending_invokes.remove(&params.id) else {
            return NodeInvokeCompleteResult::Ignored;
        };
        if !pending.node_id.eq_ignore_ascii_case(&params.node_id) {
            guard.pending_invokes.insert(pending.id.clone(), pending);
            return NodeInvokeCompleteResult::NodeMismatch;
        }
        let payload_json = params.payload_json.or_else(|| {
            params
                .payload
                .as_ref()
                .and_then(|value| serde_json::to_string(value).ok())
        });
        guard.recent_results.push_back(json!({
            "id": params.id,
            "nodeId": params.node_id,
            "ok": params.ok,
            "payloadJSON": payload_json,
            "errorCode": params.error.as_ref().and_then(|value| value.code.clone()),
            "errorMessage": params.error.as_ref().and_then(|value| value.message.clone()),
            "ts": now_ms(),
            "command": pending.command,
            "idempotencyKey": pending.idempotency_key,
            "invokeCreatedAtMs": pending.created_at_ms,
            "timeoutMs": pending.timeout_ms
        }));
        while guard.recent_results.len() > 1_024 {
            let _ = guard.recent_results.pop_front();
        }
        NodeInvokeCompleteResult::Completed
    }

    async fn record_event(&self, event: String, payload_json: Option<String>) {
        let mut guard = self.state.lock().await;
        guard.recent_events.push_back(json!({
            "event": event,
            "payloadJSON": payload_json,
            "ts": now_ms()
        }));
        while guard.recent_events.len() > 1_024 {
            let _ = guard.recent_events.pop_front();
        }
    }
}

fn prune_oldest_node_invoke_pending(
    pending_invokes: &mut HashMap<String, NodeInvokePendingEntry>,
    max_pending: usize,
) {
    while pending_invokes.len() > max_pending {
        let Some(oldest_key) = pending_invokes
            .iter()
            .min_by_key(|(_, entry)| entry.created_at_ms)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        let _ = pending_invokes.remove(&oldest_key);
    }
}

fn next_node_invoke_id() -> String {
    let sequence = NODE_INVOKE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("node-invoke-{}-{sequence}", now_ms())
}

struct ExecApprovalsRegistry {
    state: Mutex<ExecApprovalsState>,
}

#[derive(Debug, Clone)]
struct ExecApprovalsState {
    global: ExecApprovalsSnapshotState,
    node_by_id: HashMap<String, ExecApprovalsSnapshotState>,
}

#[derive(Debug, Clone)]
struct ExecApprovalsSnapshotState {
    path: String,
    exists: bool,
    file: Value,
    hash: String,
    updated_at_ms: u64,
}

impl ExecApprovalsSnapshotState {
    fn default_global() -> Self {
        Self::new(
            EXEC_APPROVALS_GLOBAL_PATH.to_owned(),
            default_exec_approvals_file(),
            true,
        )
    }

    fn default_for_node(node_id: &str) -> Self {
        Self::new(
            format!("memory://nodes/{node_id}/exec-approvals.json"),
            default_exec_approvals_file(),
            true,
        )
    }

    fn new(path: String, file: Value, exists: bool) -> Self {
        Self {
            path,
            exists,
            hash: hash_json_value(&file),
            file,
            updated_at_ms: now_ms(),
        }
    }
}

impl ExecApprovalsRegistry {
    fn new() -> Self {
        Self {
            state: Mutex::new(ExecApprovalsState {
                global: ExecApprovalsSnapshotState::default_global(),
                node_by_id: HashMap::new(),
            }),
        }
    }

    async fn get_global(&self) -> Value {
        let guard = self.state.lock().await;
        exec_approvals_snapshot_payload(&guard.global)
    }

    async fn set_global(&self, file: Value, base_hash: Option<String>) -> Result<Value, String> {
        let mut guard = self.state.lock().await;
        require_exec_approvals_base_hash(base_hash, &guard.global)?;
        let next_file = normalize_exec_approvals_file(file, Some(&guard.global.file));
        guard.global.file = next_file;
        guard.global.hash = hash_json_value(&guard.global.file);
        guard.global.exists = true;
        guard.global.updated_at_ms = now_ms();
        Ok(exec_approvals_snapshot_payload(&guard.global))
    }

    async fn get_node(&self, node_id: &str) -> Value {
        let mut guard = self.state.lock().await;
        let snapshot = guard
            .node_by_id
            .entry(node_id.to_owned())
            .or_insert_with(|| ExecApprovalsSnapshotState::default_for_node(node_id));
        snapshot.updated_at_ms = now_ms();
        let payload = exec_approvals_snapshot_payload(snapshot);
        prune_oldest_exec_approvals_nodes(&mut guard.node_by_id, MAX_EXEC_APPROVALS_NODE_SNAPSHOTS);
        payload
    }

    async fn set_node(
        &self,
        node_id: &str,
        file: Value,
        base_hash: Option<String>,
    ) -> Result<Value, String> {
        let mut guard = self.state.lock().await;
        let payload = {
            let snapshot = guard
                .node_by_id
                .entry(node_id.to_owned())
                .or_insert_with(|| ExecApprovalsSnapshotState::default_for_node(node_id));
            require_exec_approvals_base_hash(base_hash, snapshot)?;
            let next_file = normalize_exec_approvals_file(file, Some(&snapshot.file));
            snapshot.file = next_file;
            snapshot.hash = hash_json_value(&snapshot.file);
            snapshot.exists = true;
            snapshot.updated_at_ms = now_ms();
            exec_approvals_snapshot_payload(snapshot)
        };
        prune_oldest_exec_approvals_nodes(&mut guard.node_by_id, MAX_EXEC_APPROVALS_NODE_SNAPSHOTS);
        Ok(payload)
    }
}

fn exec_approvals_snapshot_payload(snapshot: &ExecApprovalsSnapshotState) -> Value {
    let mut file = snapshot.file.clone();
    if let Some(map) = file.as_object_mut() {
        let socket_path = map
            .get("socket")
            .and_then(Value::as_object)
            .and_then(|socket| socket.get("path"))
            .and_then(Value::as_str)
            .and_then(|value| normalize_optional_text(Some(value.to_owned()), 1_024));
        match socket_path {
            Some(path) => {
                map.insert("socket".to_owned(), json!({ "path": path }));
            }
            None => {
                map.remove("socket");
            }
        }
    }
    json!({
        "path": snapshot.path,
        "exists": snapshot.exists,
        "hash": snapshot.hash,
        "file": file
    })
}

fn require_exec_approvals_base_hash(
    base_hash: Option<String>,
    snapshot: &ExecApprovalsSnapshotState,
) -> Result<(), String> {
    if !snapshot.exists {
        return Ok(());
    }
    let Some(snapshot_hash) = normalize_optional_text(Some(snapshot.hash.clone()), 128) else {
        return Err(
            "exec approvals base hash unavailable; re-run exec.approvals.get and retry".to_owned(),
        );
    };
    let Some(base_hash) = normalize_optional_text(base_hash, 128) else {
        return Err(
            "exec approvals base hash required; re-run exec.approvals.get and retry".to_owned(),
        );
    };
    if !base_hash.eq_ignore_ascii_case(&snapshot_hash) {
        return Err(
            "exec approvals changed since last load; re-run exec.approvals.get and retry"
                .to_owned(),
        );
    }
    Ok(())
}

fn normalize_exec_approvals_file(incoming: Value, current: Option<&Value>) -> Value {
    let mut normalized = if incoming.is_object() {
        incoming
    } else {
        json!({})
    };

    let current_socket = current
        .and_then(|value| value.get("socket"))
        .and_then(Value::as_object);
    let current_socket_path = current_socket
        .and_then(|socket| socket.get("path"))
        .and_then(Value::as_str)
        .and_then(|value| normalize_optional_text(Some(value.to_owned()), 1_024));
    let current_token = current_socket
        .and_then(|socket| socket.get("token"))
        .and_then(Value::as_str)
        .and_then(|value| normalize_optional_text(Some(value.to_owned()), 512));

    let Some(map) = normalized.as_object_mut() else {
        return default_exec_approvals_file();
    };
    map.insert("version".to_owned(), json!(1));
    if !matches!(map.get("agents"), Some(Value::Object(_))) {
        map.insert("agents".to_owned(), json!({}));
    }

    let incoming_socket = map.get("socket").and_then(Value::as_object);
    let socket_path = incoming_socket
        .and_then(|socket| socket.get("path"))
        .and_then(Value::as_str)
        .and_then(|value| normalize_optional_text(Some(value.to_owned()), 1_024))
        .or(current_socket_path)
        .unwrap_or_else(|| EXEC_APPROVALS_SOCKET_PATH.to_owned());
    let token = incoming_socket
        .and_then(|socket| socket.get("token"))
        .and_then(Value::as_str)
        .and_then(|value| normalize_optional_text(Some(value.to_owned()), 512))
        .or(current_token)
        .unwrap_or_else(next_exec_approvals_token);
    map.insert(
        "socket".to_owned(),
        json!({
            "path": socket_path,
            "token": token
        }),
    );

    normalized
}

fn default_exec_approvals_file() -> Value {
    json!({
        "version": 1,
        "socket": {
            "path": EXEC_APPROVALS_SOCKET_PATH,
            "token": next_exec_approvals_token()
        },
        "agents": {}
    })
}

fn next_exec_approvals_token() -> String {
    use sha2::{Digest, Sha256};
    let sequence = EXEC_APPROVAL_TOKEN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut hasher = Sha256::new();
    hasher.update(now_ms().to_le_bytes());
    hasher.update(sequence.to_le_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("eat_{}", &digest[..48])
}

fn prune_oldest_exec_approvals_nodes(
    node_by_id: &mut HashMap<String, ExecApprovalsSnapshotState>,
    max_snapshots: usize,
) {
    while node_by_id.len() > max_snapshots {
        let Some(oldest_key) = node_by_id
            .iter()
            .min_by_key(|(_, snapshot)| snapshot.updated_at_ms)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        let _ = node_by_id.remove(&oldest_key);
    }
}

struct ExecApprovalRegistry {
    state: Arc<Mutex<ExecApprovalState>>,
}

#[derive(Default)]
struct ExecApprovalState {
    pending_by_id: HashMap<String, ExecApprovalPendingEntry>,
}

struct ExecApprovalPendingEntry {
    created_at_ms: u64,
    expires_at_ms: u64,
    decision: Option<String>,
    resolved_at_ms: Option<u64>,
    waiters: Vec<oneshot::Sender<Option<String>>>,
}

struct ExecApprovalCreateResult {
    id: String,
    created_at_ms: u64,
    expires_at_ms: u64,
    receiver: oneshot::Receiver<Option<String>>,
}

enum ExecApprovalWaitOutcome {
    Missing,
    Ready {
        decision: Option<String>,
        created_at_ms: u64,
        expires_at_ms: u64,
    },
    Pending {
        receiver: oneshot::Receiver<Option<String>>,
        created_at_ms: u64,
        expires_at_ms: u64,
    },
}

impl ExecApprovalRegistry {
    fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(ExecApprovalState::default())),
        }
    }

    async fn create(
        &self,
        timeout_ms: u64,
        explicit_id: Option<String>,
    ) -> Result<ExecApprovalCreateResult, String> {
        let timeout_ms = timeout_ms.max(1);
        let id = explicit_id.unwrap_or_else(next_exec_approval_id);
        let now = now_ms();
        let expires_at_ms = now.saturating_add(timeout_ms);
        let (sender, receiver) = oneshot::channel();

        {
            let mut guard = self.state.lock().await;
            if guard.pending_by_id.contains_key(&id) {
                return Err("approval id already pending".to_owned());
            }
            guard.pending_by_id.insert(
                id.clone(),
                ExecApprovalPendingEntry {
                    created_at_ms: now,
                    expires_at_ms,
                    decision: None,
                    resolved_at_ms: None,
                    waiters: vec![sender],
                },
            );
            prune_oldest_exec_approval_pending(&mut guard.pending_by_id, MAX_EXEC_APPROVAL_PENDING);
        }

        let state = Arc::clone(&self.state);
        let timeout_id = id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
            let (waiters, resolved_at_ms) = {
                let mut guard = state.lock().await;
                let Some(entry) = guard.pending_by_id.get_mut(&timeout_id) else {
                    return;
                };
                if entry.resolved_at_ms.is_some() {
                    return;
                }
                let resolved_at_ms = now_ms();
                entry.resolved_at_ms = Some(resolved_at_ms);
                entry.decision = None;
                (std::mem::take(&mut entry.waiters), resolved_at_ms)
            };
            for waiter in waiters {
                let _ = waiter.send(None);
            }
            spawn_exec_approval_grace_cleanup(state, timeout_id, resolved_at_ms);
        });

        Ok(ExecApprovalCreateResult {
            id,
            created_at_ms: now,
            expires_at_ms,
            receiver,
        })
    }

    async fn wait_decision(&self, id: &str) -> ExecApprovalWaitOutcome {
        let mut guard = self.state.lock().await;
        let Some(entry) = guard.pending_by_id.get_mut(id) else {
            return ExecApprovalWaitOutcome::Missing;
        };
        if entry.resolved_at_ms.is_some() {
            return ExecApprovalWaitOutcome::Ready {
                decision: entry.decision.clone(),
                created_at_ms: entry.created_at_ms,
                expires_at_ms: entry.expires_at_ms,
            };
        }
        let (sender, receiver) = oneshot::channel();
        entry.waiters.push(sender);
        ExecApprovalWaitOutcome::Pending {
            receiver,
            created_at_ms: entry.created_at_ms,
            expires_at_ms: entry.expires_at_ms,
        }
    }

    async fn resolve(&self, id: &str, decision: String) -> bool {
        let (waiters, resolved_at_ms) = {
            let mut guard = self.state.lock().await;
            let Some(entry) = guard.pending_by_id.get_mut(id) else {
                return false;
            };
            if entry.resolved_at_ms.is_some() {
                return false;
            }
            let resolved_at_ms = now_ms();
            entry.decision = Some(decision.clone());
            entry.resolved_at_ms = Some(resolved_at_ms);
            (std::mem::take(&mut entry.waiters), resolved_at_ms)
        };

        for waiter in waiters {
            let _ = waiter.send(Some(decision.clone()));
        }
        spawn_exec_approval_grace_cleanup(Arc::clone(&self.state), id.to_owned(), resolved_at_ms);
        true
    }
}

fn spawn_exec_approval_grace_cleanup(
    state: Arc<Mutex<ExecApprovalState>>,
    id: String,
    resolved_at_ms: u64,
) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(EXEC_APPROVAL_RESOLVED_GRACE_MS)).await;
        let mut guard = state.lock().await;
        let should_remove = guard
            .pending_by_id
            .get(&id)
            .and_then(|entry| entry.resolved_at_ms)
            .map(|entry_resolved_at_ms| entry_resolved_at_ms == resolved_at_ms)
            .unwrap_or(false);
        if should_remove {
            let _ = guard.pending_by_id.remove(&id);
        }
    });
}

fn prune_oldest_exec_approval_pending(
    pending_by_id: &mut HashMap<String, ExecApprovalPendingEntry>,
    max_pending: usize,
) {
    while pending_by_id.len() > max_pending {
        let Some(oldest_key) = pending_by_id
            .iter()
            .min_by_key(|(_, entry)| (entry.resolved_at_ms.is_none(), entry.created_at_ms))
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        let Some(removed) = pending_by_id.remove(&oldest_key) else {
            continue;
        };
        for waiter in removed.waiters {
            let _ = waiter.send(None);
        }
    }
}

fn next_exec_approval_id() -> String {
    let sequence = EXEC_APPROVAL_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("approval-{}-{sequence}", now_ms())
}

fn next_chat_inject_message_id() -> String {
    let sequence = CHAT_INJECT_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("msg-{}-{sequence}", now_ms())
}

fn next_send_message_id() -> String {
    let sequence = SEND_MESSAGE_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("send-{}-{sequence}", now_ms())
}

fn next_poll_id() -> String {
    let sequence = POLL_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("poll-{}-{sequence}", now_ms())
}

fn next_tts_audio_path(extension: &str) -> String {
    let sequence = TTS_AUDIO_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("memory://tts/audio-{}-{sequence}{extension}", now_ms())
}

fn is_supported_tts_provider(provider: &str) -> bool {
    matches!(provider, "openai" | "elevenlabs" | "edge")
}

fn tts_provider_order(primary: &str) -> Vec<&'static str> {
    let normalized = normalize(primary);
    let mut order = vec!["openai", "elevenlabs", "edge"];
    if let Some(index) = order.iter().position(|candidate| *candidate == normalized) {
        order.swap(0, index);
    }
    order
}

fn tts_fallback_providers(primary: &str) -> Vec<String> {
    tts_provider_order(primary)
        .into_iter()
        .skip(1)
        .map(str::to_owned)
        .collect()
}

fn normalize_voicewake_triggers(values: &[Value]) -> Vec<String> {
    let mut cleaned = Vec::new();
    for value in values {
        let Some(trigger) = value.as_str() else {
            continue;
        };
        let trimmed = trigger.trim();
        if trimmed.is_empty() {
            continue;
        }
        let normalized = trimmed.chars().take(64).collect::<String>();
        if normalized.is_empty() {
            continue;
        }
        cleaned.push(normalized);
        if cleaned.len() >= 32 {
            break;
        }
    }
    if cleaned.is_empty() {
        return DEFAULT_VOICEWAKE_TRIGGERS
            .iter()
            .map(|value| (*value).to_owned())
            .collect();
    }
    cleaned
}

fn derive_outbound_session_key(channel: &str, to: &str) -> String {
    let channel_key = normalize(channel);
    let target_key = normalize_outbound_target_segment(to);
    format!("agent:main:{channel_key}:out:{target_key}")
}

fn normalize_outbound_target_segment(target: &str) -> String {
    let mut normalized = String::new();
    let mut last_was_dash = false;
    for ch in target.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, ':' | '_' | '+' | '-') {
            normalized.push(ch);
            last_was_dash = false;
            continue;
        }
        if !last_was_dash {
            normalized.push('-');
            last_was_dash = true;
        }
    }
    while normalized.ends_with('-') {
        normalized.pop();
    }
    if normalized.is_empty() {
        return "target".to_owned();
    }
    if normalized.len() > 96 {
        normalized.truncate(96);
    }
    normalized
}

struct ChatRegistry {
    state: Arc<Mutex<ChatState>>,
}

#[derive(Default)]
struct ChatState {
    runs_by_id: HashMap<String, ChatRunEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatRunStatus {
    InFlight,
    Completed,
    Aborted,
}

#[derive(Debug, Clone)]
struct ChatRunEntry {
    session_key: String,
    status: ChatRunStatus,
    started_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatRunStartOutcome {
    Started,
    InFlight,
    Completed,
    Aborted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatAbortRunOutcome {
    NotFound,
    SessionMismatch,
    Aborted,
}

impl ChatRegistry {
    fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(ChatState::default())),
        }
    }

    async fn start_run(
        &self,
        session_key: &str,
        run_id: &str,
        timeout_ms: u64,
    ) -> ChatRunStartOutcome {
        let mut guard = self.state.lock().await;
        if let Some(existing) = guard.runs_by_id.get(run_id) {
            return match existing.status {
                ChatRunStatus::InFlight => ChatRunStartOutcome::InFlight,
                ChatRunStatus::Completed => ChatRunStartOutcome::Completed,
                ChatRunStatus::Aborted => ChatRunStartOutcome::Aborted,
            };
        }
        let now = now_ms();
        guard.runs_by_id.insert(
            run_id.to_owned(),
            ChatRunEntry {
                session_key: session_key.to_owned(),
                status: ChatRunStatus::InFlight,
                started_at_ms: now,
                updated_at_ms: now,
            },
        );
        prune_oldest_chat_runs(&mut guard.runs_by_id, MAX_CHAT_RUNS);
        drop(guard);

        let state = Arc::clone(&self.state);
        let complete_run_id = run_id.to_owned();
        let delay_ms = CHAT_RUN_COMPLETE_DELAY_MS.min(timeout_ms.max(1));
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let mut guard = state.lock().await;
            let Some(entry) = guard.runs_by_id.get_mut(&complete_run_id) else {
                return;
            };
            if entry.status == ChatRunStatus::InFlight {
                entry.status = ChatRunStatus::Completed;
                entry.updated_at_ms = now_ms();
            }
        });

        ChatRunStartOutcome::Started
    }

    async fn abort_run(&self, session_key: &str, run_id: &str) -> ChatAbortRunOutcome {
        let mut guard = self.state.lock().await;
        let Some(entry) = guard.runs_by_id.get_mut(run_id) else {
            return ChatAbortRunOutcome::NotFound;
        };
        if !entry.session_key.eq_ignore_ascii_case(session_key) {
            return ChatAbortRunOutcome::SessionMismatch;
        }
        if entry.status != ChatRunStatus::InFlight {
            return ChatAbortRunOutcome::NotFound;
        }
        entry.status = ChatRunStatus::Aborted;
        entry.updated_at_ms = now_ms();
        ChatAbortRunOutcome::Aborted
    }

    async fn abort_session(&self, session_key: &str) -> Vec<String> {
        let mut guard = self.state.lock().await;
        let mut aborted = Vec::new();
        for (run_id, entry) in &mut guard.runs_by_id {
            if !entry.session_key.eq_ignore_ascii_case(session_key) {
                continue;
            }
            if entry.status != ChatRunStatus::InFlight {
                continue;
            }
            entry.status = ChatRunStatus::Aborted;
            entry.updated_at_ms = now_ms();
            aborted.push(run_id.clone());
        }
        aborted.sort();
        aborted
    }
}

fn prune_oldest_chat_runs(runs_by_id: &mut HashMap<String, ChatRunEntry>, max_runs: usize) {
    while runs_by_id.len() > max_runs {
        let Some(oldest_key) = runs_by_id
            .iter()
            .min_by_key(|(_, entry)| (entry.status == ChatRunStatus::InFlight, entry.started_at_ms))
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        let _ = runs_by_id.remove(&oldest_key);
    }
}

struct SendRegistry {
    state: Mutex<SendState>,
}

#[derive(Default)]
struct SendState {
    cached_by_id: HashMap<String, SendCacheEntry>,
}

#[derive(Debug, Clone)]
struct SendCacheEntry {
    payload: Value,
    created_at_ms: u64,
}

impl SendRegistry {
    fn new() -> Self {
        Self {
            state: Mutex::new(SendState::default()),
        }
    }

    async fn get(&self, idempotency_key: &str) -> Option<Value> {
        let guard = self.state.lock().await;
        guard
            .cached_by_id
            .get(idempotency_key)
            .map(|entry| entry.payload.clone())
    }

    async fn set(&self, idempotency_key: String, payload: Value) {
        let mut guard = self.state.lock().await;
        guard.cached_by_id.insert(
            idempotency_key,
            SendCacheEntry {
                payload,
                created_at_ms: now_ms(),
            },
        );
        prune_oldest_send_cache(&mut guard.cached_by_id, MAX_SEND_CACHE_ENTRIES);
    }
}

fn prune_oldest_send_cache(cached_by_id: &mut HashMap<String, SendCacheEntry>, max_entries: usize) {
    while cached_by_id.len() > max_entries {
        let Some(oldest_key) = cached_by_id
            .iter()
            .min_by_key(|(_, entry)| entry.created_at_ms)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        let _ = cached_by_id.remove(&oldest_key);
    }
}

struct DeviceRegistry {
    state: Mutex<DevicePairState>,
}

#[derive(Debug, Clone, Default)]
struct DevicePairState {
    pending_by_id: HashMap<String, DevicePairPendingRequest>,
    paired_by_device_id: HashMap<String, PairedDeviceEntry>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct DevicePairListResult {
    pending: Vec<DevicePairPendingRequest>,
    paired: Vec<PairedDeviceView>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct DevicePairApproveResult {
    #[serde(rename = "requestId")]
    request_id: String,
    device: PairedDeviceView,
}

#[derive(Debug, Clone, serde::Serialize)]
struct DevicePairRejectResult {
    #[serde(rename = "requestId")]
    request_id: String,
    #[serde(rename = "deviceId")]
    device_id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
struct DevicePairRemoveResult {
    #[serde(rename = "deviceId")]
    device_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct DevicePairPendingRequest {
    #[serde(rename = "requestId")]
    request_id: String,
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "publicKey")]
    public_key: String,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    #[serde(rename = "clientId", skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    #[serde(rename = "clientMode", skip_serializing_if = "Option::is_none")]
    client_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    roles: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scopes: Option<Vec<String>>,
    #[serde(rename = "remoteIp", skip_serializing_if = "Option::is_none")]
    remote_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    silent: Option<bool>,
    #[serde(rename = "isRepair", skip_serializing_if = "Option::is_none")]
    is_repair: Option<bool>,
    ts: u64,
}

#[derive(Debug, Clone)]
struct PairedDeviceEntry {
    device_id: String,
    public_key: String,
    display_name: Option<String>,
    platform: Option<String>,
    client_id: Option<String>,
    client_mode: Option<String>,
    role: Option<String>,
    roles: Option<Vec<String>>,
    scopes: Option<Vec<String>>,
    remote_ip: Option<String>,
    tokens: HashMap<String, DeviceAuthTokenEntry>,
    created_at_ms: u64,
    approved_at_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
struct PairedDeviceView {
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "publicKey")]
    public_key: String,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    #[serde(rename = "clientId", skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    #[serde(rename = "clientMode", skip_serializing_if = "Option::is_none")]
    client_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    roles: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scopes: Option<Vec<String>>,
    #[serde(rename = "remoteIp", skip_serializing_if = "Option::is_none")]
    remote_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tokens: Option<Vec<DeviceAuthTokenSummary>>,
    #[serde(rename = "createdAtMs")]
    created_at_ms: u64,
    #[serde(rename = "approvedAtMs")]
    approved_at_ms: u64,
}

#[derive(Debug, Clone)]
struct DeviceAuthTokenEntry {
    token: String,
    role: String,
    scopes: Vec<String>,
    created_at_ms: u64,
    rotated_at_ms: Option<u64>,
    revoked_at_ms: Option<u64>,
    last_used_at_ms: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct DeviceAuthTokenSummary {
    role: String,
    scopes: Vec<String>,
    #[serde(rename = "createdAtMs")]
    created_at_ms: u64,
    #[serde(rename = "rotatedAtMs", skip_serializing_if = "Option::is_none")]
    rotated_at_ms: Option<u64>,
    #[serde(rename = "revokedAtMs", skip_serializing_if = "Option::is_none")]
    revoked_at_ms: Option<u64>,
    #[serde(rename = "lastUsedAtMs", skip_serializing_if = "Option::is_none")]
    last_used_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
struct DevicePairRequestedEventPayload {
    #[serde(rename = "requestId", alias = "request_id")]
    request_id: Option<String>,
    #[serde(rename = "deviceId", alias = "device_id")]
    device_id: Option<String>,
    #[serde(rename = "publicKey", alias = "public_key")]
    public_key: Option<String>,
    #[serde(rename = "displayName", alias = "display_name")]
    display_name: Option<String>,
    platform: Option<String>,
    #[serde(rename = "clientId", alias = "client_id")]
    client_id: Option<String>,
    #[serde(rename = "clientMode", alias = "client_mode")]
    client_mode: Option<String>,
    role: Option<String>,
    roles: Option<Vec<String>>,
    scopes: Option<Vec<String>>,
    #[serde(rename = "remoteIp", alias = "remote_ip")]
    remote_ip: Option<String>,
    silent: Option<bool>,
    #[serde(rename = "isRepair", alias = "is_repair")]
    is_repair: Option<bool>,
    ts: Option<u64>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
struct DevicePairResolvedEventPayload {
    #[serde(rename = "requestId", alias = "request_id")]
    request_id: Option<String>,
}

impl DeviceRegistry {
    fn new() -> Self {
        Self {
            state: Mutex::new(DevicePairState::default()),
        }
    }

    async fn list(&self) -> DevicePairListResult {
        let guard = self.state.lock().await;
        let mut pending = guard
            .pending_by_id
            .values()
            .cloned()
            .collect::<Vec<DevicePairPendingRequest>>();
        pending.sort_by(|a, b| {
            b.ts.cmp(&a.ts)
                .then_with(|| a.request_id.cmp(&b.request_id))
        });

        let mut paired = guard
            .paired_by_device_id
            .values()
            .map(redact_paired_device)
            .collect::<Vec<PairedDeviceView>>();
        paired.sort_by(|a, b| {
            b.approved_at_ms
                .cmp(&a.approved_at_ms)
                .then_with(|| a.device_id.cmp(&b.device_id))
        });
        DevicePairListResult { pending, paired }
    }

    async fn ingest_pair_requested(&self, payload: Value) {
        let Ok(event) = serde_json::from_value::<DevicePairRequestedEventPayload>(payload) else {
            return;
        };
        let Some(request_id) = normalize_optional_text(event.request_id, 128) else {
            return;
        };
        let Some(device_id) = normalize_optional_text(event.device_id, 128) else {
            return;
        };
        let Some(public_key) = normalize_optional_text(event.public_key, 1024) else {
            return;
        };
        let role = normalize_optional_text(event.role, 64);
        let mut roles = normalize_string_list(event.roles, 32, 64);
        if let Some(role_value) = &role {
            if !roles
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(role_value))
            {
                roles.push(role_value.clone());
            }
        }
        let roles = (!roles.is_empty()).then_some(roles);
        let scopes = normalize_device_auth_scopes(event.scopes);
        let request = DevicePairPendingRequest {
            request_id: request_id.clone(),
            device_id: device_id.clone(),
            public_key,
            display_name: normalize_optional_text(event.display_name, 128),
            platform: normalize_optional_text(event.platform, 128),
            client_id: normalize_optional_text(event.client_id, 128),
            client_mode: normalize_optional_text(event.client_mode, 128),
            role,
            roles,
            scopes: (!scopes.is_empty()).then_some(scopes),
            remote_ip: normalize_optional_text(event.remote_ip, 128),
            silent: event.silent,
            is_repair: event.is_repair,
            ts: event.ts.unwrap_or_else(now_ms),
        };
        let mut guard = self.state.lock().await;
        guard
            .pending_by_id
            .retain(|key, pending| key == &request_id || pending.device_id != device_id);
        guard.pending_by_id.insert(request_id, request);
        prune_oldest_pending(&mut guard.pending_by_id, 512);
    }

    async fn ingest_pair_resolved(&self, payload: Value) {
        let Ok(event) = serde_json::from_value::<DevicePairResolvedEventPayload>(payload) else {
            return;
        };
        let Some(request_id) = normalize_optional_text(event.request_id, 128) else {
            return;
        };
        let mut guard = self.state.lock().await;
        let _ = guard.pending_by_id.remove(&request_id);
    }

    async fn approve(&self, request_id: &str) -> Option<DevicePairApproveResult> {
        let mut guard = self.state.lock().await;
        let pending = guard.pending_by_id.remove(request_id)?;
        let now = now_ms();
        let existing = guard.paired_by_device_id.get(&pending.device_id).cloned();
        let mut tokens = existing
            .as_ref()
            .map(|entry| entry.tokens.clone())
            .unwrap_or_default();

        if let Some(role) = pending.role.clone() {
            let scoped = normalize_device_auth_scopes(pending.scopes.clone());
            let existing_token = tokens.get(&role).cloned();
            tokens.insert(
                role.clone(),
                DeviceAuthTokenEntry {
                    token: next_device_auth_token(&pending.device_id, &role),
                    role,
                    scopes: scoped,
                    created_at_ms: existing_token
                        .as_ref()
                        .map_or(now, |token| token.created_at_ms),
                    rotated_at_ms: existing_token.as_ref().map(|_| now),
                    revoked_at_ms: None,
                    last_used_at_ms: existing_token.and_then(|token| token.last_used_at_ms),
                },
            );
        }

        let device = PairedDeviceEntry {
            device_id: pending.device_id.clone(),
            public_key: pending.public_key,
            display_name: pending.display_name,
            platform: pending.platform,
            client_id: pending.client_id,
            client_mode: pending.client_mode,
            role: pending.role,
            roles: merge_device_roles(existing.as_ref(), pending.roles.as_ref()),
            scopes: merge_device_scopes(existing.as_ref(), pending.scopes.as_ref()),
            remote_ip: pending.remote_ip,
            tokens,
            created_at_ms: existing.as_ref().map_or(now, |entry| entry.created_at_ms),
            approved_at_ms: now,
        };
        guard
            .paired_by_device_id
            .insert(device.device_id.clone(), device.clone());
        prune_oldest_paired_devices(&mut guard.paired_by_device_id, 2_048);
        Some(DevicePairApproveResult {
            request_id: request_id.to_owned(),
            device: redact_paired_device(&device),
        })
    }

    async fn reject(&self, request_id: &str) -> Option<DevicePairRejectResult> {
        let mut guard = self.state.lock().await;
        let pending = guard.pending_by_id.remove(request_id)?;
        Some(DevicePairRejectResult {
            request_id: request_id.to_owned(),
            device_id: pending.device_id,
        })
    }

    async fn remove(&self, device_id: &str) -> Option<DevicePairRemoveResult> {
        let normalized = device_id.trim();
        if normalized.is_empty() {
            return None;
        }
        let mut guard = self.state.lock().await;
        guard.paired_by_device_id.remove(normalized)?;
        Some(DevicePairRemoveResult {
            device_id: normalized.to_owned(),
        })
    }

    async fn rotate_token(
        &self,
        device_id: &str,
        role: &str,
        scopes: Option<Vec<String>>,
    ) -> Option<DeviceAuthTokenEntry> {
        let normalized_device_id = device_id.trim();
        if normalized_device_id.is_empty() {
            return None;
        }
        let normalized_role = role.trim();
        if normalized_role.is_empty() {
            return None;
        }
        let mut guard = self.state.lock().await;
        let device = guard.paired_by_device_id.get_mut(normalized_device_id)?;
        let existing = device.tokens.get(normalized_role).cloned();
        let requested_scopes = normalize_device_auth_scopes(scopes.clone().or_else(|| {
            existing
                .as_ref()
                .map(|token| token.scopes.clone())
                .or_else(|| device.scopes.clone())
        }));
        let now = now_ms();
        let next = DeviceAuthTokenEntry {
            token: next_device_auth_token(&device.device_id, normalized_role),
            role: normalized_role.to_owned(),
            scopes: requested_scopes.clone(),
            created_at_ms: existing.as_ref().map_or(now, |token| token.created_at_ms),
            rotated_at_ms: Some(now),
            revoked_at_ms: None,
            last_used_at_ms: existing.and_then(|token| token.last_used_at_ms),
        };
        device
            .tokens
            .insert(normalized_role.to_owned(), next.clone());
        if scopes.is_some() {
            device.scopes = Some(requested_scopes);
        }
        Some(next)
    }

    async fn revoke_token(&self, device_id: &str, role: &str) -> Option<DeviceAuthTokenEntry> {
        let normalized_device_id = device_id.trim();
        if normalized_device_id.is_empty() {
            return None;
        }
        let normalized_role = role.trim();
        if normalized_role.is_empty() {
            return None;
        }
        let mut guard = self.state.lock().await;
        let device = guard.paired_by_device_id.get_mut(normalized_device_id)?;
        let token = device.tokens.get(normalized_role).cloned()?;
        let revoked = DeviceAuthTokenEntry {
            revoked_at_ms: Some(now_ms()),
            ..token
        };
        device
            .tokens
            .insert(normalized_role.to_owned(), revoked.clone());
        Some(revoked)
    }
}

fn redact_paired_device(device: &PairedDeviceEntry) -> PairedDeviceView {
    PairedDeviceView {
        device_id: device.device_id.clone(),
        public_key: device.public_key.clone(),
        display_name: device.display_name.clone(),
        platform: device.platform.clone(),
        client_id: device.client_id.clone(),
        client_mode: device.client_mode.clone(),
        role: device.role.clone(),
        roles: device.roles.clone(),
        scopes: device.scopes.clone(),
        remote_ip: device.remote_ip.clone(),
        tokens: summarize_device_tokens(&device.tokens),
        created_at_ms: device.created_at_ms,
        approved_at_ms: device.approved_at_ms,
    }
}

fn summarize_device_tokens(
    tokens: &HashMap<String, DeviceAuthTokenEntry>,
) -> Option<Vec<DeviceAuthTokenSummary>> {
    if tokens.is_empty() {
        return None;
    }
    let mut summaries = tokens
        .values()
        .map(|token| DeviceAuthTokenSummary {
            role: token.role.clone(),
            scopes: token.scopes.clone(),
            created_at_ms: token.created_at_ms,
            rotated_at_ms: token.rotated_at_ms,
            revoked_at_ms: token.revoked_at_ms,
            last_used_at_ms: token.last_used_at_ms,
        })
        .collect::<Vec<_>>();
    summaries.sort_by(|a, b| a.role.cmp(&b.role));
    Some(summaries)
}

fn merge_device_roles(
    existing: Option<&PairedDeviceEntry>,
    pending_roles: Option<&Vec<String>>,
) -> Option<Vec<String>> {
    let mut merged = Vec::new();
    if let Some(existing) = existing {
        if let Some(roles) = &existing.roles {
            for role in roles {
                push_unique_string_case_insensitive(&mut merged, role, 64);
            }
        }
        if let Some(role) = &existing.role {
            push_unique_string_case_insensitive(&mut merged, role, 64);
        }
    }
    if let Some(roles) = pending_roles {
        for role in roles {
            push_unique_string_case_insensitive(&mut merged, role, 64);
        }
    }
    (!merged.is_empty()).then_some(merged)
}

fn merge_device_scopes(
    existing: Option<&PairedDeviceEntry>,
    pending_scopes: Option<&Vec<String>>,
) -> Option<Vec<String>> {
    let mut merged = Vec::new();
    if let Some(existing) = existing {
        if let Some(scopes) = &existing.scopes {
            for scope in scopes {
                push_unique_string_case_insensitive(&mut merged, scope, 96);
            }
        }
    }
    if let Some(scopes) = pending_scopes {
        for scope in scopes {
            push_unique_string_case_insensitive(&mut merged, scope, 96);
        }
    }
    (!merged.is_empty()).then_some(merged)
}

fn normalize_device_auth_scopes(scopes: Option<Vec<String>>) -> Vec<String> {
    normalize_string_list(scopes, 64, 96)
}

fn push_unique_string_case_insensitive(target: &mut Vec<String>, raw: &str, max_len: usize) {
    let Some(value) = normalize_optional_text(Some(raw.to_owned()), max_len) else {
        return;
    };
    if target
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&value))
    {
        return;
    }
    target.push(value);
}

fn prune_oldest_pending(
    pending_by_id: &mut HashMap<String, DevicePairPendingRequest>,
    max_pending: usize,
) {
    while pending_by_id.len() > max_pending {
        let Some(oldest_key) = pending_by_id
            .iter()
            .min_by_key(|(_, pending)| pending.ts)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        let _ = pending_by_id.remove(&oldest_key);
    }
}

fn prune_oldest_paired_devices(
    paired_by_device_id: &mut HashMap<String, PairedDeviceEntry>,
    max_devices: usize,
) {
    while paired_by_device_id.len() > max_devices {
        let Some(oldest_key) = paired_by_device_id
            .iter()
            .min_by_key(|(_, device)| device.approved_at_ms)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        let _ = paired_by_device_id.remove(&oldest_key);
    }
}

fn next_device_auth_token(device_id: &str, role: &str) -> String {
    use sha2::{Digest, Sha256};
    let sequence = DEVICE_TOKEN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut hasher = Sha256::new();
    hasher.update(device_id.as_bytes());
    hasher.update(role.as_bytes());
    hasher.update(now_ms().to_le_bytes());
    hasher.update(sequence.to_le_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("dtk_{}", &digest[..48])
}

struct WebLoginRegistry {
    state: Mutex<WebLoginState>,
}

#[derive(Debug, Clone)]
struct WebLoginState {
    sessions: HashMap<String, WebLoginSession>,
}

#[derive(Debug, Clone)]
struct WebLoginSession {
    session_id: String,
    provider_id: String,
    account_id: String,
    started_at_ms: u64,
    ready_at_ms: u64,
    expires_at_ms: u64,
    qr_data_url: String,
    verbose: bool,
}

#[derive(Debug, Clone)]
struct WebLoginStartInput {
    provider_id: String,
    account_id: String,
    force: bool,
    verbose: bool,
    timeout_ms: u64,
}

#[derive(Debug, Clone)]
struct WebLoginWaitInput {
    provider_id: String,
    account_id: String,
    timeout_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
struct WebLoginStartResult {
    #[serde(rename = "providerId")]
    provider_id: String,
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "startedAtMs")]
    started_at_ms: u64,
    #[serde(rename = "expiresAtMs")]
    expires_at_ms: u64,
    #[serde(rename = "qrDataUrl")]
    qr_data_url: String,
    message: String,
    verbose: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
struct WebLoginWaitResult {
    #[serde(rename = "providerId")]
    provider_id: String,
    #[serde(rename = "accountId")]
    account_id: String,
    connected: bool,
    message: String,
}

impl WebLoginRegistry {
    fn new() -> Self {
        Self {
            state: Mutex::new(WebLoginState {
                sessions: HashMap::new(),
            }),
        }
    }

    async fn start(&self, input: WebLoginStartInput) -> WebLoginStartResult {
        let now = now_ms();
        let timeout_ms = input.timeout_ms.max(5_000);
        let key = format!(
            "{}:{}",
            normalize(&input.provider_id),
            normalize(&input.account_id)
        );
        let mut guard = self.state.lock().await;
        if !input.force {
            if let Some(existing) = guard.sessions.get(&key) {
                if now <= existing.expires_at_ms {
                    return WebLoginStartResult {
                        provider_id: existing.provider_id.clone(),
                        account_id: existing.account_id.clone(),
                        session_id: existing.session_id.clone(),
                        started_at_ms: existing.started_at_ms,
                        expires_at_ms: existing.expires_at_ms,
                        qr_data_url: existing.qr_data_url.clone(),
                        message: "QR already active. Scan it in WhatsApp -> Linked Devices."
                            .to_owned(),
                        verbose: existing.verbose,
                    };
                }
            }
        }

        let session_id = next_web_login_session_id();
        let started_at_ms = now;
        let expires_at_ms = now.saturating_add(timeout_ms.max(60_000));
        let ready_at_ms = now.saturating_add(timeout_ms.min(3_000));
        let qr_data_url = format!(
            "data:image/png;base64,cnVzdC1wYXJpdHktd2ViLWxvZ2luLXNlc3Npb24t{}",
            session_id
        );
        let session = WebLoginSession {
            session_id: session_id.clone(),
            provider_id: input.provider_id.clone(),
            account_id: input.account_id.clone(),
            started_at_ms,
            ready_at_ms,
            expires_at_ms,
            qr_data_url: qr_data_url.clone(),
            verbose: input.verbose,
        };
        guard.sessions.insert(key, session);
        if guard.sessions.len() > 64 {
            let mut oldest_key: Option<String> = None;
            let mut oldest_started = u64::MAX;
            for (entry_key, entry) in &guard.sessions {
                if entry.started_at_ms < oldest_started {
                    oldest_started = entry.started_at_ms;
                    oldest_key = Some(entry_key.clone());
                }
            }
            if let Some(oldest_key) = oldest_key {
                let _ = guard.sessions.remove(&oldest_key);
            }
        }
        WebLoginStartResult {
            provider_id: input.provider_id,
            account_id: input.account_id,
            session_id,
            started_at_ms,
            expires_at_ms,
            qr_data_url,
            message: "Scan this QR in WhatsApp -> Linked Devices.".to_owned(),
            verbose: input.verbose,
        }
    }

    async fn wait(&self, input: WebLoginWaitInput) -> WebLoginWaitResult {
        let now = now_ms();
        let timeout_ms = input.timeout_ms.max(1_000);
        let key = format!(
            "{}:{}",
            normalize(&input.provider_id),
            normalize(&input.account_id)
        );
        let mut guard = self.state.lock().await;
        let Some(session) = guard.sessions.get(&key).cloned() else {
            return WebLoginWaitResult {
                provider_id: input.provider_id,
                account_id: input.account_id,
                connected: false,
                message: "No active WhatsApp login in progress.".to_owned(),
            };
        };
        if now > session.expires_at_ms {
            let _ = guard.sessions.remove(&key);
            return WebLoginWaitResult {
                provider_id: input.provider_id,
                account_id: input.account_id,
                connected: false,
                message: "The login QR expired. Ask me to generate a new one.".to_owned(),
            };
        }
        if now.saturating_add(timeout_ms) >= session.ready_at_ms {
            let _ = guard.sessions.remove(&key);
            return WebLoginWaitResult {
                provider_id: input.provider_id,
                account_id: input.account_id,
                connected: true,
                message: "Linked! Channel account is ready.".to_owned(),
            };
        }
        WebLoginWaitResult {
            provider_id: input.provider_id,
            account_id: input.account_id,
            connected: false,
            message: "Still waiting for the QR scan. Let me know when you've scanned it."
                .to_owned(),
        }
    }
}

struct WizardRegistry {
    state: Mutex<WizardState>,
}

#[derive(Debug, Clone)]
struct WizardState {
    sessions: HashMap<String, WizardSessionState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum WizardRunStatus {
    Running,
    Done,
    Cancelled,
    Error,
}

#[derive(Debug, Clone)]
struct WizardSessionState {
    mode: String,
    workspace: Option<String>,
    status: WizardRunStatus,
    error: Option<String>,
    created_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Debug, Clone)]
enum WizardRegistryError {
    Invalid(String),
    Unavailable(String),
}

impl WizardRunStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
            Self::Error => "error",
        }
    }
}

impl WizardRegistry {
    fn new() -> Self {
        Self {
            state: Mutex::new(WizardState {
                sessions: HashMap::new(),
            }),
        }
    }

    async fn start(
        &self,
        mode: String,
        workspace: Option<String>,
    ) -> Result<Value, WizardRegistryError> {
        let mut guard = self.state.lock().await;
        if guard
            .sessions
            .values()
            .any(|session| session.status == WizardRunStatus::Running)
        {
            return Err(WizardRegistryError::Unavailable(
                "wizard already running".to_owned(),
            ));
        }
        let now = now_ms();
        let session_id = next_wizard_session_id();
        let session = WizardSessionState {
            mode,
            workspace,
            status: WizardRunStatus::Running,
            error: None,
            created_at_ms: now,
            updated_at_ms: now,
        };
        guard.sessions.insert(session_id.clone(), session.clone());
        if guard.sessions.len() > 64 {
            let mut oldest_key: Option<String> = None;
            let mut oldest_started = u64::MAX;
            for (entry_key, entry) in &guard.sessions {
                if entry.status == WizardRunStatus::Running {
                    continue;
                }
                if entry.created_at_ms < oldest_started {
                    oldest_started = entry.created_at_ms;
                    oldest_key = Some(entry_key.clone());
                }
            }
            if let Some(oldest_key) = oldest_key {
                let _ = guard.sessions.remove(&oldest_key);
            }
        }
        Ok(json!({
            "sessionId": session_id,
            "done": false,
            "step": wizard_step_payload(&session),
            "status": WizardRunStatus::Running.as_str()
        }))
    }

    async fn next(&self, params: WizardNextParams) -> Result<Value, WizardRegistryError> {
        let session_id = normalize_optional_text(params.session_id, 128).ok_or_else(|| {
            WizardRegistryError::Invalid(
                "invalid wizard.next params: sessionId required".to_owned(),
            )
        })?;
        let mut guard = self.state.lock().await;
        let Some(session) = guard.sessions.get_mut(&session_id) else {
            return Err(WizardRegistryError::Invalid("wizard not found".to_owned()));
        };

        if let Some(answer) = params.answer {
            if session.status != WizardRunStatus::Running {
                return Err(WizardRegistryError::Invalid(
                    "wizard not running".to_owned(),
                ));
            }
            let step_id = normalize_optional_text(Some(answer.step_id), 128).ok_or_else(|| {
                WizardRegistryError::Invalid(
                    "invalid wizard.next params: answer.stepId required".to_owned(),
                )
            })?;
            if normalize(&step_id) != "confirm-setup" {
                session.status = WizardRunStatus::Error;
                session.error = Some("invalid wizard step".to_owned());
                return Err(WizardRegistryError::Invalid(
                    "invalid wizard.next params: unknown stepId".to_owned(),
                ));
            }
            let accepted = match answer.value {
                Some(value) => json_value_as_bool(&value).ok_or_else(|| {
                    WizardRegistryError::Invalid(
                        "invalid wizard.next params: answer.value must be boolean".to_owned(),
                    )
                })?,
                None => true,
            };
            session.updated_at_ms = now_ms();
            session.status = if accepted {
                WizardRunStatus::Done
            } else {
                WizardRunStatus::Cancelled
            };
        }

        let running = session.status == WizardRunStatus::Running;
        let response = if running {
            json!({
                "done": false,
                "step": wizard_step_payload(session),
                "status": session.status.as_str(),
                "error": session.error
            })
        } else {
            json!({
                "done": true,
                "status": session.status.as_str(),
                "error": session.error
            })
        };
        if !running {
            let _ = guard.sessions.remove(&session_id);
        }
        Ok(response)
    }

    async fn cancel(&self, session_id: &str) -> Result<Value, WizardRegistryError> {
        let mut guard = self.state.lock().await;
        let Some(mut session) = guard.sessions.remove(session_id) else {
            return Err(WizardRegistryError::Invalid("wizard not found".to_owned()));
        };
        session.status = WizardRunStatus::Cancelled;
        session.updated_at_ms = now_ms();
        Ok(json!({
            "status": session.status.as_str(),
            "error": session.error
        }))
    }

    async fn status(&self, session_id: &str) -> Result<Value, WizardRegistryError> {
        let mut guard = self.state.lock().await;
        let Some(session) = guard.sessions.get(session_id).cloned() else {
            return Err(WizardRegistryError::Invalid("wizard not found".to_owned()));
        };
        if session.status != WizardRunStatus::Running {
            let _ = guard.sessions.remove(session_id);
        }
        Ok(json!({
            "status": session.status.as_str(),
            "error": session.error
        }))
    }
}

fn wizard_step_payload(session: &WizardSessionState) -> Value {
    let workspace_label = session
        .workspace
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("default");
    json!({
        "id": "confirm-setup",
        "type": "confirm",
        "title": "Rust Gateway Wizard",
        "message": format!(
            "Mode: {}. Workspace: {}. Confirm to apply Rust parity wizard setup.",
            session.mode, workspace_label
        ),
        "initialValue": true,
        "executor": "gateway"
    })
}

fn parse_wizard_mode(mode: Option<String>) -> Result<String, String> {
    let normalized = normalize_optional_text(mode, 32).unwrap_or_else(|| "local".to_owned());
    match normalize(&normalized).as_str() {
        "local" => Ok("local".to_owned()),
        "remote" => Ok("remote".to_owned()),
        _ => Err("invalid wizard.start params: mode must be local|remote".to_owned()),
    }
}

fn resolve_web_login_provider(channel_capabilities: &[ChannelCapabilities]) -> Option<String> {
    for candidate in ["whatsapp", "zalouser", "zalo"] {
        if channel_capabilities
            .iter()
            .any(|cap| cap.name.eq_ignore_ascii_case(candidate))
        {
            return Some(candidate.to_owned());
        }
    }
    None
}

fn extract_update_delivery_info(session_key: Option<&str>) -> (Option<Value>, Option<String>) {
    let Some(session_key) = session_key else {
        return (None, None);
    };
    let parsed = parse_session_key(session_key);
    let mut delivery = serde_json::Map::new();
    if let Some(channel) = parsed.channel {
        delivery.insert("channel".to_owned(), Value::String(channel));
    }
    if let Some(to) = parsed.scope_id {
        delivery.insert("to".to_owned(), Value::String(to));
    }
    (
        (!delivery.is_empty()).then_some(Value::Object(delivery)),
        parsed.topic_id,
    )
}

fn json_value_as_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(v) => Some(*v),
        Value::Number(v) => v.as_i64().map(|raw| raw != 0),
        Value::String(v) => match normalize(v).as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn json_value_as_timeout_ms(value: &Value) -> Option<u64> {
    let Value::Number(raw) = value else {
        return None;
    };
    if let Some(value) = raw.as_u64() {
        return Some(value.max(1));
    }
    if let Some(value) = raw.as_i64() {
        return Some(value.max(1) as u64);
    }
    let value = raw.as_f64()?;
    if !value.is_finite() {
        return None;
    }
    Some(value.floor().max(1.0) as u64)
}

fn normalize_node_invoke_result_params(params: Value) -> Value {
    let Some(mut map) = params.as_object().cloned() else {
        return params;
    };
    if matches!(map.get("payloadJSON"), Some(Value::Null)) {
        map.remove("payloadJSON");
    } else if matches!(map.get("payload_json"), Some(Value::Null)) {
        map.remove("payload_json");
    }

    let payload_json_value = map
        .get("payloadJSON")
        .cloned()
        .or_else(|| map.get("payload_json").cloned());
    if let Some(payload_json_value) = payload_json_value {
        if !payload_json_value.is_string() {
            if !map.contains_key("payload") {
                map.insert("payload".to_owned(), payload_json_value);
            }
            map.remove("payloadJSON");
            map.remove("payload_json");
        }
    }

    if matches!(map.get("error"), Some(Value::Null)) {
        map.remove("error");
    }
    Value::Object(map)
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

#[derive(Debug, Clone)]
struct ChatSessionMeta {
    session_id: String,
    thinking_level: Option<String>,
    verbose_level: Option<String>,
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

    async fn chat_meta(&self, session_key: &str) -> Option<ChatSessionMeta> {
        let guard = self.entries.lock().await;
        let entry = guard.get(session_key)?;
        Some(ChatSessionMeta {
            session_id: entry.session_id.clone(),
            thinking_level: entry.thinking_level.clone(),
            verbose_level: entry.verbose_level.clone(),
        })
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
struct TtsStatusParams {}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct TtsToggleParams {}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct TtsConvertParams {
    text: Option<String>,
    channel: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct TtsSetProviderParams {
    provider: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct TtsProvidersParams {}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct VoiceWakeGetParams {}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct VoiceWakeSetParams {
    triggers: Option<Value>,
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
struct AgentParams {
    message: String,
    #[serde(rename = "agentId", alias = "agent_id")]
    agent_id: Option<String>,
    to: Option<String>,
    #[serde(rename = "replyTo", alias = "reply_to")]
    reply_to: Option<String>,
    #[serde(rename = "sessionId", alias = "session_id")]
    session_id: Option<String>,
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
    thinking: Option<String>,
    deliver: Option<bool>,
    attachments: Option<Vec<Value>>,
    channel: Option<String>,
    #[serde(rename = "replyChannel", alias = "reply_channel")]
    reply_channel: Option<String>,
    #[serde(rename = "accountId", alias = "account_id")]
    account_id: Option<String>,
    #[serde(rename = "replyAccountId", alias = "reply_account_id")]
    reply_account_id: Option<String>,
    #[serde(rename = "threadId", alias = "thread_id")]
    thread_id: Option<String>,
    #[serde(rename = "groupId", alias = "group_id")]
    group_id: Option<String>,
    #[serde(rename = "groupChannel", alias = "group_channel")]
    group_channel: Option<String>,
    #[serde(rename = "groupSpace", alias = "group_space")]
    group_space: Option<String>,
    timeout: Option<u64>,
    lane: Option<String>,
    #[serde(rename = "extraSystemPrompt", alias = "extra_system_prompt")]
    extra_system_prompt: Option<String>,
    #[serde(rename = "inputProvenance", alias = "input_provenance")]
    input_provenance: Option<Value>,
    #[serde(rename = "idempotencyKey", alias = "idempotency_key")]
    idempotency_key: String,
    label: Option<String>,
    #[serde(rename = "spawnedBy", alias = "spawned_by")]
    spawned_by: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct AgentIdentityParams {
    #[serde(rename = "agentId", alias = "agent_id")]
    agent_id: Option<String>,
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentWaitParams {
    #[serde(rename = "runId", alias = "run_id")]
    run_id: String,
    #[serde(rename = "timeoutMs", alias = "timeout_ms")]
    timeout_ms: Option<u64>,
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
#[serde(default, deny_unknown_fields)]
struct UpdateRunParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
    note: Option<String>,
    #[serde(rename = "restartDelayMs", alias = "restart_delay_ms")]
    restart_delay_ms: Option<u64>,
    #[serde(rename = "timeoutMs", alias = "timeout_ms")]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChatHistoryParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChatSendParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: String,
    message: String,
    thinking: Option<String>,
    deliver: Option<bool>,
    attachments: Option<Vec<Value>>,
    #[serde(rename = "timeoutMs", alias = "timeout_ms")]
    timeout_ms: Option<u64>,
    #[serde(rename = "idempotencyKey", alias = "idempotency_key")]
    idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChatAbortParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: String,
    #[serde(rename = "runId", alias = "run_id")]
    run_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChatInjectParams {
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: String,
    message: String,
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodePairRequestParams {
    #[serde(rename = "nodeId", alias = "node_id")]
    node_id: String,
    #[serde(rename = "displayName", alias = "display_name")]
    display_name: Option<String>,
    platform: Option<String>,
    version: Option<String>,
    #[serde(rename = "coreVersion", alias = "core_version")]
    core_version: Option<String>,
    #[serde(rename = "uiVersion", alias = "ui_version")]
    ui_version: Option<String>,
    #[serde(rename = "deviceFamily", alias = "device_family")]
    device_family: Option<String>,
    #[serde(rename = "modelIdentifier", alias = "model_identifier")]
    model_identifier: Option<String>,
    caps: Option<Vec<String>>,
    commands: Option<Vec<String>>,
    #[serde(rename = "remoteIp", alias = "remote_ip")]
    remote_ip: Option<String>,
    silent: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct NodePairListParams {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodePairApproveParams {
    #[serde(rename = "requestId", alias = "request_id")]
    request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodePairRejectParams {
    #[serde(rename = "requestId", alias = "request_id")]
    request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodePairVerifyParams {
    #[serde(rename = "nodeId", alias = "node_id")]
    node_id: String,
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeRenameParams {
    #[serde(rename = "nodeId", alias = "node_id")]
    node_id: String,
    #[serde(rename = "displayName", alias = "display_name")]
    display_name: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct NodeListParams {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeDescribeParams {
    #[serde(rename = "nodeId", alias = "node_id")]
    node_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeInvokeParams {
    #[serde(rename = "nodeId", alias = "node_id")]
    node_id: String,
    command: String,
    params: Option<Value>,
    #[serde(rename = "timeoutMs", alias = "timeout_ms")]
    timeout_ms: Option<u64>,
    #[serde(rename = "idempotencyKey", alias = "idempotency_key")]
    idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeInvokeResultParams {
    id: String,
    #[serde(rename = "nodeId", alias = "node_id")]
    node_id: String,
    ok: bool,
    payload: Option<Value>,
    #[serde(rename = "payloadJSON", alias = "payload_json")]
    payload_json: Option<String>,
    error: Option<NodeInvokeResultError>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct NodeInvokeResultError {
    code: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeEventParams {
    event: String,
    payload: Option<Value>,
    #[serde(rename = "payloadJSON", alias = "payload_json")]
    payload_json: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ExecApprovalsGetParams {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecApprovalsSetParams {
    file: Option<Value>,
    #[serde(rename = "baseHash", alias = "base_hash")]
    base_hash: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecApprovalsNodeGetParams {
    #[serde(rename = "nodeId", alias = "node_id")]
    node_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecApprovalsNodeSetParams {
    #[serde(rename = "nodeId", alias = "node_id")]
    node_id: String,
    file: Option<Value>,
    #[serde(rename = "baseHash", alias = "base_hash")]
    base_hash: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecApprovalRequestParams {
    id: Option<String>,
    command: String,
    cwd: Option<String>,
    host: Option<String>,
    security: Option<String>,
    ask: Option<String>,
    #[serde(rename = "agentId", alias = "agent_id")]
    agent_id: Option<String>,
    #[serde(rename = "resolvedPath", alias = "resolved_path")]
    resolved_path: Option<String>,
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
    #[serde(rename = "timeoutMs", alias = "timeout_ms")]
    timeout_ms: Option<u64>,
    #[serde(rename = "twoPhase", alias = "two_phase")]
    two_phase: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ExecApprovalWaitDecisionParams {
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecApprovalResolveParams {
    id: String,
    decision: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct DevicePairListParams {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DevicePairApproveParams {
    #[serde(rename = "requestId", alias = "request_id")]
    request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DevicePairRejectParams {
    #[serde(rename = "requestId", alias = "request_id")]
    request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DevicePairRemoveParams {
    #[serde(rename = "deviceId", alias = "device_id")]
    device_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceTokenRotateParams {
    #[serde(rename = "deviceId", alias = "device_id")]
    device_id: String,
    role: String,
    scopes: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceTokenRevokeParams {
    #[serde(rename = "deviceId", alias = "device_id")]
    device_id: String,
    role: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct WebLoginStartParams {
    force: Option<bool>,
    #[serde(rename = "timeoutMs", alias = "timeout_ms")]
    timeout_ms: Option<u64>,
    verbose: Option<bool>,
    #[serde(rename = "accountId", alias = "account_id")]
    account_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct WebLoginWaitParams {
    #[serde(rename = "timeoutMs", alias = "timeout_ms")]
    timeout_ms: Option<u64>,
    #[serde(rename = "accountId", alias = "account_id")]
    account_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct WizardStartParams {
    mode: Option<String>,
    workspace: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct WizardNextParams {
    #[serde(rename = "sessionId", alias = "session_id")]
    session_id: Option<String>,
    answer: Option<WizardAnswerInput>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WizardAnswerInput {
    #[serde(rename = "stepId", alias = "step_id")]
    step_id: String,
    value: Option<Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct WizardSessionParams {
    #[serde(rename = "sessionId", alias = "session_id")]
    session_id: Option<String>,
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
#[serde(deny_unknown_fields)]
struct GatewaySendParams {
    to: String,
    message: Option<String>,
    #[serde(rename = "mediaUrl", alias = "media_url")]
    media_url: Option<String>,
    #[serde(rename = "mediaUrls", alias = "media_urls")]
    media_urls: Option<Vec<String>>,
    #[serde(rename = "gifPlayback", alias = "gif_playback")]
    gif_playback: Option<bool>,
    channel: Option<String>,
    #[serde(rename = "accountId", alias = "account_id")]
    account_id: Option<String>,
    #[serde(rename = "threadId", alias = "thread_id")]
    thread_id: Option<String>,
    #[serde(rename = "sessionKey", alias = "session_key")]
    session_key: Option<String>,
    #[serde(rename = "idempotencyKey", alias = "idempotency_key")]
    idempotency_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GatewayPollParams {
    to: String,
    question: String,
    options: Vec<String>,
    #[serde(rename = "maxSelections", alias = "max_selections")]
    max_selections: Option<usize>,
    #[serde(rename = "durationSeconds", alias = "duration_seconds")]
    duration_seconds: Option<u64>,
    #[serde(rename = "durationHours", alias = "duration_hours")]
    duration_hours: Option<u64>,
    silent: Option<bool>,
    #[serde(rename = "isAnonymous", alias = "is_anonymous")]
    is_anonymous: Option<bool>,
    #[serde(rename = "threadId", alias = "thread_id")]
    thread_id: Option<String>,
    channel: Option<String>,
    #[serde(rename = "accountId", alias = "account_id")]
    account_id: Option<String>,
    #[serde(rename = "idempotencyKey", alias = "idempotency_key")]
    idempotency_key: String,
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

fn strip_disallowed_chat_control_chars(message: &str) -> String {
    let mut output = String::with_capacity(message.len());
    for ch in message.chars() {
        let code = ch as u32;
        if code == 9 || code == 10 || code == 13 || (code >= 32 && code != 127) {
            output.push(ch);
        }
    }
    output
}

fn sanitize_chat_send_message_input(message: &str) -> Result<String, String> {
    let normalized = message.nfc().collect::<String>();
    if normalized.contains('\0') {
        return Err("message must not contain null bytes".to_owned());
    }
    Ok(strip_disallowed_chat_control_chars(&normalized))
}

fn parse_agent_reset_command(message: &str) -> Option<(&'static str, Option<String>)> {
    let trimmed = message.trim();
    let lower = trimmed.to_ascii_lowercase();
    let (reason, prefix_len) = if lower.starts_with("/new") {
        ("new", 4usize)
    } else if lower.starts_with("/reset") {
        ("reset", 6usize)
    } else {
        return None;
    };
    if trimmed.len() > prefix_len {
        let separator = *trimmed.as_bytes().get(prefix_len)?;
        if !separator.is_ascii_whitespace() {
            return None;
        }
    }
    let tail = trimmed[prefix_len..].trim();
    let followup_message = if tail.is_empty() {
        None
    } else {
        Some(tail.to_owned())
    };
    Some((reason, followup_message))
}

fn is_chat_stop_command_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    matches!(
        normalize(trimmed).as_str(),
        "/stop" | "stop" | "abort" | "interrupt" | "interrupts"
    )
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

fn next_web_login_session_id() -> String {
    let sequence = WEB_LOGIN_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("web-login-{}-{sequence}", now_ms())
}

fn next_wizard_session_id() -> String {
    let sequence = WIZARD_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("wizard-{}-{sequence}", now_ms())
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

        let connect = registry.resolve("connect");
        assert!(connect.known);
        let connect_spec = connect.spec.expect("connect spec");
        assert_eq!(connect_spec.family, MethodFamily::Connect);
        assert!(connect_spec.requires_auth);

        let voicewake = registry.resolve("voicewake.set");
        assert!(voicewake.known);
        let voicewake_spec = voicewake.spec.expect("voicewake spec");
        assert_eq!(voicewake_spec.family, MethodFamily::Gateway);
        assert!(voicewake_spec.requires_auth);
    }

    #[test]
    fn flags_unknown_method() {
        let registry = MethodRegistry::default_registry();
        for method in ["foo.bar", "gateway.restart", "message.send"] {
            let resolved = registry.resolve(method);
            assert!(!resolved.known);
            assert!(resolved.spec.is_none());
        }
    }

    #[tokio::test]
    async fn dispatcher_rejects_connect_method_after_handshake() {
        let dispatcher = RpcDispatcher::new();
        let req = RpcRequestFrame {
            id: "req-connect-after-handshake".to_owned(),
            method: "connect".to_owned(),
            params: serde_json::json!({
                "client": {
                    "id": "openclaw-cli",
                    "mode": "cli"
                }
            }),
        };
        match dispatcher.handle_request(&req).await {
            RpcDispatchOutcome::Error { code, message, .. } => {
                assert_eq!(code, 400);
                assert_eq!(message, "connect is only valid as the first request");
            }
            _ => panic!("expected connect rejection after handshake"),
        }
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
    async fn dispatcher_send_method_follows_parity_contract() {
        let dispatcher = RpcDispatcher::new();

        let missing_text_or_media = RpcRequestFrame {
            id: "req-send-empty".to_owned(),
            method: "send".to_owned(),
            params: serde_json::json!({
                "to": "+15550001111",
                "message": "   ",
                "idempotencyKey": "send-empty"
            }),
        };
        let out = dispatcher.handle_request(&missing_text_or_media).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let webchat_channel = RpcRequestFrame {
            id: "req-send-webchat".to_owned(),
            method: "send".to_owned(),
            params: serde_json::json!({
                "to": "+15550001111",
                "message": "hello",
                "channel": "webchat",
                "idempotencyKey": "send-webchat"
            }),
        };
        match dispatcher.handle_request(&webchat_channel).await {
            RpcDispatchOutcome::Error { code, message, .. } => {
                assert_eq!(code, 400);
                assert!(message.contains("Use `chat.send`"));
            }
            _ => panic!("expected webchat channel rejection"),
        }

        let unsupported_channel = RpcRequestFrame {
            id: "req-send-unsupported".to_owned(),
            method: "send".to_owned(),
            params: serde_json::json!({
                "to": "+15550001111",
                "message": "hello",
                "channel": "unknown-channel",
                "idempotencyKey": "send-unsupported"
            }),
        };
        let out = dispatcher.handle_request(&unsupported_channel).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let send = RpcRequestFrame {
            id: "req-send-default".to_owned(),
            method: "send".to_owned(),
            params: serde_json::json!({
                "to": "+15550001111",
                "message": "hello outbound",
                "idempotencyKey": "send-1"
            }),
        };
        let first_message_id = match dispatcher.handle_request(&send).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/runId")
                        .and_then(serde_json::Value::as_str),
                    Some("send-1")
                );
                assert_eq!(
                    payload
                        .pointer("/channel")
                        .and_then(serde_json::Value::as_str),
                    Some("whatsapp")
                );
                payload
                    .pointer("/messageId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .expect("message id")
            }
            _ => panic!("expected send handled response"),
        };

        match dispatcher.handle_request(&send).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/messageId")
                        .and_then(serde_json::Value::as_str),
                    Some(first_message_id.as_str())
                );
            }
            _ => panic!("expected send idempotent replay"),
        }

        let derived_session_key = super::derive_outbound_session_key("whatsapp", "+15550001111");
        let history = RpcRequestFrame {
            id: "req-send-history-derived".to_owned(),
            method: "sessions.history".to_owned(),
            params: serde_json::json!({
                "sessionKey": derived_session_key,
                "limit": 1
            }),
        };
        match dispatcher.handle_request(&history).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/count")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                assert_eq!(
                    payload
                        .pointer("/history/0/text")
                        .and_then(serde_json::Value::as_str),
                    Some("hello outbound")
                );
                assert_eq!(
                    payload
                        .pointer("/history/0/source")
                        .and_then(serde_json::Value::as_str),
                    Some("send")
                );
            }
            _ => panic!("expected derived send history"),
        }

        let send_with_context = RpcRequestFrame {
            id: "req-send-with-context".to_owned(),
            method: "send".to_owned(),
            params: serde_json::json!({
                "to": "channel:C1",
                "message": "hello thread",
                "channel": "slack",
                "accountId": "work",
                "threadId": "1710000.1",
                "sessionKey": "main",
                "idempotencyKey": "send-2"
            }),
        };
        match dispatcher.handle_request(&send_with_context).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/accountId")
                        .and_then(serde_json::Value::as_str),
                    Some("work")
                );
                assert_eq!(
                    payload
                        .pointer("/threadId")
                        .and_then(serde_json::Value::as_str),
                    Some("1710000.1")
                );
            }
            _ => panic!("expected send with context handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_poll_method_follows_parity_contract() {
        let dispatcher = RpcDispatcher::new();

        let invalid_options = RpcRequestFrame {
            id: "req-poll-invalid-options".to_owned(),
            method: "poll".to_owned(),
            params: serde_json::json!({
                "to": "+15550001111",
                "question": "Lunch?",
                "options": ["Pizza"],
                "idempotencyKey": "poll-invalid-options"
            }),
        };
        let out = dispatcher.handle_request(&invalid_options).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let unsupported_channel = RpcRequestFrame {
            id: "req-poll-unsupported".to_owned(),
            method: "poll".to_owned(),
            params: serde_json::json!({
                "to": "+15550001111",
                "question": "Lunch?",
                "options": ["Pizza", "Sushi"],
                "channel": "unknown-channel",
                "idempotencyKey": "poll-unsupported"
            }),
        };
        match dispatcher.handle_request(&unsupported_channel).await {
            RpcDispatchOutcome::Error { code, message, .. } => {
                assert_eq!(code, 400);
                assert!(message.contains("unsupported poll channel"));
            }
            _ => panic!("expected unsupported channel rejection"),
        }

        let no_poll_support = RpcRequestFrame {
            id: "req-poll-no-support".to_owned(),
            method: "poll".to_owned(),
            params: serde_json::json!({
                "to": "channel:C1",
                "question": "Lunch?",
                "options": ["Pizza", "Sushi"],
                "channel": "slack",
                "idempotencyKey": "poll-no-support"
            }),
        };
        match dispatcher.handle_request(&no_poll_support).await {
            RpcDispatchOutcome::Error { code, message, .. } => {
                assert_eq!(code, 400);
                assert_eq!(message, "unsupported poll channel: slack");
            }
            _ => panic!("expected poll capability rejection"),
        }

        let non_telegram_duration = RpcRequestFrame {
            id: "req-poll-non-telegram-duration".to_owned(),
            method: "poll".to_owned(),
            params: serde_json::json!({
                "to": "+15550001111",
                "question": "Lunch?",
                "options": ["Pizza", "Sushi"],
                "channel": "whatsapp",
                "durationSeconds": 3600,
                "idempotencyKey": "poll-non-telegram-duration"
            }),
        };
        match dispatcher.handle_request(&non_telegram_duration).await {
            RpcDispatchOutcome::Error { code, message, .. } => {
                assert_eq!(code, 400);
                assert!(message.contains("durationSeconds is only supported for Telegram polls"));
            }
            _ => panic!("expected telegram duration guard"),
        }

        let non_telegram_anonymous = RpcRequestFrame {
            id: "req-poll-non-telegram-anonymous".to_owned(),
            method: "poll".to_owned(),
            params: serde_json::json!({
                "to": "+15550001111",
                "question": "Lunch?",
                "options": ["Pizza", "Sushi"],
                "channel": "whatsapp",
                "isAnonymous": false,
                "idempotencyKey": "poll-non-telegram-anonymous"
            }),
        };
        match dispatcher.handle_request(&non_telegram_anonymous).await {
            RpcDispatchOutcome::Error { code, message, .. } => {
                assert_eq!(code, 400);
                assert!(message.contains("isAnonymous is only supported for Telegram polls"));
            }
            _ => panic!("expected telegram anonymity guard"),
        }

        let telegram_poll = RpcRequestFrame {
            id: "req-poll-telegram".to_owned(),
            method: "poll".to_owned(),
            params: serde_json::json!({
                "to": "@openclaw",
                "question": "Lunch?",
                "options": ["Pizza", "Sushi"],
                "channel": "telegram",
                "durationSeconds": 3600,
                "isAnonymous": false,
                "threadId": "42",
                "accountId": "team",
                "idempotencyKey": "poll-1"
            }),
        };
        let (first_message_id, first_poll_id) =
            match dispatcher.handle_request(&telegram_poll).await {
                RpcDispatchOutcome::Handled(payload) => {
                    assert_eq!(
                        payload
                            .pointer("/runId")
                            .and_then(serde_json::Value::as_str),
                        Some("poll-1")
                    );
                    assert_eq!(
                        payload
                            .pointer("/channel")
                            .and_then(serde_json::Value::as_str),
                        Some("telegram")
                    );
                    assert_eq!(
                        payload
                            .pointer("/threadId")
                            .and_then(serde_json::Value::as_str),
                        Some("42")
                    );
                    assert_eq!(
                        payload
                            .pointer("/accountId")
                            .and_then(serde_json::Value::as_str),
                        Some("team")
                    );
                    let message_id = payload
                        .pointer("/messageId")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                        .expect("message id");
                    let poll_id = payload
                        .pointer("/pollId")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                        .expect("poll id");
                    (message_id, poll_id)
                }
                _ => panic!("expected poll handled response"),
            };

        match dispatcher.handle_request(&telegram_poll).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/messageId")
                        .and_then(serde_json::Value::as_str),
                    Some(first_message_id.as_str())
                );
                assert_eq!(
                    payload
                        .pointer("/pollId")
                        .and_then(serde_json::Value::as_str),
                    Some(first_poll_id.as_str())
                );
            }
            _ => panic!("expected poll idempotent replay"),
        }

        let default_channel_poll = RpcRequestFrame {
            id: "req-poll-default-channel".to_owned(),
            method: "poll".to_owned(),
            params: serde_json::json!({
                "to": "+15550001111",
                "question": "Dinner?",
                "options": ["Burrito", "Pasta"],
                "idempotencyKey": "poll-2"
            }),
        };
        match dispatcher.handle_request(&default_channel_poll).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/channel")
                        .and_then(serde_json::Value::as_str),
                    Some("whatsapp")
                );
            }
            _ => panic!("expected default-channel poll response"),
        }
    }

    #[tokio::test]
    async fn dispatcher_rejects_sessions_send_webchat_channel() {
        let dispatcher = RpcDispatcher::new();
        let send = RpcRequestFrame {
            id: "req-send-webchat".to_owned(),
            method: "sessions.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:main",
                "message": "hello webchat",
                "channel": "webchat"
            }),
        };
        match dispatcher.handle_request(&send).await {
            RpcDispatchOutcome::Error { code, message, .. } => {
                assert_eq!(code, 400);
                assert!(message.contains("Use `chat.send`"));
            }
            _ => panic!("expected sessions.send webchat channel rejection"),
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
    async fn dispatcher_tts_methods_follow_parity_contract() {
        let dispatcher = RpcDispatcher::new();

        let status = RpcRequestFrame {
            id: "req-tts-status".to_owned(),
            method: "tts.status".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&status).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/enabled")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
                assert_eq!(
                    payload
                        .pointer("/provider")
                        .and_then(serde_json::Value::as_str),
                    Some("edge")
                );
                assert_eq!(
                    payload
                        .pointer("/prefsPath")
                        .and_then(serde_json::Value::as_str),
                    Some(super::TTS_PREFS_PATH)
                );
            }
            _ => panic!("expected tts.status handled"),
        }

        let invalid_provider = RpcRequestFrame {
            id: "req-tts-set-provider-invalid".to_owned(),
            method: "tts.setProvider".to_owned(),
            params: serde_json::json!({
                "provider": "invalid-provider"
            }),
        };
        match dispatcher.handle_request(&invalid_provider).await {
            RpcDispatchOutcome::Error { code, message, .. } => {
                assert_eq!(code, 400);
                assert_eq!(
                    message,
                    "Invalid provider. Use openai, elevenlabs, or edge."
                );
            }
            _ => panic!("expected invalid provider rejection"),
        }

        let set_provider = RpcRequestFrame {
            id: "req-tts-set-provider".to_owned(),
            method: "tts.setProvider".to_owned(),
            params: serde_json::json!({
                "provider": "openai"
            }),
        };
        match dispatcher.handle_request(&set_provider).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/provider")
                        .and_then(serde_json::Value::as_str),
                    Some("openai")
                );
            }
            _ => panic!("expected tts.setProvider handled"),
        }

        let enable = RpcRequestFrame {
            id: "req-tts-enable".to_owned(),
            method: "tts.enable".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&enable).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/enabled")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
            }
            _ => panic!("expected tts.enable handled"),
        }

        let convert_missing = RpcRequestFrame {
            id: "req-tts-convert-missing".to_owned(),
            method: "tts.convert".to_owned(),
            params: serde_json::json!({
                "text": "   "
            }),
        };
        match dispatcher.handle_request(&convert_missing).await {
            RpcDispatchOutcome::Error { code, message, .. } => {
                assert_eq!(code, 400);
                assert_eq!(message, "tts.convert requires text");
            }
            _ => panic!("expected missing text rejection"),
        }

        let convert = RpcRequestFrame {
            id: "req-tts-convert".to_owned(),
            method: "tts.convert".to_owned(),
            params: serde_json::json!({
                "text": "hello voice",
                "channel": "telegram"
            }),
        };
        match dispatcher.handle_request(&convert).await {
            RpcDispatchOutcome::Handled(payload) => {
                let audio_path = payload
                    .pointer("/audioPath")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                assert!(audio_path.starts_with("memory://tts/audio-"));
                assert!(audio_path.ends_with(".opus"));
                assert_eq!(
                    payload
                        .pointer("/provider")
                        .and_then(serde_json::Value::as_str),
                    Some("openai")
                );
                assert_eq!(
                    payload
                        .pointer("/outputFormat")
                        .and_then(serde_json::Value::as_str),
                    Some("opus")
                );
                assert_eq!(
                    payload
                        .pointer("/voiceCompatible")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
            }
            _ => panic!("expected tts.convert handled"),
        }

        let providers = RpcRequestFrame {
            id: "req-tts-providers".to_owned(),
            method: "tts.providers".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&providers).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/active")
                        .and_then(serde_json::Value::as_str),
                    Some("openai")
                );
                let providers = payload
                    .pointer("/providers")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                assert!(providers.iter().any(|entry| {
                    entry.pointer("/id").and_then(serde_json::Value::as_str) == Some("openai")
                }));
                assert!(providers.iter().any(|entry| {
                    entry.pointer("/id").and_then(serde_json::Value::as_str) == Some("edge")
                        && entry
                            .pointer("/configured")
                            .and_then(serde_json::Value::as_bool)
                            == Some(true)
                }));
            }
            _ => panic!("expected tts.providers handled"),
        }

        let disable = RpcRequestFrame {
            id: "req-tts-disable".to_owned(),
            method: "tts.disable".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&disable).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/enabled")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
            }
            _ => panic!("expected tts.disable handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_voicewake_methods_follow_parity_contract() {
        let dispatcher = RpcDispatcher::new();

        let get = RpcRequestFrame {
            id: "req-voicewake-get-default".to_owned(),
            method: "voicewake.get".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&get).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/triggers").cloned(),
                    Some(serde_json::json!(["openclaw", "claude", "computer"]))
                );
            }
            _ => panic!("expected voicewake.get handled"),
        }

        let set_missing = RpcRequestFrame {
            id: "req-voicewake-set-missing".to_owned(),
            method: "voicewake.set".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&set_missing).await {
            RpcDispatchOutcome::Error { code, message, .. } => {
                assert_eq!(code, 400);
                assert_eq!(message, "voicewake.set requires triggers: string[]");
            }
            _ => panic!("expected missing triggers rejection"),
        }

        let set_non_array = RpcRequestFrame {
            id: "req-voicewake-set-non-array".to_owned(),
            method: "voicewake.set".to_owned(),
            params: serde_json::json!({
                "triggers": "openclaw"
            }),
        };
        match dispatcher.handle_request(&set_non_array).await {
            RpcDispatchOutcome::Error { code, message, .. } => {
                assert_eq!(code, 400);
                assert_eq!(message, "voicewake.set requires triggers: string[]");
            }
            _ => panic!("expected non-array triggers rejection"),
        }

        let set = RpcRequestFrame {
            id: "req-voicewake-set".to_owned(),
            method: "voicewake.set".to_owned(),
            params: serde_json::json!({
                "triggers": ["  hello  ", "", "world", 42]
            }),
        };
        match dispatcher.handle_request(&set).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/triggers").cloned(),
                    Some(serde_json::json!(["hello", "world"]))
                );
            }
            _ => panic!("expected voicewake.set handled"),
        }

        let get_after = RpcRequestFrame {
            id: "req-voicewake-get-after".to_owned(),
            method: "voicewake.get".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&get_after).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/triggers").cloned(),
                    Some(serde_json::json!(["hello", "world"]))
                );
            }
            _ => panic!("expected voicewake.get after set"),
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
    async fn dispatcher_agent_identity_and_wait_methods_follow_parity_contract() {
        let dispatcher = RpcDispatcher::new();

        let identity_default = RpcRequestFrame {
            id: "req-agent-identity-default".to_owned(),
            method: "agent.identity.get".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&identity_default).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/agentId")
                        .and_then(serde_json::Value::as_str),
                    Some("main")
                );
                assert_eq!(
                    payload
                        .pointer("/emoji")
                        .and_then(serde_json::Value::as_str),
                    Some(super::DEFAULT_AGENT_IDENTITY_EMOJI)
                );
            }
            _ => panic!("expected agent.identity.get handled"),
        }

        let malformed = RpcRequestFrame {
            id: "req-agent-identity-malformed".to_owned(),
            method: "agent.identity.get".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:"
            }),
        };
        let out = dispatcher.handle_request(&malformed).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let mismatch = RpcRequestFrame {
            id: "req-agent-identity-mismatch".to_owned(),
            method: "agent.identity.get".to_owned(),
            params: serde_json::json!({
                "agentId": "ops",
                "sessionKey": "agent:main:discord:group:g1"
            }),
        };
        let out = dispatcher.handle_request(&mismatch).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let invalid_agent = RpcRequestFrame {
            id: "req-agent-invalid".to_owned(),
            method: "agent".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-agent-wait",
                "message": "hello"
            }),
        };
        let out = dispatcher.handle_request(&invalid_agent).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let agent = RpcRequestFrame {
            id: "req-agent".to_owned(),
            method: "agent".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-agent-wait",
                "message": "hello",
                "idempotencyKey": "run-agent-123"
            }),
        };
        match dispatcher.handle_request(&agent).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/runId")
                        .and_then(serde_json::Value::as_str),
                    Some("run-agent-123")
                );
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("started")
                );
            }
            _ => panic!("expected agent handled"),
        }

        match dispatcher.handle_request(&agent).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert!(matches!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("in_flight" | "ok")
                ));
            }
            _ => panic!("expected idempotent agent replay"),
        }

        let mut completed = false;
        for _ in 0..10 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            match dispatcher.handle_request(&agent).await {
                RpcDispatchOutcome::Handled(payload) => {
                    let status = payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    if status == "ok" {
                        completed = true;
                        break;
                    }
                    assert_eq!(status, "in_flight");
                }
                _ => panic!("expected completed agent replay"),
            }
        }
        assert!(completed, "expected agent replay status to become ok");

        let wait_ok = RpcRequestFrame {
            id: "req-agent-wait-ok".to_owned(),
            method: "agent.wait".to_owned(),
            params: serde_json::json!({
                "runId": "run-agent-123",
                "timeoutMs": 0
            }),
        };
        match dispatcher.handle_request(&wait_ok).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("ok")
                );
            }
            _ => panic!("expected agent.wait handled"),
        }

        let wait_timeout = RpcRequestFrame {
            id: "req-agent-wait-timeout".to_owned(),
            method: "agent.wait".to_owned(),
            params: serde_json::json!({
                "runId": "run-missing",
                "timeoutMs": 0
            }),
        };
        match dispatcher.handle_request(&wait_timeout).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("timeout")
                );
            }
            _ => panic!("expected agent.wait handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_agent_reset_command_rotates_session_and_keeps_followup() {
        let dispatcher = RpcDispatcher::new();
        let session_key = "agent:main:discord:group:g-agent-reset";

        let seed = RpcRequestFrame {
            id: "req-agent-reset-seed".to_owned(),
            method: "sessions.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": session_key,
                "message": "before reset"
            }),
        };
        let _ = dispatcher.handle_request(&seed).await;

        let status_before = RpcRequestFrame {
            id: "req-agent-reset-status-before".to_owned(),
            method: "session.status".to_owned(),
            params: serde_json::json!({
                "sessionKey": session_key
            }),
        };
        let previous_session_id = match dispatcher.handle_request(&status_before).await {
            RpcDispatchOutcome::Handled(payload) => payload
                .pointer("/session/sessionId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .expect("missing previous session id"),
            _ => panic!("expected session.status before reset"),
        };

        let reset = RpcRequestFrame {
            id: "req-agent-reset".to_owned(),
            method: "agent".to_owned(),
            params: serde_json::json!({
                "sessionKey": session_key,
                "message": "/new hello after reset",
                "idempotencyKey": "run-agent-reset-1"
            }),
        };
        let reset_session_id = match dispatcher.handle_request(&reset).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("started")
                );
                assert_eq!(
                    payload
                        .pointer("/reset/reason")
                        .and_then(serde_json::Value::as_str),
                    Some("new")
                );
                assert_eq!(
                    payload
                        .pointer("/reset/key")
                        .and_then(serde_json::Value::as_str),
                    Some(session_key)
                );
                payload
                    .pointer("/reset/sessionId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .expect("missing reset session id")
            }
            _ => panic!("expected agent reset command handled"),
        };

        assert_ne!(previous_session_id, reset_session_id);

        let history = RpcRequestFrame {
            id: "req-agent-reset-history".to_owned(),
            method: "sessions.history".to_owned(),
            params: serde_json::json!({
                "sessionKey": session_key,
                "limit": 10
            }),
        };
        match dispatcher.handle_request(&history).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/count")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                assert_eq!(
                    payload
                        .pointer("/history/0/text")
                        .and_then(serde_json::Value::as_str),
                    Some("hello after reset")
                );
                assert_eq!(
                    payload
                        .pointer("/history/0/source")
                        .and_then(serde_json::Value::as_str),
                    Some("agent")
                );
            }
            _ => panic!("expected reset history snapshot"),
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
    async fn dispatcher_update_and_web_login_methods_report_expected_payloads() {
        let dispatcher = RpcDispatcher::new();

        let invalid_update = RpcRequestFrame {
            id: "req-update-invalid".to_owned(),
            method: "update.run".to_owned(),
            params: serde_json::json!({
                "extra": true
            }),
        };
        let out = dispatcher.handle_request(&invalid_update).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let update = RpcRequestFrame {
            id: "req-update-run".to_owned(),
            method: "update.run".to_owned(),
            params: serde_json::json!({
                "sessionKey": "agent:main:discord:group:g-upd:topic:42",
                "note": "rollout",
                "restartDelayMs": 2500,
                "timeoutMs": 10
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
                        .pointer("/result/status")
                        .and_then(serde_json::Value::as_str),
                    Some("ok")
                );
                assert_eq!(
                    payload
                        .pointer("/restart/delayMs")
                        .and_then(serde_json::Value::as_u64),
                    Some(2500)
                );
                assert_eq!(
                    payload
                        .pointer("/sentinel/payload/threadId")
                        .and_then(serde_json::Value::as_str),
                    Some("42")
                );
                assert_eq!(
                    payload
                        .pointer("/sentinel/payload/deliveryContext/channel")
                        .and_then(serde_json::Value::as_str),
                    Some("discord")
                );
            }
            _ => panic!("expected update.run handled"),
        }

        let invalid_web_start = RpcRequestFrame {
            id: "req-web-start-invalid".to_owned(),
            method: "web.login.start".to_owned(),
            params: serde_json::json!({
                "unknown": true
            }),
        };
        let out = dispatcher.handle_request(&invalid_web_start).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let web_start = RpcRequestFrame {
            id: "req-web-start".to_owned(),
            method: "web.login.start".to_owned(),
            params: serde_json::json!({
                "timeoutMs": 6000,
                "verbose": true
            }),
        };
        match dispatcher.handle_request(&web_start).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/providerId")
                        .and_then(serde_json::Value::as_str),
                    Some("whatsapp")
                );
                assert_eq!(
                    payload
                        .pointer("/accountId")
                        .and_then(serde_json::Value::as_str),
                    Some("default")
                );
                let qr = payload
                    .pointer("/qrDataUrl")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                assert!(qr.starts_with("data:image/png;base64,"));
            }
            _ => panic!("expected web.login.start handled"),
        }

        let web_wait = RpcRequestFrame {
            id: "req-web-wait".to_owned(),
            method: "web.login.wait".to_owned(),
            params: serde_json::json!({
                "timeoutMs": 5000
            }),
        };
        match dispatcher.handle_request(&web_wait).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/connected")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
            }
            _ => panic!("expected web.login.wait handled"),
        }

        match dispatcher.handle_request(&web_wait).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/connected")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
            }
            _ => panic!("expected web.login.wait handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_browser_request_validates_and_reports_unavailable_contract() {
        let dispatcher = RpcDispatcher::new();

        let missing = RpcRequestFrame {
            id: "req-browser-missing".to_owned(),
            method: "browser.request".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&missing).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let invalid_method = RpcRequestFrame {
            id: "req-browser-invalid-method".to_owned(),
            method: "browser.request".to_owned(),
            params: serde_json::json!({
                "method": "PATCH",
                "path": "/tabs"
            }),
        };
        let out = dispatcher.handle_request(&invalid_method).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let non_object_params = RpcRequestFrame {
            id: "req-browser-non-object".to_owned(),
            method: "browser.request".to_owned(),
            params: serde_json::json!("raw"),
        };
        let out = dispatcher.handle_request(&non_object_params).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let valid_request = RpcRequestFrame {
            id: "req-browser-valid".to_owned(),
            method: "browser.request".to_owned(),
            params: serde_json::json!({
                "method": "get",
                "path": "/tabs",
                "query": {
                    "profile": "default"
                },
                "timeoutMs": 0
            }),
        };
        match dispatcher.handle_request(&valid_request).await {
            RpcDispatchOutcome::Error {
                code,
                message,
                details,
            } => {
                assert_eq!(code, 503);
                assert_eq!(message, "browser control is disabled");
                assert_eq!(
                    details
                        .as_ref()
                        .and_then(|value| value.pointer("/method"))
                        .and_then(serde_json::Value::as_str),
                    Some("GET")
                );
                assert_eq!(
                    details
                        .as_ref()
                        .and_then(|value| value.pointer("/path"))
                        .and_then(serde_json::Value::as_str),
                    Some("/tabs")
                );
            }
            _ => panic!("expected browser.request unavailable response"),
        }

        let non_numeric_timeout = RpcRequestFrame {
            id: "req-browser-timeout-string".to_owned(),
            method: "browser.request".to_owned(),
            params: serde_json::json!({
                "method": "POST",
                "path": "/navigate",
                "timeoutMs": "1500"
            }),
        };
        let out = dispatcher.handle_request(&non_numeric_timeout).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 503, .. }));
    }

    #[tokio::test]
    async fn dispatcher_wizard_methods_manage_session_lifecycle() {
        let dispatcher = RpcDispatcher::new();

        let invalid_start = RpcRequestFrame {
            id: "req-wizard-start-invalid".to_owned(),
            method: "wizard.start".to_owned(),
            params: serde_json::json!({
                "mode": "cluster"
            }),
        };
        let out = dispatcher.handle_request(&invalid_start).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let start = RpcRequestFrame {
            id: "req-wizard-start".to_owned(),
            method: "wizard.start".to_owned(),
            params: serde_json::json!({
                "mode": "remote",
                "workspace": "C:/workspace/openclaw"
            }),
        };
        let session_id = match dispatcher.handle_request(&start).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/done")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("running")
                );
                payload
                    .pointer("/sessionId")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .expect("wizard session id")
            }
            _ => panic!("expected wizard.start handled"),
        };

        let start_again = RpcRequestFrame {
            id: "req-wizard-start-again".to_owned(),
            method: "wizard.start".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&start_again).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 503, .. }));

        let status = RpcRequestFrame {
            id: "req-wizard-status".to_owned(),
            method: "wizard.status".to_owned(),
            params: serde_json::json!({
                "sessionId": session_id.clone()
            }),
        };
        match dispatcher.handle_request(&status).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("running")
                );
            }
            _ => panic!("expected wizard.status handled"),
        }

        let next = RpcRequestFrame {
            id: "req-wizard-next".to_owned(),
            method: "wizard.next".to_owned(),
            params: serde_json::json!({
                "sessionId": session_id.clone(),
                "answer": {
                    "stepId": "confirm-setup",
                    "value": true
                }
            }),
        };
        match dispatcher.handle_request(&next).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/done")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("done")
                );
            }
            _ => panic!("expected wizard.next handled"),
        }

        let missing_status = RpcRequestFrame {
            id: "req-wizard-status-missing".to_owned(),
            method: "wizard.status".to_owned(),
            params: serde_json::json!({
                "sessionId": session_id
            }),
        };
        let out = dispatcher.handle_request(&missing_status).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));
    }

    #[tokio::test]
    async fn dispatcher_device_pair_and_token_methods_follow_parity_contract() {
        let dispatcher = RpcDispatcher::new();

        dispatcher
            .ingest_event_frame(&serde_json::json!({
                "event": "device.pair.requested",
                "payload": {
                    "requestId": "pair-1",
                    "deviceId": "device-1",
                    "publicKey": "pubkey-1",
                    "displayName": "Primary Tablet",
                    "role": "operator",
                    "roles": ["operator"],
                    "scopes": ["exec:read", "exec:write"],
                    "ts": 123456
                }
            }))
            .await;

        let invalid_list = RpcRequestFrame {
            id: "req-device-list-invalid".to_owned(),
            method: "device.pair.list".to_owned(),
            params: serde_json::json!({
                "extra": true
            }),
        };
        let out = dispatcher.handle_request(&invalid_list).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let list = RpcRequestFrame {
            id: "req-device-list".to_owned(),
            method: "device.pair.list".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&list).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/pending/0/requestId")
                        .and_then(serde_json::Value::as_str),
                    Some("pair-1")
                );
                assert_eq!(
                    payload
                        .pointer("/pending/0/deviceId")
                        .and_then(serde_json::Value::as_str),
                    Some("device-1")
                );
            }
            _ => panic!("expected device.pair.list handled"),
        }

        let approve = RpcRequestFrame {
            id: "req-device-approve".to_owned(),
            method: "device.pair.approve".to_owned(),
            params: serde_json::json!({
                "requestId": "pair-1"
            }),
        };
        match dispatcher.handle_request(&approve).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/requestId")
                        .and_then(serde_json::Value::as_str),
                    Some("pair-1")
                );
                assert_eq!(
                    payload
                        .pointer("/device/deviceId")
                        .and_then(serde_json::Value::as_str),
                    Some("device-1")
                );
                assert_eq!(
                    payload
                        .pointer("/device/tokens/0/role")
                        .and_then(serde_json::Value::as_str),
                    Some("operator")
                );
                assert!(payload.pointer("/device/tokens/0/token").is_none());
            }
            _ => panic!("expected device.pair.approve handled"),
        }

        let rotate = RpcRequestFrame {
            id: "req-device-rotate".to_owned(),
            method: "device.token.rotate".to_owned(),
            params: serde_json::json!({
                "deviceId": "device-1",
                "role": "operator",
                "scopes": ["exec:read"]
            }),
        };
        match dispatcher.handle_request(&rotate).await {
            RpcDispatchOutcome::Handled(payload) => {
                let token = payload
                    .pointer("/token")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                assert!(token.starts_with("dtk_"));
                assert_eq!(
                    payload
                        .pointer("/scopes/0")
                        .and_then(serde_json::Value::as_str),
                    Some("exec:read")
                );
                assert!(payload
                    .pointer("/rotatedAtMs")
                    .and_then(serde_json::Value::as_u64)
                    .is_some());
            }
            _ => panic!("expected device.token.rotate handled"),
        }

        let revoke = RpcRequestFrame {
            id: "req-device-revoke".to_owned(),
            method: "device.token.revoke".to_owned(),
            params: serde_json::json!({
                "deviceId": "device-1",
                "role": "operator"
            }),
        };
        match dispatcher.handle_request(&revoke).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/deviceId")
                        .and_then(serde_json::Value::as_str),
                    Some("device-1")
                );
                assert!(payload
                    .pointer("/revokedAtMs")
                    .and_then(serde_json::Value::as_u64)
                    .is_some());
            }
            _ => panic!("expected device.token.revoke handled"),
        }

        let remove = RpcRequestFrame {
            id: "req-device-remove".to_owned(),
            method: "device.pair.remove".to_owned(),
            params: serde_json::json!({
                "deviceId": "device-1"
            }),
        };
        match dispatcher.handle_request(&remove).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/deviceId")
                        .and_then(serde_json::Value::as_str),
                    Some("device-1")
                );
            }
            _ => panic!("expected device.pair.remove handled"),
        }

        let rotate_missing = RpcRequestFrame {
            id: "req-device-rotate-missing".to_owned(),
            method: "device.token.rotate".to_owned(),
            params: serde_json::json!({
                "deviceId": "device-1",
                "role": "operator"
            }),
        };
        let out = dispatcher.handle_request(&rotate_missing).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        dispatcher
            .ingest_event_frame(&serde_json::json!({
                "event": "device.pair.requested",
                "payload": {
                    "requestId": "pair-2",
                    "deviceId": "device-2",
                    "publicKey": "pubkey-2",
                    "ts": 654321
                }
            }))
            .await;

        let reject = RpcRequestFrame {
            id: "req-device-reject".to_owned(),
            method: "device.pair.reject".to_owned(),
            params: serde_json::json!({
                "requestId": "pair-2"
            }),
        };
        match dispatcher.handle_request(&reject).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/requestId")
                        .and_then(serde_json::Value::as_str),
                    Some("pair-2")
                );
                assert_eq!(
                    payload
                        .pointer("/deviceId")
                        .and_then(serde_json::Value::as_str),
                    Some("device-2")
                );
            }
            _ => panic!("expected device.pair.reject handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_node_pairing_methods_follow_parity_contract() {
        let dispatcher = RpcDispatcher::new();

        let invalid_list = RpcRequestFrame {
            id: "req-node-list-invalid".to_owned(),
            method: "node.pair.list".to_owned(),
            params: serde_json::json!({
                "extra": true
            }),
        };
        let out = dispatcher.handle_request(&invalid_list).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let request = RpcRequestFrame {
            id: "req-node-request".to_owned(),
            method: "node.pair.request".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-1",
                "displayName": "Mac Mini",
                "platform": "darwin",
                "caps": ["browser", "camera"],
                "commands": ["browser.proxy"]
            }),
        };
        let request_id = match dispatcher.handle_request(&request).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("pending")
                );
                assert_eq!(
                    payload
                        .pointer("/created")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                payload
                    .pointer("/request/requestId")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .expect("node pair request id")
            }
            _ => panic!("expected node.pair.request handled"),
        };

        match dispatcher.handle_request(&request).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/created")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
                assert_eq!(
                    payload
                        .pointer("/request/requestId")
                        .and_then(serde_json::Value::as_str),
                    Some(request_id.as_str())
                );
            }
            _ => panic!("expected duplicate node.pair.request handled"),
        }

        let list = RpcRequestFrame {
            id: "req-node-list".to_owned(),
            method: "node.pair.list".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&list).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/pending/0/requestId")
                        .and_then(serde_json::Value::as_str),
                    Some(request_id.as_str())
                );
            }
            _ => panic!("expected node.pair.list handled"),
        }

        let approve = RpcRequestFrame {
            id: "req-node-approve".to_owned(),
            method: "node.pair.approve".to_owned(),
            params: serde_json::json!({
                "requestId": request_id.clone()
            }),
        };
        let token = match dispatcher.handle_request(&approve).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/requestId")
                        .and_then(serde_json::Value::as_str),
                    Some(request_id.as_str())
                );
                let token = payload
                    .pointer("/node/token")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                assert!(token.starts_with("ntk_"));
                token.to_owned()
            }
            _ => panic!("expected node.pair.approve handled"),
        };

        let verify_bad = RpcRequestFrame {
            id: "req-node-verify-bad".to_owned(),
            method: "node.pair.verify".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-1",
                "token": "bad-token"
            }),
        };
        match dispatcher.handle_request(&verify_bad).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(false)
                );
            }
            _ => panic!("expected node.pair.verify handled"),
        }

        let verify_ok = RpcRequestFrame {
            id: "req-node-verify-ok".to_owned(),
            method: "node.pair.verify".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-1",
                "token": token
            }),
        };
        match dispatcher.handle_request(&verify_ok).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/node/nodeId")
                        .and_then(serde_json::Value::as_str),
                    Some("node-1")
                );
            }
            _ => panic!("expected node.pair.verify handled"),
        }

        let rename = RpcRequestFrame {
            id: "req-node-rename".to_owned(),
            method: "node.rename".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-1",
                "displayName": "Ops Node"
            }),
        };
        match dispatcher.handle_request(&rename).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/displayName")
                        .and_then(serde_json::Value::as_str),
                    Some("Ops Node")
                );
            }
            _ => panic!("expected node.rename handled"),
        }

        let node_list_invalid = RpcRequestFrame {
            id: "req-node-list-params-invalid".to_owned(),
            method: "node.list".to_owned(),
            params: serde_json::json!({
                "extra": true
            }),
        };
        let out = dispatcher.handle_request(&node_list_invalid).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let node_list = RpcRequestFrame {
            id: "req-node-list-live".to_owned(),
            method: "node.list".to_owned(),
            params: serde_json::json!({}),
        };
        match dispatcher.handle_request(&node_list).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/nodes/0/nodeId")
                        .and_then(serde_json::Value::as_str),
                    Some("node-1")
                );
                assert_eq!(
                    payload
                        .pointer("/nodes/0/paired")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/nodes/0/connected")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
            }
            _ => panic!("expected node.list handled"),
        }

        let describe = RpcRequestFrame {
            id: "req-node-describe".to_owned(),
            method: "node.describe".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-1"
            }),
        };
        match dispatcher.handle_request(&describe).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/displayName")
                        .and_then(serde_json::Value::as_str),
                    Some("Ops Node")
                );
                assert_eq!(
                    payload
                        .pointer("/paired")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
            }
            _ => panic!("expected node.describe handled"),
        }

        let describe_unknown = RpcRequestFrame {
            id: "req-node-describe-unknown".to_owned(),
            method: "node.describe".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-missing"
            }),
        };
        let out = dispatcher.handle_request(&describe_unknown).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        dispatcher
            .ingest_event_frame(&serde_json::json!({
                "event": "node.pair.requested",
                "payload": {
                    "requestId": "req-node-2",
                    "nodeId": "node-2",
                    "displayName": "Aux Node",
                    "ts": 11
                }
            }))
            .await;

        let reject = RpcRequestFrame {
            id: "req-node-reject".to_owned(),
            method: "node.pair.reject".to_owned(),
            params: serde_json::json!({
                "requestId": "req-node-2"
            }),
        };
        match dispatcher.handle_request(&reject).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/requestId")
                        .and_then(serde_json::Value::as_str),
                    Some("req-node-2")
                );
                assert_eq!(
                    payload
                        .pointer("/nodeId")
                        .and_then(serde_json::Value::as_str),
                    Some("node-2")
                );
            }
            _ => panic!("expected node.pair.reject handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_node_invoke_and_event_methods_follow_parity_contract() {
        let dispatcher = RpcDispatcher::new();

        let pair_request = RpcRequestFrame {
            id: "req-node-invoke-pair-request".to_owned(),
            method: "node.pair.request".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-invoke-1",
                "commands": ["browser.proxy"]
            }),
        };
        let request_id = match dispatcher.handle_request(&pair_request).await {
            RpcDispatchOutcome::Handled(payload) => payload
                .pointer("/request/requestId")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
                .expect("request id"),
            _ => panic!("expected node.pair.request handled"),
        };
        let pair_approve = RpcRequestFrame {
            id: "req-node-invoke-pair-approve".to_owned(),
            method: "node.pair.approve".to_owned(),
            params: serde_json::json!({
                "requestId": request_id
            }),
        };
        let out = dispatcher.handle_request(&pair_approve).await;
        assert!(matches!(out, RpcDispatchOutcome::Handled(_)));

        let invoke_invalid = RpcRequestFrame {
            id: "req-node-invoke-invalid".to_owned(),
            method: "node.invoke".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-invoke-1",
                "command": "browser.proxy"
            }),
        };
        let out = dispatcher.handle_request(&invoke_invalid).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let invoke_restricted = RpcRequestFrame {
            id: "req-node-invoke-restricted".to_owned(),
            method: "node.invoke".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-invoke-1",
                "command": "system.execApprovals.get",
                "idempotencyKey": "idem-1"
            }),
        };
        let out = dispatcher.handle_request(&invoke_restricted).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let invoke_unknown = RpcRequestFrame {
            id: "req-node-invoke-unknown".to_owned(),
            method: "node.invoke".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-missing",
                "command": "browser.proxy",
                "idempotencyKey": "idem-2"
            }),
        };
        match dispatcher.handle_request(&invoke_unknown).await {
            RpcDispatchOutcome::Error { code, details, .. } => {
                assert_eq!(code, 503);
                assert_eq!(
                    details
                        .as_ref()
                        .and_then(|value| value.pointer("/code"))
                        .and_then(serde_json::Value::as_str),
                    Some("NOT_CONNECTED")
                );
            }
            _ => panic!("expected node.invoke unavailable"),
        }

        let invoke_disallowed = RpcRequestFrame {
            id: "req-node-invoke-disallowed".to_owned(),
            method: "node.invoke".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-invoke-1",
                "command": "camera.capture",
                "idempotencyKey": "idem-3"
            }),
        };
        let out = dispatcher.handle_request(&invoke_disallowed).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let invoke = RpcRequestFrame {
            id: "req-node-invoke".to_owned(),
            method: "node.invoke".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-invoke-1",
                "command": "browser.proxy",
                "params": { "path": "/tabs" },
                "timeoutMs": 1500,
                "idempotencyKey": "idem-4"
            }),
        };
        let invoke_id = match dispatcher.handle_request(&invoke).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                payload
                    .pointer("/payload/invokeId")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .expect("invoke id")
            }
            _ => panic!("expected node.invoke handled"),
        };

        let invoke_result_unknown = RpcRequestFrame {
            id: "req-node-invoke-result-unknown".to_owned(),
            method: "node.invoke.result".to_owned(),
            params: serde_json::json!({
                "id": "node-invoke-missing",
                "nodeId": "node-invoke-1",
                "ok": true
            }),
        };
        match dispatcher.handle_request(&invoke_result_unknown).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/ignored")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
            }
            _ => panic!("expected ignored node.invoke.result"),
        }

        let invoke_result_mismatch = RpcRequestFrame {
            id: "req-node-invoke-result-mismatch".to_owned(),
            method: "node.invoke.result".to_owned(),
            params: serde_json::json!({
                "id": invoke_id.clone(),
                "nodeId": "node-other",
                "ok": true
            }),
        };
        let out = dispatcher.handle_request(&invoke_result_mismatch).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let invoke_result = RpcRequestFrame {
            id: "req-node-invoke-result".to_owned(),
            method: "node.invoke.result".to_owned(),
            params: serde_json::json!({
                "id": invoke_id,
                "nodeId": "node-invoke-1",
                "ok": true,
                "payloadJSON": { "status": "ok" }
            }),
        };
        match dispatcher.handle_request(&invoke_result).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert!(payload.pointer("/ignored").is_none());
            }
            _ => panic!("expected node.invoke.result handled"),
        }

        let node_event_invalid = RpcRequestFrame {
            id: "req-node-event-invalid".to_owned(),
            method: "node.event".to_owned(),
            params: serde_json::json!({
                "event": "node.heartbeat",
                "payloadJSON": { "bad": true }
            }),
        };
        let out = dispatcher.handle_request(&node_event_invalid).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let node_event = RpcRequestFrame {
            id: "req-node-event".to_owned(),
            method: "node.event".to_owned(),
            params: serde_json::json!({
                "event": "node.heartbeat",
                "payload": { "ok": true }
            }),
        };
        match dispatcher.handle_request(&node_event).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
            }
            _ => panic!("expected node.event handled"),
        }
    }

    #[tokio::test]
    async fn dispatcher_exec_approvals_methods_follow_parity_contract() {
        let dispatcher = RpcDispatcher::new();

        let invalid_get = RpcRequestFrame {
            id: "req-exec-approvals-get-invalid".to_owned(),
            method: "exec.approvals.get".to_owned(),
            params: serde_json::json!({
                "extra": true
            }),
        };
        let out = dispatcher.handle_request(&invalid_get).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let get = RpcRequestFrame {
            id: "req-exec-approvals-get".to_owned(),
            method: "exec.approvals.get".to_owned(),
            params: serde_json::json!({}),
        };
        let global_hash = match dispatcher.handle_request(&get).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/path").and_then(serde_json::Value::as_str),
                    Some(super::EXEC_APPROVALS_GLOBAL_PATH)
                );
                assert_eq!(
                    payload
                        .pointer("/exists")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/file/version")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                assert!(payload.pointer("/file/socket/token").is_none());
                payload
                    .pointer("/hash")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .expect("exec approvals hash")
            }
            _ => panic!("expected exec.approvals.get handled"),
        };

        let set_missing_base_hash = RpcRequestFrame {
            id: "req-exec-approvals-set-no-base".to_owned(),
            method: "exec.approvals.set".to_owned(),
            params: serde_json::json!({
                "file": {
                    "version": 1,
                    "agents": {}
                }
            }),
        };
        let out = dispatcher.handle_request(&set_missing_base_hash).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let set_stale_hash = RpcRequestFrame {
            id: "req-exec-approvals-set-stale".to_owned(),
            method: "exec.approvals.set".to_owned(),
            params: serde_json::json!({
                "baseHash": "stale",
                "file": {
                    "version": 1,
                    "agents": {}
                }
            }),
        };
        let out = dispatcher.handle_request(&set_stale_hash).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let set = RpcRequestFrame {
            id: "req-exec-approvals-set".to_owned(),
            method: "exec.approvals.set".to_owned(),
            params: serde_json::json!({
                "baseHash": global_hash,
                "file": {
                    "version": 1,
                    "defaults": {
                        "security": "allowlist",
                        "ask": "on-miss"
                    },
                    "agents": {
                        "main": {
                            "allowlist": [
                                { "pattern": "git status" }
                            ]
                        }
                    }
                }
            }),
        };
        let updated_global_hash = match dispatcher.handle_request(&set).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/file/defaults/security")
                        .and_then(serde_json::Value::as_str),
                    Some("allowlist")
                );
                assert_eq!(
                    payload
                        .pointer("/file/agents/main/allowlist/0/pattern")
                        .and_then(serde_json::Value::as_str),
                    Some("git status")
                );
                assert!(payload.pointer("/file/socket/token").is_none());
                payload
                    .pointer("/hash")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .expect("updated exec approvals hash")
            }
            _ => panic!("expected exec.approvals.set handled"),
        };

        let disconnected_node_get = RpcRequestFrame {
            id: "req-exec-approvals-node-get-disconnected".to_owned(),
            method: "exec.approvals.node.get".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-exec-missing"
            }),
        };
        match dispatcher.handle_request(&disconnected_node_get).await {
            RpcDispatchOutcome::Error { code, details, .. } => {
                assert_eq!(code, 503);
                assert_eq!(
                    details
                        .as_ref()
                        .and_then(|value| value.pointer("/code"))
                        .and_then(serde_json::Value::as_str),
                    Some("NOT_CONNECTED")
                );
            }
            _ => panic!("expected exec.approvals.node.get unavailable"),
        }

        let pair_request = RpcRequestFrame {
            id: "req-exec-approvals-node-pair-request".to_owned(),
            method: "node.pair.request".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-exec-1"
            }),
        };
        let request_id = match dispatcher.handle_request(&pair_request).await {
            RpcDispatchOutcome::Handled(payload) => payload
                .pointer("/request/requestId")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
                .expect("node pair request id"),
            _ => panic!("expected node.pair.request handled"),
        };
        let pair_approve = RpcRequestFrame {
            id: "req-exec-approvals-node-pair-approve".to_owned(),
            method: "node.pair.approve".to_owned(),
            params: serde_json::json!({
                "requestId": request_id
            }),
        };
        let out = dispatcher.handle_request(&pair_approve).await;
        assert!(matches!(out, RpcDispatchOutcome::Handled(_)));

        let node_get = RpcRequestFrame {
            id: "req-exec-approvals-node-get".to_owned(),
            method: "exec.approvals.node.get".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-exec-1"
            }),
        };
        let node_hash = match dispatcher.handle_request(&node_get).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/path").and_then(serde_json::Value::as_str),
                    Some("memory://nodes/node-exec-1/exec-approvals.json")
                );
                assert_eq!(
                    payload
                        .pointer("/file/version")
                        .and_then(serde_json::Value::as_u64),
                    Some(1)
                );
                assert!(payload.pointer("/file/socket/token").is_none());
                payload
                    .pointer("/hash")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .expect("node exec approvals hash")
            }
            _ => panic!("expected exec.approvals.node.get handled"),
        };

        let node_set_missing_base_hash = RpcRequestFrame {
            id: "req-exec-approvals-node-set-no-base".to_owned(),
            method: "exec.approvals.node.set".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-exec-1",
                "file": {
                    "version": 1,
                    "agents": {}
                }
            }),
        };
        let out = dispatcher.handle_request(&node_set_missing_base_hash).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let node_set = RpcRequestFrame {
            id: "req-exec-approvals-node-set".to_owned(),
            method: "exec.approvals.node.set".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-exec-1",
                "baseHash": node_hash,
                "file": {
                    "version": 1,
                    "agents": {
                        "main": {
                            "allowlist": [
                                { "pattern": "cargo test" }
                            ]
                        }
                    }
                }
            }),
        };
        let updated_node_hash = match dispatcher.handle_request(&node_set).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/file/agents/main/allowlist/0/pattern")
                        .and_then(serde_json::Value::as_str),
                    Some("cargo test")
                );
                assert!(payload.pointer("/file/socket/token").is_none());
                payload
                    .pointer("/hash")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
                    .expect("updated node exec approvals hash")
            }
            _ => panic!("expected exec.approvals.node.set handled"),
        };

        assert_ne!(updated_global_hash, updated_node_hash);

        let node_set_stale_hash = RpcRequestFrame {
            id: "req-exec-approvals-node-set-stale".to_owned(),
            method: "exec.approvals.node.set".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-exec-1",
                "baseHash": "stale",
                "file": {
                    "version": 1,
                    "agents": {}
                }
            }),
        };
        let out = dispatcher.handle_request(&node_set_stale_hash).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let node_set_non_object = RpcRequestFrame {
            id: "req-exec-approvals-node-set-non-object".to_owned(),
            method: "exec.approvals.node.set".to_owned(),
            params: serde_json::json!({
                "nodeId": "node-exec-1",
                "baseHash": updated_node_hash,
                "file": "invalid"
            }),
        };
        let out = dispatcher.handle_request(&node_set_non_object).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));
    }

    #[tokio::test]
    async fn dispatcher_exec_approval_methods_follow_parity_contract() {
        let dispatcher = RpcDispatcher::new();

        let invalid_request = RpcRequestFrame {
            id: "req-exec-approval-request-invalid".to_owned(),
            method: "exec.approval.request".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&invalid_request).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let request_two_phase = RpcRequestFrame {
            id: "req-exec-approval-request-two-phase".to_owned(),
            method: "exec.approval.request".to_owned(),
            params: serde_json::json!({
                "id": "approval-1",
                "command": "git status",
                "twoPhase": true,
                "timeoutMs": 1_000
            }),
        };
        match dispatcher.handle_request(&request_two_phase).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("accepted")
                );
                assert_eq!(
                    payload.pointer("/id").and_then(serde_json::Value::as_str),
                    Some("approval-1")
                );
            }
            _ => panic!("expected exec.approval.request accepted response"),
        }

        let duplicate_id = RpcRequestFrame {
            id: "req-exec-approval-request-duplicate".to_owned(),
            method: "exec.approval.request".to_owned(),
            params: serde_json::json!({
                "id": "approval-1",
                "command": "ls",
                "twoPhase": true
            }),
        };
        let out = dispatcher.handle_request(&duplicate_id).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let wait_missing_id = RpcRequestFrame {
            id: "req-exec-approval-wait-missing-id".to_owned(),
            method: "exec.approval.waitDecision".to_owned(),
            params: serde_json::json!({}),
        };
        let out = dispatcher.handle_request(&wait_missing_id).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let wait_unknown = RpcRequestFrame {
            id: "req-exec-approval-wait-unknown".to_owned(),
            method: "exec.approval.waitDecision".to_owned(),
            params: serde_json::json!({
                "id": "approval-missing"
            }),
        };
        let out = dispatcher.handle_request(&wait_unknown).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let resolve_invalid_decision = RpcRequestFrame {
            id: "req-exec-approval-resolve-invalid".to_owned(),
            method: "exec.approval.resolve".to_owned(),
            params: serde_json::json!({
                "id": "approval-1",
                "decision": "approve"
            }),
        };
        let out = dispatcher.handle_request(&resolve_invalid_decision).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let resolve_unknown = RpcRequestFrame {
            id: "req-exec-approval-resolve-unknown".to_owned(),
            method: "exec.approval.resolve".to_owned(),
            params: serde_json::json!({
                "id": "approval-missing",
                "decision": "deny"
            }),
        };
        let out = dispatcher.handle_request(&resolve_unknown).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let wait_pending = RpcRequestFrame {
            id: "req-exec-approval-wait-pending".to_owned(),
            method: "exec.approval.waitDecision".to_owned(),
            params: serde_json::json!({
                "id": "approval-1"
            }),
        };
        let resolve_allow_once = RpcRequestFrame {
            id: "req-exec-approval-resolve".to_owned(),
            method: "exec.approval.resolve".to_owned(),
            params: serde_json::json!({
                "id": "approval-1",
                "decision": "allow-once"
            }),
        };
        let wait_future = dispatcher.handle_request(&wait_pending);
        let resolve_future = async {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            dispatcher.handle_request(&resolve_allow_once).await
        };
        let (wait_out, resolve_out) = tokio::join!(wait_future, resolve_future);

        match resolve_out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
            }
            _ => panic!("expected exec.approval.resolve handled"),
        }

        match wait_out {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/decision")
                        .and_then(serde_json::Value::as_str),
                    Some("allow-once")
                );
                assert_eq!(
                    payload.pointer("/id").and_then(serde_json::Value::as_str),
                    Some("approval-1")
                );
            }
            _ => panic!("expected exec.approval.waitDecision handled"),
        }

        let wait_resolved = RpcRequestFrame {
            id: "req-exec-approval-wait-resolved".to_owned(),
            method: "exec.approval.waitDecision".to_owned(),
            params: serde_json::json!({
                "id": "approval-1"
            }),
        };
        match dispatcher.handle_request(&wait_resolved).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/decision")
                        .and_then(serde_json::Value::as_str),
                    Some("allow-once")
                );
            }
            _ => panic!("expected resolved waitDecision handled"),
        }

        let request_single_phase_timeout = RpcRequestFrame {
            id: "req-exec-approval-request-single-phase".to_owned(),
            method: "exec.approval.request".to_owned(),
            params: serde_json::json!({
                "command": "echo hi",
                "timeoutMs": 1
            }),
        };
        match dispatcher
            .handle_request(&request_single_phase_timeout)
            .await
        {
            RpcDispatchOutcome::Handled(payload) => {
                assert!(payload.pointer("/id").is_some());
                assert!(payload.pointer("/decision").is_some());
                assert_eq!(
                    payload
                        .pointer("/decision")
                        .and_then(serde_json::Value::as_str),
                    None
                );
            }
            _ => panic!("expected single-phase timeout response"),
        }
    }

    #[tokio::test]
    async fn dispatcher_chat_methods_follow_parity_contract() {
        let dispatcher = RpcDispatcher::new();
        let expected_session_key = super::canonicalize_session_key("main");

        let invalid_history = RpcRequestFrame {
            id: "req-chat-history-invalid".to_owned(),
            method: "chat.history".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main",
                "extra": true
            }),
        };
        let out = dispatcher.handle_request(&invalid_history).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let missing_idempotency = RpcRequestFrame {
            id: "req-chat-send-missing-idempotency".to_owned(),
            method: "chat.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main",
                "message": "hello"
            }),
        };
        let out = dispatcher.handle_request(&missing_idempotency).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let empty_message = RpcRequestFrame {
            id: "req-chat-send-empty".to_owned(),
            method: "chat.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main",
                "message": "   ",
                "idempotencyKey": "chat-empty"
            }),
        };
        let out = dispatcher.handle_request(&empty_message).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let null_byte_message = RpcRequestFrame {
            id: "req-chat-send-null-byte".to_owned(),
            method: "chat.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main",
                "message": "bad\u{0000}message",
                "idempotencyKey": "chat-null-byte"
            }),
        };
        let out = dispatcher.handle_request(&null_byte_message).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let send = RpcRequestFrame {
            id: "req-chat-send".to_owned(),
            method: "chat.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main",
                "message": "hello from chat",
                "idempotencyKey": "chat-run-1"
            }),
        };
        match dispatcher.handle_request(&send).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/runId")
                        .and_then(serde_json::Value::as_str),
                    Some("chat-run-1")
                );
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("started")
                );
            }
            _ => panic!("expected chat.send started response"),
        }

        match dispatcher.handle_request(&send).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("in_flight")
                );
            }
            _ => panic!("expected chat.send in_flight response"),
        }

        let mut completed = false;
        for _ in 0..10 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            match dispatcher.handle_request(&send).await {
                RpcDispatchOutcome::Handled(payload) => {
                    let status = payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    if status == "ok" {
                        completed = true;
                        break;
                    }
                    assert_eq!(status, "in_flight");
                }
                _ => panic!("expected chat.send replay response"),
            }
        }
        assert!(completed, "expected ok chat.send replay status");

        let patch = RpcRequestFrame {
            id: "req-chat-session-patch".to_owned(),
            method: "sessions.patch".to_owned(),
            params: serde_json::json!({
                "key": "main",
                "thinkingLevel": "high",
                "verboseLevel": "on"
            }),
        };
        let out = dispatcher.handle_request(&patch).await;
        assert!(matches!(out, RpcDispatchOutcome::Handled(_)));

        let send_abortable = RpcRequestFrame {
            id: "req-chat-send-abortable".to_owned(),
            method: "chat.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main",
                "message": "abort this run",
                "idempotencyKey": "chat-run-abort"
            }),
        };
        let out = dispatcher.handle_request(&send_abortable).await;
        assert!(matches!(out, RpcDispatchOutcome::Handled(_)));

        let abort_mismatch = RpcRequestFrame {
            id: "req-chat-abort-mismatch".to_owned(),
            method: "chat.abort".to_owned(),
            params: serde_json::json!({
                "sessionKey": "other",
                "runId": "chat-run-abort"
            }),
        };
        let out = dispatcher.handle_request(&abort_mismatch).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let abort_not_found = RpcRequestFrame {
            id: "req-chat-abort-not-found".to_owned(),
            method: "chat.abort".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main",
                "runId": "chat-run-missing"
            }),
        };
        match dispatcher.handle_request(&abort_not_found).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/aborted")
                        .and_then(serde_json::Value::as_bool),
                    Some(false)
                );
                let run_ids = payload
                    .pointer("/runIds")
                    .and_then(serde_json::Value::as_array)
                    .expect("run ids");
                assert!(run_ids.is_empty());
            }
            _ => panic!("expected chat.abort not found response"),
        }

        let abort = RpcRequestFrame {
            id: "req-chat-abort".to_owned(),
            method: "chat.abort".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main",
                "runId": "chat-run-abort"
            }),
        };
        match dispatcher.handle_request(&abort).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/aborted")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/runIds/0")
                        .and_then(serde_json::Value::as_str),
                    Some("chat-run-abort")
                );
            }
            _ => panic!("expected chat.abort aborted response"),
        }

        match dispatcher.handle_request(&send_abortable).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/status")
                        .and_then(serde_json::Value::as_str),
                    Some("aborted")
                );
            }
            _ => panic!("expected chat.send aborted replay response"),
        }

        let send_stop_target = RpcRequestFrame {
            id: "req-chat-send-stop-target".to_owned(),
            method: "chat.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main",
                "message": "stop target",
                "idempotencyKey": "chat-run-stop-target"
            }),
        };
        let out = dispatcher.handle_request(&send_stop_target).await;
        assert!(matches!(out, RpcDispatchOutcome::Handled(_)));

        let send_stop = RpcRequestFrame {
            id: "req-chat-send-stop".to_owned(),
            method: "chat.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main",
                "message": "/stop",
                "idempotencyKey": "chat-stop"
            }),
        };
        match dispatcher.handle_request(&send_stop).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/aborted")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                let run_ids = payload
                    .pointer("/runIds")
                    .and_then(serde_json::Value::as_array)
                    .expect("run ids");
                let ids = run_ids
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>();
                assert!(ids.contains(&"chat-run-stop-target"));
            }
            _ => panic!("expected chat.send stop-command abort response"),
        }

        let send_batch_a = RpcRequestFrame {
            id: "req-chat-send-batch-a".to_owned(),
            method: "chat.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main",
                "message": "batch-a",
                "idempotencyKey": "chat-run-a"
            }),
        };
        let send_batch_b = RpcRequestFrame {
            id: "req-chat-send-batch-b".to_owned(),
            method: "chat.send".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main",
                "message": "batch-b",
                "idempotencyKey": "chat-run-b"
            }),
        };
        let out = dispatcher.handle_request(&send_batch_a).await;
        assert!(matches!(out, RpcDispatchOutcome::Handled(_)));
        let out = dispatcher.handle_request(&send_batch_b).await;
        assert!(matches!(out, RpcDispatchOutcome::Handled(_)));

        let abort_session = RpcRequestFrame {
            id: "req-chat-abort-session".to_owned(),
            method: "chat.abort".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main"
            }),
        };
        match dispatcher.handle_request(&abort_session).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    payload
                        .pointer("/aborted")
                        .and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                let run_ids = payload
                    .pointer("/runIds")
                    .and_then(serde_json::Value::as_array)
                    .expect("run ids");
                let ids = run_ids
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>();
                assert_eq!(ids, vec!["chat-run-a", "chat-run-b"]);
            }
            _ => panic!("expected chat.abort session response"),
        }

        let inject_missing_session = RpcRequestFrame {
            id: "req-chat-inject-missing-session".to_owned(),
            method: "chat.inject".to_owned(),
            params: serde_json::json!({
                "sessionKey": "missing",
                "message": "note"
            }),
        };
        let out = dispatcher.handle_request(&inject_missing_session).await;
        assert!(matches!(out, RpcDispatchOutcome::Error { code: 400, .. }));

        let inject = RpcRequestFrame {
            id: "req-chat-inject".to_owned(),
            method: "chat.inject".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main",
                "message": "operator note",
                "label": "ops"
            }),
        };
        match dispatcher.handle_request(&inject).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload.pointer("/ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert!(payload.pointer("/messageId").is_some());
            }
            _ => panic!("expected chat.inject handled response"),
        }

        let history = RpcRequestFrame {
            id: "req-chat-history".to_owned(),
            method: "chat.history".to_owned(),
            params: serde_json::json!({
                "sessionKey": "main",
                "limit": 3
            }),
        };
        match dispatcher.handle_request(&history).await {
            RpcDispatchOutcome::Handled(payload) => {
                assert_eq!(
                    payload
                        .pointer("/sessionKey")
                        .and_then(serde_json::Value::as_str),
                    Some(expected_session_key.as_str())
                );
                assert!(payload.pointer("/sessionId").is_some());
                assert_eq!(
                    payload
                        .pointer("/thinkingLevel")
                        .and_then(serde_json::Value::as_str),
                    Some("high")
                );
                assert_eq!(
                    payload
                        .pointer("/verboseLevel")
                        .and_then(serde_json::Value::as_str),
                    Some("on")
                );
                let messages = payload
                    .pointer("/messages")
                    .and_then(serde_json::Value::as_array)
                    .expect("messages array");
                assert_eq!(messages.len(), 3);
                assert_eq!(
                    messages
                        .first()
                        .and_then(|msg| msg.pointer("/role"))
                        .and_then(serde_json::Value::as_str),
                    Some("user")
                );
                assert_eq!(
                    messages
                        .last()
                        .and_then(|msg| msg.pointer("/role"))
                        .and_then(serde_json::Value::as_str),
                    Some("assistant")
                );
                let texts = messages
                    .iter()
                    .filter_map(|msg| msg.pointer("/content"))
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>();
                assert_eq!(texts, vec!["batch-a", "batch-b", "[ops] operator note"]);
            }
            _ => panic!("expected chat.history handled response"),
        }
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
