//! OpenClaw CLI — Full Rust rewrite matching `https://docs.openclaw.ai/`.

use openclaw_channels::telegram::TelegramInboundContext;
use openclaw_channels::{ChannelRegistry, DiscordChannel, TelegramChannel};
use openclaw_config::Config;
use openclaw_core::id::AgentId;
use openclaw_core::message::MessageContent;
use openclaw_core::session::SessionKind;
use openclaw_core::traits::{CompletionMessage, CompletionRequest, CompletionRole, StateStore};
use openclaw_dashboard::DashboardServer;
use openclaw_gateway::Gateway;
use openclaw_llm::{
    anthropic_provider, compatible_provider, known_compatible, ollama_provider, openai_provider,
    ProviderRegistry,
};
use openclaw_skills::SkillRegistry;
use openclaw_state::SqliteStateStore;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::{info, warn, Level};

mod config_cmd;
mod dashboard_cmd;
mod pairing_cmd;
mod service;
mod uninstall_cmd;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let command = args.get(1).map(String::as_str).unwrap_or("help");

    match command {
        "gateway" | "serve" => {
            match args.get(2).map(String::as_str) {
                Some("status") => return run_gateway_status(&args[3..]).await,
                Some("install") => return run_gateway_install(&args[3..]),
                Some("uninstall") => return run_gateway_uninstall(&args[3..]),
                // Lifecycle commands must never fall through to `run`: that would
                // start a Gateway when the operator asked to stop or restart one.
                Some("start") | Some("stop") | Some("restart") => {
                    eprintln!(
                        "`openclaw gateway {}` is not implemented yet; nothing was changed.",
                        args[2]
                    );
                    eprintln!("Use `openclaw gateway install` and the service manager, or `openclaw gateway` to run in the foreground.");
                    std::process::exit(1);
                }
                Some("run") => return run_gateway(&args[3..]).await,
                // Unknown subcommands are errors, not implicit `run`.
                Some(other) if !other.starts_with('-') => {
                    eprintln!("unknown gateway subcommand: {other}");
                    eprintln!("expected: run, status, install, uninstall, start, stop, restart");
                    std::process::exit(2);
                }
                _ => run_gateway(&args[2..]).await,
            }
        }
        "onboard" => run_onboard(&args[2..]).await,
        "config" | "configure" => {
            match config_cmd::run(&args[2..]) {
                Ok(text) => {
                    println!("{text}");
                    Ok(())
                }
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            }
        }
        "pairing" => {
            match pairing_cmd::run(&args[2..]) {
                Ok(text) => {
                    println!("{text}");
                    Ok(())
                }
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            }
        }
        "skills" => run_skills(&args[2..]),
        "memory" => run_memory(&args[2..]),
        "cron" => run_cron(&args[2..]),
        "doctor" => run_doctor(&args[2..]).await,
        "dashboard" => match dashboard_cmd::run(&args[2..]) {
            Ok(dashboard_cmd::Outcome::Opened(text)) => {
                println!("{text}");
                Ok(())
            }
            Ok(dashboard_cmd::Outcome::Json(text)) => {
                // The JSON object carries `ok`; a false value is a real failure.
                let ok = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|value| value.get("ok").and_then(serde_json::Value::as_bool))
                    .unwrap_or(false);
                println!("{text}");
                if ok {
                    Ok(())
                } else {
                    std::process::exit(1);
                }
            }
            Ok(dashboard_cmd::Outcome::Failed {
                message,
                reason,
                json,
            }) => {
                eprintln!("{message}");
                if json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "ok": false,
                            "error": { "type": "cli_error", "message": message },
                            "reason": reason,
                        })
                    );
                }
                std::process::exit(1);
            }
            Err(message) => {
                eprintln!("{message}");
                std::process::exit(2);
            }
        },
        "uninstall" => match uninstall_cmd::run(&args[2..]) {
            Ok(lines) => {
                for line in lines {
                    println!("{line}");
                }
                Ok(())
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        },
        "version" | "--version" | "-V" => {
            println!("openclaw {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        "help" | "--help" | "-h" => {
            print_help();
            Ok(())
        }
        other => {
            eprintln!("unknown command: {other}");
            print_help();
            std::process::exit(1);
        }
    }
}

fn print_help() {
    println!(
        "openclaw {version} — Self-hosted AI assistant gateway (Rust)

USAGE:
    openclaw <COMMAND> [OPTIONS]

COMMANDS:
    gateway                  Start Gateway WS, Control UI WebChat, and Channels
    gateway status           Check running Gateway & Control UI health
    gateway install          Install the Gateway service (systemd/launchd)
    gateway uninstall        Remove the Gateway service definition
    onboard                  Initialize config (OPENCLAW_CONFIG_PATH / state dir)
    config get <path>        Read a config value
    config set <path> <v>    Write a config value (JSON-typed when possible)
    config patch <json>      Merge a JSON object into config
    config unset <path>      Remove a config key
    config file              Print the active config path
    config validate          Validate the active config
    config schema            Print the supported schema summary
    configure                Alias for `config`
    dashboard [--json]       Open/print the Control UI URL (--no-open, --yes)
    uninstall [--all]        Remove service/state/workspace/app (--dry-run, --yes)
    pairing list             List DM pairing requests
    pairing approve <ch> <c> Approve a sender pairing code
    skills list              List discovered bundled, custodian, and workspace skills
    skills info <name>       Print full SKILL.md instructions for a skill
    memory list              List long-term agent memories stored in SQLite
    memory add <key> <text>  Store a long-term memory
    cron list                List scheduled automation jobs
    doctor                   Verify config, SQLite DB, skills, providers, Telegram
    version                  Print version
    help                     Print this help

NOT IMPLEMENTED YET (tracked in parity-commands.tsv):
    setup update backup restore migrate agents agent channels models plugins
    sessions logs health status devices nodes qr security secrets sandbox
    approvals mcp acp hooks webhooks message infer tui completion

OPTIONS:
    --config <PATH>          Path to config file (TOML or JSON)
    --listen <ADDR>          Gateway WebSocket listen address (default: 127.0.0.1:18789)
    --dashboard <ADDR>       Control UI listen address (default: 127.0.0.1:18790)
",
        version = env!("CARGO_PKG_VERSION")
    );
}

