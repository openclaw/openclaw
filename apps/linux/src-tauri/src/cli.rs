use serde::de::DeserializeOwned;
use std::env;
use std::ffi::OsString;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek};
use std::path::PathBuf;
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
            return Ok(Self::new(PathBuf::from(override_path), home));
        }

        let managed = home.join("bin/openclaw");
        if managed.is_file() {
            return Ok(Self::new(managed, home));
        }

        Ok(Self::new(PathBuf::from("openclaw"), home))
    }

    fn new(executable: PathBuf, openclaw_home: PathBuf) -> Self {
        Self {
            executable,
            openclaw_home,
            available: Arc::new(AtomicBool::new(true)),
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
        let mut command = Command::new(&self.executable);
        command.args(args);
        command.env("PATH", self.command_path()?);
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

    fn command_path(&self) -> Result<OsString, CliError> {
        let mut paths = vec![
            self.openclaw_home.join("bin"),
            self.openclaw_home.join("tools/node/bin"),
        ];
        if let Some(current) = env::var_os("PATH") {
            paths.extend(env::split_paths(&current));
        }
        env::join_paths(paths)
            .map_err(|error| CliError::Environment(format!("Could not construct PATH: {error}")))
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
