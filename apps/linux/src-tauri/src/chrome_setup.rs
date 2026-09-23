//! Local CLI adapter only. The browser plugin owns setup policy and result state.
use crate::cli::{CliError, OpenClawCli, SpawnCommand};
use serde::Deserialize;
use serde_json::Value;
use std::process::Command;
use std::sync::{mpsc, Mutex};
use std::thread;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

const STORE_URL: &str =
    "https://chromewebstore.google.com/detail/openclaw/kcdjddhmeafeomebliikmbpblkmkfoig";
type Job = Box<dyn FnOnce() + Send>;

/// Startup, post-install, tray and admitted Dashboard actions share this one writer.
#[derive(Default)]
pub(crate) struct ChromeSetup {
    sender: Mutex<Option<mpsc::Sender<Job>>>,
}

impl ChromeSetup {
    fn enqueue(&self, job: Job) -> Result<(), String> {
        let mut sender = self
            .sender
            .lock()
            .map_err(|_| "Chrome setup queue unavailable.")?;
        if sender.is_none() {
            let (tx, rx) = mpsc::channel::<Job>();
            thread::Builder::new()
                .name("openclaw-chrome-setup".into())
                .spawn(move || {
                    for job in rx {
                        job();
                    }
                })
                .map_err(|_| "Could not schedule Chrome setup.")?;
            *sender = Some(tx);
        }
        if sender
            .as_ref()
            .is_some_and(|sender| sender.send(job).is_err())
        {
            *sender = None;
            return Err("Chrome setup worker stopped. Try again.".into());
        }
        Ok(())
    }

    pub(crate) fn start(&self, app: AppHandle) {
        self.request(app, None, false);
    }

    pub(crate) fn installed(&self, app: AppHandle, cli: OpenClawCli) {
        self.request(app, Some(cli), false);
    }

    pub(crate) fn request_from_user(&self, app: AppHandle) {
        self.request(app, None, true);
    }

    fn request(&self, app: AppHandle, cli: Option<OpenClawCli>, open_store: bool) {
        let outcome = self.enqueue(Box::new(move || {
            let current = || !app.state::<crate::DesktopState>().is_quitting();
            let spawn = |command: &mut Command| {
                if !current() {
                    return Err("OpenClaw is quitting.".into());
                }
                command.spawn().map_err(|error| error.to_string())
            };
            let result = perform(&app, cli, Action::Install, &current, &spawn);
            if !current() {
                return;
            }
            if let Err(error) = &result {
                eprintln!("Automatic Chrome setup needs retry: {error}");
            }
            // Browser windows are only opened by an explicit tray request, never startup.
            if !open_store {
                return;
            }
            let error = match result {
                Ok(report) if store_allowed(&report) => app
                    .opener()
                    .open_url(STORE_URL, None::<&str>)
                    .err()
                    .map(|_| "Could not open the Chrome Web Store.".to_string()),
                Ok(_) => Some("Chrome registration needs attention. Check local setup before opening the Store.".into()),
                Err(error) => Some(error),
            };
            if let Some(error) = error {
                crate::notify::notify(&app, "Chrome setup needs attention", &error);
            }
        }));
        if let Err(error) = outcome {
            eprintln!("{error}");
        }
    }

    pub(crate) fn run_for_document(
        &self,
        app: AppHandle,
        action: Action,
        generation: u64,
    ) -> Result<Value, String> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.enqueue(Box::new(move || {
            let current = || {
                !app.state::<crate::DesktopState>().is_quitting()
                    && crate::native_browser_bridge::request_is_current(&app, generation)
            };
            let spawn = |command: &mut Command| {
                // Hold document authority through spawn, then let admitted work
                // settle without blocking navigation.
                app.state::<crate::native_browser_bridge::NativeBrowserBridgeState>()
                    .with_document_authority(generation, || {
                        if app.state::<crate::DesktopState>().is_quitting() {
                            return Err("OpenClaw is quitting.".into());
                        }
                        command.spawn().map_err(|error| error.to_string())
                    })
            };
            let result = perform(&app, None, action, &current, &spawn);
            let _ = tx.send(result);
        }))?;
        rx.recv()
            .map_err(|_| "Chrome setup worker stopped. Try again.".to_string())?
    }
}

fn perform(
    app: &AppHandle,
    cli: Option<OpenClawCli>,
    action: Action,
    is_current: &dyn Fn() -> bool,
    spawn: &SpawnCommand<'_>,
) -> Result<Value, String> {
    if !is_current() {
        return Err("The native browser document changed.".into());
    }
    let cli = match cli {
        Some(cli) => cli,
        None => {
            crate::installer::browser_runtime(app, action == Action::Install, is_current, spawn)
                .map_err(|_| {
                    "The local browser runtime is unavailable. Check the local installation."
                        .to_string()
                })?
        }
    };
    // Runtime discovery/provisioning may await a process: revalidate before registration.
    if !is_current() {
        return Err("The native browser document changed.".into());
    }
    run(&cli, action, spawn)
}

