//! Bundled runtime selection is an explicit action; status and launcher markers grant no authority.
use crate::cli::{output_tail, OpenClawCli};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(not(target_os = "windows"))]
const MARKER: &str = "# OpenClaw-Tauri runtime v1 ";
#[cfg(target_os = "windows")]
const MARKER: &str = "@rem # OpenClaw-Tauri runtime v1 ";
const CHANGED: &str = "The Gateway runtime or service definition changed. Its current selection was preserved; inspect it before retrying.";
const PAUSED: &str = "The Gateway is paused. Start it before choosing Use bundled runtime.";
const UPGRADE: &str = "Update the installed OpenClaw CLI before selecting the bundled runtime; this CLI cannot verify the current runtime pin and service definition.";
const UNHEALTHY: &str = "The Gateway did not become healthy on the bundled runtime.";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct BundledRuntime {
    // Existing managed launcher markers persist this key; keep them readable on upgrade.
    #[serde(rename = "bun")]
    pub executable: PathBuf,
    pub sqlite: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "RuntimeFlavor::is_jit")]
    pub flavor: RuntimeFlavor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RuntimeFlavor {
    #[default]
    Jit,
    Aot,
}

impl RuntimeFlavor {
    fn is_jit(&self) -> bool {
        *self == Self::Jit
    }

    pub(crate) fn service_kind(self) -> &'static str {
        match self {
            Self::Jit => "bun",
            Self::Aot => "standalone",
        }
    }
}

impl BundledRuntime {
    fn arguments(&self, entry: &Path) -> Vec<std::ffi::OsString> {
        match self.flavor {
            RuntimeFlavor::Jit => vec!["--no-install".into(), entry.as_os_str().into()],
            RuntimeFlavor::Aot => Vec::new(),
        }
    }

