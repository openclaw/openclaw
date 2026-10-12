#[cfg(not(target_os = "windows"))]
use crate::cli::openclaw_home;
use crate::cli::{OpenClawCli, SpawnCommand};
use serde::Deserialize;
#[cfg(not(target_os = "windows"))]
use serde::Serialize;
#[cfg(not(target_os = "windows"))]
use std::collections::VecDeque;
#[cfg(not(target_os = "windows"))]
use std::io::{BufRead, BufReader};
#[cfg(not(target_os = "windows"))]
use std::process::{Command, Stdio};
#[cfg(not(target_os = "windows"))]
use std::sync::mpsc;
#[cfg(not(target_os = "windows"))]
use std::thread;
#[cfg(not(target_os = "windows"))]
use tauri::path::BaseDirectory;
use tauri::AppHandle;
#[cfg(not(target_os = "windows"))]
use tauri::{Emitter, Manager};

#[cfg(not(target_os = "windows"))]
const INSTALL_EVENT: &str = "install-progress";
#[cfg(not(target_os = "windows"))]
const ERROR_TAIL_LINES: usize = 24;

#[cfg(not(target_os = "windows"))]
pub(crate) fn managed_launcher_absent(prefix: &std::path::Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(prefix.join("bin/openclaw")) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(format!(
            "Could not inspect the existing CLI launcher: {error}"
        )),
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallChannel {
    Stable,
    Beta,
    Dev,
}

impl InstallChannel {
    #[cfg(not(target_os = "windows"))]
    fn version(self) -> &'static str {
        match self {
            Self::Stable => "latest",
            Self::Beta => "beta",
            Self::Dev => "main",
        }
    }
}

#[cfg(not(target_os = "windows"))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress<'a> {
    stream: &'a str,
    line: &'a str,
}

#[cfg(target_os = "windows")]
pub fn install(_app: &AppHandle, _channel: InstallChannel, _fresh: bool) -> Result<(), String> {
    Err("CLI installation is unavailable in this Windows test build.".to_string())
}

#[cfg(not(target_os = "windows"))]
fn configure_installer_environment(command: &mut Command) {
    // The AppImage runtime exports its bundled usr/lib (Ubuntu 22.04, OpenSSL 3.0)
    // through LD_LIBRARY_PATH. The bundled installer drives host tools (curl, wget,
    // tar, git, and the downloaded Node), so they must resolve against host
    // libraries. Otherwise a newer host libcurl loads the older bundled libssl and
    // aborts with "OPENSSL_3.2.0 not found" (issue #146088).
    command.env_remove("LD_LIBRARY_PATH");
}

#[cfg(not(target_os = "windows"))]
pub fn install(app: &AppHandle, channel: InstallChannel, fresh: bool) -> Result<(), String> {
    let prefix = openclaw_home().map_err(|error| error.to_string())?;
    let app_version = app.package_info().version.to_string();
    let version = if fresh
        && matches!(channel, InstallChannel::Stable)
        && crate::is_release_version(&app_version)
    {
        app_version.as_str()
    } else {
        channel.version()
    };
    // Fresh setup publishes its service only after the app has admitted Bun.
    install_at(app, channel, prefix, version, fresh, None)
}

#[cfg(target_os = "windows")]
pub(crate) fn browser_runtime(
    _app: &AppHandle,
    _allow_install: bool,
    _is_current: &dyn Fn() -> bool,
    _spawn: &SpawnCommand<'_>,
) -> Result<OpenClawCli, String> {
    Err("Browser runtime installation is unavailable in this Windows test build.".into())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn browser_runtime(
    app: &AppHandle,
    allow_install: bool,
    is_current: &dyn Fn() -> bool,
    spawn: &SpawnCommand<'_>,
) -> Result<OpenClawCli, String> {
    let version = app.package_info().version.to_string();
    let release_build = crate::is_release_version(&version);
    if let Ok(cli) = OpenClawCli::discover() {
        if !release_build || cli.matches_version(&version) {
            return Ok(cli);
        }
    }
    if !release_build {
        return Err("Development builds need a local OpenClaw CLI for Chrome setup.".into());
    }
    // A missing CLI wrapper does not prove a Gateway has stopped using its package.
    // Keep browser-only downloads outside that install and pin them to this app release.
    let prefix = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Browser runtime location is unavailable: {error}"))?
        .join("browser-runtime")
        .join(&version);
    for directory in [
        prefix.parent().expect("versioned runtime parent"),
        prefix.as_path(),
    ] {
        match std::fs::symlink_metadata(directory) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err("Browser runtime directory is unavailable or redirected.".into()),
        }
    }
    if let Ok(cli) = OpenClawCli::browser_runtime(prefix.clone()) {
        if cli.matches_version(&version) {
            return Ok(cli);
        }
    }
    // This reserved app-data artifact may be incomplete after an interrupted download.
    // The canonical installer can repair it without touching the ordinary Gateway install.
    if !allow_install {
        return Err("Prepare the local browser runtime with the install action first.".into());
    }
    if !is_current() {
        return Err("The native browser document changed.".into());
    }
    install_at(
        app,
        InstallChannel::Stable,
        prefix.clone(),
        &version,
        true,
        Some(spawn),
    )?;
    let cli = OpenClawCli::browser_runtime(prefix).map_err(|error| error.to_string())?;
    if !cli.matches_version(&version) {
        return Err("The browser runtime does not match this app version.".into());
    }
    if !is_current() {
        return Err("The native browser document changed.".into());
    }
    #[cfg(target_os = "linux")]
    {
        let runtime = crate::bundled_runtime::seed(app)?;
        crate::runtime_action::bind_runtime(
            &cli,
            &runtime,
            crate::runtime_action::Purpose::Browser,
        )?;
    }
    Ok(cli)
}

