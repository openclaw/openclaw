use openclaw_config::{Config, GatewayAuth};
use std::sync::{Mutex, MutexGuard};

// Environment variables are process-global, so these tests must not interleave.
static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvGuard {
    saved: Vec<(&'static str, Option<String>)>,
    _lock: MutexGuard<'static, ()>,
}

impl EnvGuard {
    fn new(pairs: &[(&'static str, &str)]) -> Self {
        let lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let saved = pairs
            .iter()
            .map(|(key, _)| (*key, std::env::var(key).ok()))
            .collect();
        for (key, value) in pairs {
            std::env::set_var(key, value);
        }
        Self { saved, _lock: lock }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

#[test]
fn gateway_token_env_is_honored_without_a_config_file() {
    let _env = EnvGuard::new(&[
        ("OPENCLAW_GATEWAY_TOKEN", "synthetic-env-token"),
        ("OPENCLAW_GATEWAY_PASSWORD", ""),
    ]);
    let config = Config::default();
    match config.gateway.resolved_auth().unwrap() {
        GatewayAuth::Token(token) => assert_eq!(token, "synthetic-env-token"),
        GatewayAuth::None => panic!("OPENCLAW_GATEWAY_TOKEN was ignored"),
    }
    assert!(config.validate().is_empty(), "{:?}", config.validate());
}

#[test]
fn gateway_password_env_selects_password_mode() {
    let _env = EnvGuard::new(&[
        ("OPENCLAW_GATEWAY_PASSWORD", "synthetic-env-password"),
        ("OPENCLAW_GATEWAY_TOKEN", ""),
    ]);
    let mut config = Config::default();
    config.gateway.auth_mode = "password".to_owned();
    match config.gateway.resolved_auth().unwrap() {
        GatewayAuth::Token(secret) => assert_eq!(secret, "synthetic-env-password"),
        GatewayAuth::None => panic!("OPENCLAW_GATEWAY_PASSWORD was ignored"),
    }
}

#[test]
fn config_token_still_wins_over_the_environment() {
    let _env = EnvGuard::new(&[
        ("OPENCLAW_GATEWAY_TOKEN", "from-env"),
        ("OPENCLAW_GATEWAY_PASSWORD", ""),
    ]);
    let mut config = Config::default();
    config.gateway.auth_token = Some("from-config".to_owned());
    match config.gateway.resolved_auth().unwrap() {
        GatewayAuth::Token(token) => assert_eq!(token, "from-config"),
        GatewayAuth::None => panic!("configured token was ignored"),
    }
}

#[test]
fn container_style_public_bind_is_valid_only_with_a_token() {
    // Mirrors the image contract: a public listener plus an env-supplied token.
    let _env = EnvGuard::new(&[
        ("OPENCLAW_GATEWAY_TOKEN", "synthetic-container-token"),
        ("OPENCLAW_GATEWAY_PASSWORD", ""),
    ]);
    let mut config = Config::default();
    config.gateway.listen = "0.0.0.0:18789".to_owned();
    assert!(
        config.validate().is_empty(),
        "public bind with an env token must be valid: {:?}",
        config.validate()
    );
}

#[test]
fn container_style_public_bind_without_a_token_is_rejected() {
    let _env = EnvGuard::new(&[
        ("OPENCLAW_GATEWAY_TOKEN", ""),
        ("OPENCLAW_GATEWAY_PASSWORD", ""),
    ]);
    let mut config = Config::default();
    config.gateway.listen = "0.0.0.0:18789".to_owned();
    assert!(
        !config.validate().is_empty(),
        "public bind without a credential must be rejected"
    );
    assert!(config.gateway.resolved_auth().is_err() || matches!(
        config.gateway.resolved_auth().unwrap(),
        GatewayAuth::None
    ));
}
