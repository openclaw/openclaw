//! `openclaw gateway status --json` must expose the contract installers parse.
//!
//! Official references:
//!   `scripts/install-cli.sh:1234-1261` — reads `data.service.loaded` from
//!     `openclaw gateway status --json` to decide whether to refresh a service
//!   `docs/cli/gateway/query.md:212-272` — `--url`, `--port`, `--token`,
//!     `--password`, `--timeout`, `--no-probe`, `--require-rpc`, `--deep`,
//!     `--json`
//!   `docs/cli/daemon.md:26-35` — same flags on the legacy alias
//!
//! The Rust command ignored every flag, always printed human text, had no
//! `service.loaded`, and exited 0 whether or not a Gateway was reachable, so no
//! installer could branch on it.

use std::process::{Command, Output};

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_openclaw"))
        .args(args)
        .env("OPENCLAW_CONFIG_PATH", "/nonexistent/openclaw.json")
        .env_remove("OPENCLAW_GATEWAY_TOKEN")
        .output()
        .expect("run openclaw gateway status")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

#[test]
fn json_output_is_one_object_with_service_loaded() {
    let output = run(&["gateway", "status", "--json"]);
    let text = stdout(&output);
    let value: serde_json::Value = serde_json::from_str(text.trim())
        .unwrap_or_else(|error| panic!("status --json must emit one object ({error}):\n{text}"));

    assert!(
        value["service"]["loaded"].is_boolean(),
        "installers read service.loaded: {text}"
    );
    assert!(
        value["gateway"]["reachable"].is_boolean(),
        "reachable must be explicit: {text}"
    );
    assert!(
        value["ok"].is_boolean(),
        "an ok flag is required: {text}"
    );
    assert!(
        !text.contains("Gateway Status :"),
        "json mode must not print the human banner:\n{text}"
    );
}

#[test]
fn json_output_never_contains_a_secret() {
    let output = Command::new(env!("CARGO_BIN_EXE_openclaw"))
        .args(["gateway", "status", "--json"])
        .env("OPENCLAW_CONFIG_PATH", "/nonexistent/openclaw.json")
        .env("OPENCLAW_GATEWAY_TOKEN", "synthetic-status-secret")
        .output()
        .expect("run");
    let text = stdout(&output);
    assert!(
        !text.contains("synthetic-status-secret"),
        "status leaked the token:\n{text}"
    );
}

#[test]
fn no_probe_skips_the_network_check() {
    let output = run(&["gateway", "status", "--json", "--no-probe"]);
    let text = stdout(&output);
    let value: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
    assert_eq!(
        value["gateway"]["probed"], false,
        "--no-probe must skip the probe: {text}"
    );
}

#[test]
fn port_flag_is_accepted_and_reported() {
    let output = run(&["gateway", "status", "--json", "--port", "19999"]);
    let text = stdout(&output);
    let value: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
    assert_eq!(
        value["gateway"]["port"], 19999,
        "--port must retarget the probe: {text}"
    );
}

#[test]
fn unknown_flags_are_rejected() {
    let output = run(&["gateway", "status", "--frobnicate"]);
    assert!(
        !output.status.success(),
        "unknown status flag accepted:\n{}",
        stdout(&output)
    );
}

#[test]
fn human_output_still_works_without_json() {
    let output = run(&["gateway", "status"]);
    let text = stdout(&output);
    assert!(
        text.contains("Gateway Status"),
        "human mode keeps its banner:\n{text}"
    );
}
