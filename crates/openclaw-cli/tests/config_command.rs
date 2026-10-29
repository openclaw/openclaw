//! `openclaw config` must exist with the documented subcommands.
//!
//! Official reference: `docs/cli/config.md` — get/set/patch/unset/file/schema/
//! validate, plus `--dry-run` and read-only mode. The Rust CLI had no `config`
//! command at all, so every assertion here failed with "unknown command".

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "openclaw-configcmd-{}-{}",
            std::process::id(),
            label
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn config(&self) -> PathBuf {
        self.root.join("openclaw.json")
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_openclaw"))
            .args(args)
            .env("OPENCLAW_CONFIG_PATH", self.config())
            .env("OPENCLAW_STATE_DIR", &self.root)
            .env("HOME", &self.root)
            .env_remove("OPENCLAW_GATEWAY_TOKEN")
            .output()
            .expect("run openclaw")
    }

    fn seed(&self) {
        std::fs::write(
            self.config(),
            r#"{"gateway":{"listen":"127.0.0.1:18789"},"logging":{"level":"info"}}"#,
        )
        .unwrap();
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

fn read_json(path: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn config_file_prints_the_resolved_path() {
    let sandbox = Sandbox::new("file");
    sandbox.seed();
    let output = sandbox.run(&["config", "file"]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(stdout(&output).trim(), sandbox.config().display().to_string());
}

#[test]
fn config_get_reads_a_dotted_path() {
    let sandbox = Sandbox::new("get");
    sandbox.seed();
    let output = sandbox.run(&["config", "get", "gateway.listen"]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(stdout(&output).trim(), "127.0.0.1:18789");

    // A missing path is an error, not an empty success.
    let missing = sandbox.run(&["config", "get", "gateway.nope"]);
    assert!(!missing.status.success(), "missing path exited 0");
}

#[test]
fn config_set_and_unset_edit_the_file() {
    let sandbox = Sandbox::new("set");
    sandbox.seed();

    let set = sandbox.run(&["config", "set", "logging.level", "debug"]);
    assert!(set.status.success(), "{}", stderr(&set));
    assert_eq!(read_json(&sandbox.config())["logging"]["level"], "debug");

    // Booleans and numbers are typed, not stored as strings.
    let number = sandbox.run(&["config", "set", "gateway.maxConnections", "64"]);
    assert!(number.status.success(), "{}", stderr(&number));
    assert_eq!(read_json(&sandbox.config())["gateway"]["maxConnections"], 64);

    let boolean = sandbox.run(&["config", "set", "gateway.controlUiEnabled", "false"]);
    assert!(boolean.status.success(), "{}", stderr(&boolean));
    assert_eq!(
        read_json(&sandbox.config())["gateway"]["controlUiEnabled"],
        false
    );

    let unset = sandbox.run(&["config", "unset", "logging.level"]);
    assert!(unset.status.success(), "{}", stderr(&unset));
    assert!(read_json(&sandbox.config())["logging"].get("level").is_none());
}

#[test]
fn config_dry_run_reports_without_writing() {
    let sandbox = Sandbox::new("dry");
    sandbox.seed();
    let before = std::fs::read_to_string(sandbox.config()).unwrap();

    let output = sandbox.run(&["config", "set", "logging.level", "trace", "--dry-run"]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        stdout(&output).contains("trace"),
        "dry run must show the planned value: {}",
        stdout(&output)
    );
    assert_eq!(
        std::fs::read_to_string(sandbox.config()).unwrap(),
        before,
        "--dry-run wrote the config file"
    );
}

#[test]
fn config_validate_reports_problems_with_a_nonzero_exit() {
    let sandbox = Sandbox::new("validate");
    sandbox.seed();
    let ok = sandbox.run(&["config", "validate"]);
    assert!(ok.status.success(), "{}", stderr(&ok));

    // A non-loopback listener with no credential is invalid.
    std::fs::write(
        sandbox.config(),
        r#"{"gateway":{"listen":"0.0.0.0:18789"}}"#,
    )
    .unwrap();
    let bad = sandbox.run(&["config", "validate"]);
    assert!(
        !bad.status.success(),
        "invalid config validated successfully:\n{}{}",
        stdout(&bad),
        stderr(&bad)
    );
    let combined = format!("{}{}", stdout(&bad), stderr(&bad));
    assert!(
        combined.to_lowercase().contains("auth")
            || combined.to_lowercase().contains("gateway.listen"),
        "validation must name the problem:\n{combined}"
    );
}

#[test]
fn config_writes_are_refused_when_the_config_is_read_only() {
    let sandbox = Sandbox::new("readonly");
    sandbox.seed();
    let before = std::fs::read_to_string(sandbox.config()).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_openclaw"))
        .args(["config", "set", "logging.level", "debug"])
        .env("OPENCLAW_CONFIG_PATH", sandbox.config())
        .env("OPENCLAW_CONFIG_READONLY", "1")
        .output()
        .expect("run openclaw");

    assert!(
        !output.status.success(),
        "read-only config accepted a write: {}",
        stdout(&output)
    );
    assert_eq!(
        std::fs::read_to_string(sandbox.config()).unwrap(),
        before,
        "read-only config was modified"
    );
    // Reads still work.
    let read = Command::new(env!("CARGO_BIN_EXE_openclaw"))
        .args(["config", "get", "logging.level"])
        .env("OPENCLAW_CONFIG_PATH", sandbox.config())
        .env("OPENCLAW_CONFIG_READONLY", "1")
        .output()
        .expect("run openclaw");
    assert!(read.status.success(), "{}", stderr(&read));
}

#[test]
fn config_rejects_a_blank_value_and_unknown_subcommand() {
    let sandbox = Sandbox::new("blank");
    sandbox.seed();
    let blank = sandbox.run(&["config", "set", "logging.level", "   "]);
    assert!(!blank.status.success(), "blank value accepted");

    let unknown = sandbox.run(&["config", "frobnicate"]);
    assert!(!unknown.status.success());
    assert!(
        stderr(&unknown).contains("config"),
        "unknown subcommand must name the command: {}",
        stderr(&unknown)
    );
}
