//! Bundled runtime selection is an explicit action; status and launcher markers grant no authority.
use crate::cli::{output_tail, OpenClawCli};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::fs;
#[cfg(unix)]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
const MARKER: &str = "# OpenClaw-Tauri runtime v1 ";
const CHANGED: &str = "The Gateway runtime or service definition changed. Its current selection was preserved; inspect it before retrying.";
const PAUSED: &str = "The Gateway is paused. Start it before choosing Use bundled runtime.";
const UPGRADE: &str = "Update the installed OpenClaw CLI before selecting the bundled runtime; this CLI cannot verify the current runtime pin and service definition.";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct BundledRuntime {
    pub bun: PathBuf,
    pub sqlite: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
#[cfg(unix)]
pub(crate) enum Purpose {
    Gateway,
    Browser,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg(unix)]
struct Launcher {
    purpose: Purpose,
    runtime: BundledRuntime,
    entry: PathBuf,
}

#[cfg(unix)]
struct LauncherFile {
    path: PathBuf,
    bytes: Vec<u8>,
    entry: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ExpectedPin {
    revision: String,
    definition: Option<String>,
}

/// The exact observation displayed before the user confirms; never replace it after confirmation.
#[derive(Clone, Debug)]
pub(crate) struct Observation(Value);

#[derive(Debug)]
pub(crate) enum Activation {
    Applied,
    Unchanged(String),
}

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
        self.runtime_path()
            .is_some_and(|path| same_path(path, expected))
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
        self.admit_for(fresh, false)
    }

    fn admit_for(&self, fresh: bool, elevated_inspection: bool) -> Result<(), String> {
        let pin = self.expected_pin()?;
        if self.paused() {
            return Err(PAUSED.into());
        }
        if self.text("/service/definitionMutation") != Some("writable")
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
            || (self.text("/service/runtime/status") != Some("running")
                && !(elevated_inspection && self.protected_running_task()))
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
        self.unchanged_for(expected, fresh, false)
    }

    fn unchanged_for(
        &self,
        expected: &Self,
        fresh: bool,
        elevated_inspection: bool,
    ) -> Result<(), String> {
        self.admit_for(fresh, elevated_inspection)?;
        if self.expected_pin()? != expected.expected_pin()?
            || self.0.pointer("/service/revision") != expected.0.pointer("/service/revision")
            || self.0.pointer("/config/daemon/path") != expected.0.pointer("/config/daemon/path")
            || self.0.pointer("/gateway/port") != expected.0.pointer("/gateway/port")
            || self.0.pointer("/cli/entrypoint") != expected.0.pointer("/cli/entrypoint")
            || self.0.pointer("/cli/runtime/execPath")
                != expected.0.pointer("/cli/runtime/execPath")
        {
            return Err(CHANGED.into());
        }
        Ok(())
    }

    // This admits an elevation request only. The CLI must prove the running
    // process under its native lock before it can replace the definition.
    fn protected_running_task(&self) -> bool {
        cfg!(windows)
            && self.text("/service/label") == Some("Scheduled Task")
            && self.text("/service/runtime/status") == Some("unknown")
            && self.text("/service/runtime/state") == Some("Running")
    }

    pub(crate) fn requires_elevation(&self) -> Result<bool, String> {
        #[cfg(windows)]
        {
            self.requires_elevation_with(crate::windows_elevation::is_elevated)
        }
        #[cfg(not(windows))]
        Ok(false)
    }

    #[cfg(windows)]
    fn requires_elevation_with(
        &self,
        is_elevated: impl FnOnce() -> Result<bool, String>,
    ) -> Result<bool, String> {
        if self.text("/service/label") == Some("Scheduled Task")
            && self.flag("/service/loaded") == Some(true)
            && self.text("/service/definitionMutation") == Some("writable")
            && self.text("/service/targetRole") == Some("target")
            && self.command().is_some()
            && !self
                .0
                .pointer("/service/command/startupEntryPaths")
                .and_then(Value::as_array)
                .is_some_and(|paths| !paths.is_empty())
            && (matches!(
                self.text("/service/runtime/status"),
                Some("running" | "stopped")
            ) || self.protected_running_task())
        {
            // The admitted Gateway task is republished with a boot trigger, even
            // when its LeastPrivilege process is accessible to an ordinary token.
            return is_elevated().map(|elevated| !elevated);
        }
        Ok(false)
    }

    fn healthy_for(&self, runtime: &BundledRuntime) -> bool {
        let Some(pid) = self.number("/service/runtime/pid").filter(|pid| *pid > 0) else {
            return false;
        };
        let Some(port) = self.number("/port/port").filter(|port| *port > 0) else {
            return false;
        };
        self.uses_runtime_path(&runtime.bun)
            && self.text("/service/runtimeIntent/status") == Some("known")
            && self
                .text("/service/runtimeIntent/revision")
                .is_some_and(|value| !value.is_empty())
            && self
                .text("/service/runtimeIntent/definition")
                .is_some_and(|value| !value.is_empty())
            && self.text("/service/runtimeIntent/pin/runtime") == Some("bun")
            && self
                .text("/service/runtimeIntent/pin/path")
                .is_some_and(|path| same_path(Path::new(path), &runtime.bun))
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
                    !listeners.is_empty()
                        && listeners.iter().all(|listener| {
                            listener.get("pid").and_then(Value::as_u64) == Some(pid)
                                || listener.get("ppid").and_then(Value::as_u64) == Some(pid)
                        })
                })
            && self.flag("/rpc/ok") == Some(true)
    }

    fn previous_runtime_selection(&self) -> (&str, Option<&Path>) {
        let path = self
            .text("/service/runtimeIntent/pin/path")
            .map(Path::new)
            .or_else(|| self.runtime_path());
        let kind = self
            .text("/service/runtimeIntent/pin/runtime")
            .unwrap_or_else(|| {
                if path
                    .and_then(Path::file_name)
                    .is_some_and(|name| name == "bun" || name == "bun.exe")
                {
                    "bun"
                } else {
                    "node"
                }
            });
        (kind, path)
    }

    fn previous_runtime_command(&self) -> String {
        let (kind, path) = self.previous_runtime_selection();
        let mut command = format!("openclaw gateway install --force --runtime {kind}");
        if let Some(path) = path {
            if let Ok(path) = quote(path) {
                command.push_str(&format!(" --runtime-path {path}"));
            }
        }
        command
    }

    #[cfg(windows)]
    fn guarded_previous_runtime_command(&self) -> Result<String, String> {
        let (kind, path) = self.previous_runtime_selection();
        let command = windows_install_command(kind, path.ok_or(UPGRADE)?, self)?;
        crate::windows_elevation::format_manual_command(&command, false)
    }
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
    #[cfg(unix)]
    let launcher = read_launcher(cli)?;
    let confirmed = inspect(cli)?;
    perform(
        cli,
        runtime,
        &confirmed,
        true,
        is_current,
        Duration::from_secs(600),
    )?;
    #[cfg(unix)]
    if let Some(launcher) = launcher {
        check_current(is_current)?;
        publish_launcher(&launcher, runtime, Purpose::Gateway).map_err(|error| {
            format!("The Gateway was installed, but recording its launcher marker failed: {error}")
        })?;
    }
    Ok(())
}

