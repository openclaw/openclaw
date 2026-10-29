use std::path::PathBuf;

/// Environment variables the path resolver reads. Kept as a map so the
/// precedence rules are testable without mutating the process environment.
pub type PathEnv = std::collections::BTreeMap<String, String>;

fn get<'a>(env: &'a PathEnv, key: &str) -> Option<&'a str> {
    env.get(key)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
}

/// Mutable state directory: `OPENCLAW_STATE_DIR`, else `<OPENCLAW_HOME>/.openclaw`,
/// else `~/.openclaw`. Matches the upstream install/container contract.
#[must_use]
pub fn state_dir(env: &PathEnv) -> Option<PathBuf> {
    if let Some(dir) = get(env, "OPENCLAW_STATE_DIR") {
        return Some(PathBuf::from(dir));
    }
    let home = get(env, "OPENCLAW_HOME")
        .or_else(|| get(env, "HOME"))
        .or_else(|| get(env, "USERPROFILE"))?;
    Some(PathBuf::from(home).join(".openclaw"))
}

/// Canonical config path: `OPENCLAW_CONFIG_PATH` wins, otherwise the state
/// directory's `openclaw.json`.
#[must_use]
pub fn config_path(env: &PathEnv) -> Option<PathBuf> {
    get(env, "OPENCLAW_CONFIG_PATH")
        .map(PathBuf::from)
        .or_else(|| state_dir(env).map(|dir| dir.join("openclaw.json")))
}

/// Read the current process environment into a [`PathEnv`].
#[must_use]
pub fn process_env() -> PathEnv {
    std::env::vars().collect()
}
