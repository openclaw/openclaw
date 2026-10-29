//! `openclaw dashboard` — resolve and report the Control UI endpoint.
//!
//! Official reference: `docs/cli/dashboard.md`. `--json` emits one object and never
//! opens a browser; failures use `{"ok":false,"error","reason"}` and exit non-zero.
//!
//! This build cannot mint the documented one-time owner pairing handoff: that needs
//! a device-identity exchange over the Gateway WS protocol, which does not exist
//! yet. Rather than reporting `ok: true` with a null expiry (which tells an
//! integration a browser session was provisioned), the command reports the real
//! limitation and still prints the URL so an operator can authenticate manually.

use std::path::Path;

#[derive(Debug, Default)]
pub struct Options {
    pub json: bool,
    pub no_open: bool,
    pub yes: bool,
}

pub fn parse(args: &[String]) -> Result<Options, String> {
    let mut options = Options::default();
    for arg in args {
        match arg.as_str() {
            "--json" => options.json = true,
            "--no-open" => options.no_open = true,
            "--yes" | "-y" => options.yes = true,
            other => return Err(format!("unknown flag for `openclaw dashboard`: {other}")),
        }
    }
    Ok(options)
}

/// Port the Control UI listens on.
///
/// Resolved from `gateway.listen` when a config exists, falling back to the
/// documented default. Hardcoding it made any configured port report
/// `gateway_unreachable`.
fn control_ui_port() -> u16 {
    openclaw_config::paths::config_path(&openclaw_config::paths::process_env())
        .and_then(|path| openclaw_config::load_json(path).ok())
        .and_then(|config| {
            config
                .gateway
                .listen
                .rsplit_once(':')
                .and_then(|(_, port)| port.parse().ok())
        })
        .unwrap_or(18790)
}

fn reachable(port: u16) -> bool {
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

fn open_browser(url: &str) {
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

pub enum Outcome {
    /// Human-readable success line (URL printed, handoff unavailable).
    Opened(String),
    /// JSON object describing the endpoint plus the missing handoff.
    Json(String),
    /// Failure with a reason, printed to stderr, plus the JSON envelope if asked.
    Failed { message: String, reason: String, json: bool },
}

pub fn run(args: &[String]) -> Result<Outcome, String> {
    let options = parse(args)?;
    let port = control_ui_port();
    let http_url = format!("http://127.0.0.1:{port}/");

    if !reachable(port) {
        return Ok(Outcome::Failed {
            message: format!(
                "Control UI is not reachable at {http_url}. Start it with `openclaw gateway`."
            ),
            reason: "gateway_unreachable".to_owned(),
            json: options.json,
        });
    }

    // The handoff is genuinely unavailable, so the object says so instead of
    // advertising a bootstrap that cannot be exchanged.
    let object = serde_json::json!({
        "ok": false,
        "url": http_url,
        "browserUrl": http_url,
        "httpUrl": http_url,
        "port": port,
        "tokenIncluded": false,
        "browserBootstrapExpiresAtMs": serde_json::Value::Null,
        "reason": "pairing_handoff_unavailable",
        "error": {
            "type": "cli_error",
            "message": "this build cannot issue the one-time owner pairing handoff; \
                        open the URL and authenticate with the Gateway token",
        },
    });

    if options.json {
        return Ok(Outcome::Json(object.to_string()));
    }
    if !options.no_open {
        open_browser(&http_url);
    }
    Ok(Outcome::Opened(format!(
        "OpenClaw Control UI: {http_url}\n\
         No one-time pairing link is issued by this build; authenticate with the Gateway token."
    )))
}

/// True when a config file exists at the documented location.
#[allow(dead_code)]
pub fn config_exists() -> bool {
    openclaw_config::paths::config_path(&openclaw_config::paths::process_env())
        .is_some_and(|path| Path::new(&path).is_file())
}
