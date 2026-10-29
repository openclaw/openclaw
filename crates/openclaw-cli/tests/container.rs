//! Container packaging must not start in a state the Gateway refuses.
//!
//! Two real defects were here: the entrypoint exec'd the Gateway without ever
//! writing a config, so a fresh container exited 1 on the non-loopback auth guard;
//! and the default `database.path` is relative, so state landed outside the
//! declared volume and vanished on recreate.

const DOCKERFILE: &str = include_str!("../../Dockerfile.arm64");

#[test]
fn entrypoint_bootstraps_config_before_starting_the_gateway() {
    assert!(
        DOCKERFILE.contains("onboard") || DOCKERFILE.contains("entrypoint"),
        "the container must create config before the Gateway can start"
    );
    assert!(
        !DOCKERFILE.contains(r#"ENTRYPOINT ["/usr/local/bin/openclaw", "gateway""#),
        "the raw Gateway entrypoint never onboards and exits on the auth guard"
    );
}

#[test]
fn database_path_stays_inside_the_volume() {
    // The built-in default is relative ("openclaw.db"), which would write to `/`.
    // The container must therefore pin an absolute path, either in a shipped
    // config or through the entrypoint's onboarding into the volume.
    const ENTRYPOINT: &str = include_str!("../../entrypoint.sh");
    let combined = format!("{DOCKERFILE}\n{ENTRYPOINT}");
    assert!(
        combined.contains("/var/lib/openclaw"),
        "the database must resolve under the state volume"
    );
    assert!(
        ENTRYPOINT.contains("onboard"),
        "onboarding is what pins the database path inside the volume"
    );
    assert!(
        !DOCKERFILE.contains(r#""path": "openclaw.db""#),
        "relative database path escapes the volume"
    );
}

#[test]
fn container_uses_documented_state_and_config_paths() {
    for required in ["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"] {
        assert!(DOCKERFILE.contains(required), "container must set {required}");
    }
    assert!(DOCKERFILE.contains("/var/lib/openclaw"));
}

#[test]
fn container_does_not_bake_credentials() {
    for forbidden in ["OPENCLAW_GATEWAY_TOKEN=sk-", "TOKEN=your", "API_KEY=your"] {
        assert!(!DOCKERFILE.contains(forbidden), "image embeds a credential: {forbidden}");
    }
}

#[test]
fn container_targets_arm64_and_amd64() {
    assert!(DOCKERFILE.contains("aarch64-unknown-linux-gnu"));
    assert!(DOCKERFILE.contains("TARGETARCH"));
}
