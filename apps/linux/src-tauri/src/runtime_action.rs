//! Bundled runtime selection is an explicit action; status and launcher markers grant no authority.
use crate::cli::{output_tail, OpenClawCli};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::thread;
use std::time::{Duration, Instant};

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
pub(crate) enum Purpose {
    Gateway,
    Browser,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct Launcher {
    purpose: Purpose,
    runtime: BundledRuntime,
    entry: PathBuf,
}

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
        self.uses_runtime_path(&runtime.bun)
            && self.text("/service/runtimeIntent/pin/runtime") == Some("bun")
            && self
                .text("/service/runtimeIntent/pin/path")
                .is_some_and(|path| Path::new(path) == runtime.bun)
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

    fn previous_runtime_command(&self) -> String {
        let path = self
            .text("/service/runtimeIntent/pin/path")
            .map(Path::new)
            .or_else(|| self.runtime_path());
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
    let confirmed = inspect(cli)?;
    perform(
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
    Ok(())
}

/// An explicit confirmation is the only admission path for an existing service.
pub(crate) fn activate(
    cli: &OpenClawCli,
    runtime: &BundledRuntime,
    confirmed: &Observation,
    is_current: &dyn Fn() -> bool,
) -> Result<(), String> {
    perform(
        cli,
        runtime,
        confirmed,
        false,
        is_current,
        Duration::from_secs(600),
    )
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
    let result = install(cli, runtime, confirmed).and_then(|()| {
        let deadline = Instant::now() + health_timeout;
        loop {
            check_current(is_current)?;
            let observed = capture(cli, true)?;
            if observed.healthy_for(runtime) {
                return Ok(());
            }
            if observed.paused() || Instant::now() >= deadline {
                return Err("The Gateway did not become healthy on the bundled runtime.".into());
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
            "bun",
            "--runtime-path",
        ])
        .map_err(|error| error.to_string())?;
    command
        .arg(&runtime.bun)
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
            || fs::canonicalize(path).map_err(|error| error.to_string())? != *path
        {
            return Err("Bundled runtime paths must be immutable, absolute files.".into());
        }
    }
    Ok(())
}

fn quote(path: &Path) -> Result<String, String> {
    let value = path
        .to_str()
        .filter(|value| !value.contains(['\n', '\r', '\0']))
        .ok_or("Runtime paths must be single-line UTF-8.")?;
    Ok(format!("'{}'", value.replace('\'', "'\\''")))
}

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

#[cfg(test)]
#[path = "runtime_action_tests.rs"]
mod tests;
