use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("openclaw-runtime-action-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(path.join("bin")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let fixture = Self(fs::canonicalize(path).unwrap());
        fs::write(fixture.0.join("bun"), "synthetic Bun").unwrap();
        fixture.write_state(&fixture.state());
        fs::write(
            fixture.0.join("healthy.json"),
            serde_json::to_vec(&fixture.healthy()).unwrap(),
        )
        .unwrap();
        // A concurrent fork must never inherit a writable descriptor for an executed fixture.
        symlink(Self::script(), fixture.0.join("bin/openclaw")).unwrap();
        fixture
    }

    fn script() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runtime-action-cli.sh")
    }

    fn canonical_launcher(&self) -> PathBuf {
        let wrapper = self.0.join("bin/openclaw");
        let node = self.0.join("tools/node/bin/node");
        fs::create_dir_all(node.parent().unwrap()).unwrap();
        symlink(Self::script(), node).unwrap();
        let entry = self.0.join("package/dist/entry.js");
        fs::create_dir_all(entry.parent().unwrap()).unwrap();
        fs::write(&entry, "fixture").unwrap();
        fs::remove_file(&wrapper).unwrap();
        // Canonical parsing requires path-specific bytes. A child owns the writer, so Rust test
        // forks cannot inherit it; waiting for that writer proves it closed before execution.
        let mut writer = Command::new("/bin/sh")
            .args(["-c", "cat > \"$1\"", "fixture"])
            .arg(&wrapper)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        writer.stdin.take().unwrap().write_all(format!("#!/usr/bin/env bash\nset -euo pipefail\nexec \"{}/tools/node/bin/node\" \"{}\" \"$@\"\n", self.0.display(), entry.display()).as_bytes()).unwrap();
        assert!(writer.wait().unwrap().success());
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
        wrapper
    }

    fn cli(&self) -> OpenClawCli {
        OpenClawCli::browser_runtime(self.0.clone()).unwrap()
    }

    fn runtime(&self) -> BundledRuntime {
        BundledRuntime {
            bun: self.0.join("bun"),
            sqlite: None,
        }
    }

    fn state(&self) -> Value {
        serde_json::json!({
            "service": {
                "loaded": true, "targetRole": "target",
                "command": { "programArguments": ["/operator/node", "/operator/openclaw/dist/index.js", "gateway", "--port", "18789", "--allow-unconfigured"] },
                "runtime": { "status": "running", "pid": 4100 },
                "runtimeIntent": { "status": "known", "revision": "original-pin", "definition": "original-definition", "stored": false },
                "revision": "original-service", "definitionMutation": "writable",
                "launcherOverridden": false
            },
            "gateway": { "port": 18789 },
            "config": { "daemon": { "path": self.0.join("openclaw.json") } },
            "rpc": { "ok": true },
            "port": { "port": 18789, "status": "busy", "listeners": [{ "pid": 4100 }] }
        })
    }

    fn absent(&self) -> Value {
        let mut state = self.state();
        state["service"]["loaded"] = false.into();
        state["service"]["command"] = Value::Null;
        state["service"]["runtime"] = Value::Null;
        state["service"]["runtimeIntent"]["definition"] = Value::Null;
        state
    }

    fn healthy(&self) -> Value {
        let mut state = self.state();
        state["service"]["command"]["programArguments"][0] =
            self.runtime().bun.to_string_lossy().as_ref().into();
        state["service"]["runtimeIntent"] = serde_json::json!({
            "status": "known", "revision": "bundled-pin", "definition": "bundled-definition", "stored": true,
            "pin": { "runtime": "bun", "path": self.runtime().bun }
        });
        state["service"]["revision"] = "bundled-service".into();
        state
    }

    fn write_state(&self, state: &Value) {
        fs::write(
            self.0.join("state.json"),
            serde_json::to_vec(state).unwrap(),
        )
        .unwrap();
    }

    fn installs(&self) -> usize {
        fs::read_to_string(self.0.join("calls"))
            .unwrap_or_default()
            .lines()
            .count()
    }

    fn argument(&self, name: &str) -> String {
        let args = fs::read_to_string(self.0.join("args")).unwrap();
        let args: Vec<_> = args.lines().collect();
        args[args.iter().position(|arg| *arg == name).unwrap() + 1].into()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn fresh_install_carries_null_definition_and_bundled_path() {
    let fixture = Fixture::new();
    fixture.write_state(&fixture.absent());
    fresh(&fixture.cli(), &fixture.runtime(), &|| true).unwrap();
    assert_eq!(fixture.installs(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(&fixture.argument("--expected-runtime-pin")).unwrap(),
        serde_json::json!({ "revision": "original-pin", "definition": null })
    );
    assert_eq!(fixture.argument("--runtime"), "bun");
    assert_eq!(
        fixture.argument("--runtime-path"),
        fixture.runtime().bun.to_string_lossy()
    );
}

#[test]
fn fresh_install_marks_a_preexisting_canonical_launcher_after_health() {
    const CHILD: &str = "OPENCLAW_RUNTIME_ACTION_EXECUTION_CHILD";
    if std::env::var_os(CHILD).is_none() {
        // Isolate publication and execution from sibling tests that fork while the launcher is written.
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", std::thread::current().name().unwrap()])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("test result: ok. 1 passed"));
        return;
    }
    let fixture = Fixture::new();
    let wrapper = fixture.canonical_launcher();
    assert!(Command::new("/bin/cp")
        .arg(Fixture::script())
        .arg(&fixture.runtime().bun)
        .status()
        .unwrap()
        .success());
    fs::set_permissions(&fixture.runtime().bun, fs::Permissions::from_mode(0o700)).unwrap();
    fixture.write_state(&fixture.absent());
    let cli = fixture.cli();
    fresh(&cli, &fixture.runtime(), &|| true).unwrap();
    let text = fs::read_to_string(wrapper).unwrap();
    let launcher: Launcher =
        serde_json::from_str(text.lines().nth(1).unwrap().strip_prefix(MARKER).unwrap()).unwrap();
    assert_eq!(launcher.purpose, Purpose::Gateway);
    assert_eq!(launcher.runtime, fixture.runtime());
    assert!(inspect(&cli).unwrap().healthy_for(&fixture.runtime()));
    let executables = fs::read_to_string(fixture.0.join("executables")).unwrap();
    assert_eq!(executables.lines().last(), fixture.runtime().bun.to_str());
    assert_eq!(fixture.installs(), 1);
}

#[test]
fn fresh_install_does_not_mark_an_existing_launcher_after_health_failure() {
    let fixture = Fixture::new();
    let wrapper = fixture.canonical_launcher();
    let original = fs::read(&wrapper).unwrap();
    let mut failed = fixture.healthy();
    failed["service"]["runtime"]["status"] = "stopped".into();
    fs::write(
        fixture.0.join("healthy.json"),
        serde_json::to_vec(&failed).unwrap(),
    )
    .unwrap();
    fixture.write_state(&fixture.absent());
    assert!(fresh(&fixture.cli(), &fixture.runtime(), &|| true).is_err());
    assert_eq!(fs::read(wrapper).unwrap(), original);
    assert_eq!(fixture.installs(), 1);
}

#[test]
fn fresh_install_preserves_an_independent_launcher_and_its_symlink() {
    for linked in [false, true] {
        let fixture = Fixture::new();
        let wrapper = fixture.0.join("bin/openclaw");
        fs::remove_file(&wrapper).unwrap();
        assert!(Command::new("/bin/cp")
            .arg(Fixture::script())
            .arg(&wrapper)
            .status()
            .unwrap()
            .success());
        let original = fs::read(&wrapper).unwrap();
        if linked {
            let target = fixture.0.join("operator-cli");
            fs::rename(&wrapper, &target).unwrap();
            symlink(target, &wrapper).unwrap();
        }
        fixture.write_state(&fixture.absent());
        fresh(&fixture.cli(), &fixture.runtime(), &|| true).unwrap();
        assert_eq!(fs::read(&wrapper).unwrap(), original);
        assert_eq!(fs::symlink_metadata(&wrapper).unwrap().is_symlink(), linked);
        assert_eq!(fixture.installs(), 1);
    }
}

#[test]
fn fresh_install_preserves_a_canonical_launcher_replaced_during_installation() {
    let fixture = Fixture::new();
    let wrapper = fixture.canonical_launcher();
    let replacement = fs::read_to_string(&wrapper)
        .unwrap()
        .replace("/package/", "/replacement-package/");
    let entry = fixture.0.join("replacement-package/dist/entry.js");
    fs::create_dir_all(entry.parent().unwrap()).unwrap();
    fs::write(entry, "fixture").unwrap();
    fs::write(fixture.0.join("replacement-launcher"), &replacement).unwrap();
    fixture.write_state(&fixture.absent());
    let error = fresh(&fixture.cli(), &fixture.runtime(), &|| true).unwrap_err();
    assert!(error.contains("Gateway was installed"));
    assert!(error.contains("marker failed"));
    assert_eq!(fs::read_to_string(wrapper).unwrap(), replacement);
    assert_eq!(fixture.installs(), 1);
}

#[test]
fn fresh_install_refuses_a_service_that_appeared_after_inspection() {
    let fixture = Fixture::new();
    fixture.write_state(&fixture.absent());
    fs::write(
        fixture.0.join("next.json"),
        serde_json::to_vec(&fixture.state()).unwrap(),
    )
    .unwrap();
    assert!(fresh(&fixture.cli(), &fixture.runtime(), &|| true)
        .unwrap_err()
        .contains("changed"));
    assert_eq!(fixture.installs(), 0);
}

#[test]
fn fresh_install_requires_no_definition_even_when_service_is_reported_absent() {
    let fixture = Fixture::new();
    let mut state = fixture.absent();
    state["service"]["runtimeIntent"]["definition"] = "appeared".into();
    fixture.write_state(&state);
    assert!(fresh(&fixture.cli(), &fixture.runtime(), &|| true).is_err());
    assert_eq!(fixture.installs(), 0);
}

#[test]
fn explicit_action_preserves_the_exact_confirmed_pin_and_definition() {
    let fixture = Fixture::new();
    let cli = fixture.cli();
    let confirmed = inspect(&cli).unwrap();
    let wrapper = fs::read(fixture.0.join("bin/openclaw")).unwrap();
    activate(&cli, &fixture.runtime(), &confirmed, &|| true).unwrap();
    assert_eq!(fixture.installs(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(&fixture.argument("--expected-runtime-pin")).unwrap(),
        serde_json::json!({ "revision": "original-pin", "definition": "original-definition" })
    );
    assert_eq!(
        fs::read(fixture.0.join("bin/openclaw")).unwrap(),
        wrapper,
        "an explicit service choice does not replace an operator CLI launcher"
    );
    assert!(fs::read_to_string(fixture.0.join("args"))
        .unwrap()
        .contains("--allow-unconfigured\n"));
}

#[test]
fn explicit_action_refuses_changed_pin_definition_profile_or_service_revision() {
    for pointer in [
        "/service/runtimeIntent/revision",
        "/service/runtimeIntent/definition",
        "/service/revision",
        "/config/daemon/path",
    ] {
        let fixture = Fixture::new();
        let cli = fixture.cli();
        let confirmed = inspect(&cli).unwrap();
        let mut changed = fixture.state();
        *changed.pointer_mut(pointer).unwrap() = "/different".into();
        fixture.write_state(&changed);
        assert!(
            activate(&cli, &fixture.runtime(), &confirmed, &|| true)
                .unwrap_err()
                .contains("changed"),
            "{pointer}"
        );
        assert_eq!(fixture.installs(), 0, "{pointer}");
    }
}

#[test]
fn explicit_action_refuses_pauses_before_or_after_confirmation() {
    for after_confirmation in [false, true] {
        for field in ["loaded", "runtime"] {
            let fixture = Fixture::new();
            let cli = fixture.cli();
            let mut confirmed = inspect(&cli).unwrap();
            let mut paused = fixture.state();
            if field == "loaded" {
                paused["service"]["loaded"] = false.into();
            } else {
                paused["service"]["runtime"]["status"] = "stopped".into();
            }
            fixture.write_state(&paused);
            if !after_confirmation {
                confirmed = inspect(&cli).unwrap();
            }
            assert!(activate(&cli, &fixture.runtime(), &confirmed, &|| true)
                .unwrap_err()
                .contains("Start it"));
            assert_eq!(fixture.installs(), 0);
        }
    }
}

#[test]
fn canonical_cli_guard_failure_is_not_retried_or_rolled_back() {
    let fixture = Fixture::new();
    let cli = fixture.cli();
    let confirmed = inspect(&cli).unwrap();
    fs::write(fixture.0.join("reject"), "fixture").unwrap();
    let error = activate(&cli, &fixture.runtime(), &confirmed, &|| true).unwrap_err();
    assert!(error.contains("changed pin or definition"));
    assert_eq!(fixture.installs(), 1);
}

#[test]
fn failed_health_reports_manual_previous_runtime_command_without_rollback() {
    let fixture = Fixture::new();
    let cli = fixture.cli();
    let confirmed = inspect(&cli).unwrap();
    let mut unhealthy = fixture.healthy();
    unhealthy["rpc"]["ok"] = false.into();
    fs::write(
        fixture.0.join("healthy.json"),
        serde_json::to_vec(&unhealthy).unwrap(),
    )
    .unwrap();
    let error = perform(
        &cli,
        &fixture.runtime(),
        &confirmed,
        false,
        &|| true,
        Duration::ZERO,
    )
    .unwrap_err();
    assert!(error.contains("No automatic rollback"));
    assert!(error.contains(
        "openclaw gateway install --force --runtime node --runtime-path '/operator/node'"
    ));
    assert_eq!(fixture.installs(), 1);
    assert_eq!(
        fs::read(fixture.0.join("state.json")).unwrap(),
        serde_json::to_vec(&unhealthy).unwrap()
    );
}

#[test]
fn previous_bun_runtime_is_reported_for_manual_recovery() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    state["service"]["runtimeIntent"]["pin"] =
        serde_json::json!({ "runtime": "bun", "path": "/previous runtime/bun" });
    assert_eq!(
        Observation(state).previous_runtime_command(),
        "openclaw gateway install --force --runtime bun --runtime-path '/previous runtime/bun'"
    );
}

#[test]
fn health_requires_the_intended_service_and_its_listener_not_the_inspecting_cli_runtime() {
    let fixture = Fixture::new();
    let healthy = fixture.healthy();
    assert!(Observation(healthy.clone()).healthy_for(&fixture.runtime()));
    for (pointer, value) in [
        ("/service/loaded", false.into()),
        ("/service/runtime/status", "stopped".into()),
        ("/service/targetRole", "diagnostic-only".into()),
        ("/service/runtime/pid", 0.into()),
        ("/service/command/programArguments/0", "/other/bun".into()),
        ("/service/runtimeIntent/pin/path", "/other/bun".into()),
        ("/port/listeners/0/pid", 9000.into()),
        ("/port/port", 18790.into()),
        ("/port/status", "unknown".into()),
        ("/port/listeners", serde_json::json!([])),
        ("/rpc/ok", false.into()),
    ] {
        let mut state = healthy.clone();
        *state.pointer_mut(pointer).unwrap() = value;
        assert!(
            !Observation(state).healthy_for(&fixture.runtime()),
            "{pointer}"
        );
    }
    let mut state = healthy;
    state["port"]["listeners"][0] = serde_json::json!({ "pid": 9000, "ppid": 4100 });
    assert!(Observation(state).healthy_for(&fixture.runtime()));
}

#[test]
fn read_only_inspection_offers_current_runtime_without_installing() {
    let fixture = Fixture::new();
    let cli = fixture.cli();
    let before = inspect(&cli).unwrap();
    assert!(before.current_runtime().contains("/operator/node"));
    assert!(!before.is_current(&fixture.runtime()));
    fixture.write_state(&fixture.healthy());
    assert!(inspect(&cli)
        .unwrap()
        .uses_runtime_path(&fixture.runtime().bun));
    assert_eq!(fixture.installs(), 0);
}

#[test]
fn unsupported_cli_gets_update_guidance_without_installing() {
    let fixture = Fixture::new();
    let cli = fixture.cli();
    let mut state = fixture.state();
    state["service"]
        .as_object_mut()
        .unwrap()
        .remove("runtimeIntent");
    fixture.write_state(&state);
    let confirmed = inspect(&cli).unwrap();
    assert!(activate(&cli, &fixture.runtime(), &confirmed, &|| true)
        .unwrap_err()
        .contains("Update the installed OpenClaw CLI"));
    assert_eq!(fixture.installs(), 0);
}

#[test]
fn explicit_selection_cannot_continue_after_being_superseded() {
    let fixture = Fixture::new();
    let cli = fixture.cli();
    let confirmed = inspect(&cli).unwrap();
    assert!(activate(&cli, &fixture.runtime(), &confirmed, &|| false).is_err());
    assert_eq!(fixture.installs(), 0);
}

#[test]
fn binding_a_fresh_launcher_needs_no_node_backup_or_service_mutation() {
    let fixture = Fixture::new();
    let cli = fixture.cli();
    let wrapper = fixture.canonical_launcher();
    bind_runtime(&cli, &fixture.runtime(), Purpose::Gateway).unwrap();
    let bytes = fs::read(&wrapper).unwrap();
    let text = String::from_utf8(bytes.clone()).unwrap();
    let launcher: Launcher =
        serde_json::from_str(text.lines().nth(1).unwrap().strip_prefix(MARKER).unwrap()).unwrap();
    assert_eq!(launcher.purpose, Purpose::Gateway);
    assert_eq!(launcher.runtime, fixture.runtime());
    assert_eq!(bytes, render(&launcher).unwrap());
    assert_eq!(fs::read_dir(fixture.0.join("bin")).unwrap().count(), 1);
    assert_eq!(fixture.installs(), 0);
}

#[test]
fn binding_does_not_follow_an_operator_launcher_symlink() {
    let fixture = Fixture::new();
    let cli = fixture.cli();
    let wrapper = fixture.0.join("bin/openclaw");
    let target = fixture.0.join("operator-cli");
    fs::rename(&wrapper, &target).unwrap();
    let original = fs::read(&target).unwrap();
    symlink(&target, &wrapper).unwrap();
    assert!(bind_runtime(&cli, &fixture.runtime(), Purpose::Browser).is_err());
    assert_eq!(fs::read(&target).unwrap(), original);
}

#[cfg(target_os = "linux")]
#[test]
fn detached_runtime_action_delivers_the_complete_error_to_its_presenter() {
    use crate::gateway_operation_queue::{GatewayOperationError, GatewayOperationQueue};
    let fixture = Fixture::new();
    let error = "The Gateway is paused. Start it before choosing Use bundled runtime.\nTo select the previous runtime manually, run:\nopenclaw gateway install --force --runtime node";
    let (sender, receiver) = std::sync::mpsc::channel();
    let queue = GatewayOperationQueue::new(
        move |_, _| Err(error.to_string()),
        move |failure| {
            assert!(sender.send(failure).is_ok());
        },
    );
    queue.submit_runtime(crate::RuntimeAction {
        cli: fixture.cli(),
        observation: Observation(fixture.healthy()),
    });
    match receiver.recv_timeout(Duration::from_secs(1)).unwrap() {
        GatewayOperationError::Runtime(message) => assert_eq!(message, error),
        GatewayOperationError::Action(_) => {
            panic!("runtime guidance reached the generic error presenter")
        }
    }
}
