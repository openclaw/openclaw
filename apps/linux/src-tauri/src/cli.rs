use serde::de::DeserializeOwned;
use std::env;
use std::ffi::OsString;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

pub(crate) type SpawnCommand<'a> = dyn Fn(&mut Command) -> Result<Child, String> + 'a;

#[derive(Clone, Debug)]
pub struct OpenClawCli {
    executable: PathBuf,
    openclaw_home: PathBuf,
    available: Arc<AtomicBool>,
    allow_runtime_management: bool,
}

#[derive(Debug)]
pub enum CliError {
    Missing,
    Environment(String),
    Spawn(String),
    CommandFailed(String),
    InvalidJson(String),
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => write!(formatter, "OpenClaw CLI not found"),
            Self::Environment(message)
            | Self::Spawn(message)
            | Self::CommandFailed(message)
            | Self::InvalidJson(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for CliError {}

impl OpenClawCli {
    pub fn discover() -> Result<Self, CliError> {
        let cli = Self::locate()?;
        match cli.verify() {
            Ok(()) => Ok(cli),
            Err(_) if cli.executable == PathBuf::from("openclaw") => Err(CliError::Missing),
            Err(error) => Err(error),
        }
    }

    /// Resolve the executable for an owner that supplies cancellable process supervision.
    pub(crate) fn locate() -> Result<Self, CliError> {
        let home = openclaw_home()?;
        if let Some(override_path) = env::var_os("OPENCLAW_DESKTOP_CLI") {
            let mut cli = Self::new(PathBuf::from(override_path), home);
            cli.allow_runtime_management = false;
            return Ok(cli);
        }

        let managed = managed_launcher(&home);
        if managed.is_file() {
            return Ok(Self::new(managed, home));
        }

        let cli = Self::new(PathBuf::from("openclaw"), home);
        #[cfg(windows)]
        let cli = {
            let executable = env::split_paths(&cli.command_path()?)
                .flat_map(|directory| {
                    [
                        directory.join("openclaw.exe"),
                        directory.join("openclaw.cmd"),
                    ]
                })
                .find(|candidate| candidate.is_file());
            Self {
                executable: executable.unwrap_or(cli.executable),
                ..cli
            }
        };
        Ok(cli)
    }

    fn new(executable: PathBuf, openclaw_home: PathBuf) -> Self {
        Self {
            executable,
            openclaw_home,
            available: Arc::new(AtomicBool::new(true)),
            allow_runtime_management: true,
        }
    }

    #[cfg(not(target_os = "windows"))]
    pub(crate) fn browser_runtime(prefix: PathBuf) -> Result<Self, CliError> {
        // The install prefix supplies executable/PATH only; the user’s config and state stay unchanged.
        let cli = Self::new(prefix.join("bin/openclaw"), prefix);
        cli.verify()?;
        Ok(cli)
    }

    #[cfg(not(target_os = "windows"))]
    pub(crate) fn matches_version(&self, version: &str) -> bool {
        self.output(["--version"]).is_ok_and(|output| {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let reported = stdout.trim();
            let reported = reported.strip_prefix("OpenClaw ").unwrap_or(reported);
            output.status.success() && reported.split_whitespace().next() == Some(version)
        })
    }

    pub fn is_available(&self) -> bool {
        self.available.load(Ordering::Acquire)
    }

    fn verify(&self) -> Result<(), CliError> {
        let output = self.output(["--version"])?;
        if output.status.success() {
            return Ok(());
        }
        Err(CliError::Spawn(format!(
            "OpenClaw CLI exited with {}",
            output.status
        )))
    }

    pub fn command<I, S>(&self, args: I) -> Result<Command, CliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        #[cfg(windows)]
        let mut command = self
            .managed_windows_command()?
            .unwrap_or_else(|| Command::new(&self.executable));
        #[cfg(not(windows))]
        let mut command = Command::new(&self.executable);
        command.args(args);
        let command_path = self.command_path()?;
        #[cfg(windows)]
        let command_path = {
            let program = Path::new(command.get_program());
            if program.starts_with(self.openclaw_home.join("tools/desktop-cli")) {
                env::join_paths(
                    program
                        .parent()
                        .into_iter()
                        .map(Path::to_path_buf)
                        .chain(env::split_paths(&command_path)),
                )
                .map_err(|error| CliError::Environment(error.to_string()))?
            } else {
                command_path
            }
        };
        command.env("PATH", command_path);
        command.stdin(Stdio::null());
        Ok(command)
    }

    pub fn output<I, S>(&self, args: I) -> Result<Output, CliError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut command = self.command(args)?;
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let child = command.spawn().map_err(|error| {
            self.available.store(false, Ordering::Release);
            CliError::Spawn(format!("Failed to run OpenClaw CLI: {error}"))
        })?;
        child.wait_with_output().map_err(|error| {
            CliError::Spawn(format!("Failed to read OpenClaw CLI output: {error}"))
        })
    }

