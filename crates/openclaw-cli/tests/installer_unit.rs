//! Guards the Linux installer against diverging from the official contract.
//!
//! The previous version hand-wrote a systemd unit inside a heredoc and shipped a
//! merged `ExecStart...Restart=always` line, so the service had no restart policy.
//! Service ownership now belongs to `openclaw gateway install`, and this test keeps
//! it that way.

const INSTALLER: &str = include_str!("../../install-linux-arm64.sh");

#[test]
fn installer_delegates_service_installation_to_the_cli() {
    assert!(
        INSTALLER.contains("gateway install"),
        "installer must use `openclaw gateway install` as the single service owner"
    );
    assert!(
        !INSTALLER.contains("systemctl enable"),
        "installer must not reimplement service activation"
    );
    assert!(
        !INSTALLER.contains("[Service]"),
        "installer must not hand-write a systemd unit"
    );
}

#[test]
fn installer_uses_documented_paths_and_credentials() {
    for required in [
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_GATEWAY_TOKEN",
    ] {
        assert!(
            INSTALLER.contains(required),
            "installer must honor {required}"
        );
    }
    assert!(
        INSTALLER.contains("onboard"),
        "installer must create config through the CLI owner"
    );
}

#[test]
fn installer_never_embeds_a_literal_secret() {
    // Match an assigned secret value, not a variable name reference.
    for forbidden in ["TOKEN=your", "TOKEN=sk-", "API_KEY=your", "bot_token_here"] {
        assert!(
            !INSTALLER.contains(forbidden),
            "installer must not write placeholder or literal secrets: {forbidden}"
        );
    }
    // Credentials are read from the environment, never generated into a file we own.
    assert!(!INSTALLER.contains("GATEWAY_TOKEN=\"$(head"));
}

#[test]
fn installer_requires_a_known_architecture() {
    assert!(INSTALLER.contains("aarch64|arm64"));
    assert!(INSTALLER.contains("x86_64|amd64"));
    assert!(
        INSTALLER.contains("unsupported architecture"),
        "unknown architectures must fail loudly"
    );
}
