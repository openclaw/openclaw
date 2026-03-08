use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use base64::Engine as _;
use ring::signature;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub gateway: GatewayConfig,
    pub runtime: RuntimeConfig,
    pub security: SecurityConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayConfig {
    pub url: String,
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeConfig {
    pub audit_only: bool,
    pub decision_event: String,
    pub worker_concurrency: usize,
    pub max_queue: usize,
    #[serde(default = "default_session_queue_mode")]
    pub session_queue_mode: SessionQueueMode,
    #[serde(default = "default_group_activation_mode")]
    pub group_activation_mode: GroupActivationMode,
    pub eval_timeout_ms: u64,
    pub memory_sample_secs: u64,
    #[serde(default = "default_idempotency_ttl_secs")]
    pub idempotency_ttl_secs: u64,
    #[serde(default = "default_idempotency_max_entries")]
    pub idempotency_max_entries: usize,
    #[serde(default = "default_session_state_path")]
    pub session_state_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityConfig {
    pub review_threshold: u8,
    pub block_threshold: u8,
    pub virustotal_api_key: Option<String>,
    pub virustotal_timeout_ms: u64,
    pub quarantine_dir: PathBuf,
    pub protect_paths: Vec<PathBuf>,
    pub allowed_command_prefixes: Vec<String>,
    pub blocked_command_patterns: Vec<String>,
    pub prompt_injection_patterns: Vec<String>,
    #[serde(default)]
    pub tool_policies: HashMap<String, PolicyAction>,
    #[serde(default = "default_tool_risk_bonus")]
    pub tool_risk_bonus: HashMap<String, u8>,
    #[serde(default = "default_channel_risk_bonus")]
    pub channel_risk_bonus: HashMap<String, u8>,
    #[serde(default)]
    pub signed_policy_bundle: Option<PathBuf>,
    #[serde(default)]
    pub signed_policy_signature: Option<PathBuf>,
    #[serde(default)]
    pub signed_policy_public_key: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct SignedPolicyBundle {
    review_threshold: Option<u8>,
    block_threshold: Option<u8>,
    allowed_command_prefixes: Option<Vec<String>>,
    blocked_command_patterns: Option<Vec<String>>,
    prompt_injection_patterns: Option<Vec<String>>,
    tool_policies: Option<HashMap<String, PolicyAction>>,
    tool_risk_bonus: Option<HashMap<String, u8>>,
    channel_risk_bonus: Option<HashMap<String, u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyAction {
    Allow,
    Review,
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionQueueMode {
    Followup,
    Steer,
    Collect,
    #[serde(
        rename = "steer-backlog",
        alias = "steer_backlog",
        alias = "steer+backlog"
    )]
    SteerBacklog,
    Interrupt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupActivationMode {
    Mention,
    Always,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            gateway: GatewayConfig {
                url: "ws://127.0.0.1:18789/ws".to_owned(),
                token: None,
            },
            runtime: RuntimeConfig {
                audit_only: false,
                decision_event: "security.decision".to_owned(),
                worker_concurrency: 8,
                max_queue: 256,
                session_queue_mode: default_session_queue_mode(),
                group_activation_mode: default_group_activation_mode(),
                eval_timeout_ms: 2_500,
                memory_sample_secs: 15,
                idempotency_ttl_secs: default_idempotency_ttl_secs(),
                idempotency_max_entries: default_idempotency_max_entries(),
                session_state_path: default_session_state_path(),
            },
            security: SecurityConfig {
                review_threshold: 35,
                block_threshold: 65,
                virustotal_api_key: None,
                virustotal_timeout_ms: 1_400,
                quarantine_dir: PathBuf::from(".openclaw-rs/quarantine"),
                protect_paths: vec![
                    PathBuf::from("./openclaw.mjs"),
                    PathBuf::from("./dist/index.js"),
                ],
                allowed_command_prefixes: vec![
                    "git ".to_owned(),
                    "ls".to_owned(),
                    "rg ".to_owned(),
                ],
                blocked_command_patterns: vec![
                    r"(?i)\brm\s+-rf\s+/".to_owned(),
                    r"(?i)\bmkfs\b".to_owned(),
                    r"(?i)\bdd\s+if=".to_owned(),
                    r"(?i)\bcurl\s+[^|]*\|\s*sh\b".to_owned(),
                    r"(?i)\bwget\s+[^|]*\|\s*sh\b".to_owned(),
                ],
                prompt_injection_patterns: vec![
                    r"(?i)ignore\s+all\s+previous\s+instructions".to_owned(),
                    r"(?i)reveal\s+the\s+system\s+prompt".to_owned(),
                    r"(?i)override\s+developer\s+instructions".to_owned(),
                    r"(?i)disable\s+safety".to_owned(),
                ],
                tool_policies: HashMap::new(),
                tool_risk_bonus: default_tool_risk_bonus(),
                channel_risk_bonus: default_channel_risk_bonus(),
                signed_policy_bundle: None,
                signed_policy_signature: None,
                signed_policy_public_key: None,
            },
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let mut cfg = if path.exists() {
            let text = std::fs::read_to_string(path)
                .with_context(|| format!("failed reading config file {}", path.display()))?;
            toml::from_str::<Config>(&text)
                .with_context(|| format!("failed parsing TOML config {}", path.display()))?
        } else {
            Self::default()
        };
        cfg.apply_env_overrides();
        cfg.apply_signed_policy_bundle(path)?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn apply_cli_overrides(
        &mut self,
        gateway_url: Option<&str>,
        gateway_token: Option<&str>,
        audit_only: bool,
    ) {
        if let Some(url) = gateway_url {
            self.gateway.url = url.to_owned();
        }
        if let Some(token) = gateway_token {
            self.gateway.token = Some(token.to_owned());
        }
        if audit_only {
            self.runtime.audit_only = true;
        }
    }

    fn apply_env_overrides(&mut self) {
        if let Ok(v) = env::var("OPENCLAW_RS_GATEWAY_URL") {
            self.gateway.url = v;
        }
        if let Ok(v) = env::var("OPENCLAW_RS_GATEWAY_TOKEN") {
            self.gateway.token = Some(v);
        }
        if let Ok(v) = env::var("OPENCLAW_RS_AUDIT_ONLY") {
            self.runtime.audit_only = parse_bool(&v);
        }
        if let Ok(v) = env::var("OPENCLAW_RS_VT_API_KEY") {
            self.security.virustotal_api_key = Some(v);
        }
        if let Ok(v) = env::var("OPENCLAW_RS_WORKER_CONCURRENCY") {
            if let Ok(n) = v.parse::<usize>() {
                self.runtime.worker_concurrency = n.max(1);
            }
        }
        if let Ok(v) = env::var("OPENCLAW_RS_MAX_QUEUE") {
            if let Ok(n) = v.parse::<usize>() {
                self.runtime.max_queue = n.max(16);
            }
        }
        if let Ok(v) = env::var("OPENCLAW_RS_SESSION_QUEUE_MODE") {
            if let Some(mode) = parse_session_queue_mode(&v) {
                self.runtime.session_queue_mode = mode;
            }
        }
        if let Ok(v) = env::var("OPENCLAW_RS_GROUP_ACTIVATION_MODE")
            .or_else(|_| env::var("OPENCLAW_RS_GROUP_ACTIVATION"))
        {
            if let Some(mode) = parse_group_activation_mode(&v) {
                self.runtime.group_activation_mode = mode;
            }
        }
        if let Ok(v) = env::var("OPENCLAW_RS_ALLOWED_COMMAND_PREFIXES") {
            self.security.allowed_command_prefixes = split_csv(&v);
        }
        if let Ok(v) = env::var("OPENCLAW_RS_MEMORY_SAMPLE_SECS") {
            if let Ok(n) = v.parse::<u64>() {
                self.runtime.memory_sample_secs = n.max(1);
            }
        }
        if let Ok(v) = env::var("OPENCLAW_RS_IDEMPOTENCY_TTL_SECS") {
            if let Ok(n) = v.parse::<u64>() {
                self.runtime.idempotency_ttl_secs = n.max(1);
            }
        }
        if let Ok(v) = env::var("OPENCLAW_RS_IDEMPOTENCY_MAX_ENTRIES") {
            if let Ok(n) = v.parse::<usize>() {
                self.runtime.idempotency_max_entries = n.max(32);
            }
        }
        if let Ok(v) = env::var("OPENCLAW_RS_SESSION_STATE_PATH") {
            self.runtime.session_state_path = PathBuf::from(v);
        }
        if let Ok(v) = env::var("OPENCLAW_RS_SIGNED_POLICY_BUNDLE") {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                self.security.signed_policy_bundle = Some(PathBuf::from(trimmed));
            }
        }
        if let Ok(v) = env::var("OPENCLAW_RS_SIGNED_POLICY_SIGNATURE") {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                self.security.signed_policy_signature = Some(PathBuf::from(trimmed));
            }
        }
        if let Ok(v) = env::var("OPENCLAW_RS_SIGNED_POLICY_PUBLIC_KEY") {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                self.security.signed_policy_public_key = Some(trimmed.to_owned());
            }
        }
    }

    fn apply_signed_policy_bundle(&mut self, config_path: &Path) -> Result<()> {
        let Some(bundle_ref) = self.security.signed_policy_bundle.as_ref() else {
            return Ok(());
        };
        let signature_ref = self.security.signed_policy_signature.as_ref().context(
            "security.signed_policy_signature is required when signed_policy_bundle is set",
        )?;
        let public_key = self
            .security
            .signed_policy_public_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context(
                "security.signed_policy_public_key is required when signed_policy_bundle is set",
            )?;

        let bundle_path = resolve_config_relative_path(config_path, bundle_ref);
        let signature_path = resolve_config_relative_path(config_path, signature_ref);
        let bundle_bytes = std::fs::read(&bundle_path).with_context(|| {
            format!(
                "failed reading signed policy bundle {}",
                bundle_path.display()
            )
        })?;
        let signature_text = std::fs::read_to_string(&signature_path).with_context(|| {
            format!(
                "failed reading signed policy signature {}",
                signature_path.display()
            )
        })?;
        verify_bundle_signature(&bundle_bytes, &signature_text, public_key).with_context(|| {
            format!(
                "signed policy verification failed for {}",
                bundle_path.display()
            )
        })?;

        let bundle_text = String::from_utf8(bundle_bytes)
            .context("signed policy bundle must be valid UTF-8 TOML")?;
        let policy = toml::from_str::<SignedPolicyBundle>(&bundle_text)
            .context("failed parsing signed policy bundle TOML")?;
        self.apply_policy_bundle(policy);
        Ok(())
    }

    fn apply_policy_bundle(&mut self, bundle: SignedPolicyBundle) {
        if let Some(v) = bundle.review_threshold {
            self.security.review_threshold = v;
        }
        if let Some(v) = bundle.block_threshold {
            self.security.block_threshold = v;
        }
        if let Some(v) = bundle.allowed_command_prefixes {
            self.security.allowed_command_prefixes = v;
        }
        if let Some(v) = bundle.blocked_command_patterns {
            self.security.blocked_command_patterns = v;
        }
        if let Some(v) = bundle.prompt_injection_patterns {
            self.security.prompt_injection_patterns = v;
        }
        if let Some(v) = bundle.tool_policies {
            self.security.tool_policies = v;
        }
        if let Some(v) = bundle.tool_risk_bonus {
            self.security.tool_risk_bonus = v;
        }
        if let Some(v) = bundle.channel_risk_bonus {
            self.security.channel_risk_bonus = v;
        }
    }

    fn validate(&self) -> Result<()> {
        if self.security.review_threshold >= self.security.block_threshold {
            anyhow::bail!("security.review_threshold must be lower than security.block_threshold");
        }
        if self.runtime.worker_concurrency == 0 {
            anyhow::bail!("runtime.worker_concurrency must be > 0");
        }
        if self.runtime.max_queue == 0 {
            anyhow::bail!("runtime.max_queue must be > 0");
        }
        if self.runtime.memory_sample_secs == 0 {
            anyhow::bail!("runtime.memory_sample_secs must be > 0");
        }
        if self.runtime.idempotency_ttl_secs == 0 {
            anyhow::bail!("runtime.idempotency_ttl_secs must be > 0");
        }
        if self.runtime.idempotency_max_entries == 0 {
            anyhow::bail!("runtime.idempotency_max_entries must be > 0");
        }
        Ok(())
    }
}

fn split_csv(input: &str) -> Vec<String> {
    input
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn resolve_config_relative_path(config_path: &Path, target: &Path) -> PathBuf {
    if target.is_absolute() {
        return target.to_path_buf();
    }
    let base_dir = config_path.parent().unwrap_or_else(|| Path::new("."));
    base_dir.join(target)
}

fn verify_bundle_signature(
    bundle_bytes: &[u8],
    signature_text: &str,
    public_key_text: &str,
) -> Result<()> {
    let signature_bytes =
        decode_compact_text_bytes(signature_text, 64, "security.signed_policy_signature")?;
    let public_key_bytes =
        decode_compact_text_bytes(public_key_text, 32, "security.signed_policy_public_key")?;
    let key = signature::UnparsedPublicKey::new(&signature::ED25519, &public_key_bytes);
    key.verify(bundle_bytes, &signature_bytes)
        .map_err(|_| anyhow::anyhow!("signature verification failed"))?;
    Ok(())
}

fn decode_compact_text_bytes(
    input: &str,
    expected_len: usize,
    field_name: &str,
) -> Result<Vec<u8>> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        anyhow::bail!("{field_name} cannot be empty");
    }

    let decoded_base64 = base64::engine::general_purpose::STANDARD.decode(trimmed);
    let bytes = match decoded_base64 {
        Ok(bytes) => bytes,
        Err(_) if is_hex_string(trimmed) => decode_hex_string(trimmed)?,
        Err(err) => {
            return Err(anyhow::anyhow!(
                "{field_name} must be base64 (preferred) or hex bytes: {err}"
            ));
        }
    };

    if bytes.len() != expected_len {
        anyhow::bail!(
            "{field_name} must decode to {expected_len} bytes, got {}",
            bytes.len()
        );
    }
    Ok(bytes)
}

