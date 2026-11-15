use crate::cli::openclaw_home;
use crate::cli::{OpenClawCli, SpawnCommand};
use serde::Deserialize;
use serde::Serialize;
use std::collections::VecDeque;
#[cfg(any(target_os = "windows", test))]
use std::io::Write;
use std::io::{BufRead, BufReader};
#[cfg(target_os = "windows")]
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::thread;
#[cfg(not(target_os = "windows"))]
use tauri::path::BaseDirectory;
use tauri::AppHandle;
use tauri::{Emitter, Manager};

const INSTALL_EVENT: &str = "install-progress";
const ERROR_TAIL_LINES: usize = 24;

#[cfg(any(target_os = "windows", test))]
fn prepare_package_root(prefix: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let root = prefix.join("tools/openclaw");
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    // Without its own manifest, Bun can install into an ancestor's unrelated project.
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join("package.json"))
    {
        Ok(mut file) => file
            .write_all(b"{\"name\":\"openclaw-desktop-runtime\",\"private\":true}\n")
            .map_err(|error| error.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(format!(
                "Could not initialize the private CLI package: {error}"
            ))
        }
    }
    Ok(root)
}

pub(crate) fn managed_launcher_absent(prefix: &std::path::Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(crate::cli::managed_launcher(prefix)) {
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
    pub(crate) fn for_build(
        release_build: bool,
        runtime: Option<crate::runtime_action::RuntimeFlavor>,
    ) -> Self {
        if release_build || runtime.is_some() {
            Self::Stable
        } else {
            Self::Dev
        }
    }

    pub(crate) fn require_available(
        self,
        runtime: Option<crate::runtime_action::RuntimeFlavor>,
    ) -> Result<(), String> {
        if runtime.is_some() && !matches!(self, Self::Stable) {
            return Err("This app installs its bundled OpenClaw runtime. Beta and Development channels are unavailable; update the desktop app to change versions.".into());
        }
        Ok(())
    }

    fn version(self) -> &'static str {
        match self {
            Self::Stable => "latest",
            Self::Beta => "beta",
            Self::Dev => "main",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress<'a> {
    stream: &'a str,
    line: &'a str,
}

#[cfg(target_os = "windows")]
fn configure_installer_environment(command: &mut Command) -> Result<(), String> {
    // Published package checks compare Bun's temporary Node shim paths. Windows
    // 8.3 TEMP aliases make the same shim look like a different, persistent Node.
    let temporary = std::fs::canonicalize(std::env::temp_dir())
        .map_err(|error| format!("Installer temporary directory is unavailable: {error}"))?;
    let temporary = crate::runtime_action::windows_process_path(&temporary)?;
    command.env("TEMP", &temporary).env("TMP", &temporary);
    Ok(())
}

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
    Ok(cli)
}

fn install_at(
    app: &AppHandle,
    channel: InstallChannel,
    prefix: std::path::PathBuf,
    version: &str,
    #[cfg_attr(target_os = "windows", allow(unused_variables))] runtime_only: bool,
    spawn: Option<&SpawnCommand<'_>>,
) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    if let Some((runtime, entry)) = crate::bundled_runtime::seed_cli(app, &prefix)? {
        return crate::runtime_action::install_launcher(
            &prefix,
            &runtime,
            &entry,
            if spawn.is_some() {
                crate::runtime_action::Purpose::Browser
            } else {
                crate::runtime_action::Purpose::Gateway
            },
        );
    }
    #[cfg(not(target_os = "windows"))]
    let mut command = {
        let script = app
            .path()
            .resolve("install-cli.sh", BaseDirectory::Resource)
            .map_err(|error| format!("Bundled installer is unavailable: {error}"))?;
        let mut command = crate::cli::host_command("bash");
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
    };
    #[cfg(target_os = "windows")]
    let (mut command, runtime, entry) = {
        if matches!(channel, InstallChannel::Dev) {
            return Err("For Windows development builds, build the CLI from source and select it with OPENCLAW_DESKTOP_CLI. Use Stable or Beta for app-managed installation.".into());
        }
        let runtime = crate::bundled_runtime::seed(app)?;
        let package_root = prepare_package_root(&prefix)?;
        let mut command = Command::new(&runtime.executable);
        configure_installer_environment(&mut command)?;
        // This private root has no dev dependencies; Bun rejects --production with --trust.
        command
            .args(["add", "--exact", "--trust"])
            .arg(format!("openclaw@{version}"))
            .current_dir(&package_root)
            .env("OPENCLAW_PACKAGE_BUN_LAUNCHER", &runtime.executable);
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
        let entry = package_root.join("node_modules/openclaw/openclaw.mjs");
        (command, runtime, entry)
    };
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
        #[cfg(target_os = "windows")]
        crate::runtime_action::install_launcher(
            &prefix,
            &runtime,
            &entry,
            crate::runtime_action::Purpose::Gateway,
        )?;
        return Ok(());
    }

    let detail = tail.into_iter().collect::<Vec<_>>().join("\n");
    if detail.is_empty() {
        Err(format!("Installer exited with {status}"))
    } else {
        Err(format!("Installer exited with {status}\n{detail}"))
    }
}

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