    pub fn json<T, I, S>(&self, args: I) -> Result<T, CliError>
    where
        T: DeserializeOwned,
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let output = self.output(args)?;
        // Failed commands own their stderr; parsing first would mislabel real
        // failures as missing CLI dashboard support.
        if !output.status.success() {
            let message = output_tail(&output.stderr)
                .or_else(|| output_tail(&output.stdout))
                .unwrap_or_else(|| format!("OpenClaw CLI exited with {}", output.status));
            return Err(CliError::CommandFailed(message));
        }
        serde_json::from_slice(&output.stdout).map_err(|error| {
            CliError::InvalidJson(format!("OpenClaw CLI returned invalid JSON: {error}"))
        })
    }

    pub(crate) fn bounded_json<T: DeserializeOwned>(
        &self,
        args: &[&str],
        spawn: &SpawnCommand<'_>,
    ) -> Result<T, CliError> {
        let mut command = self.command(args)?;
        let mut output = ChromeSetupOutput::new().map_err(|error| {
            CliError::Spawn(format!("Could not prepare Chrome setup output: {error}"))
        })?;
        let stdout = output
            .file
            .try_clone()
            .map_err(|error| CliError::Spawn(format!("Could not capture Chrome setup: {error}")))?;
        command
            .env("OPENCLAW_NO_RESPAWN", "1")
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::null());
        let mut child = spawn(&mut command).map_err(CliError::Spawn)?;
        let deadline = Instant::now() + Duration::from_secs(60);
        let result = loop {
            if output
                .file
                .metadata()
                .map(|metadata| metadata.len() > 1024 * 1024)
                .unwrap_or(true)
            {
                break Err(CliError::InvalidJson(
                    "Chrome setup output exceeded its limit.".into(),
                ));
            }
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Err(error) => {
                    break Err(CliError::Spawn(format!(
                        "Could not wait for Chrome setup: {error}"
                    )))
                }
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
                Ok(None) => {
                    break Err(CliError::CommandFailed(
                        "Chrome setup timed out; retry with openclaw browser extension install."
                            .into(),
                    ))
                }
            }
        };
        // Seekable output avoids an orphaned reader when a descendant retains stdout.
        let _ = child.kill();
        let _ = child.wait();
        let status = result?;
        if !status.success() {
            return Err(CliError::CommandFailed(
                "Chrome setup process failed.".into(),
            ));
        }
        let mut bytes = Vec::new();
        output
            .file
            .rewind()
            .and_then(|_| {
                (&mut output.file)
                    .take((1024 * 1024) + 1)
                    .read_to_end(&mut bytes)
            })
            .map_err(|error| CliError::Spawn(format!("Could not read Chrome setup: {error}")))?;
        if bytes.len() > 1024 * 1024 {
            return Err(CliError::InvalidJson(
                "Chrome setup output exceeded its limit.".into(),
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| CliError::InvalidJson("Chrome setup returned no valid result.".into()))
    }

    #[cfg(unix)]
    pub(crate) fn managed_wrapper(&self) -> Option<PathBuf> {
        let managed = managed_launcher(&self.openclaw_home);
        (self.allow_runtime_management && self.executable == managed).then_some(managed)
    }

    #[cfg(windows)]
    fn managed_windows_command(&self) -> Result<Option<Command>, CliError> {
        if !self.allow_runtime_management
            || self.executable != managed_launcher(&self.openclaw_home)
        {
            return Ok(None);
        }
        let metadata = fs::symlink_metadata(&self.executable)
            .map_err(|error| CliError::Environment(error.to_string()))?;
        if !metadata.is_file() || metadata.len() > 65536 {
            return Ok(None);
        }
        let bytes =
            fs::read(&self.executable).map_err(|error| CliError::Environment(error.to_string()))?;
        let Ok(text) = std::str::from_utf8(&bytes) else {
            return Ok(None);
        };
        let Some((slot, entry)) = private_windows_launcher(text) else {
            return Ok(None);
        };
        let directory = self.openclaw_home.join("tools/desktop-cli").join(slot);
        let mut command = Command::new(directory.join("node.exe"));
        command.arg(directory.join(entry));
        Ok(Some(command))
    }

    fn command_path(&self) -> Result<OsString, CliError> {
        let mut paths = vec![
            self.openclaw_home.join("bin"),
            self.openclaw_home.join(if cfg!(windows) {
                "tools/node"
            } else {
                "tools/node/bin"
            }),
        ];
        if let Some(current) = env::var_os("PATH") {
            paths.extend(env::split_paths(&current));
        }
        env::join_paths(paths)
            .map_err(|error| CliError::Environment(format!("Could not construct PATH: {error}")))
    }
}