fn is_hex_string(input: &str) -> bool {
    !input.is_empty() && input.len() % 2 == 0 && input.chars().all(|c| c.is_ascii_hexdigit())
}

fn decode_hex_string(input: &str) -> Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(input.len() / 2);
    for chunk in input.as_bytes().chunks_exact(2) {
        let hex = std::str::from_utf8(chunk).context("invalid hex bytes")?;
        let value = u8::from_str_radix(hex, 16).context("invalid hex digits")?;
        bytes.push(value);
    }
    Ok(bytes)
}

fn parse_bool(s: &str) -> bool {
    matches!(
        s.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn default_tool_risk_bonus() -> HashMap<String, u8> {
    HashMap::from([
        ("exec".to_owned(), 20),
        ("bash".to_owned(), 20),
        ("process".to_owned(), 10),
        ("apply_patch".to_owned(), 12),
        ("browser".to_owned(), 8),
        ("gateway".to_owned(), 20),
        ("nodes".to_owned(), 20),
    ])
}

fn default_channel_risk_bonus() -> HashMap<String, u8> {
    HashMap::from([
        ("discord".to_owned(), 10),
        ("slack".to_owned(), 8),
        ("telegram".to_owned(), 6),
        ("whatsapp".to_owned(), 6),
        ("webchat".to_owned(), 8),
    ])
}

fn default_idempotency_ttl_secs() -> u64 {
    300
}

fn default_idempotency_max_entries() -> usize {
    5000
}

fn default_session_state_path() -> PathBuf {
    PathBuf::from(".openclaw-rs/session-state.json")
}

fn default_session_queue_mode() -> SessionQueueMode {
    SessionQueueMode::Followup
}

fn default_group_activation_mode() -> GroupActivationMode {
    GroupActivationMode::Mention
}

fn parse_session_queue_mode(s: &str) -> Option<SessionQueueMode> {
    match s.trim().to_ascii_lowercase().as_str() {
        "followup" => Some(SessionQueueMode::Followup),
        "queue" | "queued" => Some(SessionQueueMode::Steer),
        "steer" => Some(SessionQueueMode::Steer),
        "collect" => Some(SessionQueueMode::Collect),
        "steer-backlog" | "steer_backlog" | "steer+backlog" => Some(SessionQueueMode::SteerBacklog),
        "interrupt" | "interrupts" | "abort" => Some(SessionQueueMode::Interrupt),
        _ => None,
    }
}

fn parse_group_activation_mode(s: &str) -> Option<GroupActivationMode> {
    match s.trim().to_ascii_lowercase().as_str() {
        "mention" => Some(GroupActivationMode::Mention),
        "always" => Some(GroupActivationMode::Always),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use base64::Engine as _;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    use super::Config;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let mut dir = std::env::temp_dir();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        dir.push(format!("openclaw-rs-config-{tag}-{stamp}"));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    fn base_config_toml() -> String {
        r#"
[gateway]
url = "ws://127.0.0.1:18789/ws"
token = ""

[runtime]
audit_only = false
decision_event = "security.decision"
worker_concurrency = 2
max_queue = 32
session_queue_mode = "followup"
group_activation_mode = "mention"
eval_timeout_ms = 1200
memory_sample_secs = 10
idempotency_ttl_secs = 120
idempotency_max_entries = 1024
session_state_path = ".openclaw-rs/session-state.json"

[security]
review_threshold = 35
block_threshold = 65
virustotal_api_key = ""
virustotal_timeout_ms = 400
quarantine_dir = ".openclaw-rs/quarantine"
protect_paths = ["./openclaw.mjs"]
allowed_command_prefixes = ["git "]
blocked_command_patterns = ["(?i)\\brm\\s+-rf\\s+/"]
prompt_injection_patterns = ["(?i)ignore\\s+all\\s+previous\\s+instructions"]
tool_policies = {}
tool_risk_bonus = {}
channel_risk_bonus = {}
"#
        .to_owned()
    }

    #[test]
    fn load_applies_verified_signed_policy_bundle() {
        let dir = temp_dir("signed-policy-ok");
        let bundle_path = dir.join("policy-bundle.toml");
        let sig_path = dir.join("policy-bundle.sig");
        let cfg_path = dir.join("openclaw-rs.toml");
        std::fs::write(
            &bundle_path,
            r#"
review_threshold = 20
block_threshold = 50
allowed_command_prefixes = ["git ", "rg "]
tool_policies = { exec = "block" }
channel_risk_bonus = { discord = 12 }
"#,
        )
        .expect("write bundle");
        let bundle_bytes = std::fs::read(&bundle_path).expect("read bundle");
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("pkcs8");
        let signing_key = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("keypair");
        let signature = signing_key.sign(&bundle_bytes);
        std::fs::write(
            &sig_path,
            base64::engine::general_purpose::STANDARD.encode(signature.as_ref()),
        )
        .expect("write signature");
        let public_key =
            base64::engine::general_purpose::STANDARD.encode(signing_key.public_key().as_ref());
        let config_toml = format!(
            "{}\nsigned_policy_bundle = \"{}\"\nsigned_policy_signature = \"{}\"\nsigned_policy_public_key = \"{}\"\n",
            base_config_toml(),
            bundle_path.file_name().expect("bundle file").to_string_lossy(),
            sig_path.file_name().expect("sig file").to_string_lossy(),
            public_key
        );
        std::fs::write(&cfg_path, config_toml).expect("write config");

        let cfg = Config::load(&cfg_path).expect("load config");
        assert_eq!(cfg.security.review_threshold, 20);
        assert_eq!(cfg.security.block_threshold, 50);
        assert_eq!(
            cfg.security.allowed_command_prefixes,
            vec!["git ".to_owned(), "rg ".to_owned()]
        );
        assert_eq!(
            cfg.security.tool_policies.get("exec").copied(),
            Some(super::PolicyAction::Block)
        );
        assert_eq!(cfg.security.channel_risk_bonus.get("discord"), Some(&12));
    }

    #[test]
    fn load_rejects_tampered_signed_policy_bundle() {
        let dir = temp_dir("signed-policy-bad");
        let bundle_path = dir.join("policy-bundle.toml");
        let sig_path = dir.join("policy-bundle.sig");
        let cfg_path = dir.join("openclaw-rs.toml");
        std::fs::write(
            &bundle_path,
            "review_threshold = 15\nblock_threshold = 45\n",
        )
        .expect("write bundle");
        let bundle_bytes = std::fs::read(&bundle_path).expect("read bundle");
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("pkcs8");
        let signing_key = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("keypair");
        let signature = signing_key.sign(&bundle_bytes);
        std::fs::write(
            &sig_path,
            base64::engine::general_purpose::STANDARD.encode(signature.as_ref()),
        )
        .expect("write signature");
        std::fs::write(
            &bundle_path,
            "review_threshold = 30\nblock_threshold = 60\n# tampered\n",
        )
        .expect("tamper bundle");

        let public_key =
            base64::engine::general_purpose::STANDARD.encode(signing_key.public_key().as_ref());
        let config_toml = format!(
            "{}\nsigned_policy_bundle = \"{}\"\nsigned_policy_signature = \"{}\"\nsigned_policy_public_key = \"{}\"\n",
            base_config_toml(),
            bundle_path.file_name().expect("bundle file").to_string_lossy(),
            sig_path.file_name().expect("sig file").to_string_lossy(),
            public_key
        );
        std::fs::write(&cfg_path, config_toml).expect("write config");

        let err = Config::load(&cfg_path).expect_err("expected signed policy verify failure");
        let message = format!("{err:#}");
        assert!(message.contains("signed policy verification failed"));
    }

    #[test]
    fn parse_session_queue_mode_supports_upstream_aliases() {
        assert_eq!(
            super::parse_session_queue_mode("queue"),
            Some(super::SessionQueueMode::Steer)
        );
        assert_eq!(
            super::parse_session_queue_mode("steer+backlog"),
            Some(super::SessionQueueMode::SteerBacklog)
        );
        assert_eq!(
            super::parse_session_queue_mode("interrupt"),
            Some(super::SessionQueueMode::Interrupt)
        );
    }
}
