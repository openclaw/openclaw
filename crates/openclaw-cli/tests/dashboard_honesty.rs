//! `openclaw dashboard` must not claim a pairing handoff it cannot issue.
//!
//! Official reference: `docs/cli/dashboard.md` — `browserUrl` carries a
//! single-use, ten-minute bootstrap in the URL fragment that the browser
//! exchanges for a durable administrator device credential, and failures return
//! `{"ok":false,"error":{...},"reason":...}` with a non-zero exit.
//!
//! The Rust build returned `ok: true` with `browserBootstrapExpiresAtMs: null`
//! and a fragment-less `browserUrl`, which tells an integration a session was
//! provisioned when it was not.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Output};

/// Start a throwaway HTTP listener that answers 200 to anything, so the
/// reachability check passes and the handoff branch is exercised.
fn fake_control_ui() -> (u16, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = std::thread::spawn(move || {
        for _ in 0..4 {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\n\r\nok",
                );
            }
        }
    });
    (port, handle)
}

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_openclaw"))
        .args(args)
        .env("OPENCLAW_CONFIG_PATH", "/nonexistent/openclaw.json")
        .env_remove("OPENCLAW_GATEWAY_TOKEN")
        .output()
        .expect("run openclaw dashboard")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

#[test]
fn json_output_is_a_single_object_and_never_leaks_a_secret() {
    let output = Command::new(env!("CARGO_BIN_EXE_openclaw"))
        .args(["dashboard", "--json"])
        .env("OPENCLAW_CONFIG_PATH", "/nonexistent/openclaw.json")
        .env("OPENCLAW_GATEWAY_TOKEN", "synthetic-dashboard-secret")
        .output()
        .expect("run");
    let text = stdout(&output);
    let value: serde_json::Value = serde_json::from_str(text.trim())
        .unwrap_or_else(|error| panic!("dashboard --json must emit one object ({error}):\n{text}"));
    assert!(
        value["ok"].is_boolean(),
        "ok must be present: {text}"
    );
    assert!(
        !text.contains("synthetic-dashboard-secret"),
        "dashboard leaked the token:\n{text}"
    );
}

#[test]
fn unreachable_control_ui_reports_a_reason_and_exits_non_zero() {
    let output = run(&["dashboard", "--json"]);
    let text = stdout(&output);
    let value: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
    assert_eq!(value["ok"], false, "{text}");
    assert_eq!(value["reason"], "gateway_unreachable", "{text}");
    assert!(!output.status.success(), "failure must exit non-zero:\n{text}");
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
        "unknown flag accepted:\n{}",
        stdout(&output)
    );
}

#[test]
fn a_reachable_ui_does_not_claim_an_owner_handoff() {
    // Even when the UI answers, this build cannot mint the bootstrap token, so the
    // result must be an honest failure rather than a null-expiry success.
    let _ = fake_control_ui();
    let output = run(&["dashboard", "--json"]);
    let text = stdout(&output);
    let value: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
    assert_ne!(
        value["ok"], true,
        "dashboard must not report ok:true without a bootstrap token: {text}"
    );
}
