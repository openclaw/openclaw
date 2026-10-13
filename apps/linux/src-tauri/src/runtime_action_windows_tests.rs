use super::*;

#[test]
fn health_accepts_the_service_owners_ordinary_windows_runtime_path() {
    let root =
        std::env::temp_dir().join(format!("openclaw-runtime-health-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let bun = root.join("bun.exe");
    fs::write(&bun, "synthetic Bun").unwrap();
    let runtime = BundledRuntime {
        bun: fs::canonicalize(&bun).unwrap(),
        sqlite: None,
    };
    let ordinary = windows_process_path(&runtime.bun).unwrap();
    let mut health = serde_json::json!({
        "service": {
            "loaded": true, "targetRole": "target",
            "runtime": {"status": "running", "pid": 4100},
            "command": {"programArguments": [&ordinary]},
            "runtimeIntent": {"status": "known", "revision": "synthetic-pin", "definition": "synthetic-task", "pin": {"runtime": "bun", "path": &ordinary}}
        },
        "gateway": {"port": 19815},
        "port": {"port": 19815, "status": "busy", "listeners": [{"pid": 4100}]},
        "rpc": {"ok": true}
    });
    assert!(Observation(health.clone()).healthy_for(&runtime));
    let other = root.join("other-bun.exe");
    fs::write(&other, "another runtime").unwrap();
    health["service"]["runtimeIntent"]["pin"]["path"] =
        windows_process_path(&other).unwrap().into();
    assert!(!Observation(health).healthy_for(&runtime));
    fs::remove_dir_all(root).unwrap();
}