    pub(crate) fn command(&self, entry: &Path) -> Command {
        let mut command = Command::new(&self.executable);
        command.args(self.arguments(entry));
        command
            .env_remove("OPENCLAW_SQLITE_LIBRARY")
            .env_remove("LD_LIBRARY_PATH")
            .env_remove("BUN_BE_BUN");
        if let Some(sqlite) = &self.sqlite {
            command.env("OPENCLAW_SQLITE_LIBRARY", sqlite);
        }
        command
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Purpose {
    Gateway,
    Browser,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct Launcher {
    purpose: Purpose,
    runtime: BundledRuntime,
    entry: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retention: Option<RuntimeRetention>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct RuntimeRetention {
    current: PathBuf,
    previous: Option<PathBuf>,
}

struct LauncherFile {
    path: PathBuf,
    bytes: Vec<u8>,
    entry: PathBuf,
    selection: Option<Launcher>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ExpectedPin {
    revision: String,
    definition: Option<String>,
}

/// The exact observation displayed before the user confirms; never replace it after confirmation.
#[derive(Clone, Debug)]
pub(crate) struct Observation(Value);

impl Observation {
    fn text(&self, pointer: &str) -> Option<&str> {
        self.0.pointer(pointer).and_then(Value::as_str)
    }

    fn flag(&self, pointer: &str) -> Option<bool> {
        self.0.pointer(pointer).and_then(Value::as_bool)
    }

    fn number(&self, pointer: &str) -> Option<u64> {
        self.0.pointer(pointer).and_then(Value::as_u64)
    }

    pub(crate) fn current_runtime(&self) -> String {
        let path = self.runtime_path();
        let kind = self
            .text("/service/runtimeIntent/pin/runtime")
            .unwrap_or("runtime");
        match path {
            Some(path) => format!("{kind}: {}", path.display()),
            None => "No installed Gateway service".into(),
        }
    }

    pub(crate) fn uses_runtime_path(&self, expected: &Path) -> bool {
        self.runtime_path().is_some_and(|path| {
            path == expected || fs::canonicalize(path).ok().as_deref() == Some(expected)
        })
    }

    pub(crate) fn paused(&self) -> bool {
        self.command().is_some()
            && (self.flag("/service/loaded") == Some(false)
                || self.text("/service/runtime/status") == Some("stopped"))
    }

    fn command(&self) -> Option<&Vec<Value>> {
        self.0
            .pointer("/service/command/programArguments")
            .and_then(Value::as_array)
    }

    fn runtime_path(&self) -> Option<&Path> {
        self.command()?.first()?.as_str().map(Path::new)
    }

    fn absent(&self) -> bool {
        self.flag("/service/loaded") == Some(false)
            && self
                .0
                .pointer("/service/command")
                .is_none_or(Value::is_null)
    }

    fn expected_pin(&self) -> Result<ExpectedPin, String> {
        let intent = self.0.pointer("/service/runtimeIntent").ok_or(UPGRADE)?;
        if intent.get("status").and_then(Value::as_str) != Some("known") {
            return Err(UPGRADE.into());
        }
        serde_json::from_value(intent.clone()).map_err(|_| UPGRADE.into())
    }

    fn admit(&self, fresh: bool) -> Result<(), String> {
        let pin = self.expected_pin()?;
        if self.paused() {
            return Err(PAUSED.into());
        }
        // Creation has no definition to replace; the CLI still owns platform permissions.
        let mutation = self.text("/service/definitionMutation");
        if mutation == Some("sealed")
            || (!fresh && mutation != Some("writable"))
            || self.flag("/service/launcherOverridden") == Some(true)
            || self.flag("/config/mismatch") == Some(true)
            || self.text("/service/revision").is_none()
            || !self
                .text("/config/daemon/path")
                .is_some_and(|path| Path::new(path).is_absolute())
        {
            return Err("The Gateway service definition cannot be safely replaced. Inspect Gateway status before retrying.".into());
        }
        if fresh {
            if !self.absent() || pin.definition.is_some() {
                return Err(CHANGED.into());
            }
        } else if self.command().is_none()
            || pin.definition.is_none()
            || self.flag("/service/loaded") != Some(true)
            || self.text("/service/runtime/status") != Some("running")
            || self.text("/service/targetRole") != Some("target")
        {
            return Err(
                "The Gateway runtime state is unknown. Check Gateway status before retrying."
                    .into(),
            );
        }
        Ok(())
    }

    fn unchanged_from(&self, expected: &Self, fresh: bool) -> Result<(), String> {
        self.admit(fresh)?;
        if self.expected_pin()? != expected.expected_pin()?
            || self.0.pointer("/service/revision") != expected.0.pointer("/service/revision")
            || self.0.pointer("/config/daemon/path") != expected.0.pointer("/config/daemon/path")
            || self.0.pointer("/gateway/port") != expected.0.pointer("/gateway/port")
        {
            return Err(CHANGED.into());
        }
        Ok(())
    }

    fn healthy_for(&self, runtime: &BundledRuntime) -> bool {
        let Some(pid) = self.number("/service/runtime/pid").filter(|pid| *pid > 0) else {
            return false;
        };
        let Some(port) = self.number("/port/port").filter(|port| *port > 0) else {
            return false;
        };
        self.uses_runtime_path(&runtime.executable)
            && self.text("/service/runtimeIntent/pin/runtime")
                == Some(runtime.flavor.service_kind())
            && self
                .text("/service/runtimeIntent/pin/path")
                .is_some_and(|path| {
                    Path::new(path) == runtime.executable
                        || (cfg!(target_os = "windows")
                            && fs::canonicalize(path).ok().as_deref()
                                == Some(runtime.executable.as_path()))
                })
            && self.flag("/service/loaded") == Some(true)
            && self.text("/service/targetRole") == Some("target")
            && self.text("/service/runtime/status") == Some("running")
            && self.text("/port/status") == Some("busy")
            && self.number("/gateway/port") == Some(port)
            && self
                .0
                .pointer("/port/listeners")
                .and_then(Value::as_array)
                .is_some_and(|listeners| {
                    // Process diagnostics are optional; reported foreign owners still reject health.
                    listeners.iter().all(|listener| {
                        listener.get("pid").and_then(Value::as_u64) == Some(pid)
                            || listener.get("ppid").and_then(Value::as_u64) == Some(pid)
                    })
                })
            && self.flag("/rpc/ok") == Some(true)
    }

    fn check_health(&self, runtime: &BundledRuntime, fresh: bool) -> Result<bool, &'static str> {
        if self.healthy_for(runtime) {
            Ok(true)
        } else if !fresh && self.paused() {
            Err(UNHEALTHY)
        } else {
            // A newly installed Windows login item can still be starting after
            // install returns. Keep its existing health deadline while it starts.
            Ok(false)
        }
    }

    fn selected_runtime_path(&self) -> Option<&Path> {
        self.text("/service/runtimeIntent/pin/path")
            .map(Path::new)
            .or_else(|| self.runtime_path())
    }

    fn previous_runtime_command(&self) -> String {
        let path = self.selected_runtime_path();
        let kind = self
            .text("/service/runtimeIntent/pin/runtime")
            .unwrap_or_else(|| {
                if path
                    .and_then(Path::file_name)
                    .is_some_and(|name| name == "bun")
                {
                    "bun"
                } else {
                    "node"
                }
            });
        let mut command = format!("openclaw gateway install --force --runtime {kind}");
        if let Some(path) = path {
            if let Ok(path) = quote(path) {
                command.push_str(&format!(" --runtime-path {path}"));
            }
        }
        command
    }
}

/// Service inspection and installation use the selected artifact even when the old
/// managed CLI predates this runtime flavor. Its launcher changes only after health.
pub(crate) fn select_cli(
    cli: &OpenClawCli,
    runtime: &BundledRuntime,
) -> Result<OpenClawCli, String> {
    let entry = runtime
        .entry
        .clone()
        .or_else(|| (runtime.flavor == RuntimeFlavor::Aot).then(|| runtime.executable.clone()));
    let Some(entry) = entry else {
        if read_launcher(cli)?.is_some_and(|launcher| {
            launcher
                .selection
                .is_some_and(|selection| selection.runtime.flavor == RuntimeFlavor::Aot)
        }) {
            return Err("This JIT build needs its matching OpenClaw package. Install the CLI from this app before switching from AOT.".into());
        }
        return Ok(cli.clone());
    };
    Ok(cli.with_bundled_runtime(runtime, entry))
}

/// Read-only: safe to use while displaying or refreshing the runtime action.
pub(crate) fn inspect(cli: &OpenClawCli) -> Result<Observation, String> {
    capture(cli, false)
}

/// Explicit first-run setup records an existing managed launcher only after successful health checks.
pub(crate) fn fresh(
    cli: &OpenClawCli,
    runtime: &BundledRuntime,
    is_current: &dyn Fn() -> bool,
) -> Result<(), String> {
    let launcher = read_launcher(cli)?;
    let selected_cli = select_cli(cli, runtime)?;
    let cli = &selected_cli;
    validate_runtime(runtime)?;
    let observed = inspect(cli)?;
    if !observed.absent() {
        return Err(CHANGED.into());
    }
    match observed.text("/service/runtimeIntent/status") {
        Some("known") => observed.admit(true)?,
        Some("migrationPending") => {}
        _ => return Err(UPGRADE.into()),
    }
    // Baseline setup owns fresh config, workspace, and runtime-pin initialization.
    check_current(is_current)?;
    let output = checked_output(
        cli.command(["setup", "--baseline", "--json"])
            .map_err(|error| error.to_string())?,
        "Baseline setup",
    )?;
    let result: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Baseline setup returned invalid JSON.")?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("Baseline setup did not succeed.".into());
    }
    let confirmed = inspect(cli)?;
    let healthy = perform(
        cli,
        runtime,
        &confirmed,
        true,
        is_current,
        Duration::from_secs(600),
    )?;
    if let Some(launcher) = launcher {
        check_current(is_current)?;
        publish_launcher(&launcher, runtime, Purpose::Gateway).map_err(|error| {
            format!("The Gateway was installed, but recording its launcher marker failed: {error}")
        })?;
    }
    collect_after_healthy(cli, runtime, &confirmed, &healthy, is_current);
    Ok(())
}

/// An explicit confirmation is the only admission path for an existing service.
pub(crate) fn activate(
    cli: &OpenClawCli,
    runtime: &BundledRuntime,
    confirmed: &Observation,
    is_current: &dyn Fn() -> bool,
) -> Result<(), String> {
    let launcher = read_launcher(cli)?;
    let selected_cli = select_cli(cli, runtime)?;
    let cli = &selected_cli;
    let healthy = perform(
        cli,
        runtime,
        confirmed,
        false,
        is_current,
        Duration::from_secs(600),
    )?;
    if let Some(launcher) = launcher {
        check_current(is_current)?;
        publish_launcher(&launcher, runtime, Purpose::Gateway)?;
    }
    collect_after_healthy(cli, runtime, confirmed, &healthy, is_current);
    Ok(())
}

fn perform(
    cli: &OpenClawCli,
    runtime: &BundledRuntime,
    confirmed: &Observation,
    fresh: bool,
    is_current: &dyn Fn() -> bool,
    health_timeout: Duration,
) -> Result<Observation, String> {
    check_current(is_current)?;
    validate_runtime(runtime)?;
    confirmed.admit(fresh)?;
    inspect(cli)?.unchanged_from(confirmed, fresh)?;
    check_current(is_current)?;
    let result = install(cli, runtime, confirmed).and_then(|()| {
        let deadline = Instant::now() + health_timeout;
        loop {
            check_current(is_current)?;
            let observed = capture(cli, true)?;
            if observed.check_health(runtime, fresh)? {
                return Ok(observed);
            }
            if Instant::now() >= deadline {
                return Err(UNHEALTHY.into());
            }
            thread::sleep(Duration::from_secs(2));
        }
    });
    result.map_err(|error| {
        let recovery = if fresh {
            "To install with Node manually"
        } else {
            "To select the previous runtime manually"
        };
        format!(
            "Bundled runtime activation failed: {error}\nNo automatic rollback was performed. {recovery}, run:\n{}",
            confirmed.previous_runtime_command()
        )
    })
}

fn collect_after_healthy(
    cli: &OpenClawCli,
    runtime: &BundledRuntime,
    confirmed: &Observation,
    healthy: &Observation,
    is_current: &dyn Fn() -> bool,
) {
    let result = (|| -> Result<(), String> {
        check_current(is_current)?;
        healthy.expected_pin()?;
        let Some(original) = read_launcher(cli)? else {
            return Ok(());
        };
        let Some(mut launcher) = original.selection.clone() else {
            return Ok(());
        };
        let previous = confirmed.selected_runtime_path().filter(|path| {
            *path != runtime.executable
                && fs::canonicalize(path).ok().as_deref() != Some(runtime.executable.as_path())
        });
        let previous = previous.map(Path::to_path_buf).or_else(|| {
            launcher.retention.as_ref().and_then(|retention| {
                (retention.current == runtime.executable)
                    .then(|| retention.previous.clone())
                    .flatten()
            })
        });
        launcher.retention = Some(RuntimeRetention {
            current: runtime.executable.clone(),
            previous,
        });
        write_launcher(&original, &launcher)?;
        let retention = launcher.retention.as_ref().expect("recorded retention");
        // Without a known rollback selection, wait for another successful activation.
        let Some(previous) = &retention.previous else {
            return Ok(());
        };
        let mut references = vec![
            runtime.executable.clone(),
            previous.clone(),
            launcher.runtime.executable.clone(),
            launcher.entry.clone(),
        ];
        references.extend(launcher.runtime.sqlite.clone());
        references.extend(
            healthy
                .command()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute()),
        );
        references.extend(
            healthy
                .text("/service/runtimeIntent/pin/path")
                .map(PathBuf::from),
        );
        let prefix = original
            .path
            .parent()
            .and_then(Path::parent)
            .ok_or(CHANGED)?;
        crate::bundled_runtime::collect_after_healthy(prefix, &references)
    })();
    if let Err(error) = result {
        eprintln!("Old bundled runtime cleanup skipped: {error}");
    }
}

fn install(
    cli: &OpenClawCli,
    runtime: &BundledRuntime,
    confirmed: &Observation,
) -> Result<(), String> {
    let mut command = cli
        .command([
            "gateway",
            "install",
            "--force",
            "--json",
            "--runtime",
            runtime.flavor.service_kind(),
            "--runtime-path",
        ])
        .map_err(|error| error.to_string())?;
    // The Windows service owner writes this path into its cmd.exe launcher.
    #[cfg(target_os = "windows")]
    command.arg(windows_process_path(&runtime.executable)?);
    #[cfg(not(target_os = "windows"))]
    command.arg(&runtime.executable);
    command
        .arg("--expected-runtime-pin")
        .arg(serde_json::to_string(&confirmed.expected_pin()?).map_err(|error| error.to_string())?)
        .env_remove("OPENCLAW_SQLITE_LIBRARY")
        .env_remove("LD_LIBRARY_PATH");
    if let Some(sqlite) = &runtime.sqlite {
        command.env("OPENCLAW_SQLITE_LIBRARY", sqlite);
    }
    if let Some(port) = confirmed.0.pointer("/gateway/port").and_then(Value::as_u64) {
        command.args(["--port", &port.to_string()]);
    }
    if confirmed.command().is_some_and(|args| {
        args.iter()
            .any(|arg| arg.as_str() == Some("--allow-unconfigured"))
    }) {
        command.arg("--allow-unconfigured");
    }
    let output = checked_output(command, "Gateway runtime installation")?;
    let result: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Gateway install returned invalid JSON.")?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("Gateway runtime installation did not succeed.".into());
    }
    Ok(())
}

fn capture(cli: &OpenClawCli, probe: bool) -> Result<Observation, String> {
    let mut command = cli
        .command(["gateway", "status", "--deep", "--json"])
        .map_err(|error| error.to_string())?;
    if !probe {
        command.arg("--no-probe");
    }
    let output = checked_output(command, "Gateway runtime inspection")?;
    let state: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Gateway status returned invalid JSON.")?;
    if !state.get("service").is_some_and(Value::is_object) {
        return Err(UPGRADE.into());
    }
    Ok(Observation(state))
}

fn checked_output(mut command: Command, label: &str) -> Result<Output, String> {
    command.stdin(std::process::Stdio::null());
    let output = command
        .output()
        .map_err(|error| format!("{label} could not start: {error}"))?;
    if output.status.success() {
        return Ok(output);
    }
    Err(format!(
        "{label} failed: {}",
        output_tail(&output.stderr)
            .or_else(|| output_tail(&output.stdout))
            .unwrap_or_else(|| output.status.to_string())
    ))
}

/// This marker describes a launcher only. It never grants permission to mutate a service.
pub(crate) fn bind_runtime(
    cli: &OpenClawCli,
    runtime: &BundledRuntime,
    purpose: Purpose,
) -> Result<(), String> {
    validate_runtime(runtime)?;
    let launcher =
        read_launcher(cli)?.ok_or("The CLI launcher is not a recognized managed installation.")?;
    publish_launcher(&launcher, runtime, purpose)
}

fn read_launcher(cli: &OpenClawCli) -> Result<Option<LauncherFile>, String> {
    let Some(path) = cli.managed_wrapper() else {
        return Ok(None);
    };
    read_launcher_path(path)
}

fn read_launcher_path(path: PathBuf) -> Result<Option<LauncherFile>, String> {
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 65536 {
        return Ok(None);
    }
    let bytes = read_regular(&path)?;
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Ok(None);
    };
    if let Some(marker) = text
        .lines()
        .nth(1)
        .and_then(|line| line.strip_prefix(MARKER))
    {
        let Ok(launcher) = serde_json::from_str::<Launcher>(marker) else {
            return Ok(None);
        };
        if render(&launcher).ok().as_deref() != Some(bytes.as_slice()) {
            return Ok(None);
        }
        return Ok(Some(LauncherFile {
            path,
            bytes,
            entry: launcher.entry.clone(),
            selection: Some(launcher),
        }));
    }
    #[cfg(target_os = "windows")]
    return Ok(None);
    #[cfg(not(target_os = "windows"))]
    {
        let prefix = path.parent().and_then(Path::parent).ok_or(CHANGED)?;
        let start = format!(
            "#!/usr/bin/env bash\nset -euo pipefail\nexec \"{}/tools/node/bin/node\" \"",
            prefix.display()
        );
        let Some(entry) = text
            .strip_prefix(&start)
            .and_then(|text| text.strip_suffix("\" \"$@\"\n"))
        else {
            return Ok(None);
        };
        if entry.contains(['\n', '\r', '$', '`', '"', '\\']) || !entry.ends_with("/dist/entry.js") {
            return Ok(None);
        }
        let entry = fs::canonicalize(entry).map_err(|error| error.to_string())?;
        if !entry.starts_with(fs::canonicalize(prefix).map_err(|error| error.to_string())?) {
            return Ok(None);
        }
        Ok(Some(LauncherFile {
            path,
            bytes,
            entry,
            selection: None,
        }))
    }
}