fn cli_name() -> &'static str {
    if cfg!(windows) {
        "openclaw.cmd"
    } else {
        "openclaw"
    }
}

pub(crate) fn managed_launcher(prefix: &Path) -> PathBuf {
    prefix.join("bin").join(cli_name())
}

#[cfg(windows)]
fn private_windows_launcher(text: &str) -> Option<(&str, &str)> {
    let start = "@echo off\r\nsetlocal DisableDelayedExpansion\r\n\"%~dp0..\\tools\\desktop-cli\\";
    let slot = text.strip_prefix(start)?.split('\\').next()?;
    if slot.len() != 32 || !slot.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let entry = "node_modules\\openclaw\\dist\\entry.js";
    if text
        != format!(
            "{start}{slot}\\node.exe\" \"%~dp0..\\tools\\desktop-cli\\{slot}\\{entry}\" %*\r\n"
        )
    {
        return None;
    }
    Some((slot, entry))
}

#[cfg(windows)]
pub(crate) fn ordinary_windows_path(path: &Path) -> PathBuf {
    use std::path::{Component, Prefix};
    let mut parts = path.components();
    match parts.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::VerbatimDisk(letter) => {
                PathBuf::from(format!("{}:\\", char::from(letter))).join(parts.as_path())
            }
            Prefix::VerbatimUNC(server, share) => PathBuf::from(r"\\")
                .join(server)
                .join(share)
                .join(parts.as_path()),
            _ => path.to_path_buf(),
        },
        _ => path.to_path_buf(),
    }
}

struct ChromeSetupOutput {
    file: File,
    path: PathBuf,
}

impl ChromeSetupOutput {
    fn new() -> std::io::Result<Self> {
        let path = env::temp_dir().join(format!("openclaw-chrome-{}.log", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path)?;
        Ok(Self { file, path })
    }
}

impl Drop for ChromeSetupOutput {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub(crate) fn output_tail(output: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(output);
    let mut lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    // Repeated progress lines carry no additional failure context.
    lines.dedup();
    let start = lines.len().saturating_sub(12);
    let tail = &lines[start..];
    (!tail.is_empty()).then(|| tail.join("\n"))
}

pub fn openclaw_home() -> Result<PathBuf, CliError> {
    #[cfg(target_os = "windows")]
    let home = env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("USERPROFILE").filter(|value| !value.is_empty()));
    #[cfg(not(target_os = "windows"))]
    let home = env::var_os("HOME").filter(|value| !value.is_empty());
    let home = home.ok_or_else(|| CliError::Environment("HOME is not set".to_string()))?;
    Ok(PathBuf::from(home).join(".openclaw"))
}

#[cfg(test)]
mod tests {
    use super::{output_tail, OpenClawCli};
    use std::path::PathBuf;

