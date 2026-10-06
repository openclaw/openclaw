//! The companion owns a desktop-only CLI node; the CLI owns pairing and streaming.
use crate::cli::OpenClawCli;
use crate::desktop_node_process::DesktopNodeProcess;
use crate::gateway_profiles::GatewayProfiles;
use crate::gateway_ws::{GatewayClient, GatewayGeneration, GatewayWsConfig};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Manager, Url};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            enabled: None,
            state: "starting",
            detail: Some("Reading this computer's desktop sharing settings.".into()),
        }
    }
}

#[derive(Clone)]
struct Desired {
    revision: u64,
    target: Option<(GatewayGeneration, GatewayWsConfig)>,
    stopping: bool,
    disable_for_run: bool,
    preference_error: Option<String>,
}
struct Shared {
    desired: Desired,
    status_revision: u64,
    status: Status,
}

pub(crate) struct DesktopNode {
    shared: Arc<Mutex<Shared>>,
    profiles: Arc<GatewayProfiles>,
    sender: mpsc::SyncSender<()>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl DesktopNode {
    pub fn start(app: AppHandle, profiles: Arc<GatewayProfiles>) -> Result<Self, String> {
        let root = app
            .path()
            .app_config_dir()
            .map_err(|error| error.to_string())?
            .join("desktop-node");
        let shared = Arc::new(Mutex::new(Shared {
            desired: Desired {
                revision: 0,
                target: None,
                stopping: false,
                disable_for_run: false,
                preference_error: None,
            },
            status_revision: 0,
            status: Status::default(),
        }));
        let (sender, receiver) = mpsc::sync_channel(1);
        let state = Arc::clone(&shared);
        let preferences = Arc::clone(&profiles);
        let worker = thread::Builder::new()
            .name("desktop-node".into())
            .spawn(move || {
                run(app, root, preferences, state, receiver);
            })
            .map_err(|error| format!("Could not start desktop sharing: {error}"))?;
        Ok(Self {
            shared,
            profiles,
            sender,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn status(&self) -> (u64, Status) {
        let shared = self.shared.lock().expect("desktop node state");
        (shared.status_revision, shared.status.clone())
    }

    pub fn configure(&self, generation: GatewayGeneration, config: Option<GatewayWsConfig>) {
        let mut shared = self.shared.lock().expect("desktop node state");
        if shared.desired.stopping {
            return;
        }
        shared.desired.target = config.map(|config| (generation, config));
        shared.desired.revision += 1;
        drop(shared);
        let _ = self.sender.try_send(());
    }

    // Caller holds the trusted document's authority across this app-global preference write.
    pub fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        if self
            .shared
            .lock()
            .map_err(|_| "Desktop sharing is unavailable.")?
            .desired
            .stopping
        {
            return Err("OpenClaw is quitting.".into());
        }
        let result = self.profiles.set_desktop_sharing_enabled(enabled);
        let mut shared = self
            .shared
            .lock()
            .map_err(|_| "Desktop sharing is unavailable.")?;
        // An off request always withdraws this run's permission, even if the vault is locked.
        shared.desired.disable_for_run =
            !enabled || (result.is_err() && shared.desired.disable_for_run);
        if result.is_ok() || !enabled {
            shared.status.enabled = Some(enabled);
        }
        shared.desired.preference_error = result.err().map(|error| if enabled { error } else { format!("Desktop sharing is off for this run, but its preference could not be saved and may turn on after restart. {error}") });
        shared.status.state = "starting";
        shared.status.detail = Some(
            if enabled {
                "Preparing desktop sharing."
            } else {
                "Stopping desktop sharing."
            }
            .into(),
        );
        shared.status_revision += 1;
        shared.desired.revision += 1;
        drop(shared);
        match self.sender.try_send(()) {
            Ok(()) | Err(mpsc::TrySendError::Full(())) => Ok(()),
            Err(mpsc::TrySendError::Disconnected(())) => {
                Err("Desktop sharing stopped unexpectedly. Restart OpenClaw-Tauri.".into())
            }
        }
    }

    pub fn stop(&self) {
        let mut shared = self.shared.lock().expect("desktop node state");
        shared.desired.stopping = true;
        shared.desired.revision += 1;
        drop(shared);
        let _ = self.sender.try_send(());
    }

    pub fn wait_stopped(&self) {
        self.stop();
        if let Some(worker) = self.worker.lock().expect("desktop node worker").take() {
            if worker.join().is_err() {
                eprintln!("Desktop sharing shutdown failed.");
            }
        }
    }
}

fn publish(app: &AppHandle, shared: &Mutex<Shared>, revision: u64, status: Status) {
    let mut current = shared.lock().expect("desktop node state");
    if current.desired.revision != revision {
        return;
    }
    current.status = status;
    current.status_revision += 1;
    drop(current);
    crate::native_device_settings::publish(app);
}

fn run(
    app: AppHandle,
    root: PathBuf,
    profiles: Arc<GatewayProfiles>,
    shared: Arc<Mutex<Shared>>,
    receiver: mpsc::Receiver<()>,
) {
    let mut child: Option<DesktopNodeProcess> = None;
    let mut probe_owner: Option<DesktopNodeProcess> = None;
    let mut applied = None;
    let mut redactions = Vec::<String>::new();
    let mut diagnostic_tail = VecDeque::new();
    loop {
        let desired = shared.lock().expect("desktop node state").desired.clone();
        if applied != Some(desired.revision) {
            let mut cleanup_failed = false;
            for owner in [&mut child, &mut probe_owner] {
                if let Some(process) = owner.as_mut() {
                    if let Err(error) = process.stop() {
                        publish(
                            &app,
                            &shared,
                            desired.revision,
                            Status {
                                enabled: Some(false),
                                state: "error",
                                detail: Some(error),
                            },
                        );
                        cleanup_failed = true;
                        continue;
                    }
                }
                owner.take();
            }
            if cleanup_failed {
                // Keep every unresolved owner; a replacement never outruns teardown.
                let _ = receiver.recv_timeout(Duration::from_secs(1));
                continue;
            }
            if desired.stopping {
                break;
            }
            let mut preparing = Status {
                enabled: shared.lock().expect("desktop node state").status.enabled,
                ..Status::default()
            };
            publish(&app, &shared, desired.revision, preparing.clone());
            let prepared = prepare(
                &root,
                &profiles,
                &desired,
                &mut probe_owner,
                || {
                    let current = shared.lock().expect("desktop node state");
                    current.desired.stopping || current.desired.revision != desired.revision
                },
                |enabled| {
                    preparing.enabled = Some(enabled);
                    preparing.detail = Some("Preparing desktop sharing.".into());
                    publish(&app, &shared, desired.revision, preparing.clone());
                },
            );
            applied = Some(desired.revision);
            match prepared {
                Err(error) => publish(
                    &app,
                    &shared,
                    desired.revision,
                    Status {
                        enabled: preparing.enabled,
                        state: "error",
                        detail: Some(error),
                    },
                ),
                Ok((enabled, command)) => {
                    let Some((mut command, secrets)) = command else {
                        publish(
                            &app,
                            &shared,
                            desired.revision,
                            Status {
                                enabled: Some(enabled),
                                state: if desired.preference_error.is_some() {
                                    "error"
                                } else {
                                    "off"
                                },
                                detail: desired.preference_error.clone().or_else(|| {
                                    enabled.then(|| {
                                        "Select a Primary Gateway to share this desktop.".into()
                                    })
                                }),
                            },
                        );
                        continue;
                    };
                    redactions = secrets;
                    diagnostic_tail.clear();
                    command.env("OPENCLAW_NO_RESPAWN", "1");
                    let generation = desired.target.as_ref().expect("prepared desktop route").0;
                    let started = app
                        .state::<GatewayClient>()
                        .with_generation(generation, || {
                            let current = shared
                                .lock()
                                .map_err(|_| "Desktop sharing is unavailable.")?;
                            if current.desired.revision != desired.revision
                                || current.desired.stopping
                            {
                                return Ok(None);
                            }
                            DesktopNodeProcess::spawn(command).map(Some)
                        });
                    match started {
                        Ok(Some(process)) => {
                            child = Some(process);
                            publish(&app, &shared, desired.revision, Status { enabled: Some(enabled), state: "running", detail: Some("Desktop sharing is running for the Primary Gateway. Approve this computer's desktop capability there if requested.".into()) });
                        }
                        Ok(None) => {}
                        Err(error) => publish(
                            &app,
                            &shared,
                            desired.revision,
                            Status {
                                enabled: Some(enabled),
                                state: "error",
                                detail: Some(error),
                            },
                        ),
                    }
                }
            }
        }
        if let Some(process) = child.as_mut() {
            retain_diagnostics(process, &redactions, &mut diagnostic_tail);
            match process.exited() {
                Ok(false) => {}
                outcome => {
                    let stopped = process.stop();
                    retain_diagnostics(process, &redactions, &mut diagnostic_tail);
                    let error = outcome.err().or_else(|| stopped.as_ref().err().cloned()).unwrap_or_else(|| format!("Desktop sharing exited. Check the local CLI and Primary Gateway, then turn sharing off and on to retry.\n{}", diagnostic_tail.iter().cloned().collect::<Vec<_>>().join("\n")));
                    publish(
                        &app,
                        &shared,
                        desired.revision,
                        Status {
                            enabled: Some(true),
                            state: "error",
                            detail: Some(error),
                        },
                    );
                    // Join descendants before considering a later operator-requested restart.
                    if stopped.is_ok() {
                        child = None;
                    }
                }
            }
        }
        let _ = receiver.recv_timeout(Duration::from_millis(250));
    }
}

fn retain_diagnostics(
    process: &DesktopNodeProcess,
    secrets: &[String],
    tail: &mut VecDeque<String>,
) {
    for (_, line) in process.output() {
        if !line.trim().is_empty() {
            tail.push_back(sanitize_diagnostic(&line, secrets));
            if tail.len() > 6 {
                tail.pop_front();
            }
        }
    }
}

fn prepare(
    root: &Path,
    profiles: &GatewayProfiles,
    desired: &Desired,
    probe_owner: &mut Option<DesktopNodeProcess>,
    cancelled: impl Fn() -> bool,
    mut resolved: impl FnMut(bool),
) -> Result<(bool, Option<(Command, Vec<String>)>), String> {
    if desired.disable_for_run {
        resolved(false);
        return Ok((false, None));
    }
    let preference = profiles.desktop_sharing_enabled()?;
    if let Some(enabled) = preference {
        resolved(enabled);
        if !enabled {
            return Ok((false, None));
        }
    }
    let cli = OpenClawCli::locate().map_err(|_| {
        "Install or update the local OpenClaw CLI to prepare desktop sharing.".to_string()
    })?;
    let mut probe = |args: &[&str]| {
        let command = cli.command(args).map_err(|error| error.to_string())?;
        DesktopNodeProcess::probe(command, &cancelled, probe_owner)?
            .ok_or_else(|| "Desktop sharing setup was superseded.".to_string())
    };
    if !probe(&["--version"])?.status.success() {
        return Err("Install or update the local OpenClaw CLI to prepare desktop sharing.".into());
    }
    let config_file_output = probe(&["config", "file", "--json"])?;
    if !config_file_output.status.success() {
        return Err("Could not resolve this computer's config file. Run openclaw config file --json and try again.".into());
    }
    let config_file: Value = serde_json::from_slice(&config_file_output.stdout)
        .map_err(|_| "The local CLI returned an invalid config path.")?;
    let config_path = config_file
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("The local CLI did not report an absolute config path.")?;
    let enabled = match preference {
        Some(enabled) => enabled,
        None => {
            let enabled = resolve_desktop_enabled(&probe(&[
                "config",
                "get",
                "desktop.host.enabled",
                "--json",
            ])?)?;
            resolved(enabled);
            enabled
        }
    };
    let Some((_, target)) = desired.target.as_ref().filter(|_| enabled) else {
        return Ok((enabled, None));
    };
    let state_dir = node_state_dir(root, &config_path, &target.node_identity_scope);
    std::fs::create_dir_all(&state_dir)
        .map_err(|error| format!("Could not prepare desktop node state: {error}"))?;
    let mut command = cli
        .command(node_arguments(target)?)
        .map_err(|error| error.to_string())?;
    // Identity is app-owned; configuration remains at the canonical include-aware CLI path.
    command
        .env_remove("CF_ACCESS_CLIENT_ID")
        .env_remove("CF_ACCESS_CLIENT_SECRET")
        .env("OPENCLAW_STATE_DIR", state_dir)
        .env("OPENCLAW_CONFIG_PATH", config_path)
        .env(
            "OPENCLAW_GATEWAY_TOKEN",
            target.token.as_deref().unwrap_or(""),
        )
        .env(
            "OPENCLAW_GATEWAY_PASSWORD",
            target.password.as_deref().unwrap_or(""),
        );
    let secrets = [&target.token, &target.password]
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .cloned()
        .collect();
    Ok((enabled, Some((command, secrets))))
}

fn resolve_desktop_enabled(output: &Output) -> Result<bool, String> {
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        "The local CLI returned invalid desktop settings. Update OpenClaw and try again."
    })?;
    if output.status.success() {
        return value
            .as_bool()
            .ok_or_else(|| "Desktop sharing config must be true or false.".into());
    }
    if value.get("ok") == Some(&Value::Bool(false))
        && value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .is_some_and(|message| {
                message.starts_with("Config path is valid but unset: desktop.host.enabled.")
            })
    {
        return Ok(true);
    }
    Err("Could not resolve desktop sharing config. Run openclaw config get desktop.host.enabled --json to fix the reported config error.".into())
}

fn node_arguments(target: &GatewayWsConfig) -> Result<Vec<String>, String> {
    let url = parse_target(target)?;
    let host = url.host_str().ok_or("Primary Gateway host is missing.")?;
    let port = url
        .port_or_known_default()
        .ok_or("Primary Gateway port is missing.")?;
    let mut args = vec![
        "node".into(),
        "run".into(),
        "--commands".into(),
        "desktop.stream".into(),
        "--desktop-sharing".into(),
        "--auth-from-env".into(),
        "--parent-stdin".into(),
        "--host".into(),
        host.into(),
        "--port".into(),
        port.to_string(),
        "--context-path".into(),
        url.path().into(),
        if url.scheme() == "wss" {
            "--tls"
        } else {
            "--no-tls"
        }
        .into(),
    ];
    if let Some(pin) = &target.tls_fingerprint {
        args.extend(["--tls-fingerprint".into(), pin.clone()]);
    }
    Ok(args)
}

fn parse_target(target: &GatewayWsConfig) -> Result<Url, String> {
    let url = Url::parse(&target.ws_url).map_err(|_| "Invalid Primary Gateway URL.")?;
    if !matches!(url.scheme(), "ws" | "wss")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "The Primary Gateway must use a WebSocket URL without embedded credentials.".into(),
        );
    }
    Ok(url)
}