/// The desktop invokes Bun directly so Windows shell parsing never sees user arguments.
#[cfg(target_os = "windows")]
pub(crate) fn managed_command(cli: &OpenClawCli) -> Result<Option<Command>, String> {
    if cli.managed_wrapper().is_none() {
        return Ok(None);
    }
    let launcher = read_launcher(cli)?.ok_or(
        "The managed OpenClaw launcher is invalid. Reinstall the local CLI from the desktop app.",
    )?;
    let selection = launcher.selection.as_ref().ok_or(CHANGED)?;
    validate_runtime(&selection.runtime)?;
    let command = selection.runtime.command(&launcher.entry);
    Ok(Some(command))
}

/// Publish the initial launcher only after the bundled package has been installed.
pub(crate) fn install_launcher(
    prefix: &Path,
    runtime: &BundledRuntime,
    entry: &Path,
    purpose: Purpose,
) -> Result<(), String> {
    validate_runtime(runtime)?;
    let entry = fs::canonicalize(entry).map_err(|error| error.to_string())?;
    if !entry.starts_with(fs::canonicalize(prefix).map_err(|error| error.to_string())?) {
        return Err("The CLI entry point must belong to its managed installation.".into());
    }
    let path = crate::cli::managed_launcher(prefix);
    fs::create_dir_all(path.parent().ok_or(CHANGED)?).map_err(|error| error.to_string())?;
    let original = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => LauncherFile {
            path,
            bytes: Vec::new(),
            entry: entry.clone(),
            selection: None,
        },
        _ => read_launcher_path(path.clone())?
            .ok_or("The existing CLI launcher is not a recognized managed installation.")?,
    };
    publish_launcher(&LauncherFile { entry, ..original }, runtime, purpose)
}