fn resolve_config(explicit_path: Option<&str>) -> Result<(Config, Option<PathBuf>), Box<dyn std::error::Error>> {
    if let Some(p) = explicit_path {
        let path = PathBuf::from(p);
        let cfg = if path.extension().is_some_and(|ext| ext == "json") {
            openclaw_config::load_json(&path)?
        } else {
            openclaw_config::load(&path)?
        };
        return Ok((cfg, Some(path)));
    }

    // Documented precedence: OPENCLAW_CONFIG_PATH wins, then the state-dir
    // default. `/etc/openclaw/config.toml` is only a last-resort packaged layout,
    // and the undocumented OPENCLAW_CONFIG is honored only after the documented
    // variable so it can never shadow an operator's explicit choice.
    let documented = openclaw_config::paths::config_path(&openclaw_config::paths::process_env());
    let candidates = [
        documented,
        std::env::var("OPENCLAW_CONFIG").ok().map(PathBuf::from),
        Some(PathBuf::from("/etc/openclaw/config.toml")),
        std::env::var("HOME")
            .ok()
            .map(|h| Path::new(&h).join(".openclaw").join("openclaw.json")),
        std::env::var("USERPROFILE")
            .ok()
            .map(|h| Path::new(&h).join(".openclaw").join("openclaw.json")),
    ];

    for candidate in candidates.into_iter().flatten() {
        if candidate.is_file() {
            let cfg = if candidate.extension().is_some_and(|ext| ext == "json") {
                openclaw_config::load_json(&candidate)?
            } else {
                openclaw_config::load(&candidate)?
            };
            return Ok((cfg, Some(candidate)));
        }
    }

    Ok((Config::default(), None))
}

fn run_gateway_install(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let mut config_path_arg: Option<String> = None;
    let mut user = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--config" => {
                config_path_arg = args.get(i + 1).cloned();
                i += 2;
            }
            "--user" => {
                user = true;
                i += 1;
            }
            _ => i += 1,
        }
    }

    let (config, resolved) = resolve_config(config_path_arg.as_deref())?;
    let config_path = resolved.ok_or(
        "no configuration file found; run `openclaw onboard` first so the service has a config",
    )?;
    let binary = service::current_binary()?;

    match service::install(&binary, &config, &config_path, user) {
        Ok(installed) => {
            println!("Installed {} service: {}", installed.manager, installed.path.display());
            // Official `gateway install` enables and starts the service. A failed
            // activation is an install failure, not a printed suggestion.
            match service::activate(&installed) {
                Ok(()) => {
                    println!("Service is enabled and running.");
                    Ok(())
                }
                Err(error) => {
                    eprintln!("gateway install wrote the definition but activation failed: {error}");
                    eprintln!("Fix the service manager, then run: {}", installed.activation);
                    std::process::exit(1);
                }
            }
        }
        Err(error) => {
            eprintln!("gateway install failed: {error}");
            Err(error.into())
        }
    }
}

fn run_gateway_uninstall(_args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let mut removed = Vec::new();
    let mut candidates = vec![
        PathBuf::from("/etc/systemd/system/openclaw-gateway.service"),
        PathBuf::from("/etc/systemd/system/openclaw-gateway.service.d"),
        PathBuf::from("/etc/systemd/system/clawdbot-gateway.service"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(
            Path::new(&home)
                .join(".config/systemd/user/openclaw-gateway.service"),
        );
        candidates.push(
            Path::new(&home)
                .join("Library/LaunchAgents/ai.openclaw.gateway.plist"),
        );
    }
    for candidate in candidates {
        if candidate.exists() {
            std::fs::remove_file(&candidate)
                .map_err(|error| format!("failed to remove {}: {error}", candidate.display()))?;
            removed.push(candidate);
        }
    }
    if removed.is_empty() {
        println!("No OpenClaw service definition was installed.");
    } else {
        for path in removed {
            println!("Removed {}", path.display());
        }
        println!("Reload the service manager to finish removal.");
    }
    Ok(())
}

/// Gateway service status, with the machine-readable contract installers parse.
struct StatusOptions {
    json: bool,
    no_probe: bool,
    port: Option<u16>,
    token: Option<String>,
    password: Option<String>,
}

fn parse_status_args(args: &[String]) -> Result<StatusOptions, String> {
    let mut options = StatusOptions {
        json: false,
        no_probe: false,
        port: None,
        token: None,
        password: None,
    };
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => {
                options.json = true;
                index += 1;
            }
            "--no-probe" => {
                options.no_probe = true;
                index += 1;
            }
            "--deep" | "--require-rpc" => {
                // Accepted; the probe already reports reachability explicitly.
                index += 1;
            }
            "--port" => {
                let raw = args.get(index + 1).ok_or("--port needs a value")?;
                options.port = Some(
                    raw.parse::<u16>()
                        .map_err(|_| format!("invalid --port value: {raw}"))?,
                );
                index += 2;
            }
            "--token" => {
                options.token = args.get(index + 1).cloned();
                index += 2;
            }
            "--password" => {
                options.password = args.get(index + 1).cloned();
                index += 2;
            }
            "--url" => {
                // Accepted for compatibility; this build probes the local listener.
                index += 2;
            }
            "--timeout" => {
                index += 2;
            }
            other => return Err(format!("unknown gateway status option: {other}")),
        }
    }
    Ok(options)
}

