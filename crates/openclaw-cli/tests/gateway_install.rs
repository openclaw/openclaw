//! `openclaw gateway install` must not report success without installing.

use std::process::Command;

#[test]
fn gateway_install_never_claims_success_without_a_service_manager() {
    // Cargo sets this for integration tests of a crate that declares the bin.
    let binary = env!("CARGO_BIN_EXE_openclaw");
    let output = Command::new(binary)
        .args(["gateway", "install"])
        .output()
        .expect("run openclaw gateway install");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}{stderr}");

    // This host has no systemd/launchd owner for the Gateway. The command must
    // fail and name the reason instead of printing an onboarding success banner.
    assert!(
        !output.status.success(),
        "gateway install exited 0 without installing a service:\n{combined}"
    );
    assert!(
        !combined.contains("Onboarding ready"),
        "gateway install reused the onboarding banner:\n{combined}"
    );
    assert!(
        combined.to_lowercase().contains("systemd")
            || combined.to_lowercase().contains("launchd")
            || combined.to_lowercase().contains("unsupported"),
        "failure must name the missing service manager:\n{combined}"
    );
}
