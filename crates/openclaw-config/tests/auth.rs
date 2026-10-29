use openclaw_config::{load_json, Config};

#[test]
fn upstream_json_auth_is_never_silently_discarded() {
    let path = std::env::temp_dir().join(format!("openclaw-auth-{}.json", std::process::id()));
    for (mode, auth, expected) in [
        ("token", r#"{"mode":"token","token":"synthetic-json-token"}"#, Some("synthetic-json-token")),
        ("password", r#"{"mode":"password","password":"synthetic-json-password"}"#, Some("synthetic-json-password")),
        ("none", r#"{"mode":"none"}"#, None),
    ] {
        std::fs::write(&path, format!(r#"{{"gateway":{{"auth":{auth}}},"logging":{{"level":"debug"}}}}"#)).unwrap();
        let result = load_json(&path);
        std::fs::remove_file(&path).unwrap();
        let config = result.unwrap();
        assert_eq!(config.logging.level, "debug", "normalization discarded sibling config");
        assert_eq!(config.gateway.resolved_auth_mode(), mode, "upstream auth mode was discarded");
        let policy = config.gateway.resolved_auth().unwrap();
        assert!(policy.permits(expected));
        if expected.is_some() {
            assert!(!policy.permits(None), "upstream credential was ignored");
            assert!(!policy.permits(Some("wrong")));
        }
    }
    std::fs::write(&path, r#"{"gateway":{"auth":{"mode":"trusted-proxy"}}}"#).unwrap();
    let result = load_json(&path);
    std::fs::remove_file(&path).unwrap();
    let config = result.unwrap();
    assert!(
        !config.validate().is_empty() && config.gateway.resolved_auth().is_err(),
        "unsupported auth mode must not become open access"
    );
}

#[test]
fn default_listener_is_private_and_public_unauthenticated_bind_is_rejected() {
    let mut config = Config::default();
    assert_eq!(config.gateway.listen, "127.0.0.1:18789");
    config.gateway.listen = "0.0.0.0:18789".to_owned();
    assert!(!config.validate().is_empty(), "public listener accepted without auth");
}