#[cfg(not(target_os = "windows"))]
fn install_at(
    app: &AppHandle,
    channel: InstallChannel,
    prefix: std::path::PathBuf,
    version: &str,
    runtime_only: bool,
    spawn: Option<&SpawnCommand<'_>>,
) -> Result<(), String> {
    let script = app
        .path()
        .resolve("install-cli.sh", BaseDirectory::Resource)
        .map_err(|error| format!("Bundled installer is unavailable: {error}"))?;
    let mut command = Command::new("bash");
    configure_installer_environment(&mut command);
    command
        .arg(script)
        .args(["--json", "--no-onboard", "--prefix"])
        .arg(&prefix)
        .args(["--version", version]);
    if runtime_only {
        command.arg("--runtime-only");
        if !matches!(channel, InstallChannel::Dev) {
            command.arg("--npm");
        }
    }
    if matches!(channel, InstallChannel::Dev) {
        command
            .args(["--install-method", "git", "--git-dir"])
            .arg(prefix.join("dev/openclaw"));
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match spawn {
        Some(spawn) => spawn(&mut command),
        None => command.spawn().map_err(|error| error.to_string()),
    }
    .map_err(|error| format!("Could not start bundled installer: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read installer output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read installer errors".to_string())?;
    let (sender, receiver) = mpsc::channel::<(&'static str, String)>();

    let stdout_thread = stream_lines("stdout", stdout, sender.clone());
    let stderr_thread = stream_lines("stderr", stderr, sender);
    let mut tail = VecDeque::with_capacity(ERROR_TAIL_LINES);
    for (stream, line) in receiver {
        if spawn.is_none() {
            let _ = app.emit_to(
                "main",
                INSTALL_EVENT,
                InstallProgress {
                    stream,
                    line: &line,
                },
            );
        }
        // Structured step events belong to the log pane; the failure tail is
        // shown as prose and must keep only human-readable diagnostics.
        if serde_json::from_str::<serde_json::Value>(&line)
            .is_ok_and(|value| value.get("event").is_some())
        {
            continue;
        }
        if tail.len() == ERROR_TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line);
    }

    let status = child
        .wait()
        .map_err(|error| format!("Could not wait for bundled installer: {error}"))?;
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    if status.success() {
        return Ok(());
    }

    let detail = tail.into_iter().collect::<Vec<_>>().join("\n");
    if detail.is_empty() {
        Err(format!("Installer exited with {status}"))
    } else {
        Err(format!("Installer exited with {status}\n{detail}"))
    }
}

#[cfg(not(target_os = "windows"))]
fn stream_lines<R>(
    stream: &'static str,
    reader: R,
    sender: mpsc::Sender<(&'static str, String)>,
) -> thread::JoinHandle<()>
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if sender.send((stream, line)).is_err() {
                break;
            }
        }
    })
}

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::{configure_installer_environment, managed_launcher_absent};
    use std::process::Command;

    #[test]
    fn existing_state_is_not_a_cli_install_but_a_dangling_launcher_is() {
        let prefix =
            std::env::temp_dir().join(format!("openclaw-install-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(prefix.join("bin")).unwrap();
        std::fs::write(
            prefix.join("openclaw.json"),
            "{\"gateway\":{\"mode\":\"local\"}}\n",
        )
        .unwrap();
        assert!(managed_launcher_absent(&prefix).unwrap());
        std::os::unix::fs::symlink(
            prefix.join("missing-external-cli"),
            prefix.join("bin/openclaw"),
        )
        .unwrap();
        assert!(!managed_launcher_absent(&prefix).unwrap());
        assert!(prefix.join("openclaw.json").is_file());
        std::fs::remove_dir_all(prefix).unwrap();
    }

    #[test]
    fn installer_child_does_not_inherit_the_appimage_library_path() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "printf '%s' \"${LD_LIBRARY_PATH-unset}\""])
            .env("LD_LIBRARY_PATH", "/tmp/appimage/usr/lib");
        configure_installer_environment(&mut command);

        let output = command.output().expect("installer environment probe");
        assert!(output.status.success(), "probe failed: {output:?}");
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "unset",
            "the installer child must not inherit the AppImage library path"
        );
    }
}