fn publish_launcher(
    original: &LauncherFile,
    runtime: &BundledRuntime,
    purpose: Purpose,
) -> Result<(), String> {
    let launcher = Launcher {
        purpose,
        runtime: runtime.clone(),
        entry: runtime
            .entry
            .clone()
            .unwrap_or_else(|| match runtime.flavor {
                RuntimeFlavor::Aot => runtime.executable.clone(),
                RuntimeFlavor::Jit => original.entry.clone(),
            }),
        retention: original
            .selection
            .as_ref()
            .and_then(|selection| selection.retention.clone()),
    };
    write_launcher(original, &launcher)
}

fn write_launcher(original: &LauncherFile, launcher: &Launcher) -> Result<(), String> {
    let path = &original.path;
    let replacement = render(launcher)?;
    if replacement == original.bytes {
        return if read_regular(path)? == original.bytes {
            Ok(())
        } else {
            Err(CHANGED.into())
        };
    }
    let temporary =
        path.with_file_name(format!(".openclaw-tauri-launcher-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o700);
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&replacement)
            .and_then(|()| file.sync_all())
            .map_err(|error| error.to_string())?;
        if original.bytes.is_empty() {
            if fs::symlink_metadata(path).is_ok() {
                return Err(CHANGED.into());
            }
        } else if read_regular(path)? != original.bytes {
            return Err(CHANGED.into());
        }
        drop(file);
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn validate_runtime(runtime: &BundledRuntime) -> Result<(), String> {
    for path in std::iter::once(&runtime.executable)
        .chain(runtime.sqlite.iter())
        .chain(runtime.entry.iter())
    {
        if !path.is_absolute()
            || !path.is_file()
            || fs::canonicalize(path).map_err(|error| error.to_string())? != *path
        {
            return Err("Bundled runtime paths must be immutable, absolute files.".into());
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn quote(path: &Path) -> Result<String, String> {
    let value = path
        .to_str()
        .filter(|value| !value.contains(['\n', '\r', '\0']))
        .ok_or("Runtime paths must be single-line UTF-8.")?;
    Ok(format!("'{}'", value.replace('\'', "'\\''")))
}

#[cfg(not(target_os = "windows"))]
fn render(launcher: &Launcher) -> Result<Vec<u8>, String> {
    let sqlite = launcher
        .runtime
        .sqlite
        .as_ref()
        .map(|path| quote(path).map(|value| format!("export OPENCLAW_SQLITE_LIBRARY={value}\n")))
        .transpose()?
        .unwrap_or_default();
    let arguments = launcher
        .runtime
        .arguments(&launcher.entry)
        .iter()
        .map(|argument| {
            // Preserve the installed v1 JIT launcher's literal flag spelling.
            if argument == "--no-install" {
                Ok("--no-install".to_string())
            } else {
                quote(Path::new(argument))
            }
        })
        .collect::<Result<Vec<_>, String>>()?
        .join(" ");
    let arguments = if arguments.is_empty() {
        String::new()
    } else {
        format!(" {arguments}")
    };
    let bun_mode = if launcher.runtime.flavor == RuntimeFlavor::Aot {
        " BUN_BE_BUN"
    } else {
        ""
    };
    Ok(format!("#!/bin/sh\n{MARKER}{}\nunset OPENCLAW_SQLITE_LIBRARY LD_LIBRARY_PATH{bun_mode}\n{sqlite}exec {}{arguments} \"$@\"\n",
        serde_json::to_string(launcher).map_err(|error| error.to_string())?,
        quote(&launcher.runtime.executable)?).into_bytes())
}

#[cfg(target_os = "windows")]
fn quote(path: &Path) -> Result<String, String> {
    let value = path
        .to_str()
        .filter(|value| !value.contains(['\n', '\r', '\0']))
        .ok_or("Runtime paths must be single-line UTF-8.")?;
    Ok(format!("'{}'", value.replace('\'', "''")))
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_process_path(path: &Path) -> Result<String, String> {
    let value = path
        .to_str()
        .filter(|value| !value.contains(['\n', '\r', '\0', '"']))
        .ok_or("Runtime paths must be single-line UTF-8 without quotes.")?;
    // Windows command interpreters do not accept canonicalize's extended prefix.
    Ok(if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(value).to_string()
    })
}

#[cfg(target_os = "windows")]
fn cmd_quote(path: &Path) -> Result<String, String> {
    let value = windows_process_path(path)?;
    Ok(format!("\"{}\"", value.replace('%', "%%")))
}

#[cfg(target_os = "windows")]
fn render(launcher: &Launcher) -> Result<Vec<u8>, String> {
    let sqlite = launcher
        .runtime
        .sqlite
        .as_ref()
        .map(|path| {
            cmd_quote(path).map(|value| {
                format!(
                    "@set \"OPENCLAW_SQLITE_LIBRARY={}\"\r\n",
                    &value[1..value.len() - 1]
                )
            })
        })
        .transpose()?
        .unwrap_or_default();
    Ok(format!("@setlocal DisableDelayedExpansion\r\n{MARKER}{}\r\n@chcp 65001 >nul\r\n@set OPENCLAW_SQLITE_LIBRARY=\r\n@set LD_LIBRARY_PATH=\r\n{sqlite}@{} --no-install {} %*\r\n@exit /b %errorlevel%\r\n",
        serde_json::to_string(launcher).map_err(|error| error.to_string())?,
        cmd_quote(&launcher.runtime.executable)?, cmd_quote(&launcher.entry)?).into_bytes())
}

fn read_regular(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 65536 {
        return Err(CHANGED.into());
    }
    fs::read(path).map_err(|error| error.to_string())
}

fn check_current(is_current: &dyn Fn() -> bool) -> Result<(), String> {
    if is_current() {
        Ok(())
    } else {
        Err("Runtime setup was superseded; retry from the current Gateway selection.".into())
    }
}

#[cfg(all(test, unix))]
#[path = "runtime_action_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "runtime_action_windows_tests.rs"]
mod windows_tests;

#[cfg(all(
    test,
    any(target_os = "linux", target_os = "windows", target_os = "macos")
))]
#[test]
fn detached_runtime_action_delivers_the_complete_error_to_its_presenter() {
    use crate::gateway_operation_queue::{
        GatewayOperation, GatewayOperationError, GatewayOperationQueue,
    };
    let runtime = BundledRuntime {
        executable: PathBuf::from("fixture-bun"),
        sqlite: None,
        flavor: RuntimeFlavor::Jit,
        entry: None,
    };
    let error = "The Gateway is paused. Start it before choosing Use bundled runtime.\nTo select the previous runtime manually, run:\nopenclaw gateway install --force --runtime node";
    let (sender, receiver) = std::sync::mpsc::channel();
    let queue = GatewayOperationQueue::new(
        move |operation, _| {
            assert!(matches!(operation, GatewayOperation::Runtime(_)));
            Err(error.to_string())
        },
        move |failure| {
            assert!(sender.send(failure).is_ok());
        },
    );
    queue.submit_runtime(crate::RuntimeAction {
        cli: OpenClawCli::from_bundled(&runtime, "fixture-entry.js".into(), "fixture-home".into()),
        observation: Observation(Value::Null),
    });
    match receiver.recv_timeout(Duration::from_secs(1)).unwrap() {
        GatewayOperationError::Runtime(message) => assert_eq!(message, error),
        GatewayOperationError::Action(_) => {
            panic!("runtime guidance reached the generic error presenter")
        }
    }
}
