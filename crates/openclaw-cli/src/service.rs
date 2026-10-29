//! Gateway service installation (systemd / launchd).
//!
//! Upstream `openclaw gateway install` hands the Gateway to the platform service
//! manager so it survives logout and restarts. This module owns that contract for
//! the Rust build and refuses unsupported hosts instead of reporting success.

use openclaw_config::Config;
use std::path::{Path, PathBuf};

/// Where the service definition was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub path: PathBuf,
    pub manager: &'static str,
    /// Extra instruction the operator must run (for example `systemctl enable`).
    pub activation: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("this host has no supported service manager (need systemd or launchd); nothing was installed")]
    Unsupported,
    #[error("installing a system service needs root; re-run with sudo, or use `--user` for a user unit")]
    NeedsRoot,
    #[error("gateway authentication is not usable: {0}")]
    Auth(String),
    #[error("invalid configuration: {0}")]
    Config(String),
    #[error("failed to write {path}: {error}")]
    Write { path: String, error: String },
    #[error("could not run {command}: {error}")]
    Command { command: String, error: String },
}

/// Render the systemd unit. Kept pure so the generated contract is testable on
/// every platform, not only on the host that writes it.
#[must_use]
pub fn systemd_unit(binary: &Path, config_path: &Path, workdir: &Path, user: bool) -> String {
    let exec = format!(
        "{} gateway --config {}",
        binary.display(),
        config_path.display()
    );
    let (wanted_by, user_line) = if user {
        ("default.target", "")
    } else {
        ("multi-user.target", "")
    };
    format!(
        "[Unit]\n\
         Description=OpenClaw Gateway\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         {user_line}WorkingDirectory={workdir}\n\
         ExecStart={exec}\n\
         Restart=always\n\
         RestartSec=3\n\
         LimitNOFILE=65535\n\
         \n\
         [Install]\n\
         WantedBy={wanted_by}\n",
        workdir = workdir.display(),
        user_line = user_line,
        exec = exec,
        wanted_by = wanted_by,
    )
}

/// Render the launchd agent plist for the given label and arguments.
#[must_use]
pub fn launchd_plist(label: &str, program: &Path, args: &[String], log_dir: &Path) -> String {
    let mut arguments = String::new();
    arguments.push_str(&format!("    <string>{}</string>\n", xml_escape(&program.display().to_string())));
    for arg in args {
        arguments.push_str(&format!("    <string>{}</string>\n", xml_escape(arg)));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{arguments}  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{out}</string>
  <key>StandardErrorPath</key>
  <string>{err}</string>
</dict>
</plist>
"#,
        label = xml_escape(label),
        arguments = arguments,
        out = xml_escape(&log_dir.join("gateway.log").display().to_string()),
        err = xml_escape(&log_dir.join("gateway.err.log").display().to_string()),
    )
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Validate that this Gateway can be handed to a service manager.
///
/// Upstream blocks installation when the credential cannot be resolved, so a
/// service never starts in an unauthenticated or crash-looping state.
pub fn preflight(config: &Config) -> Result<(), ServiceError> {
    let problems = config.validate();
    if !problems.is_empty() {
        return Err(ServiceError::Config(problems.join("; ")));
    }
    config
        .gateway
        .resolved_auth()
        .map(|_| ())
        .map_err(|error| ServiceError::Auth(error.to_string()))
}

/// Install the Gateway service for the current host.
pub fn install(
    binary: &Path,
    config: &Config,
    config_path: &Path,
    user: bool,
) -> Result<Installed, ServiceError> {
    preflight(config)?;

    if cfg!(target_os = "linux") {
        return install_systemd(binary, config_path, user);
    }
    if cfg!(target_os = "macos") {
        return install_launchd(binary, config_path);
    }
    Err(ServiceError::Unsupported)
}

fn install_systemd(binary: &Path, config_path: &Path, user: bool) -> Result<Installed, ServiceError> {
    // A user unit needs no root; a system unit is the default for servers.
    let (dir, scope) = if user {
        let base = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .map(|home| Path::new(&home).join(".config"))
            })
            .ok_or(ServiceError::Unsupported)?;
        (base.join("systemd").join("user"), true)
    } else {
        if !is_root() {
            return Err(ServiceError::NeedsRoot);
        }
        (PathBuf::from("/etc/systemd/system"), false)
    };

    let workdir = config_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("/"));
    let unit = systemd_unit(binary, config_path, &workdir, scope);
    let path = dir.join("openclaw-gateway.service");
    std::fs::create_dir_all(&dir).map_err(|error| ServiceError::Write {
        path: dir.display().to_string(),
        error: error.to_string(),
    })?;
    std::fs::write(&path, unit).map_err(|error| ServiceError::Write {
        path: path.display().to_string(),
        error: error.to_string(),
    })?;

    let activation = if scope {
        "systemctl --user daemon-reload && systemctl --user enable --now openclaw-gateway.service".to_owned()
    } else {
        "systemctl daemon-reload && systemctl enable --now openclaw-gateway.service".to_owned()
    };
    Ok(Installed {
        path,
        manager: "systemd",
        activation,
    })
}

