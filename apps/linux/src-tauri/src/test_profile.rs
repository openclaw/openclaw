//! The hand-test app owns one fixed profile and an in-process Gateway supervisor.
use crate::cli::OpenClawCli;
use crate::gateway::{GatewayAction, GatewaySnapshot};
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const PROFILE: &str = "aot-test";
const IDENTIFIER: &str = "ai.openclaw.tauri.aot";
const PORT: u16 = 19876;
static ROOT: OnceLock<PathBuf> = OnceLock::new();
static CLI: OnceLock<OpenClawCli> = OnceLock::new();
static GATEWAY: Mutex<Option<Child>> = Mutex::new(None);

pub(crate) fn enabled() -> bool {
    option_env!("OPENCLAW_DESKTOP_TEST_PROFILE") == Some(PROFILE)
}

pub(crate) fn profile() -> Option<&'static str> {
    enabled().then_some(PROFILE)
}

pub(crate) fn state_root() -> Result<PathBuf, String> {
    ROOT.get()
        .cloned()
        .ok_or_else(|| "AOT test profile was not initialized.".into())
}

pub(crate) fn initialize(identifier: &str) -> Result<(), String> {
    if enabled() != (identifier == IDENTIFIER) {
        return Err("The AOT test profile and app identifier must be built together.".into());
    }
    if !enabled() {
        return Ok(());
    }
    if crate::bundled_runtime::flavor() != Some(crate::runtime_action::RuntimeFlavor::Aot) {
        return Err("The AOT test app requires a staged AOT runtime.".into());
    }
    let home = std::env::var_os("HOME").ok_or("HOME is unavailable for the test profile.")?;
    let home = fs::canonicalize(home).map_err(|error| error.to_string())?;
    let root = home.join(".openclaw-aot-test");
    match fs::symlink_metadata(&root) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err("The AOT test state directory is redirected or not a directory.".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(&root).map_err(|error| error.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    if fs::symlink_metadata(root.join("openclaw.json")).is_ok_and(|metadata| !metadata.is_file()) {
        return Err("The AOT test configuration must be a regular file.".into());
    }
    ROOT.set(root.clone())
        .map_err(|_| "AOT test profile was initialized twice.")?;
    // This runs before Tauri creates threads or reads any OpenClaw state.
    for key in [
        "OPENCLAW_DESKTOP_CLI",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_GATEWAY_PASSWORD",
        "OPENCLAW_GATEWAY_SERVICE_PID",
        "OPENCLAW_SERVICE_MARKER",
        "OPENCLAW_SERVICE_KIND",
    ] {
        std::env::remove_var(key);
    }
    std::env::set_var("OPENCLAW_HOME", home);
    for (key, value) in profile_environment(&root) {
        std::env::set_var(key, value);
    }
    Ok(())
}

fn profile_environment(root: &Path) -> Vec<(&'static str, std::ffi::OsString)> {
    vec![
        ("OPENCLAW_PROFILE", PROFILE.into()),
        ("OPENCLAW_STATE_DIR", root.as_os_str().into()),
        (
            "OPENCLAW_WORKSPACE_DIR",
            root.join("workspace").into_os_string(),
        ),
        (
            "OPENCLAW_CONFIG_PATH",
            root.join("openclaw.json").into_os_string(),
        ),
        (
            "OPENCLAW_OAUTH_DIR",
            root.join("credentials").into_os_string(),
        ),
        ("OPENCLAW_GATEWAY_PORT", PORT.to_string().into()),
        ("OPENCLAW_LAUNCHD_LABEL", "ai.openclaw.aot-test".into()),
        (
            "OPENCLAW_SYSTEMD_UNIT",
            "openclaw-gateway-aot-test.service".into(),
        ),
        (
            "OPENCLAW_WINDOWS_TASK_NAME",
            "OpenClaw Gateway (aot-test)".into(),
        ),
        ("OPENCLAW_NO_RESPAWN", "1".into()),
        ("OPENCLAW_SUPERVISOR_MODE", "external".into()),
        ("OPENCLAW_SERVICE_REPAIR_POLICY", "external".into()),
    ]
}

pub(crate) fn configure_command(command: &mut Command) -> Result<(), String> {
    if !enabled() {
        return Ok(());
    }
    command.args(["--profile", PROFILE]);
    for (key, value) in profile_environment(&state_root()?) {
        command.env(key, value);
    }
    command
        .env_remove("OPENCLAW_DESKTOP_CLI")
        .env_remove("OPENCLAW_GATEWAY_TOKEN")
        .env_remove("OPENCLAW_GATEWAY_PASSWORD");
    Ok(())
}

pub(crate) fn prepare(app: &AppHandle) -> Result<(), String> {
    if !enabled() {
        return Ok(());
    }
    let root = state_root()?;
    let (runtime, entry) =
        crate::bundled_runtime::seed_cli(app, &root)?.ok_or("AOT test app has no bundled CLI.")?;
    let cli = OpenClawCli::from_bundled(&runtime, entry, root);
    CLI.set(cli)
        .map_err(|_| "AOT test CLI was prepared twice.".into())
}

pub(crate) fn cli() -> Result<OpenClawCli, String> {
    CLI.get()
        .cloned()
        .ok_or_else(|| "The AOT test CLI is not ready.".into())
}

pub(crate) fn status(cli: &OpenClawCli) -> Result<GatewaySnapshot, String> {
    let (running, path) = {
        let mut child = GATEWAY
            .lock()
            .map_err(|_| "AOT test Gateway lock failed.")?;
        if child
            .as_mut()
            .is_some_and(|child| child.try_wait().ok().flatten().is_some())
        {
            *child = None;
        }
        (child.is_some(), cli.executable_path().to_path_buf())
    };
    let reachable = running
        && cli
            .json::<serde_json::Value, _, _>(["gateway", "status", "--json"])
            .ok()
            .and_then(|value| {
                value
                    .pointer("/rpc/ok")
                    .and_then(serde_json::Value::as_bool)
            })
            .unwrap_or(false);
    Ok(GatewaySnapshot {
        phase: if reachable { "connected" } else if running { "reconnecting" } else { "stopped" },
        installed: true, running, reachable,
        status: if reachable { "Connected" } else if running { "Starting AOT test Gateway" } else { "Stopped" }.into(),
        detail: Some("AOT test profile: app-owned foreground Gateway on port 19876; no system service is installed.".into()),
        setup_error: None, runtime_path: Some(path),
    })
}

pub(crate) fn start(cli: &OpenClawCli) -> Result<(), String> {
    {
        let mut current = GATEWAY
            .lock()
            .map_err(|_| "AOT test Gateway lock failed.")?;
        if current
            .as_mut()
            .is_some_and(|child| child.try_wait().ok().flatten().is_none())
        {
            return Ok(());
        }
        let address = SocketAddr::from(([127, 0, 0, 1], PORT));
        if TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok() {
            return Err("Port 19876 is already occupied. The AOT test app will not stop or adopt that process.".into());
        }
        let logs = state_root()?.join("logs");
        fs::create_dir_all(&logs).map_err(|error| error.to_string())?;
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join("desktop-gateway.log"))
            .map_err(|error| error.to_string())?;
        let mut command = cli
            .command([
                "gateway",
                "run",
                "--port",
                "19876",
                "--bind",
                "loopback",
                "--allow-unconfigured",
            ])
            .map_err(|error| error.to_string())?;
        command
            .stdout(Stdio::from(
                log.try_clone().map_err(|error| error.to_string())?,
            ))
            .stderr(Stdio::from(log));
        *current = Some(
            command
                .spawn()
                .map_err(|error| format!("AOT test Gateway failed to start: {error}"))?,
        );
    }
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let snapshot = status(cli)?;
        if snapshot.reachable {
            return Ok(());
        }
        if !snapshot.running || Instant::now() >= deadline {
            return Err("AOT test Gateway did not become ready. See ~/.openclaw-aot-test/logs/desktop-gateway.log.".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[derive(Debug)]
enum ChildStop {
    Exited(std::process::ExitStatus),
    Forced,
}

fn stop_child(child: &mut Child, budget: Duration) -> Result<ChildStop, String> {
    if let Some(exit) = child.try_wait().map_err(|error| error.to_string())? {
        return Ok(ChildStop::Exited(exit));
    }
    #[cfg(unix)]
    {
        let sent = unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
        if sent != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!("Could not stop AOT test Gateway: {error}"));
            }
        }
        let deadline = Instant::now() + budget;
        loop {
            if let Some(exit) = child.try_wait().map_err(|error| error.to_string())? {
                return Ok(ChildStop::Exited(exit));
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    #[cfg(not(unix))]
    let _ = budget;
    child.kill().map_err(|error| error.to_string())?;
    child.wait().map_err(|error| error.to_string())?;
    Ok(ChildStop::Forced)
}

pub(crate) fn stop() -> Result<(), String> {
    if !enabled() {
        return Ok(());
    }
    let budget = Duration::from_millis(
        option_env!("OPENCLAW_GATEWAY_SERVICE_STOP_TIMEOUT_MS")
            .expect("AOT test profile requires its compiled Gateway shutdown budget")
            .parse()
            .expect("compiled Gateway shutdown budget"),
    );
    let mut current = GATEWAY
        .lock()
        .map_err(|_| "AOT test Gateway lock failed.")?;
    let Some(child) = current.as_mut() else {
        return Ok(());
    };
    let outcome = stop_child(child, budget)?;
    *current = None;
    match outcome {
        ChildStop::Exited(exit) if exit.success() => Ok(()),
        ChildStop::Exited(exit) => Err(format!("AOT test Gateway shutdown exited with {exit}.")),
        ChildStop::Forced => Err(format!(
            "AOT test Gateway was force-stopped after {} seconds; shutdown did not finish cleanly. Inspect ~/.openclaw-aot-test/logs/desktop-gateway.log before starting it again.",
            budget.as_secs()
        )),
    }
}

pub(crate) fn handle_run_event(event: &tauri::RunEvent) -> Result<(), String> {
    // macOS's native Quit sends Exit without first sending ExitRequested.
    if matches!(event, tauri::RunEvent::Exit) {
        stop()
    } else {
        Ok(())
    }
}

pub(crate) fn action(cli: &OpenClawCli, action: GatewayAction) -> Result<GatewaySnapshot, String> {
    if matches!(action, GatewayAction::Stop | GatewayAction::Restart) {
        stop()?;
    }
    if matches!(action, GatewayAction::Start | GatewayAction::Restart) {
        start(cli)?;
    }
    status(cli)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn terminal_exit_drains_the_app_owned_gateway() {
        use std::io::{BufRead, BufReader};

        if !enabled() {
            assert!(handle_run_event(&tauri::RunEvent::Exit).is_ok());
            return;
        }
        struct Cleanup;
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Some(mut child) = GATEWAY
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take()
                {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }

        let mut child = Command::new("node")
            .args([
                "--eval",
                "process.on('SIGTERM', () => process.exit(0)); process.stdin.resume(); console.log('ready');",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready, "ready\n");
        let _cleanup = Cleanup;
        let previous = GATEWAY.lock().unwrap().replace(child);
        assert!(previous.is_none());
        handle_run_event(&tauri::RunEvent::Ready).unwrap();
        let running = GATEWAY
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none();
        assert!(running);
        handle_run_event(&tauri::RunEvent::Exit).unwrap();
        let stopped = GATEWAY.lock().unwrap().is_none();
        assert!(stopped, "terminal app exit left its Gateway running");
    }

    #[cfg(unix)]
    #[test]
    fn owned_child_finishes_its_drain_or_reports_a_forced_stop() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::os::unix::process::ExitStatusExt;

        struct TestChild(Child);
        impl Drop for TestChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        for drains in [true, false] {
            let script = r#"
                process.on('SIGTERM', () => {
                    process.stdout.write('draining\n');
                    if (process.argv[1] === 'drain') {
                        process.stdin.once('data', () => {
                            process.stdout.write('drained\n', () => process.exit(0));
                        });
                    }
                });
                process.stdin.resume();
                process.stdout.write('ready\n');
            "#;
            let mut child = TestChild(
                Command::new("node")
                    .args(["--eval", script, if drains { "drain" } else { "hold" }])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
            let mut output = BufReader::new(child.0.stdout.take().unwrap());
            let mut ready = String::new();
            output.read_line(&mut ready).unwrap();
            assert_eq!(ready, "ready\n");
            let mut input = child.0.stdin.take().unwrap();
            if drains {
                let drain = std::thread::spawn(move || {
                    let mut started = String::new();
                    output.read_line(&mut started).unwrap();
                    assert_eq!(started, "draining\n");
                    input.write_all(b"finish\n").unwrap();
                    let mut completed = String::new();
                    output.read_to_string(&mut completed).unwrap();
                    completed
                });
                assert!(matches!(
                    stop_child(&mut child.0, Duration::from_secs(2)).unwrap(),
                    ChildStop::Exited(exit) if exit.success()
                ));
                assert_eq!(drain.join().unwrap(), "drained\n");
            } else {
                assert!(matches!(
                    stop_child(&mut child.0, Duration::from_millis(100)).unwrap(),
                    ChildStop::Forced
                ));
                assert_eq!(
                    child.0.try_wait().unwrap().unwrap().signal(),
                    Some(libc::SIGKILL)
                );
            }
        }
    }

    #[test]
    fn fixed_profile_keeps_state_service_and_port_out_of_default_namespace() {
        let root = Path::new("/Users/fixture/.openclaw-aot-test");
        let env = profile_environment(root)
            .into_iter()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(env["OPENCLAW_STATE_DIR"], root.as_os_str());
        assert_eq!(
            env["OPENCLAW_WORKSPACE_DIR"],
            root.join("workspace").as_os_str()
        );
        assert_eq!(env["OPENCLAW_PROFILE"], "aot-test");
        assert_eq!(env["OPENCLAW_GATEWAY_PORT"], "19876");
        assert_eq!(env["OPENCLAW_LAUNCHD_LABEL"], "ai.openclaw.aot-test");
        assert_eq!(env["OPENCLAW_SUPERVISOR_MODE"], "external");
        assert_eq!(env["OPENCLAW_SERVICE_REPAIR_POLICY"], "external");
        assert_eq!(
            env["OPENCLAW_CONFIG_PATH"],
            root.join("openclaw.json").as_os_str()
        );
    }
}