/// True when a service definition exists for this host.
fn service_loaded() -> bool {
    let mut candidates = vec![
        PathBuf::from("/etc/systemd/system/openclaw-gateway.service"),
        PathBuf::from("/etc/systemd/system/clawdbot-gateway.service"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(
            Path::new(&home).join(".config/systemd/user/openclaw-gateway.service"),
        );
        candidates.push(
            Path::new(&home).join("Library/LaunchAgents/ai.openclaw.gateway.plist"),
        );
    }
    candidates.iter().any(|path| path.is_file())
}

async fn run_gateway_status(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let options = match parse_status_args(args) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };

    let (config, _) = resolve_config(None)?;
    // Precedence: explicit flag, then configured secret.
    let token = options
        .token
        .clone()
        .or_else(|| Config::resolve_secret(&config.gateway.auth_token))
        .or_else(|| Config::resolve_env("OPENCLAW_GATEWAY_TOKEN"));
    let password = options
        .password
        .clone()
        .or_else(|| Config::resolve_secret(&config.gateway.auth_password))
        .or_else(|| Config::resolve_env("OPENCLAW_GATEWAY_PASSWORD"));

    let port = options.port.unwrap_or_else(|| {
        config
            .gateway
            .listen
            .rsplit_once(':')
            .and_then(|(_, port)| port.parse().ok())
            .unwrap_or(18789)
    });

    let loaded = service_loaded();
    let mut reachable = false;
    let mut probed = false;
    let mut unauthorized = false;

    if !options.no_probe {
        probed = true;
        // Probe the Gateway's own Control UI/HTTP port for liveness, then confirm
        // the credential is accepted so `reachable` means "usable", not "a socket
        // accepted the connection".
        let url = format!("http://127.0.0.1:{port}/api/status");
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()?;
        let mut request = client.get(&url);
        if let Some(token) = &token {
            request = request.bearer_auth(token);
        } else if let Some(password) = &password {
            request = request.bearer_auth(password);
        }
        match request.send().await {
            Ok(response) if response.status().is_success() => reachable = true,
            Ok(response) if response.status() == reqwest::StatusCode::UNAUTHORIZED => {
                unauthorized = true;
            }
            _ => {}
        }
    }

    let ok = reachable || (options.no_probe && loaded);
    if options.json {
        println!(
            "{}",
            serde_json::json!({
                "ok": ok,
                "service": { "loaded": loaded, "manager": if loaded { "systemd-or-launchd" } else { "none" } },
                "gateway": {
                    "reachable": reachable,
                    "probed": probed,
                    "unauthorized": unauthorized,
                    "port": port,
                },
            })
        );
    } else {
        println!(
            "Gateway Status : {}",
            if reachable {
                "ONLINE"
            } else if unauthorized {
                "UNAUTHORIZED"
            } else if options.no_probe {
                "UNKNOWN (probe skipped)"
            } else {
                "OFFLINE (start with `openclaw gateway`)"
            }
        );
        println!("Service loaded : {}", if loaded { "yes" } else { "no" });
        println!("Port           : {port}");
    }

    // Non-zero when the status could not be established, so scripts can branch.
    if reachable || (options.no_probe && loaded) {
        Ok(())
    } else {
        std::process::exit(1);
    }
}

async fn run_onboard(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    // Upstream contract: OPENCLAW_CONFIG_PATH wins, else
    // $OPENCLAW_STATE_DIR/openclaw.json (OPENCLAW_HOME/HOME fallback).
    let env = openclaw_config::paths::process_env();
    let config_file = openclaw_config::paths::config_path(&env)
        .ok_or("cannot determine a config path: set HOME, OPENCLAW_STATE_DIR, or OPENCLAW_CONFIG_PATH")?;
    let dir = config_file
        .parent()
        .map(Path::to_path_buf)
        .ok_or("config path has no parent directory")?;
    std::fs::create_dir_all(&dir)?;

    if !config_file.exists() {
        // Generate the gateway credential during onboarding: upstream generates a
        // token by default, and a fresh install must never start unauthenticated.
        let token = uuid::Uuid::new_v4().to_string();
        let sample = serde_json::json!({
            "gateway": {
                // `mode: local` is the documented marker that this host owns a
                // local Gateway; its absence is how damaged config is detected.
                "mode": "local",
                "listen": "127.0.0.1:18789",
                "requireAuth": true,
                "auth": { "mode": "token", "token": token },
                "controlUiEnabled": true
            },
            "database": {
                "engine": "sqlite",
                "path": dir.join("openclaw.db").to_string_lossy()
            },
            "providers": {
                "anthropic": {
                    "type": "anthropic",
                    "apiKey": "$ANTHROPIC_API_KEY",
                    "model": "claude-sonnet-4-20250514"
                },
                "openai": {
                    "type": "openai",
                    "apiKey": "$OPENAI_API_KEY",
                    "model": "gpt-4o"
                }
            },
            "agents": {
                "default": {
                    "systemPrompt": "You are OpenClaw, a helpful self-hosted AI assistant.",
                    "provider": "anthropic",
                    "maxTokens": 4096
                }
            },
            "channels": {
                "telegram": {
                    "enabled": true,
                    "botToken": "$TELEGRAM_BOT_TOKEN",
                    "dmPolicy": "pairing",
                    "allowFrom": [],
                    "requireMention": true
                }
            }
        });
        std::fs::write(&config_file, serde_json::to_string_pretty(&sample)?)?;
        println!("==> Created {}", config_file.display());
        println!("==> Gateway token generated. Set OPENCLAW_GATEWAY_TOKEN or use the token in that file.");
    } else {
        println!("==> Config already exists at {}", config_file.display());
    }

    // Official flags: `--install-daemon` installs the managed service, and
    // `--no-install-daemon`/`--skip-daemon` are the explicit skip. Unknown flags
    // are rejected rather than silently ignored.
    let install_daemon = args.iter().any(|a| a == "--install-daemon");
    for arg in args {
        match arg.as_str() {
            "--install-daemon" | "--no-install-daemon" | "--skip-daemon" | "--config" => {}
            other if other.starts_with("--") => {
                eprintln!("unknown onboarding flag: {other}");
                eprintln!("supported: --install-daemon, --no-install-daemon, --config <path>");
                std::process::exit(2);
            }
            _ => {}
        }
    }

    if install_daemon {
        let binary = service::current_binary()?;
        // Load what was just written so preflight validates the real file.
        let config = openclaw_config::load_json(&config_file)?;
        match service::install(&binary, &config, &config_file, false) {
            Ok(installed) => {
                println!("==> Installed {} service: {}", installed.manager, installed.path.display());
                println!("    Activate it with: {}", installed.activation);
            }
            Err(error) => {
                eprintln!("==> Gateway service install failed: {error}");
                eprintln!("    Config was written; install the service later with `openclaw gateway install`.");
                std::process::exit(1);
            }
        }
    }
    println!("==> Onboarding ready. Start with: openclaw gateway");
    Ok(())
}