/// An explicit confirmation is the only admission path for an existing service.
pub(crate) fn activate(
    cli: &OpenClawCli,
    runtime: &BundledRuntime,
    confirmed: &Observation,
    is_current: &dyn Fn() -> bool,
) -> Result<Activation, String> {
    #[cfg(windows)]
    {
        let elevated = confirmed.requires_elevation()?;
        if elevated || confirmed.uses_runtime_path(&runtime.bun) {
            check_current(is_current)?;
            validate_runtime(runtime)?;
            confirmed.admit_for(false, elevated)?;
            inspect(cli)?.unchanged_for(confirmed, false, elevated)?;
            check_current(is_current)?;
            if confirmed.uses_runtime_path(&runtime.bun) {
                return Ok(Activation::Unchanged(
                    "The Gateway already selects this app's bundled Bun. No change was made."
                        .into(),
                ));
            }
            return activate_elevated(runtime, confirmed, is_current);
        }
    }
    perform(
        cli,
        runtime,
        confirmed,
        false,
        is_current,
        Duration::from_secs(600),
    )?;
    Ok(Activation::Applied)
}

#[cfg(windows)]
fn windows_install_command(
    runtime: &str,
    runtime_path: &Path,
    confirmed: &Observation,
) -> Result<Command, String> {
    if confirmed.text("/cli/runtime/kind") != Some("node")
        || confirmed.flag("/cli/runtime/supported") != Some(true)
    {
        return Err(UPGRADE.into());
    }
    let executable = Path::new(confirmed.text("/cli/runtime/execPath").ok_or(UPGRADE)?);
    let entrypoint = Path::new(confirmed.text("/cli/entrypoint").ok_or(UPGRADE)?);
    if !executable.is_absolute()
        || !entrypoint.is_absolute()
        || !executable.is_file()
        || !entrypoint.is_file()
        || !entrypoint
            .extension()
            .is_some_and(|ext| ext == "js" || ext == "mjs")
    {
        return Err(UPGRADE.into());
    }
    // The canonical status identifies the CLI actually used for the prompt.
    // ShellExecute cannot carry private PATH/state environment overrides.
    let mut command = Command::new(executable);
    command.arg(entrypoint);
    let profile = confirmed
        .text("/service/command/environment/OPENCLAW_PROFILE")
        .filter(|value| !value.is_empty())
        .map(OsString::from)
        .or_else(|| std::env::var_os("OPENCLAW_PROFILE").filter(|value| !value.is_empty()));
    if let Some(profile) = profile {
        command.arg("--profile").arg(profile);
    }
    command.args(install_arguments(runtime, runtime_path, confirmed)?);
    Ok(command)
}

