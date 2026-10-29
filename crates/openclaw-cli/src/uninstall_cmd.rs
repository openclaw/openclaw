//! `openclaw uninstall` — remove the Gateway service and/or local data.
//!
//! Official reference: `docs/cli/uninstall.md`. Scope flags select what is
//! removed; `--dry-run` prints the plan; `--non-interactive` requires `--yes`;
//! state removal requires exclusive ownership of the state directory.

use std::path::PathBuf;

#[derive(Debug, Default, Clone, Copy)]
pub struct Scopes {
    pub service: bool,
    pub state: bool,
    pub workspace: bool,
    pub app: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum UninstallError {
    #[error("--non-interactive requires --yes")]
    ConfirmationRequired,
    #[error("no scope selected; pass --service, --state, --workspace, --app, or --all")]
    NoScope,
    #[error("state is owned by a running Gateway; stop it through its service owner first")]
    GatewayRunning,
    #[error("failed to remove {path}: {error}")]
    Remove { path: String, error: String },
}

/// Parse documented flags. `--all` expands to every scope.
pub fn parse(args: &[String]) -> (Scopes, bool, bool, bool) {
    let mut scopes = Scopes::default();
    let mut yes = false;
    let mut non_interactive = false;
    let mut dry_run = false;
    for arg in args {
        match arg.as_str() {
            "--service" => scopes.service = true,
            "--state" => scopes.state = true,
            "--workspace" => scopes.workspace = true,
            "--app" => scopes.app = true,
            "--all" => {
                scopes.service = true;
                scopes.state = true;
                scopes.workspace = true;
                scopes.app = true;
            }
            "--yes" | "-y" => yes = true,
            "--non-interactive" => non_interactive = true,
            "--dry-run" => dry_run = true,
            _ => {}
        }
    }
    (scopes, yes, non_interactive, dry_run)
}

/// True when a Gateway process appears to own this state directory.
fn gateway_running() -> bool {
    // The Gateway writes a lock-free marker only while it is live; absence means
    // no owner, so uninstall can proceed. A present marker blocks state removal.
    let Some(state) = openclaw_config::paths::state_dir(&openclaw_config::paths::process_env())
    else {
        return false;
    };
    state.join("gateway.pid").is_file()
}

fn remove(path: &PathBuf) -> Result<bool, UninstallError> {
    if !path.exists() {
        return Ok(false);
    }
    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(|error| UninstallError::Remove {
            path: path.display().to_string(),
            error: error.to_string(),
        })?;
    } else {
        std::fs::remove_file(path).map_err(|error| UninstallError::Remove {
            path: path.display().to_string(),
            error: error.to_string(),
        })?;
    }
    Ok(true)
}