/// Run the activation command so `gateway install` actually starts the Gateway.
///
/// Official `gateway install` enables and starts the service; printing a command
/// and returning success leaves nothing running, which the installer then reports
/// as a working endpoint. Errors here are real install failures.
pub fn activate(installed: &Installed) -> Result<(), ServiceError> {
    #[cfg(target_os = "linux")]
    {
        let user = installed.activation.contains("--user");
        let mut commands: Vec<Vec<&str>> = Vec::new();
        if user {
            commands.push(vec!["--user", "daemon-reload"]);
            commands.push(vec!["--user", "enable", "--now", "openclaw-gateway.service"]);
        } else {
            commands.push(vec!["daemon-reload"]);
            commands.push(vec!["enable", "--now", "openclaw-gateway.service"]);
        }
        for args in commands {
            let output = std::process::Command::new("systemctl")
                .args(&args)
                .output()
                .map_err(|error| ServiceError::Command {
                    command: format!("systemctl {}", args.join(" ")),
                    error: error.to_string(),
                })?;
            if !output.status.success() {
                return Err(ServiceError::Command {
                    command: format!("systemctl {}", args.join(" ")),
                    error: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
                });
            }
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let _ = installed;
        // bootstrap is per-user and needs the plist path.
        let output = std::process::Command::new("launchctl")
            .args(["bootstrap", "gui/501", &installed.path.display().to_string()])
            .output()
            .map_err(|error| ServiceError::Command {
                command: "launchctl bootstrap".to_owned(),
                error: error.to_string(),
            })?;
        if !output.status.success() {
            return Err(ServiceError::Command {
                command: "launchctl bootstrap".to_owned(),
                error: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        return Ok(());
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = installed;
        Err(ServiceError::Unsupported)
    }
}

fn install_launchd(binary: &Path, config_path: &Path) -> Result<Installed, ServiceError> {
    let home = std::env::var("HOME").map_err(|_| ServiceError::Unsupported)?;
    let dir = Path::new(&home).join("Library").join("LaunchAgents");
    let log_dir = Path::new(&home)
        .join("Library")
        .join("Logs")
        .join("openclaw");
    std::fs::create_dir_all(&dir).map_err(|error| ServiceError::Write {
        path: dir.display().to_string(),
        error: error.to_string(),
    })?;
    std::fs::create_dir_all(&log_dir).map_err(|error| ServiceError::Write {
        path: log_dir.display().to_string(),
        error: error.to_string(),
    })?;

    let label = "ai.openclaw.gateway";
    let args = vec![
        "gateway".to_owned(),
        "--config".to_owned(),
        config_path.display().to_string(),
    ];
    let plist = launchd_plist(label, binary, &args, &log_dir);
    let path = dir.join(format!("{label}.plist"));
    std::fs::write(&path, plist).map_err(|error| ServiceError::Write {
        path: path.display().to_string(),
        error: error.to_string(),
    })?;

    let activation = format!("launchctl bootstrap gui/$(id -u) {}", path.display());
    Ok(Installed {
        path,
        manager: "launchd",
        activation,
    })
}

fn is_root() -> bool {
    std::env::var("EUID")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .is_some_and(|euid| euid == 0)
        || std::env::var("USER").is_ok_and(|user| user == "root")
}

/// Path of the currently running executable, resolved through symlinks so the
/// unit points at the real binary rather than a shim.
pub fn current_binary() -> Result<PathBuf, ServiceError> {
    let exe = std::env::current_exe().map_err(|error| ServiceError::Command {
        command: "current_exe".to_owned(),
        error: error.to_string(),
    })?;
    Ok(std::fs::canonicalize(&exe).unwrap_or(exe))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemd_unit_keeps_one_directive_per_line() {
        let unit = systemd_unit(
            Path::new("/usr/local/bin/openclaw"),
            Path::new("/etc/openclaw/openclaw.json"),
            Path::new("/var/lib/openclaw"),
            false,
        );
        for line in unit.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('[') || line.starts_with('#') {
                continue;
            }
            assert!(line.contains('='), "not a directive: {line:?}");
            let (_, value) = line.split_once('=').unwrap();
            assert!(
                !value.contains("Restart=") && !value.contains("WorkingDirectory="),
                "merged directives: {line:?}"
            );
        }
        assert!(unit.contains("ExecStart=/usr/local/bin/openclaw gateway --config /etc/openclaw/openclaw.json"));
        assert!(unit.contains("Restart=always"));
        assert!(unit.contains("WantedBy=multi-user.target"));
        assert!(!unit.contains("--token"), "secrets must not enter the unit");
    }

    #[test]
    fn user_unit_targets_default_target() {
        let unit = systemd_unit(
            Path::new("/bin/openclaw"),
            Path::new("/home/o/.openclaw/openclaw.json"),
            Path::new("/home/o/.openclaw"),
            true,
        );
        assert!(unit.contains("WantedBy=default.target"));
        assert!(!unit.contains("multi-user.target"));
    }

    #[test]
    fn launchd_plist_escapes_arguments() {
        let plist = launchd_plist(
            "ai.openclaw.gateway",
            Path::new("/opt/openclaw & co/openclaw"),
            &["gateway".to_owned(), "--config".to_owned(), "/tmp/a<b>.json".to_owned()],
            Path::new("/tmp/logs"),
        );
        assert!(plist.contains("/opt/openclaw &amp; co/openclaw"));
        assert!(plist.contains("/tmp/a&lt;b&gt;.json"));
        assert!(!plist.contains("a<b>"));
        assert!(plist.contains("<key>KeepAlive</key>"));
    }

    #[test]
    fn unsupported_hosts_fail_instead_of_reporting_success() {
        // This test binary runs on the host; only assert the negative case.
        if cfg!(target_os = "linux") || cfg!(target_os = "macos") {
            return;
        }
        let config = Config::default();
        let error = install(
            Path::new("/bin/openclaw"),
            &config,
            Path::new("/etc/openclaw/openclaw.json"),
            false,
        )
        .unwrap_err();
        assert!(matches!(error, ServiceError::Unsupported));
    }
}