#[cfg(windows)]
fn activate_elevated(
    runtime: &BundledRuntime,
    confirmed: &Observation,
    is_current: &dyn Fn() -> bool,
) -> Result<Activation, String> {
    use crate::windows_elevation::{self, ElevationError, Request};
    let mut command = windows_install_command("bun", &runtime.bun, confirmed)?;
    let manual = windows_elevation::format_manual_command(&command, true)?;
    let fallback = format!(
        "Run this exact command in PowerShell with administrator approval for this Windows account:\n{manual}"
    );
    if !windows_elevation::can_elevate()? {
        return Ok(Activation::Unchanged(format!(
            "This Windows account cannot approve an administrator request. This action did not change the Gateway.\n\n{fallback}"
        )));
    }
    let mut request = Request::create(
        &runtime.bun,
        &serde_json::to_value(confirmed.expected_pin()?).map_err(|error| error.to_string())?,
    )?;
    command
        .arg("--desktop-runtime-receipt")
        .arg(request.argument_json());
    check_current(is_current)?;
    let code = match windows_elevation::run(&command) {
        Ok(code) => code,
        Err(ElevationError::Cancelled) => {
            eprintln!("Runtime elevation cancelled (Win32 ERROR_CANCELLED, 1223).");
            return Ok(Activation::Unchanged(format!(
                "Windows administrator approval was cancelled. This action did not change the Gateway.\n\n{fallback}"
            )));
        }
        Err(ElevationError::NonAdministrator) => {
            return Ok(Activation::Unchanged(format!(
                "This Windows account cannot approve an administrator request. This action did not change the Gateway.\n\n{fallback}"
            )));
        }
        Err(ElevationError::Failed(error)) => {
            return Err(format!("Windows could not complete the CLI handoff: {error}\nInspect Gateway status before retrying.\n\n{fallback}"));
        }
    };
    // Keep the request handles alive until the owner has exited. Never kill or
    // retry an elevated writer because the app's selection changed meanwhile.
    let receipt = request.read_completed().map_err(|error| {
        format!("The elevated CLI exited with code {code}, but {error}\nInspect Gateway status before retrying.\n\n{fallback}")
    })?;
    check_current(is_current)?;
    if code != 0
        || receipt.pointer("/install/action").and_then(Value::as_str) != Some("install")
        || receipt.pointer("/install/ok").and_then(Value::as_bool) != Some(true)
    {
        let error = receipt
            .pointer("/install/error")
            .and_then(Value::as_str)
            .unwrap_or("The elevated CLI refused or could not complete runtime installation.");
        return Err(format!("{error}\n\n{fallback}"));
    }
    let observation = Observation(receipt.get("observation").cloned().unwrap_or(Value::Null));
    if !observation.healthy_for(runtime)
        || observation.0.pointer("/config/daemon/path")
            != confirmed.0.pointer("/config/daemon/path")
        || observation.0.pointer("/gateway/port") != confirmed.0.pointer("/gateway/port")
    {
        return Err(activation_health_failure(
            confirmed,
            false,
            "The Gateway was not verified healthy on the bundled runtime.",
        ));
    }
    Ok(Activation::Applied)
}

