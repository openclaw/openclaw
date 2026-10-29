//! Channel DM policy validation must match the documented contract.
//!
//! Official reference: `docs/channels/pairing.md` — `open` is public only when the
//! effective allowlist includes `"*"`; `allowlist` with an empty list rejects
//! everyone. The Rust validator had no channel checks at all, so a bot could be
//! silently public or silently unreachable.

use openclaw_config::{ChannelAccountConfig, Config};

fn config_with(policy: &str, allow: &[&str]) -> Config {
    let mut config = Config::default();
    let mut channel = ChannelAccountConfig::default();
    channel.dm_policy = policy.to_owned();
    channel.allow_from = allow.iter().map(|entry| (*entry).to_owned()).collect();
    config.channels.insert("telegram".to_owned(), channel);
    config
}

#[test]
fn open_without_wildcard_is_rejected() {
    let problems = config_with("open", &[]).validate();
    assert!(
        problems.iter().any(|p| p.contains("open") && p.contains("allowFrom")),
        "open without '*' must be a validation error: {problems:?}"
    );
    let concrete = config_with("open", &["12345"]).validate();
    assert!(
        concrete.iter().any(|p| p.contains("allowFrom")),
        "open with only concrete entries is not public: {concrete:?}"
    );
}

#[test]
fn open_with_wildcard_is_valid() {
    assert!(config_with("open", &["*"]).validate().is_empty());
}

#[test]
fn allowlist_with_empty_list_is_rejected() {
    let problems = config_with("allowlist", &[]).validate();
    assert!(
        problems.iter().any(|p| p.contains("allowlist")),
        "an empty allowlist locks everyone out: {problems:?}"
    );
}

#[test]
fn unknown_policy_is_rejected() {
    let problems = config_with("whatever", &[]).validate();
    assert!(
        problems.iter().any(|p| p.contains("invalid dmPolicy")),
        "unknown policy must be named: {problems:?}"
    );
}

#[test]
fn pairing_and_disabled_are_valid_without_entries() {
    assert!(config_with("pairing", &[]).validate().is_empty());
    assert!(config_with("disabled", &[]).validate().is_empty());
}