fn node_state_dir(root: &Path, config_path: &Path, scope: &str) -> PathBuf {
    let mut hash = Sha256::new();
    hash.update(config_path.to_string_lossy().as_bytes());
    hash.update([0]);
    hash.update(scope.as_bytes());
    root.join(
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    )
}

fn sanitize_diagnostic(line: &str, secrets: &[String]) -> String {
    let mut message = line.to_string();
    for secret in secrets {
        message = message.replace(secret, "[redacted]");
    }
    message
        .chars()
        .filter(|ch| !ch.is_control())
        .take(1000)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_config_false_is_not_mistaken_for_an_unset_default() {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        let reply = |success, value: Value| Output {
            status: std::process::ExitStatus::from_raw(if success { 0 } else { 256 }),
            stdout: serde_json::to_vec(&value).unwrap(),
            stderr: Vec::new(),
        };
        assert!(!resolve_desktop_enabled(&reply(true, Value::Bool(false))).unwrap());
        assert!(resolve_desktop_enabled(&reply(true, Value::Bool(true))).unwrap());
        assert!(resolve_desktop_enabled(&reply(false, serde_json::json!({"ok":false,"error":{"type":"cli_error","message":"Config path is valid but unset: desktop.host.enabled. The runtime default applies."}}))).unwrap());
        assert!(resolve_desktop_enabled(&reply(
            false,
            serde_json::json!({"ok":false,"error":{"message":"Config include is invalid"}})
        ))
        .is_err());
        assert!(resolve_desktop_enabled(&reply(true, Value::String("false".into()))).is_err());
    }

    #[test]
    fn node_identity_tracks_logical_gateway_and_config_while_ssh_reconnects_keep_pairing() {
        let mut request = crate::remote_gateway::RemoteGatewayRequest {
            transport: "ssh".into(),
            url: None,
            ssh_target: Some("operator@studio.example:2222".into()),
            token: None,
            password: None,
            remote_port: Some(18789),
            tls_fingerprint: None,
        };
        let first = crate::remote_gateway::desktop_node_identity_scope(
            &request,
            &Url::parse("ws://127.0.0.1:34001/team/").unwrap(),
        )
        .unwrap();
        let recovered = crate::remote_gateway::desktop_node_identity_scope(
            &request,
            &Url::parse("ws://127.0.0.1:35002/team").unwrap(),
        )
        .unwrap();
        let root = Path::new("app-state");
        let config = Path::new("profile/openclaw.json");
        assert_eq!(
            node_state_dir(root, config, &first),
            node_state_dir(root, config, &recovered)
        );
        request.ssh_target = Some("operator@another.example:2222".into());
        let changed = crate::remote_gateway::desktop_node_identity_scope(
            &request,
            &Url::parse("ws://127.0.0.1:35002/team").unwrap(),
        )
        .unwrap();
        assert_ne!(
            node_state_dir(root, config, &first),
            node_state_dir(root, config, &changed)
        );
        assert_ne!(
            node_state_dir(root, config, &first),
            node_state_dir(root, Path::new("other/openclaw.json"), &first)
        );
        assert_ne!(
            node_state_dir(root, config, "wss://studio.example/team"),
            node_state_dir(root, config, "wss://studio.example/other")
        );
    }

    #[test]
    fn native_launch_keeps_auth_out_of_argv_and_preserves_selected_tls_context() {
        let target = GatewayWsConfig::new(
            "wss://studio.example:8443/team".into(),
            Some("synthetic-token".into()),
            None,
            Some("ab".repeat(32)),
            crate::gateway_ws::GatewayOwnership::Remote,
        );
        let args = node_arguments(&target).unwrap();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--commands", "desktop.stream"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--context-path", "/team"]));
        assert!(args.contains(&"--tls".into()));
        assert!(args.contains(&"--auth-from-env".into()));
        assert!(args.contains(&"--parent-stdin".into()));
        assert!(!args.contains(&"--display-name".into()));
        assert!(!args.join(" ").contains("synthetic-token"));
        assert_eq!(
            sanitize_diagnostic("auth synthetic-token\n", &["synthetic-token".into()]),
            "auth [redacted]"
        );
    }
}