fn perform(
    cli: &OpenClawCli,
    runtime: &BundledRuntime,
    confirmed: &Observation,
    fresh: bool,
    is_current: &dyn Fn() -> bool,
    health_timeout: Duration,
) -> Result<(), String> {
    check_current(is_current)?;
    validate_runtime(runtime)?;
    confirmed.admit(fresh)?;
    inspect(cli)?.unchanged_from(confirmed, fresh)?;
    check_current(is_current)?;
    install(cli, runtime, confirmed)
        .map_err(|error| activation_failure(confirmed, fresh, &error))?;
    let deadline = Instant::now() + health_timeout;
    wait_for_health(
        runtime,
        fresh && cfg!(windows),
        is_current,
        || capture(cli, true),
        || {
            if Instant::now() >= deadline {
                return Err("The Gateway did not become healthy on the bundled runtime.".into());
            }
            thread::sleep(Duration::from_secs(2));
            Ok(())
        },
    )
    .map_err(|error| activation_health_failure(confirmed, fresh, &error))
}

fn activation_health_failure(confirmed: &Observation, fresh: bool, error: &str) -> String {
    if cfg!(windows) {
        return format!(
            "The Gateway was installed, but its health could not be verified: {error}\nInspect Gateway status before retrying."
        );
    }
    activation_failure(confirmed, fresh, error)
}

fn activation_failure(confirmed: &Observation, fresh: bool, error: &str) -> String {
    #[cfg(windows)]
    if !fresh {
        let recovery = match confirmed.guarded_previous_runtime_command() {
            Ok(command) => format!(
                "To select the previous runtime manually, run this exact command in PowerShell:\n{command}"
            ),
            Err(reason) => format!("The guarded recovery command is unavailable: {reason}"),
        };
        return format!(
            "Bundled runtime activation failed: {error}\nInspect Gateway status before retrying. {recovery}"
        );
    }
    let recovery = if fresh {
        "To install with Node manually"
    } else {
        "To select the previous runtime manually"
    };
    format!(
        "Bundled runtime activation failed: {error}\nNo automatic rollback was performed. {recovery}, run:\n{}",
        confirmed.previous_runtime_command()
    )
}

fn wait_for_health(
    runtime: &BundledRuntime,
    fresh_windows: bool,
    is_current: &dyn Fn() -> bool,
    mut observe: impl FnMut() -> Result<Observation, String>,
    mut wait: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    loop {
        check_current(is_current)?;
        let observed = observe()?;
        if observed.healthy_for(runtime) {
            return Ok(());
        }
        // A newly launched Startup-folder Gateway is reported stopped until its port binds.
        if observed.paused() && !fresh_windows {
            return Err("The Gateway did not become healthy on the bundled runtime.".into());
        }
        wait()?;
    }
}

fn install(
    cli: &OpenClawCli,
    runtime: &BundledRuntime,
    confirmed: &Observation,
) -> Result<(), String> {
    let mut command = cli
        .command(install_arguments("bun", &runtime.bun, confirmed)?)
        .map_err(|error| error.to_string())?;
    command
        .env_remove("OPENCLAW_SQLITE_LIBRARY")
        .env_remove("LD_LIBRARY_PATH");
    if let Some(sqlite) = &runtime.sqlite {
        command.env("OPENCLAW_SQLITE_LIBRARY", sqlite);
    }
    let output = checked_output(command, "Gateway runtime installation")?;
    let result: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Gateway install returned invalid JSON.")?;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("Gateway runtime installation did not succeed.".into());
    }
    Ok(())
}

