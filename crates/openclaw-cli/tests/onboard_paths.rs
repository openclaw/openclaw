//! Onboarding must write config where the documented resolver looks.
//!
//! Runs the real binary in a temporary state dir, so this proves the written file
//! is discoverable by the same precedence the Gateway uses.

use std::path::Path;
use std::process::Command;

#[test]
fn onboarding_writes_config_into_the_state_dir() {
    let root = std::env::temp_dir().join(format!("openclaw-onboard-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_openclaw"))
        .arg("onboard")
        .env("OPENCLAW_STATE_DIR", &root)
        .env("HOME", &root)
        .env_remove("OPENCLAW_CONFIG_PATH")
        .env_remove("OPENCLAW_GATEWAY_TOKEN")
        .output()
        .expect("run onboarding");

    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.status.success(), "onboarding failed:\n{combined}");

    let config = root.join("openclaw.json");
    assert!(
        config.is_file(),
        "onboarding must write {} (state dir), not a hardcoded home path:\n{combined}",
        config.display()
    );

    let raw = std::fs::read_to_string(&config).unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        value["gateway"]["listen"], "127.0.0.1:18789",
        "fresh config must bind loopback"
    );
    assert_eq!(
        value["gateway"]["requireAuth"], true,
        "fresh config must require auth"
    );
    assert!(
        value["gateway"]["auth"]["token"]
            .as_str()
            .is_some_and(|token| token.len() >= 16),
        "onboarding must generate a real token, got: {}",
        value["gateway"]["auth"]
    );
    // The database must live inside the state dir, not the current directory.
    let db = value["database"]["path"].as_str().unwrap_or_default();
    assert!(
        Path::new(db).starts_with(&root),
        "database path {db} escaped the state dir"
    );

    std::fs::remove_dir_all(&root).unwrap();
}
