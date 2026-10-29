//! Config resolution must honor the documented precedence.
//!
//! Official reference: `docs/help/environment.md` — `OPENCLAW_CONFIG_PATH`
//! overrides the active config file, and explicit path variables win over
//! defaults. The Rust resolver searched `OPENCLAW_CONFIG` and a hardcoded
//! `/etc/openclaw/config.toml` *before* the documented variable, so a user-set
//! `OPENCLAW_CONFIG_PATH` was silently ignored.

use std::path::PathBuf;
use std::process::{Command, Output};

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "openclaw-configpath-{}-{}",
            std::process::id(),
            label
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        Self { root }
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn run(sandbox: &Sandbox, extra_env: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_openclaw"));
    command.args(["config", "file"]);
    command.env("HOME", &sandbox.root);
    command.env("OPENCLAW_STATE_DIR", &sandbox.root);
    command.env_remove("OPENCLAW_CONFIG_PATH");
    command.env_remove("OPENCLAW_CONFIG");
    command.env_remove("OPENCLAW_HOME");
    for (key, value) in extra_env {
        command.env(key, value);
    }
    command.output().expect("run openclaw config file")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

#[test]
fn openclaw_config_path_wins_over_the_state_dir_default() {
    let sandbox = Sandbox::new("explicit");
    let explicit = sandbox.root.join("custom").join("openclaw.json");
    std::fs::create_dir_all(explicit.parent().unwrap()).unwrap();
    std::fs::write(&explicit, r#"{"logging":{"level":"debug"}}"#).unwrap();

    let output = run(&sandbox, &[("OPENCLAW_CONFIG_PATH", &explicit.to_string_lossy())]);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(stdout(&output), explicit.display().to_string());
}

#[test]
fn state_dir_default_is_used_when_no_explicit_path_is_set() {
    let sandbox = Sandbox::new("default");
    let output = run(&sandbox, &[]);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(
        stdout(&output),
        sandbox.root.join("openclaw.json").display().to_string()
    );
}

#[test]
fn undocumented_openclaw_config_does_not_override_the_documented_variable() {
    let sandbox = Sandbox::new("undocumented");
    let documented = sandbox.root.join("documented.json");
    let undocumented = sandbox.root.join("undocumented.json");
    std::fs::write(&documented, r#"{"logging":{"level":"info"}}"#).unwrap();
    std::fs::write(&undocumented, r#"{"logging":{"level":"trace"}}"#).unwrap();

    let output = run(
        &sandbox,
        &[
            ("OPENCLAW_CONFIG_PATH", &documented.to_string_lossy()),
            ("OPENCLAW_CONFIG", &undocumented.to_string_lossy()),
        ],
    );
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(
        stdout(&output),
        documented.display().to_string(),
        "the documented OPENCLAW_CONFIG_PATH must win"
    );
}