fn install_arguments(
    runtime: &str,
    runtime_path: &Path,
    confirmed: &Observation,
) -> Result<Vec<OsString>, String> {
    let mut arguments: Vec<OsString> = [
        "gateway",
        "install",
        "--force",
        "--json",
        "--runtime",
        runtime,
        "--runtime-path",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    arguments.push(runtime_path.as_os_str().to_owned());
    arguments.push("--expected-runtime-pin".into());
    arguments.push(
        serde_json::to_string(&confirmed.expected_pin()?)
            .map_err(|error| error.to_string())?
            .into(),
    );
    if let Some(port) = confirmed.number("/gateway/port") {
        arguments.extend(["--port".into(), port.to_string().into()]);
    }
    if confirmed.command().is_some_and(|args| {
        args.iter()
            .any(|arg| arg.as_str() == Some("--allow-unconfigured"))
    }) {
        arguments.push("--allow-unconfigured".into());
    }
    Ok(arguments)
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
#[cfg(unix)]
pub(crate) fn bind_runtime(
    cli: &OpenClawCli,
    runtime: &BundledRuntime,
    purpose: Purpose,
) -> Result<(), String> {
    validate_runtime(runtime)?;
    let launcher =
        read_launcher(cli)?.ok_or("The CLI launcher is not a canonical managed installation.")?;
    publish_launcher(&launcher, runtime, purpose)
}

#[cfg(unix)]
fn read_launcher(cli: &OpenClawCli) -> Result<Option<LauncherFile>, String> {
    let Some(path) = cli.managed_wrapper() else {
        return Ok(None);
    };
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 65536 {
        return Ok(None);
    }
    let bytes = read_regular(&path)?;
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Ok(None);
    };
    let entry = if let Some(marker) = text
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
        launcher.entry
    } else {
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
        entry
    };
    Ok(Some(LauncherFile { path, bytes, entry }))
}

#[cfg(unix)]
fn publish_launcher(
    original: &LauncherFile,
    runtime: &BundledRuntime,
    purpose: Purpose,
) -> Result<(), String> {
    let path = &original.path;
    let launcher = Launcher {
        purpose,
        runtime: runtime.clone(),
        entry: original.entry.clone(),
    };
    let replacement = render(&launcher)?;
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
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&replacement)
            .and_then(|()| file.sync_all())
            .map_err(|error| error.to_string())?;
        if read_regular(path)? != original.bytes {
            return Err(CHANGED.into());
        }
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn validate_runtime(runtime: &BundledRuntime) -> Result<(), String> {
    for path in std::iter::once(&runtime.bun).chain(runtime.sqlite.iter()) {
        if !path.is_absolute()
            || !path.is_file()
            || normalized_path(&fs::canonicalize(path).map_err(|error| error.to_string())?)
                != normalized_path(path)
        {
            return Err("Bundled runtime paths must be immutable, absolute files.".into());
        }
    }
    Ok(())
}

fn normalized_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        crate::cli::ordinary_windows_path(path)
    }
    #[cfg(not(windows))]
    path.to_path_buf()
}

fn same_path(left: &Path, right: &Path) -> bool {
    normalized_path(left) == normalized_path(right)
        || matches!((fs::canonicalize(left), fs::canonicalize(right)), (Ok(left), Ok(right)) if left == right)
}

fn quote(path: &Path) -> Result<String, String> {
    let value = path
        .to_str()
        .filter(|value| !value.contains(['\n', '\r', '\0']))
        .ok_or("Runtime paths must be single-line UTF-8.")?;
    #[cfg(windows)]
    let escaped = value.replace('\'', "''");
    #[cfg(not(windows))]
    let escaped = value.replace('\'', "'\\''");
    Ok(format!("'{escaped}'"))
}

