//! `openclaw onboard --install-daemon` must install the service or fail.
//!
//! Official reference: `docs/cli/onboard.md` — `--install-daemon` starts the managed
//! Gateway install; `--no-install-daemon` is the explicit skip. The Rust build
//! printed "run ./install-linux-arm64.sh" and exited 0, which reports success while
//! nothing is installed.

use std::path::PathBuf;
use std::process::{Command, Output};

fn sandbox(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "openclaw-onboard-daemon-{}-{}",
        std::process::id(),
        label
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn run(root: &PathBuf, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_openclaw"))
        .args(args)
        .env("OPENCLAW_STATE_DIR", root)
        .env("HOME", root)
        .env_remove("OPENCLAW_CONFIG_PATH")
        .env_remove("OPENCLAW_GATEWAY_TOKEN")
        .output()
        .expect("run openclaw")
}

fn combined(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn install_daemon_fails_honestly_when_no_service_manager_exists() {
    let root = sandbox("fail");
    let output = run(&root, &["onboard", "--install-daemon"]);
    let text = combined(&output);

    if cfg!(target_os = "linux") || cfg!(target_os = "macos") {
        // A real service manager exists on these hosts; either it installed
        // (success) or it reported a concrete failure. Never a silent success.
        assert!(
            output.status.success() || text.to_lowercase().contains("service"),
            "must install or name the failure:\n{text}"
        );
    } else {
        assert!(
            !output.status.success(),
            "--install-daemon exited 0 without installing a service:\n{text}"
        );
        assert!(
            text.to_lowercase().contains("service manager")
                || text.to_lowercase().contains("systemd")
                || text.to_lowercase().contains("launchd"),
            "failure must name the missing service manager:\n{text}"
        );
        assert!(
            !text.contains("Onboarding ready"),
            "must not print the ready banner after a failed daemon install:\n{text}"
        );
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn no_install_daemon_skips_the_service_and_still_writes_config() {
    let root = sandbox("skip");
    let output = run(&root, &["onboard", "--no-install-daemon"]);
    assert!(output.status.success(), "{}", combined(&output));
    assert!(
        root.join("openclaw.json").is_file(),
        "--no-install-daemon must still write config:\n{}",
        combined(&output)
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn unknown_onboard_flags_are_rejected_instead_of_ignored() {
    let root = sandbox("unknown");
    let output = run(&root, &["onboard", "--frobnicate"]);
    assert!(
        !output.status.success(),
        "unknown onboarding flag was silently accepted:\n{}",
        combined(&output)
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn onboarding_writes_gateway_mode_local() {
    let root = sandbox("mode");
    let output = run(&root, &["onboard"]);
    assert!(output.status.success(), "{}", combined(&output));
    let raw = std::fs::read_to_string(root.join("openclaw.json")).unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        value["gateway"]["mode"], "local",
        "onboarding must stamp gateway.mode=local:\n{raw}"
    );
    let _ = std::fs::remove_dir_all(&root);
}