/// Run uninstall. Returns human-readable lines describing the outcome.
pub fn run(args: &[String]) -> Result<Vec<String>, UninstallError> {
    let (scopes, yes, non_interactive, dry_run) = parse(args);
    if non_interactive && !yes {
        return Err(UninstallError::ConfirmationRequired);
    }
    if !scopes.service && !scopes.state && !scopes.workspace && !scopes.app {
        return Err(UninstallError::NoScope);
    }
    if scopes.state && !yes && non_interactive {
        return Err(UninstallError::ConfirmationRequired);
    }

    let env = openclaw_config::paths::process_env();
    let config_path = openclaw_config::paths::config_path(&env);
    let state_dir = openclaw_config::paths::state_dir(&env);

    let mut plan: Vec<(&str, PathBuf)> = Vec::new();
    let mut skipped: Vec<&str> = Vec::new();
    if scopes.service {
        for path in [
            PathBuf::from("/etc/systemd/system/openclaw-gateway.service"),
            PathBuf::from("/etc/systemd/system/openclaw-gateway.service.d"),
            // Legacy unit from the pre-rename era; documented cleanup target.
            PathBuf::from("/etc/systemd/system/clawdbot-gateway.service"),
        ] {
            plan.push(("service", path));
        }
        if let Ok(home) = std::env::var("HOME") {
            plan.push((
                "service",
                PathBuf::from(&home).join(".config/systemd/user/openclaw-gateway.service"),
            ));
            plan.push((
                "service",
                PathBuf::from(&home).join("Library/LaunchAgents/ai.openclaw.gateway.plist"),
            ));
        }
    }
    if scopes.state {
        if gateway_running() {
            return Err(UninstallError::GatewayRunning);
        }
        // `--state` means "remove state and config", but the documented contract
        // preserves workspace directories unless `--workspace` is also selected.
        if let Some(config) = &config_path {
            plan.push(("state", config.clone()));
        }
        if let Some(state) = &state_dir {
            if scopes.workspace {
                plan.push(("state", state.clone()));
            } else {
                // Remove each entry, keeping workspace directories intact.
                let workspace_paths = workspace_dirs(state);
                if let Ok(entries) = std::fs::read_dir(state) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if workspace_paths.iter().any(|kept| path == *kept) {
                            continue;
                        }
                        plan.push(("state", path));
                    }
                }
            }
        }
    }
    if scopes.workspace {
        if let Some(state) = &state_dir {
            for workspace in workspace_dirs(state) {
                plan.push(("workspace", workspace));
            }
            // Configured external workspaces are removed too.
            for workspace in configured_workspaces() {
                plan.push(("workspace", workspace));
            }
        }
    }
    if scopes.app {
        if cfg!(target_os = "macos") {
            plan.push(("app", PathBuf::from("/Applications/OpenClaw.app")));
        } else {
            // A skipped scope must not abort the other requested scopes.
            skipped.push("app scope is not applicable on this platform (macOS only)");
        }
    }

    let mut lines: Vec<String> = skipped.iter().map(|note| (*note).to_owned()).collect();
    let mut failures = Vec::new();
    for (scope, path) in plan {
        if dry_run {
            if path.exists() {
                lines.push(format!("[dry-run] would remove {scope}: {}", path.display()));
            }
            continue;
        }
        match remove(&path) {
            Ok(true) => lines.push(format!("removed {scope}: {}", path.display())),
            Ok(false) => {}
            Err(error) => failures.push(error.to_string()),
        }
    }
    lines.extend(failures.iter().map(|error| format!("failed: {error}")));
    if lines.is_empty() {
        lines.push("nothing to remove".to_owned());
    }
    if !failures.is_empty() {
        return Err(UninstallError::Remove {
            path: failures.join("; "),
            error: "one or more scopes failed".to_owned(),
        });
    }
    Ok(lines)
}

/// Workspace directories the state scope must preserve by default.
fn workspace_dirs(state: &std::path::Path) -> Vec<PathBuf> {
    vec![state.join("workspace"), state.join("workspaces")]
}

/// Workspace paths named in the active config, so `--workspace` also removes
/// agents whose workspace lives outside the state directory.
fn configured_workspaces() -> Vec<PathBuf> {
    let Some(config_path) = openclaw_config::paths::config_path(&openclaw_config::paths::process_env())
    else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(&config_path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(agents) = value.get("agents").and_then(|a| a.as_object()) {
        for agent in agents.values() {
            if let Some(workspace) = agent.get("workspace").and_then(|w| w.as_str()) {
                if !workspace.trim().is_empty() {
                    out.push(PathBuf::from(workspace));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_expands_to_every_scope() {
        let (scopes, _, _, _) = parse(&["--all".to_owned()]);
        assert!(scopes.service && scopes.state && scopes.workspace && scopes.app);
    }

    #[test]
    fn non_interactive_requires_yes() {
        let args = vec!["--state".to_owned(), "--non-interactive".to_owned()];
        assert!(matches!(
            run(&args),
            Err(UninstallError::ConfirmationRequired)
        ));
    }

    #[test]
    fn no_scope_is_an_error_not_a_silent_success() {
        assert!(matches!(run(&[]), Err(UninstallError::NoScope)));
    }
}
