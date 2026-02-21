mod bridge;
mod channels;
mod config;
mod gateway;
mod memory;
mod protocol;
mod runtime;
mod scheduler;
mod security;
mod session_key;
mod state;
mod types;

use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use config::Config;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(author, version, about = "Rust runtime + defender for OpenClaw")]
struct Cli {
    /// Path to TOML config file.
    #[arg(long, env = "OPENCLAW_RS_CONFIG", default_value = "openclaw-rs.toml")]
    config: PathBuf,

    /// Override gateway URL.
    #[arg(long, env = "OPENCLAW_RS_GATEWAY_URL")]
    gateway_url: Option<String>,

    /// Override gateway token.
    #[arg(long, env = "OPENCLAW_RS_GATEWAY_TOKEN")]
    gateway_token: Option<String>,

    /// Enable audit-only mode (never block, always review/allow with annotation).
    #[arg(long, env = "OPENCLAW_RS_AUDIT_ONLY")]
    audit_only: bool,

    /// Log level filter, e.g. info,debug,trace.
    #[arg(long, env = "OPENCLAW_RS_LOG", default_value = "info")]
    log: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    init_logging(&cli.log)?;

    let mut cfg = Config::load(&cli.config)?;
    cfg.apply_cli_overrides(
        cli.gateway_url.as_deref(),
        cli.gateway_token.as_deref(),
        cli.audit_only,
    );

    let runtime = runtime::AgentRuntime::new(cfg).await?;
    runtime.run().await
}

fn init_logging(filter: &str) -> Result<()> {
    let env = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(filter));
    tracing_subscriber::fmt()
        .with_env_filter(env)
        .with_target(false)
        .init();
    Ok(())
}
