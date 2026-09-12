use super::ensure_ready;
use crate::cli::OpenClawCli;
use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;

const CHILD: &str = "OPENCLAW_STATUS_CONTRACT_CHILD";
const TEST: &str = "gateway::status_tests::cli_service_status_lifecycle_contract";
const BROWSER_URL: &str = "http://127.0.0.1:18789/#bootstrapToken=fixture-status-grant";
const INSPECTION_ERROR: &str = "systemctl is-enabled timed out";
const RPC_ERROR: &str = "Gateway authentication failed: fixture token rejected";
const CLI: &str = r#"#!/bin/sh
root=$(dirname "$0")
printf '%s\n' "$*" >> "$root/calls"
case "$*" in
  --version) printf '0.0.0-test\n' ;;
  'gateway status --json')
    if test -f "$root/started"; then
      cat "$root/healthy.json"
    elif test -f "$root/installed"; then
      cat "$root/stopped.json"
    else
      cat "$root/status.json"
    fi ;;
  'gateway install --json')
    touch "$root/installed"
    printf '{"ok":true}\n' ;;
  'gateway start --json')
    touch "$root/started"
    printf '{"ok":true}\n' ;;
  'dashboard --json --no-open') cat "$root/dashboard.json" ;;
  *) printf 'Unexpected fixture CLI invocation\n' >&2; exit 1 ;;
esac
"#;

struct TestDirectory(PathBuf);

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

enum Expected {
    Ready { install: bool, start: bool },
    Unknown { inspection: bool, auth: bool },
    Invalid,
}

fn status(loaded: Value, running: bool, reachable: bool) -> Value {
    json!({
        "service": {
            "loaded": loaded,
            "command": null,
            "runtime": {"status": if running { "running" } else { "stopped" }},
        },
        "rpc": {"ok": reachable}
    })
}

#[test]
fn cli_service_status_lifecycle_contract() {
    // A fresh process owns CLI discovery and HOME; parallel Rust tests never
    // observe a temporary override or share this test's service-call recorder.
    if let Some(root) = std::env::var_os(CHILD) {
        let cli = OpenClawCli::discover().expect("discover isolated fixture CLI");
        let result = match ensure_ready(&cli) {
            Ok(ready) => json!({
                "ok": true,
                "reachable": ready.snapshot.reachable,
                "phase": ready.snapshot.phase,
                "dashboardUrl": ready.dashboard_url,
            }),
            Err(error) => json!({"ok": false, "error": error}),
        };
        fs::write(
            PathBuf::from(root).join("result.json"),
            serde_json::to_vec(&result).unwrap(),
        )
        .expect("record ensure_ready result");
        return;
    }

    let mut unknown = status(Value::Null, false, false);
    unknown["service"]["loadState"] = json!({"status": "unknown", "detail": INSPECTION_ERROR});
    unknown["service"]["runtime"]["status"] = json!("unknown");
    unknown["rpc"]["error"] = json!(RPC_ERROR);
    let mut unknown_healthy = unknown.clone();
    unknown_healthy["rpc"] = json!({"ok": true});
    let mut unknown_with_command = unknown.clone();
    unknown_with_command["service"]["command"] =
        json!({"programArguments": ["openclaw", "gateway"]});
    let mut missing_loaded = status(Value::Null, false, false);
    missing_loaded["service"]
        .as_object_mut()
        .unwrap()
        .remove("loaded");

    let cases = [
        (
            "unknown-healthy",
            unknown_healthy.to_string(),
            Expected::Ready {
                install: false,
                start: false,
            },
        ),
        (
            "unknown-unreachable-no-command",
            unknown.to_string(),
            Expected::Unknown {
                inspection: true,
                auth: true,
            },
        ),
        (
            "unknown-unreachable-with-command",
            unknown_with_command.to_string(),
            Expected::Unknown {
                inspection: true,
                auth: true,
            },
        ),
        (
            "known-absent",
            status(json!(false), false, false).to_string(),
            Expected::Ready {
                install: true,
                start: true,
            },
        ),
        (
            "loaded-stopped",
            status(json!(true), false, false).to_string(),
            Expected::Ready {
                install: false,
                start: true,
            },
        ),
        (
            "healthy-unmanaged",
            status(json!(false), true, true).to_string(),
            Expected::Ready {
                install: false,
                start: false,
            },
        ),
        (
            "healthy-managed",
            status(json!(true), true, true).to_string(),
            Expected::Ready {
                install: false,
                start: false,
            },
        ),
        (
            "missing-loaded",
            missing_loaded.to_string(),
            Expected::Unknown {
                inspection: false,
                auth: false,
            },
        ),
        (
            "malformed-loaded",
            status(json!("false"), false, false).to_string(),
            Expected::Invalid,
        ),
        (
            "missing-service",
            json!({"rpc": {"ok": false}}).to_string(),
            Expected::Invalid,
        ),
        ("malformed-json", "{invalid".to_string(), Expected::Invalid),
    ];
    let mut failures = Vec::new();
    for (name, initial_status, expected) in cases {
        let directory = TestDirectory(
            std::env::temp_dir().join(format!("openclaw-status-contract-{}", uuid::Uuid::new_v4())),
        );
        let root = &directory.0;
        fs::create_dir(root).unwrap();
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
        let executable = root.join("openclaw");
        fs::write(&executable, CLI).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("status.json"), initial_status).unwrap();
        fs::write(
            root.join("healthy.json"),
            status(json!(true), true, true).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("stopped.json"),
            status(json!(true), false, false).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("dashboard.json"),
            json!({
                "ok": true,
                "url": "http://127.0.0.1:18789/#token=fixture-status-token",
                "browserUrl": BROWSER_URL,
                "wsUrl": "ws://127.0.0.1:18789",
            })
            .to_string(),
        )
        .unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env_clear()
            .env(CHILD, root)
            .env("HOME", root)
            .env("PATH", "/usr/bin:/bin")
            .env("OPENCLAW_DESKTOP_CLI", &executable)
            .output()
            .expect("run isolated ensure_ready contract");
        assert!(
            output.status.success(),
            "{name}: fixture child failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value =
            serde_json::from_slice(&fs::read(root.join("result.json")).unwrap()).unwrap();
        let calls = fs::read_to_string(root.join("calls")).unwrap();
        let lifecycle: Vec<_> = calls
            .lines()
            .filter(|call| *call != "--version" && *call != "gateway status --json")
            .collect();
        let mut expected_calls = Vec::new();
        let valid = match expected {
            Expected::Ready { install, start } => {
                if install {
                    expected_calls.push("gateway install --json");
                }
                if start {
                    expected_calls.push("gateway start --json");
                }
                expected_calls.push("dashboard --json --no-open");
                result["ok"] == true
                    && result["reachable"] == true
                    && result["phase"] == "connected"
                    && result["dashboardUrl"] == BROWSER_URL
            }
            Expected::Unknown { inspection, auth } => {
                let error = result["error"].as_str().unwrap_or("");
                result["ok"] == false
                    && error.contains("openclaw gateway status")
                    && !error.contains("invalid JSON")
                    && (!inspection || error.contains(INSPECTION_ERROR))
                    && (!auth || error.contains(RPC_ERROR))
            }
            Expected::Invalid => result["ok"] == false,
        };
        let passed = valid && lifecycle == expected_calls;
        println!(
            "{} {name}: result={result}; lifecycle={lifecycle:?}",
            if passed { "PASS" } else { "FAIL" }
        );
        if !passed {
            failures.push(name);
        }
    }
    assert!(
        failures.is_empty(),
        "CLI status contract failures: {failures:?}"
    );
}
