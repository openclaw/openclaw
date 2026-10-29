//! Service identity must match the official unit/label names.
//!
//! Official reference: `docs/install/uninstall.md` — the unit is
//! `openclaw-gateway.service` (or `openclaw-gateway-<profile>.service`), the macOS
//! label is `ai.openclaw.gateway`, and a legacy `clawdbot-gateway.service` is
//! cleaned up. The Rust build wrote `openclaw.service`, so official tooling could
//! not see or remove it.

const SERVICE: &str = include_str!("../src/service.rs");
const UNINSTALL: &str = include_str!("../src/uninstall_cmd.rs");

#[test]
fn systemd_unit_uses_the_official_name() {
    assert!(
        SERVICE.contains("openclaw-gateway.service"),
        "service definition must be openclaw-gateway.service"
    );
    assert!(
        !SERVICE.contains("\"openclaw.service\""),
        "the non-official openclaw.service name must be gone"
    );
}

#[test]
fn uninstall_removes_the_official_name_and_the_legacy_unit() {
    assert!(
        UNINSTALL.contains("openclaw-gateway.service"),
        "uninstall must remove the official unit"
    );
    assert!(
        UNINSTALL.contains("clawdbot-gateway.service"),
        "uninstall must also clean up the legacy clawdbot-gateway.service"
    );
}

#[test]
fn macos_label_matches_the_official_identity() {
    assert!(
        SERVICE.contains("ai.openclaw.gateway"),
        "macOS launchd label must be ai.openclaw.gateway"
    );
}