#[cfg(test)]
mod tests {
    #[cfg(not(target_os = "windows"))]
    use super::managed_launcher_absent;
    use super::prepare_package_root;
    use super::InstallChannel;
    use crate::runtime_action::RuntimeFlavor;

    #[test]
    fn bundled_installs_reject_other_channels_and_default_to_the_bundle() {
        for runtime in [Some(RuntimeFlavor::Jit), Some(RuntimeFlavor::Aot)] {
            for release_build in [false, true] {
                assert!(matches!(
                    InstallChannel::for_build(release_build, runtime),
                    InstallChannel::Stable
                ));
            }
            assert!(InstallChannel::Stable.require_available(runtime).is_ok());
            for channel in [InstallChannel::Beta, InstallChannel::Dev] {
                assert!(channel
                    .require_available(runtime)
                    .unwrap_err()
                    .contains("update the desktop app"));
            }
        }
    }

    #[test]
    fn builds_without_a_bundle_keep_the_channel_choices() {
        assert!(matches!(
            InstallChannel::for_build(true, None),
            InstallChannel::Stable
        ));
        assert!(matches!(
            InstallChannel::for_build(false, None),
            InstallChannel::Dev
        ));
        for channel in [
            InstallChannel::Stable,
            InstallChannel::Beta,
            InstallChannel::Dev,
        ] {
            assert!(channel.require_available(None).is_ok());
        }
    }

    #[test]
    fn private_package_root_prevents_ancestor_selection_and_preserves_retry_metadata() {
        let root = std::env::temp_dir().join(format!("openclaw-package-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let ancestor = b"{\"name\":\"unrelated-project\",\"private\":true}\n";
        std::fs::write(root.join("package.json"), ancestor).unwrap();
        let prefix = root.join("state");
        let package = prepare_package_root(&prefix).unwrap();
        let manifest = package.join("package.json");
        let created: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        assert_eq!(created["private"], true);
        let installed = b"{\"private\":true,\"dependencies\":{\"openclaw\":\"2026.9.9\"}}\n";
        std::fs::write(&manifest, installed).unwrap();
        assert_eq!(prepare_package_root(&prefix).unwrap(), package);
        assert_eq!(std::fs::read(&manifest).unwrap(), installed);
        assert_eq!(std::fs::read(root.join("package.json")).unwrap(), ancestor);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(target_os = "windows"))]
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
            crate::cli::managed_launcher(&prefix),
        )
        .unwrap();
        assert!(!managed_launcher_absent(&prefix).unwrap());
        assert!(prefix.join("openclaw.json").is_file());
        std::fs::remove_dir_all(prefix).unwrap();
    }
}
