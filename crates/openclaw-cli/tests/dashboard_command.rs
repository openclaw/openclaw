//! `openclaw dashboard` must support the documented flags.
//!
//! Official reference: `docs/cli/dashboard.md` — `--no-open`, `--json`, `--yes`,
//! machine-readable object with `url`/`httpUrl`/`wsUrl`/`port`, and a non-zero
//! exit with `{"ok":false,...}` when the Gateway is not reachable.
//! The Rust CLI printed one hardcoded line and ignored every flag.

use std::process::{Command, Output};

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_openclaw"))
        .args(args)
        .env("OPENCLAW_CONFIG_PATH", "/nonexistent/openclaw.json")
        .env_remove("OPENCLAW_GATEWAY_TOKEN")
        .output()
        .expect("run openclaw")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

#[test]
fn json_output_is_a_single_machine_readable_object() {
    let output = run(&["dashboard", "--json"]);
    let text = stdout(&output);
    let value: serde_json::Value = serde_json::from_str(text.trim())
        .unwrap_or_else(|error| panic!("dashboard --json is not one JSON object ({error}):\n{text}"));

    // Not reachable in this sandbox: the documented failure envelope.
    assert_eq!(value["ok"], false, "unexpected success: {text}");
    assert!(
        value["error"]["message"].is_string(),
        "failure must carry an error message: {text}"
    );
    assert!(
        value["reason"].is_string(),
        "failure must carry a machine-readable reason: {text}"
    );
    assert!(
        !output.status.success(),
        "failure must exit non-zero:\n{text}"
    );
    assert!(
        !text.contains("OpenClaw Control UI:"),
        "json mode must not print the human banner:\n{text}"
    );
}

#[test]
fn json_output_never_contains_a_secret() {
    let output = Command::new(env!("CARGO_BIN_EXE_openclaw"))
        .args(["dashboard", "--json"])
        .env("OPENCLAW_CONFIG_PATH", "/nonexistent/openclaw.json")
        .env("OPENCLAW_GATEWAY_TOKEN", "synthetic-should-not-leak")
        .output()
        .expect("run openclaw");
    let text = stdout(&output);
    assert!(
        !text.contains("synthetic-should-not-leak"),
        "dashboard output leaked the gateway token:\n{text}"
    );
}

#[test]
fn no_open_prints_a_url_without_launching_a_browser() {
    let output = run(&["dashboard", "--no-open"]);
    let text = format!(
        "{}{}",
        stdout(&output),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        text.contains("http://") || text.contains("https://"),
        "--no-open must print a URL:\n{text}"
    );
}

#[test]
fn unknown_flags_are_rejected() {
    let output = run(&["dashboard", "--frobnicate"]);
    assert!(
        !output.status.success(),
        "unknown flag accepted: {}",
        stdout(&output)
    );
}
