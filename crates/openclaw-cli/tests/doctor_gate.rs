//! `openclaw doctor` must gate installers: problems mean a non-zero exit.
//!
//! Official reference: `docs/install/installer.md` — "repair or final verification
//! failure exits nonzero, and the success banner appears only after those steps
//! complete". The Rust build printed WARN/ERROR lines and always exited 0, so an
//! upgrade could never detect a broken config.

use std::path::PathBuf;
use std::process::{Command, Output};

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "openclaw-doctor-{}-{}",
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

    fn write_config(&self, listen: &str) {
        let value = serde_json::json!({
            "gateway": { "mode": "local", "listen": listen },
            "database": { "path": self.root.join("db.sqlite").display().to_string() },
        });
        std::fs::write(self.config(), serde_json::to_string_pretty(&value).unwrap()).unwrap();
    }

    fn run(&self) -> Output {
        Command::new(env!("CARGO_BIN_EXE_openclaw"))
            .arg("doctor")
            .env("OPENCLAW_CONFIG_PATH", self.config())
            .env("OPENCLAW_STATE_DIR", &self.root)
            .env("HOME", &self.root)
            .env_remove("OPENCLAW_GATEWAY_TOKEN")
            .env_remove("TELEGRAM_BOT_TOKEN")
            .output()
            .expect("run openclaw doctor")
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn combined(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn invalid_config_exits_non_zero() {
    let sandbox = Sandbox::new("invalid");
    // Non-loopback listener with no credential is invalid.
    sandbox.write_config("0.0.0.0:18789");

    let output = sandbox.run();
    let text = combined(&output);
    assert!(
        !output.status.success(),
        "doctor reported problems but exited 0:\n{text}"
    );
    assert!(
        text.contains("problem"),
        "doctor must summarize the problems:\n{text}"
    );
}

#[test]
fn valid_config_exits_zero() {
    let sandbox = Sandbox::new("valid");
    sandbox.write_config("127.0.0.1:18789");

    let output = sandbox.run();
    let text = combined(&output);
    assert!(
        output.status.success(),
        "valid config must pass doctor:\n{text}"
    );
}

#[test]
fn section_numbering_is_consistent() {
    let sandbox = Sandbox::new("numbering");
    sandbox.write_config("127.0.0.1:18789");
    let text = combined(&sandbox.run());
    let mut denominators = std::collections::BTreeSet::new();
    for marker in ["[1/", "[2/", "[3/", "[4/", "[5/"] {
        if let Some(index) = text.find(marker) {
            let rest = &text[index + marker.len()..];
            if let Some(end) = rest.find(']') {
                denominators.insert(rest[..end].to_owned());
            }
        }
    }
    assert_eq!(
        denominators.len(),
        1,
        "doctor mixes denominators {denominators:?}:\n{text}"
    );
}