fn store_allowed(report: &Value) -> bool {
    report.get("action").and_then(Value::as_str) == Some("install")
        && report.pointer("/target/kind").and_then(Value::as_str) == Some("local-host")
        && report
            .pointer("/installation/nativeHostRegistered")
            .and_then(Value::as_bool)
            == Some(true)
        && report
            .pointer("/installation/automaticBootstrapSupported")
            .and_then(Value::as_bool)
            == Some(true)
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Inspect,
    Install,
    Verify,
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum Request {
    #[serde(rename = "chrome-extension-setup")]
    ChromeSetup { action: Action },
}

pub fn parse_request(message: Value) -> Result<Action, String> {
    let Request::ChromeSetup { action } = serde_json::from_value(message)
        .map_err(|_| "Invalid Chrome setup action. Choose inspect, install, or verify.")?;
    Ok(action)
}

fn arguments(action: Action) -> [&'static str; 8] {
    [
        "browser",
        "extension",
        "setup",
        "--action",
        match action {
            Action::Inspect => "inspect",
            Action::Install => "install",
            Action::Verify => "verify",
        },
        "--json",
        "--wait-ms",
        "1000",
    ]
}

pub fn run(cli: &OpenClawCli, action: Action, spawn: &SpawnCommand<'_>) -> Result<Value, String> {
    // Pending and blocked are successful canonical JSON results, not transport
    // failures. Do not infer readiness or bootstrap support from this platform.
    cli.bounded_json(&arguments(action), spawn)
        .map_err(cli_error)
}

pub fn cli_error(error: CliError) -> String {
    // CLI diagnostics may contain local paths or configuration. Only canonical
    // setup results cross into a potentially remote dashboard, never raw stderr.
    match error {
        CliError::Missing => "OpenClaw CLI is not installed on this computer.",
        CliError::Environment(_) | CliError::Spawn(_) => {
            "Could not run OpenClaw CLI on this computer. Check the local CLI installation."
        }
        CliError::CommandFailed(_) => {
            "Chrome setup failed on this computer. Check the local CLI installation and try again."
        }
        CliError::InvalidJson(_) => {
            "OpenClaw CLI returned an invalid Chrome setup result. Update the local CLI and try again."
        }
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_only_explicit_setup_actions_and_no_caller_selected_targets() {
        for (name, action) in [
            ("inspect", Action::Inspect),
            ("install", Action::Install),
            ("verify", Action::Verify),
        ] {
            assert_eq!(
                parse_request(json!({"type": "chrome-extension-setup", "action": name})).unwrap(),
                action
            );
            assert_eq!(
                arguments(action),
                [
                    "browser",
                    "extension",
                    "setup",
                    "--action",
                    name,
                    "--json",
                    "--wait-ms",
                    "1000"
                ]
            );
        }
        for message in [
            json!({"type": "chrome-extension-setup"}),
            json!({"type": "chrome-extension-setup", "action": "install --url https://other.example"}),
            json!({"type": "chrome-extension-setup", "action": "pair"}),
            json!({"type": "chrome-extension-setup", "action": "inspect", "profile": "remote"}),
            json!({"type": "chrome-extension-setup", "action": "install", "command": "other"}),
            json!({"type": "chrome-extension-setup", "action": "install", "url": "https://other.example"}),
            json!({"type": "open-link", "action": "install"}),
        ] {
            assert!(parse_request(message).is_err());
        }
    }

    #[test]
    fn queued_actions_are_serial_and_can_revalidate_after_waiting() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let owner = ChromeSetup::default();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let current = Arc::new(AtomicBool::new(true));
        owner
            .enqueue(Box::new(move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            }))
            .unwrap();
        started_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        let queued_current = current.clone();
        owner
            .enqueue(Box::new(move || {
                finished_tx
                    .send(queued_current.load(Ordering::SeqCst))
                    .unwrap();
            }))
            .unwrap();
        current.store(false, Ordering::SeqCst);
        release_tx.send(()).unwrap();
        assert!(!finished_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap());
    }

    #[test]
    fn explicit_store_action_requires_canonical_owned_registration() {
        let report = json!({"action":"install", "target":{"kind":"local-host"},
            "installation":{"nativeHostRegistered":true,"automaticBootstrapSupported":true}});
        assert!(store_allowed(&report));
        for pointer in [
            "/installation/nativeHostRegistered",
            "/installation/automaticBootstrapSupported",
        ] {
            let mut denied = report.clone();
            *denied.pointer_mut(pointer).unwrap() = json!(false);
            assert!(!store_allowed(&denied));
        }
        let mut inspect = report;
        inspect["action"] = json!("inspect");
        assert!(!store_allowed(&inspect));
        assert!(!store_allowed(&json!({"manualSetupRequired":false})));
    }

    #[test]
    fn transport_errors_do_not_expose_cli_diagnostics() {
        for error in [
            CliError::Environment("fixture-private-value".into()),
            CliError::Spawn("fixture-private-value".into()),
            CliError::CommandFailed("fixture-private-value".into()),
            CliError::InvalidJson("fixture-private-value".into()),
        ] {
            assert!(!cli_error(error).contains("fixture-private-value"));
        }
    }
}