fn run_skills(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let reg = SkillRegistry::discover_default();
    let sub = args.first().map(String::as_str).unwrap_or("list");
    match sub {
        "list" => {
            println!("Loaded {} OpenClaw skills:", reg.len());
            println!("{:<26} {:<12} {}", "SKILL", "SOURCE", "DESCRIPTION");
            for s in reg.list() {
                let desc: String = s.description.chars().take(68).collect();
                println!("{:<26} {:<12} {}", s.name, s.source, desc);
            }
        }
        "info" | "show" => {
            let name = args.get(1).ok_or("usage: openclaw skills info <name>")?;
            match reg.get(name) {
                Some(s) => {
                    println!("Name        : {} {}", s.emoji.as_deref().unwrap_or("🔧"), s.name);
                    println!("Source      : {} ({})", s.source, s.file_path);
                    println!("Description : {}\n", s.description);
                    println!("{}", s.instructions);
                }
                None => {
                    eprintln!("skill not found: {name}");
                    std::process::exit(1);
                }
            }
        }
        other => {
            eprintln!("unknown skills subcommand: {other} (expected `list` or `info`)");
            std::process::exit(1);
        }
    }
    Ok(())
}

fn run_memory(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let (config, _) = resolve_config(None)?;
    let store = SqliteStateStore::open(&config.database.path)?;
    let sub = args.first().map(String::as_str).unwrap_or("list");
    match sub {
        "list" => {
            let mems = store.list_memories()?;
            if mems.is_empty() {
                println!("No memories stored yet.");
            } else {
                for m in mems {
                    println!("[#{}] {} — {} ({})", m.id, m.key, m.content, m.created_at);
                }
            }
        }
        "add" => {
            let key = args.get(1).ok_or("usage: openclaw memory add <key> <content>")?;
            let content = args[2..].join(" ");
            let rec = store.add_memory(key, &content)?;
            println!("Saved memory #{}: {} = {}", rec.id, rec.key, rec.content);
        }
        _ => {}
    }
    Ok(())
}

fn run_cron(_args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let (config, _) = resolve_config(None)?;
    let store = SqliteStateStore::open(&config.database.path)?;
    let jobs = store.list_cron_jobs()?;
    if jobs.is_empty() {
        println!("No cron jobs configured.");
    } else {
        for j in jobs {
            println!("{} ({}s, enabled={}): {}", j.name, j.interval_secs, j.enabled, j.prompt);
        }
    }
    Ok(())
}

async fn run_doctor(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let mut cfg_path: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--config" {
            cfg_path = args.get(i + 1).cloned();
            i += 2;
        } else {
            i += 1;
        }
    }
    let (config, path) = resolve_config(cfg_path.as_deref())?;
    println!("=== OpenClaw Doctor ===");
    let mut problems = config.validate();
    if problems.is_empty() {
        println!("[1/5] Config file : {} (valid)", path.as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "built-in defaults".to_owned()));
    } else {
        println!("[1/5] Config file : {}", path.as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "built-in defaults".to_owned()));
        for problem in &problems {
            println!("      WARN        : {problem}");
        }
    }

    match SqliteStateStore::open(&config.database.path) {
        Ok(store) => {
            let count = store.list_pairings().map(|v| v.len()).unwrap_or(0);
            println!(
                "[2/5] SQLite DB   : OK ({}, {} pending pairings)",
                config.database.path, count
            );
        }
        Err(e) => {
            println!("[2/5] SQLite DB   : ERROR ({e})");
            problems.push(format!("database: {e}"));
        }
    }

    println!("[3/5] Skills      : {} loaded (bundled + custodian + workspace)", SkillRegistry::discover_default().len());

    println!("[4/5] Providers   : {} configured", config.providers.len());
    for (id, p) in &config.providers {
        let has_key = Config::resolve_secret(&p.api_key).is_some();
        println!(
            "      - {id} ({}) : api_key={}",
            p.provider_type,
            if has_key { "present" } else { "missing" }
        );
    }

    let tg_token = config
        .channels
        .iter()
        .find(|(k, _)| k.starts_with("telegram"))
        .and_then(|(_, c)| c.resolved_token())
        .or_else(|| std::env::var("TELEGRAM_BOT_TOKEN").ok().filter(|s| !s.is_empty()));

    if let Some(token) = tg_token {
        let tg = TelegramChannel::new(token);
        match tg.get_me().await {
            Ok(me) => println!(
                "[5/5] Telegram    : OK (@{} / id={})",
                me.username.unwrap_or_else(|| me.first_name),
                me.id
            ),
            Err(e) => {
                println!("[5/5] Telegram    : ERROR ({e})");
                problems.push(format!("telegram: {e}"));
            }
        }
    } else {
        println!("[5/5] Telegram    : SKIPPED (no token configured)");
    }

    // Doctor is a gate for installers and upgrades: a reported problem must be a
    // non-zero exit, otherwise repair failure looks like success.
    if problems.is_empty() {
        Ok(())
    } else {
        eprintln!();
        eprintln!("doctor found {} problem(s):", problems.len());
        for problem in &problems {
            eprintln!("  - {problem}");
        }
        std::process::exit(1);
    }
}

