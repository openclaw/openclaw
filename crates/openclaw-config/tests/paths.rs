use openclaw_config::paths::{config_path, state_dir, PathEnv};

fn env(pairs: &[(&str, &str)]) -> PathEnv {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

#[test]
fn config_path_follows_upstream_precedence() {
    // OPENCLAW_CONFIG_PATH wins over every state-dir default.
    assert_eq!(
        config_path(&env(&[
            ("OPENCLAW_CONFIG_PATH", "/run/config/openclaw.json"),
            ("OPENCLAW_STATE_DIR", "/data/.openclaw"),
            ("HOME", "/home/operator"),
        ])),
        Some(std::path::PathBuf::from("/run/config/openclaw.json"))
    );

    // OPENCLAW_STATE_DIR moves the default config with it (containers, Fly, Render).
    assert_eq!(
        config_path(&env(&[
            ("OPENCLAW_STATE_DIR", "/data/.openclaw"),
            ("HOME", "/home/operator"),
        ])),
        Some(std::path::PathBuf::from("/data/.openclaw/openclaw.json"))
    );

    // OPENCLAW_HOME relocates the state directory without replacing the file name.
    assert_eq!(
        config_path(&env(&[
            ("OPENCLAW_HOME", "/srv/openclaw"),
            ("HOME", "/home/operator"),
        ])),
        Some(std::path::PathBuf::from("/srv/openclaw/.openclaw/openclaw.json"))
    );

    assert_eq!(
        config_path(&env(&[("HOME", "/home/operator")])),
        Some(std::path::PathBuf::from("/home/operator/.openclaw/openclaw.json"))
    );

    // Windows profile fallback; no HOME available.
    assert_eq!(
        config_path(&env(&[("USERPROFILE", r"C:\Users\operator")])),
        Some(
            std::path::PathBuf::from(r"C:\Users\operator").join(".openclaw/openclaw.json")
        )
    );
}

#[test]
fn state_dir_prefers_explicit_then_openclaw_home_then_user_home() {
    assert_eq!(
        state_dir(&env(&[
            ("OPENCLAW_STATE_DIR", "/data/.openclaw"),
            ("OPENCLAW_HOME", "/srv/openclaw"),
            ("HOME", "/home/operator"),
        ])),
        Some(std::path::PathBuf::from("/data/.openclaw"))
    );
    assert_eq!(
        state_dir(&env(&[
            ("OPENCLAW_HOME", "/srv/openclaw"),
            ("HOME", "/home/operator")
        ])),
        Some(std::path::PathBuf::from("/srv/openclaw/.openclaw"))
    );
    assert_eq!(
        state_dir(&env(&[("HOME", "/home/operator")])),
        Some(std::path::PathBuf::from("/home/operator/.openclaw"))
    );
    assert_eq!(state_dir(&env(&[])), None);
}

#[test]
fn blank_values_are_ignored_rather_than_selecting_the_cwd() {
    assert_eq!(
        config_path(&env(&[
            ("OPENCLAW_CONFIG_PATH", "   "),
            ("OPENCLAW_STATE_DIR", ""),
            ("HOME", "/home/operator"),
        ])),
        Some(std::path::PathBuf::from("/home/operator/.openclaw/openclaw.json"))
    );
}