    #[cfg(windows)]
    #[test]
    fn ambient_windows_discovery_supports_executables_and_command_launchers() {
        use std::{env, fs, process::Command};
        const CHILD: &str = "OPENCLAW_CLI_DISCOVERY_TEST_CHILD";
        if let Some(expected) = env::var_os(CHILD) {
            let cli = OpenClawCli::discover().expect("discover ambient Windows CLI");
            assert_eq!(cli.executable, PathBuf::from(expected));
            return;
        }
        let root = env::temp_dir().join(format!("openclaw-discovery-{}", uuid::Uuid::new_v4()));
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let ambient = root.join("ambient");
        fs::create_dir_all(&ambient).unwrap();
        let probe = root.join("probe.rs");
        fs::write(&probe, "fn main() { println!(\"0.0.0-test\"); }").unwrap();
        let executable = ambient.join("openclaw.exe");
        let compiled = Command::new("rustc")
            .arg(&probe)
            .arg("-o")
            .arg(&executable)
            .output()
            .unwrap();
        assert!(
            compiled.status.success(),
            "{}",
            String::from_utf8_lossy(&compiled.stderr)
        );
        let launcher = ambient.join("openclaw.cmd");
        for (index, expected) in [&executable, &executable, &launcher]
            .into_iter()
            .enumerate()
        {
            if index == 1 {
                fs::write(&launcher, "@echo off\r\necho 0.0.0-test\r\n").unwrap();
            } else if index == 2 {
                fs::remove_file(&executable).unwrap();
            }
            let output = Command::new(env::current_exe().unwrap())
                .args(["--exact", "cli::tests::ambient_windows_discovery_supports_executables_and_command_launchers", "--nocapture"])
                .env(CHILD, expected)
                .env("HOME", &root)
                .env("USERPROFILE", &root)
                .env("PATH", &ambient)
                .env_remove("OPENCLAW_DESKTOP_CLI")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn managed_windows_cli_preserves_native_arguments_and_operator_launchers() {
        use std::{fs, process::Command};
        let root = std::env::temp_dir().join(format!("openclaw-cli-{}", uuid::Uuid::new_v4()));
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let slot = "0123456789abcdef0123456789abcdef";
        let directory = root.join("tools/desktop-cli").join(slot);
        fs::create_dir_all(&directory).unwrap();
        fs::create_dir_all(root.join("bin")).unwrap();
        let probe = directory.join("probe.rs");
        fs::write(
            &probe,
            "fn main() { for arg in std::env::args().skip(1) { println!(\"{}\", arg); } }",
        )
        .unwrap();
        let compiled = Command::new("rustc")
            .arg(&probe)
            .arg("-o")
            .arg(directory.join("node.exe"))
            .output()
            .unwrap();
        assert!(
            compiled.status.success(),
            "{}",
            String::from_utf8_lossy(&compiled.stderr)
        );
        let wrapper = super::managed_launcher(&root);
        let text = format!("@echo off\r\nsetlocal DisableDelayedExpansion\r\n\"%~dp0..\\tools\\desktop-cli\\{slot}\\node.exe\" \"%~dp0..\\tools\\desktop-cli\\{slot}\\node_modules\\openclaw\\dist\\entry.js\" %*\r\n");
        fs::write(&wrapper, &text).unwrap();
        let cli = OpenClawCli::new(wrapper.clone(), root);
        let pin = r#"{"revision":"test","definition":"a & b %PATH% ! quoted"}"#;
        let output = cli
            .output(["gateway", "install", "--expected-runtime-pin", pin])
            .unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert_eq!(
            stdout.lines().skip(1).collect::<Vec<_>>(),
            ["gateway", "install", "--expected-runtime-pin", pin]
        );
        let mut overridden = cli.clone();
        overridden.allow_runtime_management = false;
        assert_eq!(
            overridden.command(["--version"]).unwrap().get_program(),
            wrapper.as_os_str()
        );
        fs::write(&wrapper, format!("{text}rem operator customization\r\n")).unwrap();
        assert_eq!(
            cli.command(["--version"]).unwrap().get_program(),
            wrapper.as_os_str()
        );
    }

    #[cfg(windows)]
    #[test]
    fn canonical_windows_paths_keep_their_volume_and_unc_share() {
        assert_eq!(
            super::ordinary_windows_path(std::path::Path::new(r"\\?\C:\Users\Fixture\bun.exe")),
            PathBuf::from(r"C:\Users\Fixture\bun.exe")
        );
        assert_eq!(
            super::ordinary_windows_path(std::path::Path::new(r"\\?\UNC\server\share\bun.exe")),
            PathBuf::from(r"\\server\share\bun.exe")
        );
    }

    #[test]
    fn output_tail_keeps_the_last_twelve_nonempty_lines() {
        let output = (1..=15)
            .map(|line| format!("message {line}"))
            .collect::<Vec<_>>()
            .join("\n\n");
        let expected = (4..=15)
            .map(|line| format!("message {line}"))
            .collect::<Vec<_>>()
            .join("\n");

        assert_eq!(output_tail(output.as_bytes()), Some(expected));
        assert_eq!(output_tail(b"\n  \n"), None);
        assert_eq!(
            output_tail(b"waiting\n\nwaiting\nfailed\nwaiting"),
            Some("waiting\nfailed\nwaiting".into())
        );
    }

    #[cfg(unix)]
    #[test]
    fn chrome_setup_preserves_canonical_pending_and_blocked_results() {
        use crate::chrome_setup::{run, Action};
        use serde_json::json;
        use std::fs;
        use std::os::unix::fs::symlink;
        use std::process::Command;

        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let fixture = Fixture(
            std::env::temp_dir().join(format!("openclaw-chrome-setup-{}", uuid::Uuid::new_v4())),
        );
        fs::create_dir_all(&fixture.0).unwrap();
        let executable = fixture.0.join("openclaw");
        // A concurrent test's fork can inherit a script writer and make execve fail with ETXTBSY.
        symlink(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/chrome-setup-cli.sh"),
            &executable,
        )
        .unwrap();
        let cli = OpenClawCli::new(executable, fixture.0.clone());
        let spawn = |command: &mut Command| command.spawn().map_err(|error| error.to_string());
        assert!(cli.matches_version("2026.9.4"));
        assert!(!cli.matches_version("2026.9.3"));
        let denied = run(&cli, Action::Install, &|_| {
            Err("fixture-revoked-authority".into())
        })
        .unwrap_err();
        assert!(!denied.contains("fixture-revoked-authority"));
        assert!(!fixture.0.join("calls").exists());
        for (action, name, phase) in [
            (Action::Inspect, "inspect", "inspection_required"),
            (Action::Install, "install", "needs_browser_action"),
            (Action::Verify, "verify", "blocked"),
        ] {
            let expected = json!({
                "action": name,
                "target": {"kind": "local-host", "platform": "fixture", "hostname": "fixture",
                    "profile": "work", "relayPort": 18792},
                "phase": phase, "reason": "fixture",
                "installation": {"nativeHostRegistered": false, "installRequested": false,
                    "installedProfiles": 0, "discoveredProfiles": 0, "awaitingApproval": false,
                    "automaticBootstrapSupported": false},
                "connection": {"state": "not_checked"}, "nextAction": "install"
            });
            fs::write(fixture.0.join("result.json"), expected.to_string()).unwrap();
            assert_eq!(run(&cli, action, &spawn).unwrap(), expected);
        }
        assert_eq!(
            fs::read_to_string(fixture.0.join("calls")).unwrap(),
            ["inspect", "install", "verify"]
                .map(|action| format!(
                    "browser extension setup --action {action} --json --wait-ms 1000\n"
                ))
                .concat()
        );
        fs::write(fixture.0.join("fail"), "").unwrap();
        let error = run(&cli, Action::Install, &spawn).unwrap_err();
        assert!(error.contains("Chrome setup failed"));
        assert!(!error.contains("fixture-private-diagnostic"));
        fs::remove_file(fixture.0.join("fail")).unwrap();
        fs::write(fixture.0.join("result.json"), "x".repeat(1024 * 1024 + 1)).unwrap();
        assert!(run(&cli, Action::Inspect, &spawn)
            .unwrap_err()
            .contains("invalid Chrome setup result"));
        fs::write(fixture.0.join("result.json"), "invalid JSON").unwrap();
        assert!(run(&cli, Action::Inspect, &spawn)
            .unwrap_err()
            .contains("invalid Chrome setup result"));
    }

    #[test]
    fn missing_executable_invalidates_the_cached_cli() {
        let cli = OpenClawCli::new(
            PathBuf::from("openclaw-test-executable-that-does-not-exist"),
            PathBuf::new(),
        );

        assert!(cli.is_available());
        assert!(cli.output(["--version"]).is_err());
        assert!(!cli.is_available());
    }
}