async fn run_gateway(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let mut config_path: Option<String> = None;
    let mut listen_override: Option<String> = None;
    let mut port_override: Option<u16> = None;
    let mut bind_override: Option<String> = None;
    let mut token_override: Option<String> = None;
    let mut password_override: Option<String> = None;
    let mut dashboard_addr = "127.0.0.1:18790".to_owned();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--config" => {
                config_path = args.get(i + 1).cloned();
                i += 2;
            }
            "--listen" => {
                listen_override = args.get(i + 1).cloned();
                i += 2;
            }
            "--port" => {
                let raw = args.get(i + 1).ok_or("--port needs a value")?;
                port_override = Some(
                    raw.parse::<u16>()
                        .map_err(|_| format!("invalid --port value: {raw}"))?,
                );
                i += 2;
            }
            "--bind" => {
                bind_override = args.get(i + 1).cloned();
                i += 2;
            }
            "--token" => {
                token_override = args.get(i + 1).cloned();
                i += 2;
            }
            "--password" => {
                password_override = args.get(i + 1).cloned();
                i += 2;
            }
            "--dashboard" => {
                if let Some(addr) = args.get(i + 1) {
                    dashboard_addr = addr.clone();
                }
                i += 2;
            }
            // Accepted no-ops that change only logging/verbosity.
            "--verbose" | "--dev" => i += 1,
            // `--force` would need a stale-listener kill path; refuse rather than
            // pretend it worked.
            "--force" | "--reset" => {
                return Err(format!("`{}` is not implemented yet", args[i]).into());
            }
            other => {
                // Unknown flags are errors: silently skipping them made `--port`
                // and `--token` look honored while the defaults were used.
                return Err(format!(
                    "unknown gateway option: {other}\n\
                     supported: --config, --listen, --port, --bind, --token, --password, --dashboard"
                )
                .into());
            }
        }
    }

    let (mut config, _) = resolve_config(config_path.as_deref())?;

    // --bind/--port and --listen address the same field; the more specific wins.
    if let Some(bind) = bind_override {
        let port = port_override.unwrap_or_else(|| {
            config
                .gateway
                .listen
                .rsplit_once(':')
                .and_then(|(_, port)| port.parse().ok())
                .unwrap_or(18789)
        });
        config.gateway.listen = format!("{bind}:{port}");
    } else if let Some(port) = port_override {
        let host = config
            .gateway
            .listen
            .rsplit_once(':')
            .map_or("127.0.0.1", |(host, _)| host)
            .to_owned();
        config.gateway.listen = format!("{host}:{port}");
    }
    if let Some(listen) = listen_override {
        config.gateway.listen = listen;
    }
    if let Some(token) = token_override {
        config.gateway.auth_token = Some(token);
        config.gateway.auth_mode = "token".to_owned();
        config.gateway.require_auth = true;
    }
    if let Some(password) = password_override {
        config.gateway.auth_password = Some(password);
        config.gateway.auth_mode = "password".to_owned();
        config.gateway.require_auth = true;
    }

    let problems = config.validate();
    if !problems.is_empty() {
        for problem in &problems {
            eprintln!("config error: {problem}");
        }
        std::process::exit(1);
    }

    let level = match config.logging.level.as_str() {
        "trace" => Level::TRACE,
        "debug" => Level::DEBUG,
        "warn" => Level::WARN,
        "error" => Level::ERROR,
        _ => Level::INFO,
    };
    tracing_subscriber::fmt()
        .with_max_level(level)
        .with_target(false)
        .init();

    let state = Arc::new(SqliteStateStore::open(&config.database.path)?);

    let mut providers = ProviderRegistry::new();
    for (id, provider_config) in &config.providers {
        let api_key = match Config::resolve_secret(&provider_config.api_key) {
            Some(k) => k,
            None if provider_config.provider_type == "ollama" => String::new(),
            None => continue,
        };
        let model = provider_config.model.clone().unwrap_or_default();
        let provider: Arc<dyn openclaw_core::traits::ModelProvider> =
            match provider_config.provider_type.as_str() {
                "anthropic" => anthropic_provider(api_key, model),
                "openai" => openai_provider(api_key, model),
                "ollama" => ollama_provider(
                    provider_config
                        .base_url
                        .clone()
                        .unwrap_or_else(|| "http://localhost:11434".to_owned()),
                    model,
                ),
                other => {
                    // Every remaining upstream provider extension speaks the
                    // OpenAI Chat Completions wire format.
                    let known = known_compatible(other);
                    let base_url = provider_config
                        .base_url
                        .clone()
                        .or_else(|| known.map(|(url, _)| url.to_owned()));
                    let Some(base_url) = base_url else {
                        info!(provider = %id, kind = %other, "skipping provider without a baseUrl");
                        continue;
                    };
                    let model = if model.is_empty() {
                        known.map(|(_, m)| m.to_owned()).unwrap_or_default()
                    } else {
                        model
                    };
                    compatible_provider(id.clone(), base_url, api_key, model)
                }
            };
        providers.register(provider);
    }
    // Env var auto-detection if config had no providers with valid keys
    if providers.list().is_empty() {
        if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
            if !key.is_empty() {
                providers.register(anthropic_provider(key, "claude-sonnet-4-20250514"));
            }
        }
        if let Ok(key) = std::env::var("OPENAI_API_KEY") {
            if !key.is_empty() {
                providers.register(openai_provider(key, "gpt-4o"));
            }
        }
    }
    let providers = Arc::new(providers);

    let gateway = Gateway::new(config.gateway.clone()).with_transcripts({
        // `sessions.get` serves committed transcript rows, not an empty array.
        struct StoreTranscripts(Arc<SqliteStateStore>);
        impl openclaw_gateway::TranscriptReader for StoreTranscripts {
            fn recent_messages(&self, session_id: &str, limit: usize) -> Vec<serde_json::Value> {
                self.0.transcript_messages(session_id, limit)
            }
        }
        Arc::new(StoreTranscripts(Arc::clone(&state)))
    });
    let registry = Arc::clone(gateway.registry());
    let skills = Arc::new(SkillRegistry::discover_default());

    // Restart recovery: the Gateway owns its session state, so hydrate the roster
    // from the durable store before serving. Without this, every restart emptied
    // `sessions.list` even though the rows were committed.
    match state.load_sessions() {
        Ok(rows) if !rows.is_empty() => {
            let count = registry.import_rows(rows);
            info!(sessions = count, "restored sessions from durable store");
        }
        Ok(_) => {}
        Err(error) => warn!(%error, "could not restore sessions"),
    }

    // Init & spawn channels
    let mut channels = ChannelRegistry::new();
    for (key, account) in &config.channels {
        if !account.enabled {
            continue;
        }
        let channel_name = key.split(':').next().unwrap_or(key);
        // Official pairing is keyed by channel AND account; `telegram:work` must
        // not share approvals with `telegram:personal`.
        let account_id = key.split_once(':').map_or("default", |(_, account)| account);
        let channel: Arc<dyn openclaw_core::traits::Channel> = match channel_name {
            "telegram" => {
                let Some(token) = account.resolved_token() else {
                    warn!(channel = "telegram", "missing botToken");
                    continue;
                };
                build_telegram_channel(
                    token,
                    account_id.to_owned(),
                    account.dm_policy.clone(),
                    account.allow_from.clone(),
                    account.require_mention,
                    account.api_root.clone(),
                    Arc::clone(&state),
                    Arc::clone(&providers),
                    Arc::clone(&skills),
                    Arc::clone(&registry),
                )
            }
            "discord" => {
                let Some(token) = account.resolved_token() else {
                    warn!(channel = "discord", "missing botToken");
                    continue;
                };
                Arc::new(DiscordChannel::new(token))
            }
            "slack" => {
                let Some(url) = account.options.get("webhookUrl").and_then(|v| v.as_str()) else {
                    warn!(channel = "slack", "missing options.webhookUrl");
                    continue;
                };
                Arc::new(openclaw_channels::HttpChannel::slack(url.to_owned()))
            }
            "mattermost" => {
                let Some(url) = account.options.get("webhookUrl").and_then(|v| v.as_str()) else {
                    warn!(channel = "mattermost", "missing options.webhookUrl");
                    continue;
                };
                Arc::new(openclaw_channels::HttpChannel::mattermost(url.to_owned()))
            }
            "googlechat" => {
                let Some(url) = account.options.get("webhookUrl").and_then(|v| v.as_str()) else {
                    warn!(channel = "googlechat", "missing options.webhookUrl");
                    continue;
                };
                Arc::new(openclaw_channels::HttpChannel::google_chat(url.to_owned()))
            }
            "msteams" => {
                let Some(url) = account.options.get("webhookUrl").and_then(|v| v.as_str()) else {
                    warn!(channel = "msteams", "missing options.webhookUrl");
                    continue;
                };
                Arc::new(openclaw_channels::HttpChannel::msteams(url.to_owned()))
            }
            "feishu" => {
                let Some(url) = account.options.get("webhookUrl").and_then(|v| v.as_str()) else {
                    warn!(channel = "feishu", "missing options.webhookUrl");
                    continue;
                };
                Arc::new(openclaw_channels::HttpChannel::feishu(url.to_owned()))
            }
            other => {
                let support = openclaw_channels::channel_spec(other)
                    .map(|spec| spec.support);
                match support {
                    Some(openclaw_channels::ChannelSupport::PluginOnly) => warn!(
                        channel = %channel_name,
                        "channel requires the upstream plugin; not available in this build"
                    ),
                    _ => info!(channel = %channel_name, "skipping unknown channel"),
                }
                continue;
            }
        };
        let ch_clone = Arc::clone(&channel);
        tokio::spawn(async move {
            if let Err(error) = ch_clone.start().await {
                warn!(%error, "channel stopped with error");
            }
        });
        channels.register(channel);
    }

    // Env var fallback for quick Telegram setup: TELEGRAM_BOT_TOKEN
    if channels.get("telegram").is_none() {
        if let Ok(token) = std::env::var("TELEGRAM_BOT_TOKEN") {
            if !token.is_empty() {
                let dm_policy = std::env::var("OPENCLAW_TELEGRAM_DM_POLICY")
                    .unwrap_or_else(|_| "pairing".to_owned());
                let tg = build_telegram_channel(
                    token,
                    "default".to_owned(),
                    dm_policy,
                    Vec::new(),
                    true,
                    None,
                    Arc::clone(&state),
                    Arc::clone(&providers),
                    Arc::clone(&skills),
                    Arc::clone(&registry),
                );
                let tg_run = Arc::clone(&tg);
                tokio::spawn(async move {
                    let _ = tg_run.start().await;
                });
                channels.register(tg);
            }
        }
    }

    let channel_names: Vec<String> = channels.list().into_iter().map(str::to_owned).collect();

    // Spawn Web Control UI + WebChat + Pairing API
    if config.gateway.control_ui_enabled {
        let dash_registry = Arc::clone(&registry);
        let dash_state = Arc::clone(&state);
        let dash_providers = Arc::clone(&providers);
        let dash_skills = Arc::clone(&skills);
        let dash_addr = dashboard_addr.clone();
        let dash_channels = channel_names.clone();
        // The Control UI enforces the same credential as the Gateway, so a
        // single policy governs every ingress instead of the UI being open.
        let dash_auth = config.gateway.resolved_auth()?;
        tokio::spawn(async move {
            let server = DashboardServer::new(
                dash_addr,
                dash_registry,
                dash_state,
                dash_providers,
                dash_skills,
                dash_channels,
            )
            .with_auth(dash_auth);
            if let Err(error) = server.run().await {
                warn!(%error, "control-ui server stopped");
            }
        });
    }

    info!(
        gateway = %config.gateway.listen,
        control_ui = %dashboard_addr,
        skills = skills.len(),
        providers = ?providers.list(),
        channels = ?channels.list(),
        "openclaw starting"
    );

    let handle = gateway.run().await?;
    info!("openclaw ready — press Ctrl+C to stop");

    tokio::signal::ctrl_c().await?;
    handle.shutdown();
    info!("openclaw stopped");

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn build_telegram_channel(
    token: String,
    account_id: String,
    dm_policy: String,
    allow_from: Vec<String>,
    require_mention: bool,
    api_root: Option<String>,
    state: Arc<SqliteStateStore>,
    providers: Arc<ProviderRegistry>,
    skills: Arc<SkillRegistry>,
    registry: Arc<openclaw_gateway::SessionRegistry>,
) -> Arc<dyn openclaw_core::traits::Channel> {
    let handler: openclaw_channels::telegram::InboundHandler =
        Arc::new(move |ctx: TelegramInboundContext| {
            let state = Arc::clone(&state);
            let providers = Arc::clone(&providers);
            let skills = Arc::clone(&skills);
            let registry = Arc::clone(&registry);
            let account_id = account_id.clone();
            let dm_policy = dm_policy.clone();
            let allow_from = allow_from.clone();
            Box::pin(async move {
                let inbound = &ctx.message;
                let text = match &inbound.content {
                    MessageContent::Text { text } | MessageContent::Markdown { text } => {
                        text.trim().to_owned()
                    }
                    _ => return None,
                };

                // 1. Handle `/id` before pairing check so users can find their Telegram ID
                if text == "/id" || text.starts_with("/id@") {
                    return Some(format!(
                        "👤 Telegram User ID: {}\n💬 Chat ID: {}\n🧵 Thread ID: {:?}",
                        ctx.sender_id, ctx.chat_id, ctx.message_thread_id
                    ));
                }

                // 2. DM Access Control & Pairing (docs/channels/pairing.md).
                //
                // `disabled` must stay silent (it previously fell into the pairing
                // branch and sent codes), and `open` is public only when the
                // effective allowlist contains `*` — otherwise concrete entries
                // still restrict admission.
                if ctx.chat_type == "private" {
                    let sender_id_str = ctx.sender_id.to_string();
                    let in_allowlist = allow_from.iter().any(|entry| {
                        entry == "*"
                            || entry == &sender_id_str
                            || ctx
                                .sender_username
                                .as_ref()
                                .is_some_and(|u| entry.trim_start_matches('@').eq_ignore_ascii_case(u))
                    });
                    let wildcard = allow_from.iter().any(|entry| entry == "*");
                    let policy_blocks = match dm_policy.as_str() {
                        "disabled" => true,
                        "open" => !wildcard && !in_allowlist,
                        "allowlist" => !in_allowlist,
                        _ => true, // "pairing" and unknown values require approval
                    };
                    if dm_policy == "disabled" {
                        return None;
                    }

                    let is_paired = state
                        .is_sender_approved_in("telegram", &account_id, &sender_id_str)
                        .unwrap_or(false);

                    if policy_blocks && !is_paired {
                        if dm_policy == "allowlist" || dm_policy == "open" {
                            return Some("⛔ You are not in the allowFrom list for this bot.".to_owned());
                        }
                        match state.get_or_create_pairing_in(
                            "telegram",
                            &account_id,
                            &sender_id_str,
                            &ctx.sender_first_name,
                            &ctx.chat_id.to_string(),
                        ) {
                            // Official behaviour: the pairing notice is sent only
                            // when a new request is created, not on every message.
                            Ok(req) if req.created => {
                                return Some(format!(
                                    "🦞 OpenClaw Pairing Required\n\nYour pairing code is: {}\n\nApprove on your server with:\n  openclaw pairing approve telegram {}\nOr click Approve in the Web Control UI.",
                                    req.code, req.code
                                ));
                            }
                            Ok(_) => {
                                // A live request already exists and was already
                                // announced; stay silent so the sender is not spammed.
                                return None;
                            }
                            // Official behaviour at the pending cap: ignore the
                            // request instead of replying on every message.
                            Err(_) => return None,
                        }
                    }
                }

                // 3. Handle built-in Telegram slash commands & skill commands
                let cmd = text.split_whitespace().next().unwrap_or_default();
                let base_cmd = cmd.split('@').next().unwrap_or(cmd);
                let arg_tail = text.strip_prefix(cmd).unwrap_or_default().trim();
                match base_cmd {
                    "/start" => {
                        return Some(
                            "🦞 Welcome to OpenClaw! Send any message to chat, or use /skills, /weather <city>, /remember <note>, /new, /status, /id, /help."
                                .to_owned(),
                        );
                    }
                    "/help" => {
                        return Some(
                            "🦞 OpenClaw Commands:\n/skills — List loaded skills\n/weather <city> — Run weather skill (wttr.in)\n/remember <note> — Save to long-term memory\n/memories — List saved memories\n/new or /reset — Clear conversation history\n/status — Show session & model status\n/id — Show your Telegram user & chat ID"
                                .to_owned(),
                        );
                    }
                    "/skills" => {
                        let list: Vec<String> = skills
                            .list()
                            .into_iter()
                            .take(30)
                            .map(|s| format!("{} {} ({})", s.emoji.as_deref().unwrap_or("🔧"), s.name, s.source))
                            .collect();
                        return Some(format!(
                            "🦞 OpenClaw Skills ({} total):\n{}",
                            skills.len(),
                            list.join("\n")
                        ));
                    }
                    "/weather" => {
                        let loc = if arg_tail.is_empty() { "Jakarta" } else { arg_tail };
                        return Some(
                            openclaw_skills::fetch_weather(loc)
                                .await
                                .unwrap_or_else(|e| format!("⚠️ Weather error: {e}")),
                        );
                    }
                    "/remember" => {
                        if arg_tail.is_empty() {
                            return Some("Usage: /remember <fact to store>".to_owned());
                        }
                        let _ = state.add_memory("telegram", arg_tail);
                        return Some(format!("🧠 Saved to memory: {arg_tail}"));
                    }
                    "/memories" => {
                        let mems = state.list_memories().unwrap_or_default();
                        if mems.is_empty() {
                            return Some("No memories saved yet. Use `/remember <fact>`.".to_owned());
                        }
                        let lines: Vec<String> = mems
                            .iter()
                            .take(20)
                            .map(|m| format!("• [{}] {}", m.key, m.content))
                            .collect();
                        return Some(format!("🧠 Stored Memories:\n{}", lines.join("\n")));
                    }
                    "/new" | "/reset" => {
                        let _ = state.clear_session_history(&inbound.session);
                        registry.remove(&inbound.session);
                        return Some("✨ Session history cleared. Starting a fresh conversation!".to_owned());
                    }
                    "/status" => {
                        let turns = registry
                            .get(&inbound.session)
                            .map(|s| s.turn_count)
                            .unwrap_or(0);
                        let provs = providers.list().join(", ");
                        return Some(format!(
                            "🦞 OpenClaw Status\nSession: {}\nTurns: {}\nSkills: {}\nProviders: {}",
                            inbound.session,
                            turns,
                            skills.len(),
                            if provs.is_empty() { "none" } else { &provs }
                        ));
                    }
                    _ => {}
                }

                // 4. Persist inbound message & update SessionRegistry
                let _ = state.save_inbound(inbound).await;
                if registry.get(&inbound.session).is_none() {
                    let mut s = registry.create(
                        if ctx.chat_type == "private" {
                            SessionKind::Direct
                        } else {
                            SessionKind::Group
                        },
                        inbound.channel.clone(),
                        AgentId::from_raw("default"),
                        vec![inbound.author.clone()],
                    );
                    s.id = inbound.session.clone();
                    registry.upsert(s);
                }
                if let Some(mut s) = registry.get(&inbound.session) {
                    s.turn_count += 1;
                    s.updated_at = chrono::Utc::now();
                    registry.upsert(s);
                }

                // 5. Load multi-turn conversation history from SQLite
                let history_turns = state
                    .load_conversation_turns(&inbound.session, 20)
                    .unwrap_or_default();
                let mut messages: Vec<CompletionMessage> = history_turns
                    .into_iter()
                    .map(|(role, content, _)| CompletionMessage {
                        role: if role == "assistant" {
                            CompletionRole::Assistant
                        } else {
                            CompletionRole::User
                        },
                        content,
                    })
                    .collect();
                if messages.is_empty() {
                    messages.push(CompletionMessage {
                        role: CompletionRole::User,
                        content: text.clone(),
                    });
                }

                // 6. Complete via configured ModelProvider with skills & long-term memories injected
                if let Some(provider_name) = providers.list().first() {
                    if let Some(provider) = providers.get(provider_name) {
                        let mut sys_prompt =
                            String::from("You are OpenClaw, a helpful self-hosted AI assistant.");
                        sys_prompt.push_str(&skills.build_prompt_augmentation(&text));
                        if let Ok(mems) = state.list_memories() {
                            if !mems.is_empty() {
                                sys_prompt.push_str("\n<long_term_memories>\n");
                                for m in mems.iter().take(20) {
                                    sys_prompt.push_str(&format!("- {}: {}\n", m.key, m.content));
                                }
                                sys_prompt.push_str("</long_term_memories>\n");
                            }
                        }

                        let req = CompletionRequest {
                            session: inbound.session.clone(),
                            system_prompt: sys_prompt,
                            messages,
                            max_tokens: Some(2048),
                            temperature: None,
                        };
                        match provider.complete(req).await {
                            Ok(reply) => {
                                let _ = state.save_reply(&inbound.session, &reply).await;
                                return reply.text;
                            }
                            Err(error) => {
                                warn!(%error, "provider completion failed");
                                return Some(format!("⚠️ Provider error: {error}"));
                            }
                        }
                    }
                }

                let fallback = openclaw_core::message::ReplyPayload {
                    text: Some(format!("OpenClaw received ({} skills active): {text}", skills.len())),
                    ..Default::default()
                };
                let _ = state.save_reply(&inbound.session, &fallback).await;
                fallback.text
            })
        });

    Arc::new(
        TelegramChannel::new(token)
            .with_api_root(api_root)
            .with_require_mention(require_mention)
            .with_handler(handler),
    )
}
