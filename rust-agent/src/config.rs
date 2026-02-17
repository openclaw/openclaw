use std::env;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
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
    pub eval_timeout_ms: u64,
    pub memory_sample_secs: u64,
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
                eval_timeout_ms: 2_500,
                memory_sample_secs: 15,
            },
            security: SecurityConfig {
                review_threshold: 35,
                block_threshold: 65,
                virustotal_api_key: None,
                virustotal_timeout_ms: 1_400,
                quarantine_dir: PathBuf::from(".openclaw-rs/quarantine"),
                protect_paths: vec![PathBuf::from("./openclaw.mjs"), PathBuf::from("./dist/index.js")],
                allowed_command_prefixes: vec!["git ".to_owned(), "ls".to_owned(), "rg ".to_owned()],
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
        if let Ok(v) = env::var("OPENCLAW_RS_ALLOWED_COMMAND_PREFIXES") {
            self.security.allowed_command_prefixes = split_csv(&v);
        }
        if let Ok(v) = env::var("OPENCLAW_RS_MEMORY_SAMPLE_SECS") {
            if let Ok(n) = v.parse::<u64>() {
                self.runtime.memory_sample_secs = n.max(1);
            }
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

fn parse_bool(s: &str) -> bool {
    matches!(s.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
}
