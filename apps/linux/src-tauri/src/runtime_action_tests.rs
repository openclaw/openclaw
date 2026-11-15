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
            executable: self.0.join("bun"),
            sqlite: None,
            flavor: RuntimeFlavor::Jit,
            entry: None,
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
            self.runtime().executable.to_string_lossy().as_ref().into();
        state["service"]["runtimeIntent"] = serde_json::json!({
            "status": "known", "revision": "bundled-pin", "definition": "bundled-definition", "stored": true,
            "pin": { "runtime": "bun", "path": self.runtime().executable }
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
fn fresh_setup_initializes_pending_profile_before_gateway_install() {
    let fixture = Fixture::new();
    let mut pending = fixture.absent();
    pending["service"]["runtimeIntent"] =
        serde_json::json!({"status": "migrationPending", "nextStep": "run openclaw doctor"});
    pending["service"]
        .as_object_mut()
        .unwrap()
        .remove("revision");
    pending["service"]
        .as_object_mut()
        .unwrap()
        .remove("definitionMutation");
    fixture.write_state(&pending);
    let mut initialized = fixture.absent();
    initialized["service"]["runtimeIntent"]["revision"] = "initialized-pin".into();
    fs::write(
        fixture.0.join("setup-state.json"),
        serde_json::to_vec(&initialized).unwrap(),
    )
    .unwrap();

    fresh(&fixture.cli(), &fixture.runtime(), &|| true).unwrap();

    assert_eq!(fixture.installs(), 1);
    assert_eq!(
        fs::read_to_string(fixture.0.join("setup-calls")).unwrap(),
        "setup\n"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&fixture.argument("--expected-runtime-pin")).unwrap(),
        serde_json::json!({"revision": "initialized-pin", "definition": null})
    );
    assert!(inspect(&fixture.cli())
        .unwrap()
        .healthy_for(&fixture.runtime()));
}

#[test]
fn fresh_setup_failure_does_not_install_or_publish_the_launcher() {
    let fixture = Fixture::new();
    let wrapper = fixture.canonical_launcher();
    let original = fs::read(&wrapper).unwrap();
    fixture.write_state(&fixture.absent());
    fs::write(fixture.0.join("setup-reject"), "").unwrap();

    let error = fresh(&fixture.cli(), &fixture.runtime(), &|| true).unwrap_err();

    assert!(error.contains("baseline setup failed"));
    assert_eq!(fixture.installs(), 0);
    assert_eq!(fs::read(wrapper).unwrap(), original);
}

#[test]
fn fresh_setup_refuses_existing_or_unknown_services_before_profile_changes() {
    for kind in ["running", "paused", "unknown"] {
        let fixture = Fixture::new();
        let mut state = fixture.state();
        if kind == "paused" {
            state["service"]["loaded"] = false.into();
            state["service"]["runtime"]["status"] = "stopped".into();
        } else if kind == "unknown" {
            state = fixture.absent();
            state["service"]["runtimeIntent"] = serde_json::json!({"status": "unknown"});
        }
        fixture.write_state(&state);

        assert!(fresh(&fixture.cli(), &fixture.runtime(), &|| true).is_err());

        assert!(!fixture.0.join("setup-calls").exists(), "{kind}");
        assert_eq!(fixture.installs(), 0, "{kind}");
    }
}

#[test]
fn fresh_install_with_unknown_mutation_capability_carries_null_definition_and_bundled_path() {
    let fixture = Fixture::new();
    let mut absent = fixture.absent();
    absent["service"]["definitionMutation"] = "unknown".into();
    fixture.write_state(&absent);
    fresh(&fixture.cli(), &fixture.runtime(), &|| true).unwrap();
    assert_eq!(fixture.installs(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(&fixture.argument("--expected-runtime-pin")).unwrap(),
        serde_json::json!({ "revision": "original-pin", "definition": null })
    );
    assert_eq!(fixture.argument("--runtime"), "bun");
    assert_eq!(
        fixture.argument("--runtime-path"),
        fixture.runtime().executable.to_string_lossy()
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
        .arg(&fixture.runtime().executable)
        .status()
        .unwrap()
        .success());
    fs::set_permissions(
        &fixture.runtime().executable,
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
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
    assert_eq!(
        executables.lines().last(),
        fixture.runtime().executable.to_str()
    );
    assert_eq!(fixture.installs(), 1);
}

#[test]
fn fresh_install_does_not_mark_an_existing_launcher_after_health_inspection_failure() {
    let fixture = Fixture::new();
    let wrapper = fixture.canonical_launcher();
    let original = fs::read(&wrapper).unwrap();
    fs::write(fixture.0.join("healthy.json"), "invalid JSON").unwrap();
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
fn health_requires_the_intended_service_and_rejects_reported_foreign_listeners() {
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
        ("/port/listeners", Value::Null),
        ("/port/listeners", serde_json::json!({})),
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
    let mut missing = fixture.healthy();
    missing["port"].as_object_mut().unwrap().remove("listeners");
    assert!(!Observation(missing).healthy_for(&fixture.runtime()));
}

#[test]
fn activation_accepts_a_healthy_service_without_optional_process_details() {
    let fixture = Fixture::new();
    let mut healthy = fixture.healthy();
    healthy["port"]["listeners"] = serde_json::json!([]);
    healthy["port"]["hints"] = serde_json::json!([
        "Port is in use but process details are unavailable (install lsof or run as an admin user)."
    ]);
    fs::write(
        fixture.0.join("healthy.json"),
        serde_json::to_vec(&healthy).unwrap(),
    )
    .unwrap();
    let cli = fixture.cli();
    let confirmed = inspect(&cli).unwrap();

    let result = perform(
        &cli,
        &fixture.runtime(),
        &confirmed,
        false,
        &|| true,
        Duration::ZERO,
    )
    .unwrap();

    assert!(result.healthy_for(&fixture.runtime()));
    assert_eq!(fixture.installs(), 1);
}

#[test]
fn fresh_activation_waits_for_service_start_but_existing_activation_respects_stop() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    for pointer in ["/service/loaded", "/service/runtime/status"] {
        let mut starting = fixture.healthy();
        *starting.pointer_mut(pointer).unwrap() = if pointer.ends_with("loaded") {
            false.into()
        } else {
            "stopped".into()
        };
        let observation = Observation(starting);
        assert_eq!(observation.check_health(&runtime, true), Ok(false));
        assert_eq!(observation.check_health(&runtime, false), Err(UNHEALTHY));
    }
    assert_eq!(
        Observation(fixture.healthy()).check_health(&runtime, true),
        Ok(true)
    );
}

#[test]
fn read_only_inspection_offers_current_runtime_without_installing() {
    let fixture = Fixture::new();
    let cli = fixture.cli();
    let before = inspect(&cli).unwrap();
    assert!(before.current_runtime().contains("/operator/node"));
    assert!(!before.uses_runtime_path(&fixture.runtime().executable));
    fixture.write_state(&fixture.healthy());
    assert!(inspect(&cli)
        .unwrap()
        .uses_runtime_path(&fixture.runtime().executable));
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

#[test]
fn healthy_activation_persists_previous_selection_and_failure_keeps_it() {
    const CHILD: &str = "OPENCLAW_RETENTION_ACTIVATION_CHILD";
    if std::env::var_os(CHILD).is_none() {
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
        return;
    }
    let fixture = Fixture::new();
    let wrapper = fixture.canonical_launcher();
    assert!(Command::new("/bin/cp")
        .arg(Fixture::script())
        .arg(&fixture.runtime().executable)
        .status()
        .unwrap()
        .success());
    fs::set_permissions(
        &fixture.runtime().executable,
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let cli = fixture.cli();
    bind_runtime(&cli, &fixture.runtime(), Purpose::Gateway).unwrap();
    fixture.write_state(&fixture.healthy());
    let second = fixture.0.join("second-bun");
    let third = fixture.0.join("third-bun");
    for (index, path) in [&second, &third, &third].into_iter().enumerate() {
        if index == 1 {
            let mut wrapped = inspect(&cli).unwrap().0;
            wrapped["service"]["command"]["programArguments"][0] =
                serde_json::json!(fixture.runtime().executable);
            fixture.write_state(&wrapped);
        }
        assert!(Command::new("/bin/cp")
            .arg(Fixture::script())
            .arg(path)
            .status()
            .unwrap()
            .success());
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = BundledRuntime {
            executable: path.clone(),
            sqlite: None,
            flavor: RuntimeFlavor::Jit,
            entry: None,
        };
        let mut healthy = fixture.healthy();
        healthy["service"]["command"]["programArguments"][0] = serde_json::json!(path);
        healthy["service"]["runtimeIntent"]["pin"]["path"] = serde_json::json!(path);
        fs::write(fixture.0.join("healthy.json"), healthy.to_string()).unwrap();
        activate(&cli, &runtime, &inspect(&cli).unwrap(), &|| true).unwrap();
    }
    let bytes = fs::read(&wrapper).unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    let marker: Value =
        serde_json::from_str(text.lines().nth(1).unwrap().strip_prefix(MARKER).unwrap()).unwrap();
    assert_eq!(
        marker.pointer("/retention/current"),
        Some(&serde_json::json!(&third))
    );
    assert_eq!(
        marker.pointer("/retention/previous"),
        Some(&serde_json::json!(&second))
    );
    fs::write(fixture.0.join("healthy.json"), "invalid status").unwrap();
    assert!(activate(&cli, &fixture.runtime(), &inspect(&cli).unwrap(), &|| true).is_err());
    assert_eq!(fs::read(wrapper).unwrap(), bytes);
}

#[test]
fn successive_aot_activations_replace_the_jit_launcher_entry() {
    const CHILD: &str = "OPENCLAW_AOT_ACTIVATION_CHILD";
    if std::env::var_os(CHILD).is_none() {
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
        return;
    }
    let fixture = Fixture::new();
    let entry = fixture.0.join("package/entry.mjs");
    fs::create_dir_all(entry.parent().unwrap()).unwrap();
    fs::write(&entry, "fixture").unwrap();
    let old = fixture.runtime();
    assert!(Command::new("/bin/cp")
        .arg(Fixture::script())
        .arg(&old.executable)
        .status()
        .unwrap()
        .success());
    fs::set_permissions(&old.executable, fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_file(fixture.0.join("bin/openclaw")).unwrap();
    install_launcher(&fixture.0, &old, &entry, Purpose::Gateway).unwrap();
    let cli = fixture.cli();
    fixture.write_state(&fixture.healthy());
    let mut runtime = old.clone();
    runtime.flavor = RuntimeFlavor::Aot;
    let mut previous = old.executable.clone();
    for name in ["aot-openclaw", "aot-next-openclaw"] {
        runtime.executable = fixture.0.join(name);
        assert!(Command::new("/bin/cp")
            .arg(Fixture::script())
            .arg(&runtime.executable)
            .status()
            .unwrap()
            .success());
        fs::set_permissions(&runtime.executable, fs::Permissions::from_mode(0o700)).unwrap();
        let mut health = fixture.healthy();
        health["service"]["command"]["programArguments"] =
            serde_json::json!([runtime.executable, "gateway"]);
        health["service"]["runtimeIntent"]["pin"] =
            serde_json::json!({"runtime": "standalone", "path": runtime.executable});
        fs::write(fixture.0.join("healthy.json"), health.to_string()).unwrap();
        let confirmed = inspect(&cli).unwrap();
        activate(&cli, &runtime, &confirmed, &|| true).unwrap();
        assert_eq!(fixture.argument("--runtime"), "standalone");
        let args = fs::read_to_string(fixture.0.join("args")).unwrap();
        assert!(!args.contains("--no-install"));
        assert!(!args.contains("entry.mjs"));
        let launcher = read_launcher(&cli).unwrap().unwrap().selection.unwrap();
        assert_eq!(launcher.runtime.flavor, RuntimeFlavor::Aot);
        assert_eq!(launcher.runtime.executable, runtime.executable);
        assert_eq!(launcher.entry, runtime.executable);
        let retention = launcher.retention.unwrap();
        assert_eq!(retention.current, runtime.executable);
        assert_eq!(retention.previous, Some(previous));
        assert!(inspect(&cli).unwrap().healthy_for(&runtime));
        previous = runtime.executable.clone();
    }
    assert!(old.executable.is_file());
}