#[cfg(unix)]
fn render(launcher: &Launcher) -> Result<Vec<u8>, String> {
    let sqlite = launcher
        .runtime
        .sqlite
        .as_ref()
        .map(|path| quote(path).map(|value| format!("export OPENCLAW_SQLITE_LIBRARY={value}\n")))
        .transpose()?
        .unwrap_or_default();
    Ok(format!("#!/bin/sh\n{MARKER}{}\nunset OPENCLAW_SQLITE_LIBRARY LD_LIBRARY_PATH\n{sqlite}exec {} --no-install {} \"$@\"\n",
        serde_json::to_string(launcher).map_err(|error| error.to_string())?,
        quote(&launcher.runtime.bun)?, quote(&launcher.entry)?).into_bytes())
}

#[cfg(unix)]
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

#[cfg(test)]
mod health_tests {
    use super::*;

    #[test]
    fn fresh_windows_waits_through_startup_observations_without_reinstalling() {
        let runtime = BundledRuntime {
            bun: std::env::temp_dir().join("synthetic-bun.exe"),
            sqlite: None,
        };
        let healthy = serde_json::json!({
            "service": {
                "loaded": true, "targetRole": "target",
                "command": {"programArguments": [runtime.bun]},
                "runtime": {"status": "running", "pid": 4100},
                "runtimeIntent": {
                    "status": "known", "revision": "pin", "definition": "definition",
                    "pin": {"runtime": "bun", "path": runtime.bun}
                }
            },
            "gateway": {"port": 18789},
            "port": {"port": 18789, "status": "busy", "listeners": [{"pid": 4100}]},
            "rpc": {"ok": true}
        });
        let mut starting = healthy.clone();
        starting["service"]["runtime"] = serde_json::json!({"status": "stopped"});
        starting["rpc"]["ok"] = false.into();
        starting["port"]["listeners"] = serde_json::json!([]);
        let mut observations = [starting, healthy].into_iter();
        let mut waits = 0;
        wait_for_health(
            &runtime,
            true,
            &|| true,
            || {
                Ok(Observation(
                    observations.next().expect("unexpected extra probe"),
                ))
            },
            || {
                waits += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(waits, 1);
        assert!(observations.next().is_none());
    }

    #[test]
    fn fresh_windows_still_honors_the_health_budget_and_superseded_selection() {
        let runtime = BundledRuntime {
            bun: std::env::temp_dir().join("synthetic-bun.exe"),
            sqlite: None,
        };
        let stopped = || {
            Ok(Observation(serde_json::json!({"service": {
                "loaded": true, "command": {"programArguments": [runtime.bun]},
                "runtime": {"status": "stopped"}
            }})))
        };
        assert_eq!(
            wait_for_health(&runtime, true, &|| true, stopped, || Err("expired".into())),
            Err("expired".into())
        );
        assert!(wait_for_health(
            &runtime,
            true,
            &|| false,
            || panic!("a superseded operation must not inspect or mutate the service"),
            || panic!("a superseded operation must not wait"),
        )
        .unwrap_err()
        .contains("superseded"));
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    fn protected_task() -> Observation {
        Observation(serde_json::json!({
            "service": {
                "label": "Scheduled Task", "loaded": true, "targetRole": "target",
                "command": {"programArguments": [r"C:\runtime\node.exe", r"C:\cli\entry.js", "gateway"]},
                "runtime": {"status": "unknown", "state": "Running"},
                "runtimeIntent": {"status": "known", "revision": "captured-pin", "definition": "captured-task"},
                "revision": "service-revision", "definitionMutation": "writable", "launcherOverridden": false
            },
            "gateway": {"port": 18789},
            "config": {"daemon": {"path": r"C:\Users\fixture\.openclaw\openclaw.json"}}
        }))
    }

    #[test]
    fn windows_startup_registration_never_requests_elevation() {
        let mut observed = protected_task();
        assert_eq!(observed.requires_elevation_with(|| Ok(false)), Ok(true));
        observed.0["service"]["command"]["startupEntryPaths"] = serde_json::json!([]);
        assert_eq!(observed.requires_elevation_with(|| Ok(false)), Ok(true));
        observed.0["service"]["command"]["startupEntryPaths"] =
            serde_json::json!([r"C:\Users\fixture\Startup\OpenClaw Gateway.vbs"]);
        assert_eq!(
            observed.requires_elevation_with(|| panic!("Startup does not need elevation")),
            Ok(false)
        );
        observed.0["service"]["runtime"] =
            serde_json::json!({"status": "running", "pid": std::process::id()});
        assert!(observed.admit(false).is_ok());
        assert_eq!(
            observed.requires_elevation_with(|| panic!("Startup does not need elevation")),
            Ok(false)
        );
    }

    #[test]
    fn windows_task_registration_needs_elevation_independently_of_its_process() {
        for state in ["running", "stopped"] {
            let mut observed = protected_task();
            // The current process is accessible; a stopped task has no process at all.
            observed.0["service"]["runtime"] = if state == "running" {
                serde_json::json!({"status": state, "pid": std::process::id()})
            } else {
                serde_json::json!({"status": state})
            };
            assert_eq!(observed.requires_elevation_with(|| Ok(false)), Ok(true));
            assert_eq!(observed.requires_elevation_with(|| Ok(true)), Ok(false));
            if state == "stopped" {
                assert_eq!(observed.admit_for(false, true), Err(PAUSED.into()));
            }
        }
        let protected = protected_task();
        assert_eq!(protected.requires_elevation_with(|| Ok(false)), Ok(true));
        assert_eq!(protected.requires_elevation_with(|| Ok(true)), Ok(false));
    }

    #[test]
    fn windows_task_elevation_requires_known_registration() {
        for (pointer, value) in [
            ("/service/loaded", Value::Null),
            ("/service/loaded", Value::Bool(false)),
            ("/service/command", Value::Null),
            ("/service/definitionMutation", "unknown".into()),
            ("/service/definitionMutation", "sealed".into()),
            ("/service/targetRole", "diagnostic-only".into()),
            ("/service/runtime/state", "Queued".into()),
        ] {
            let mut observed = protected_task();
            *observed.0.pointer_mut(pointer).unwrap() = value;
            assert_eq!(
                observed.requires_elevation_with(|| panic!("Unknown task cannot request UAC")),
                Ok(false),
                "{pointer}"
            );
        }
    }

    #[test]
    fn windows_guarded_failure_preserves_owner_recovery_and_manual_command() {
        let root = std::env::temp_dir().join(format!("openclaw-recovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let node = root.join("node's runner.exe");
        let entry = root.join("entry's module.mjs");
        fs::write(&node, "synthetic Node").unwrap();
        fs::write(&entry, "synthetic CLI").unwrap();
        let mut observed = protected_task();
        observed.0["cli"] = serde_json::json!({
            "runtime": {"kind": "node", "supported": true, "execPath": node},
            "entrypoint": entry
        });
        observed.0["service"]["runtimeIntent"]["pin"] = serde_json::json!({
            "runtime": "bun", "path": r"C:\Peter's files\$(ignored);&bun.exe"
        });
        let owner_error = "Gateway install failed; the previous definition was restored.";
        let message = activation_failure(&observed, false, owner_error);
        assert!(message.contains(owner_error));
        assert!(message.contains("Inspect Gateway status before retrying."));
        assert!(!message.contains("No automatic rollback"));
        assert!(message.contains("-ArgumentList '"));
        assert!(!message.contains("RunAs"));
        assert!(!message.contains("administrator approval"));
        assert!(message.contains("node''s runner.exe"));
        assert!(message.contains("entry''s module.mjs"));
        assert!(message.contains(r#""--runtime" "bun""#));
        assert!(message.contains(r#""C:\Peter''s files\$(ignored);&bun.exe""#));
        assert!(message.contains(r#""--expected-runtime-pin" "{\"revision\":\"captured-pin\",\"definition\":\"captured-task\"}""#));
        let fresh = activation_failure(&observed, true, "Startup failed.");
        assert!(fresh.contains("No automatic rollback was performed."));
        assert!(fresh.contains("To install with Node manually"));
        assert!(!fresh.contains("--expected-runtime-pin"));
        for fresh in [false, true] {
            let unverified = activation_health_failure(&observed, fresh, "Health check failed.");
            assert!(unverified.contains("Gateway was installed"));
            assert!(unverified.contains("health could not be verified"));
            assert!(unverified.contains("Health check failed."));
            assert!(unverified.contains("Inspect Gateway status before retrying."));
            assert!(!unverified.contains("--expected-runtime-pin"));
            assert!(!unverified.contains("Start-Process"));
            assert!(!unverified.contains("gateway install"));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_guarded_failure_never_substitutes_an_unguarded_recovery_command() {
        let message = activation_failure(&protected_task(), false, "Publication failed.");
        assert!(message.contains("Inspect Gateway status before retrying."));
        assert!(message.contains("guarded recovery command is unavailable"));
        assert!(!message.contains("gateway install"));
    }

    #[test]
    fn windows_unknown_process_only_admits_guarded_elevated_inspection() {
        let observed = protected_task();
        assert!(observed.admit(false).is_err());
        assert!(observed.admit_for(false, true).is_ok());
        for (pointer, changed) in [
            ("/service/runtime/state", Value::String("Queued".into())),
            (
                "/service/targetRole",
                Value::String("diagnostic-only".into()),
            ),
            ("/service/runtimeIntent/definition", Value::Null),
            ("/service/launcherOverridden", Value::Bool(true)),
            (
                "/service/definitionMutation",
                Value::String("sealed".into()),
            ),
        ] {
            let mut state = observed.0.clone();
            *state.pointer_mut(pointer).unwrap() = changed;
            assert!(
                Observation(state).admit_for(false, true).is_err(),
                "{pointer}"
            );
        }
    }

    #[test]
    fn windows_elevation_never_replaces_the_confirmed_pin_or_definition() {
        let confirmed = protected_task();
        for pointer in [
            "/service/runtimeIntent/revision",
            "/service/runtimeIntent/definition",
            "/service/revision",
            "/config/daemon/path",
        ] {
            let mut state = confirmed.0.clone();
            *state.pointer_mut(pointer).unwrap() = "changed".into();
            assert!(
                Observation(state)
                    .unchanged_for(&confirmed, false, true)
                    .is_err(),
                "{pointer}"
            );
        }
        let runtime = BundledRuntime {
            bun: PathBuf::from(r"C:\runtime\bun.exe"),
            sqlite: None,
        };
        let arguments = install_arguments("bun", &runtime.bun, &confirmed).unwrap();
        let pin_index = arguments
            .iter()
            .position(|value| value == "--expected-runtime-pin")
            .unwrap()
            + 1;
        assert_eq!(
            serde_json::from_str::<Value>(arguments[pin_index].to_str().unwrap()).unwrap(),
            serde_json::json!({"revision":"captured-pin", "definition":"captured-task"})
        );
    }

    #[test]
    fn windows_runtime_paths_and_recovery_preserve_literal_arguments() {
        let root = std::env::temp_dir().join(format!("openclaw-runtime-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let bun = root.join("bun.exe");
        fs::write(&bun, "synthetic runtime").unwrap();
        let runtime = BundledRuntime {
            bun: normalized_path(&fs::canonicalize(&bun).unwrap()),
            sqlite: None,
        };
        assert!(validate_runtime(&runtime).is_ok());
        assert!(same_path(&runtime.bun, &fs::canonicalize(&bun).unwrap()));
        assert_eq!(
            quote(Path::new(r"C:\Peter's files\bun.exe")).unwrap(),
            r"'C:\Peter''s files\bun.exe'"
        );
        let observed = Observation(serde_json::json!({ "service": {
            "command": { "programArguments": [r"C:\Peter's files\bun.exe"] },
            "runtimeIntent": { "status": "known", "revision": "pin", "definition": "task" }
        }}));
        assert_eq!(
            observed.previous_runtime_command(),
            r"openclaw gateway install --force --runtime bun --runtime-path 'C:\Peter''s files\bun.exe'"
        );
        assert_eq!(
            serde_json::to_value(observed.expected_pin().unwrap()).unwrap(),
            serde_json::json!({"revision":"pin","definition":"task"})
        );
        fs::remove_dir_all(root).unwrap();
    }
}
