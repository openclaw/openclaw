//! `resolve_config` (used by doctor/gateway/pairing) must honor the same
//! documented precedence as `config file`.
//!
//! The resolver searched `OPENCLAW_CONFIG`, then a hardcoded
//! `/etc/openclaw/config.toml`, *before* `OPENCLAW_CONFIG_PATH`, so on a host with
//! the packaged `/etc` layout a user-set variable was silently ignored and
//! commands acted on a different file than the operator named.

use std::path::PathBuf;
use std::process::{Command, Output};

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "openclaw-resolve-{}-{}",
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

fn doctor(sandbox: &Sandbox, extra_env: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_openclaw"));
    command.arg("doctor");
    command.env("HOME", &sandbox.root);
    command.env("OPENCLAW_STATE_DIR", &sandbox.root);
    command.env_remove("OPENCLAW_CONFIG_PATH");
    command.env_remove("OPENCLAW_CONFIG");
    command.env_remove("OPENCLAW_HOME");
    command.env_remove("OPENCLAW_GATEWAY_TOKEN");
    for (key, value) in extra_env {
        command.env(key, value);
    }
    command.output().expect("run openclaw doctor")
}

fn combined(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn doctor_uses_openclaw_config_path() {
    let sandbox = Sandbox::new("explicit");
    let explicit = sandbox.root.join("explicit.json");
    std::fs::write(
        &explicit,
        r#"{"gateway":{"listen":"127.0.0.1:18789"},"database":{"path":"explicit.db"}}"#,
    )
    .unwrap();

    let output = doctor(&sandbox, &[("OPENCLAW_CONFIG_PATH", &explicit.to_string_lossy())]);
    let text = combined(&output);
    assert!(
        text.contains(&explicit.display().to_string()),
        "doctor must use OPENCLAW_CONFIG_PATH, not another file:\n{text}"
    );
}

#[test]
fn undocumented_openclaw_config_never_beats_the_documented_variable() {
    let sandbox = Sandbox::new("undocumented");
    let documented = sandbox.root.join("documented.json");
    let undocumented = sandbox.root.join("undocumented.json");
    std::fs::write(
        &documented,
        r#"{"gateway":{"listen":"127.0.0.1:18789"},"database":{"path":"documented.db"}}"#,
    )
    .unwrap();
    std::fs::write(
        &undocumented,
        r#"{"gateway":{"listen":"127.0.0.1:18789"},"database":{"path":"undocumented.db"}}"#,
    )
    .unwrap();

    let output = doctor(
        &sandbox,
        &[
            ("OPENCLAW_CONFIG_PATH", &documented.to_string_lossy()),
            ("OPENCLAW_CONFIG", &undocumented.to_string_lossy()),
        ],
    );
    let text = combined(&output);
    assert!(
        text.contains(&documented.display().to_string()),
        "the documented OPENCLAW_CONFIG_PATH must win over OPENCLAW_CONFIG:\n{text}"
    );
    assert!(
        !text.contains(&undocumented.display().to_string()),
        "the undocumented variable selected the config:\n{text}"
    );
}

#[test]
fn state_dir_default_applies_when_nothing_is_set() {
    let sandbox = Sandbox::new("default");
    // Write the default config so the resolver has something to find.
    std::fs::write(
        sandbox.root.join("openclaw.json"),
        r#"{"gateway":{"listen":"127.0.0.1:18789"},"database":{"path":"default.db"}}"#,
    )
    .unwrap();
    let output = doctor(&sandbox, &[]);
    let text = combined(&output);
    assert!(
        text.contains(&sandbox.root.join("openclaw.json").display().to_string()),
        "doctor must fall back to <state dir>/openclaw.json:\n{text}"
    );
}
