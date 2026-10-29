//! `openclaw uninstall` must honor documented scopes and safety rules.
//!
//! Official reference: `docs/cli/uninstall.md` — `--service`, `--state`,
//! `--workspace`, `--app`, `--all`, `--yes`, `--non-interactive`, `--dry-run`.
//! The Rust CLI had no `uninstall` command at all.

use std::path::PathBuf;
use std::process::{Command, Output};

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "openclaw-uninstall-{}-{}",
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

    fn seed(&self) {
        std::fs::write(
            self.config(),
            r#"{"gateway":{"listen":"127.0.0.1:18789"},"database":{"path":"db.sqlite"}}"#,
        )
        .unwrap();
        std::fs::write(self.root.join("db.sqlite"), b"state").unwrap();
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_openclaw"))
            .args(args)
            .env("OPENCLAW_CONFIG_PATH", self.config())
            .env("OPENCLAW_STATE_DIR", &self.root)
            .env("HOME", &self.root)
            .output()
            .expect("run openclaw")
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
fn all_scope_removes_everything_and_still_reports_app_as_not_applicable() {
    let sandbox = Sandbox::new("all");
    sandbox.seed();
    let output = sandbox.run(&["uninstall", "--all", "--yes", "--non-interactive"]);
    let text = combined(&output).to_lowercase();
    assert!(
        !sandbox.config().exists(),
        "--all left the config behind (it must not stop at the app scope):\n{text}"
    );
    assert!(
        !sandbox.root.join("db.sqlite").exists(),
        "--all left the database behind:\n{text}"
    );
    if !cfg!(target_os = "macos") {
        assert!(
            text.contains("not applicable") || text.contains("macos"),
            "--all must still report the app scope as not applicable:\n{text}"
        );
    }
}

#[test]
fn state_scope_preserves_workspaces_unless_workspace_is_selected() {
    let sandbox = Sandbox::new("workspace");
    sandbox.seed();
    let workspace = sandbox.root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("MEMORY.md"), b"agent notes").unwrap();

    let output = sandbox.run(&["uninstall", "--state", "--yes", "--non-interactive"]);
    assert!(output.status.success(), "{}", combined(&output));
    assert!(
        workspace.join("MEMORY.md").is_file(),
        "--state must preserve configured workspace directories:\n{}",
        combined(&output)
    );
    assert!(!sandbox.config().exists(), "config should still be removed");
}

#[test]
fn workspace_scope_removes_workspaces_when_asked() {
    let sandbox = Sandbox::new("workspace-only");
    sandbox.seed();
    let workspace = sandbox.root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("MEMORY.md"), b"agent notes").unwrap();

    let output = sandbox.run(&[
        "uninstall",
        "--state",
        "--workspace",
        "--yes",
        "--non-interactive",
    ]);
    assert!(output.status.success(), "{}", combined(&output));
    assert!(
        !workspace.exists(),
        "--workspace must remove workspace directories:\n{}",
        combined(&output)
    );
}

#[test]
fn dry_run_lists_planned_scopes_without_removing_anything() {
    let sandbox = Sandbox::new("dry");
    sandbox.seed();
    let output = sandbox.run(&["uninstall", "--state", "--dry-run", "--yes"]);
    assert!(output.status.success(), "{}", combined(&output));
    assert!(sandbox.config().is_file(), "--dry-run deleted config");
    assert!(sandbox.root.join("db.sqlite").is_file(), "--dry-run deleted state");
    let text = combined(&output);
    assert!(
        text.to_lowercase().contains("state"),
        "dry run must name the planned scope:\n{text}"
    );
}

#[test]
fn state_scope_removes_config_and_database() {
    let sandbox = Sandbox::new("state");
    sandbox.seed();
    let output = sandbox.run(&["uninstall", "--state", "--yes", "--non-interactive"]);
    assert!(output.status.success(), "{}", combined(&output));
    assert!(!sandbox.config().exists(), "config survived --state");
    assert!(!sandbox.root.join("db.sqlite").exists(), "database survived --state");
}

#[test]
fn non_interactive_without_yes_is_refused() {
    let sandbox = Sandbox::new("noyes");
    sandbox.seed();
    let output = sandbox.run(&["uninstall", "--state", "--non-interactive"]);
    assert!(
        !output.status.success(),
        "--non-interactive without --yes must not proceed:\n{}",
        combined(&output)
    );
    assert!(sandbox.config().is_file(), "config was removed anyway");
}

#[test]
fn no_scope_removes_nothing_without_yes() {
    let sandbox = Sandbox::new("noscope");
    sandbox.seed();
    let output = sandbox.run(&["uninstall", "--yes"]);
    // With no scope flags upstream prompts; a non-TTY run must not silently
    // delete the whole installation.
    assert!(
        !output.status.success() || combined(&output).to_lowercase().contains("scope"),
        "no-scope uninstall behaved silently:\n{}",
        combined(&output)
    );
    assert!(sandbox.config().is_file(), "no-scope uninstall deleted config");
}

#[test]
fn app_scope_is_not_applicable_off_macos() {
    if cfg!(target_os = "macos") {
        return;
    }
    let sandbox = Sandbox::new("app");
    sandbox.seed();
    let output = sandbox.run(&["uninstall", "--app", "--yes", "--non-interactive"]);
    let text = combined(&output).to_lowercase();
    assert!(
        text.contains("not applicable") || text.contains("macos"),
        "--app must report it does not apply here:\n{text}"
    );
}
