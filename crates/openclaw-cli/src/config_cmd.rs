//! `openclaw config` — non-interactive config helpers.
//!
//! Official reference: `docs/cli/config.md`. Owns get/set/patch/unset/file/
//! validate against `openclaw.json`, honoring `OPENCLAW_CONFIG_READONLY`.

use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("no config file found; run `openclaw onboard` first")]
    Missing,
    #[error("cannot read {path}: {error}")]
    Read { path: String, error: String },
    #[error("cannot write {path}: {error}")]
    Write { path: String, error: String },
    #[error("invalid JSON in {path}: {error}")]
    Parse { path: String, error: String },
    #[error("config is read-only (OPENCLAW_CONFIG_READONLY or OPENCLAW_NIX_MODE is set)")]
    ReadOnly,
    #[error("path not found: {0}")]
    PathNotFound(String),
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("value must not be blank")]
    BlankValue,
    #[error("usage: openclaw config <get|set|patch|unset|file|schema|validate> ...")]
    Usage,
    #[error("validation failed:\n{}", .0.join("\n"))]
    Invalid(Vec<String>),
}

/// Resolve the active config file using the documented precedence.
pub fn config_file() -> Result<PathBuf, ConfigError> {
    openclaw_config::paths::config_path(&openclaw_config::paths::process_env())
        .ok_or(ConfigError::Missing)
}

fn read_only() -> bool {
    let flag = |name: &str| {
        std::env::var(name)
            .ok()
            .is_some_and(|value| value.trim() == "1")
    };
    flag("OPENCLAW_CONFIG_READONLY") || flag("OPENCLAW_NIX_MODE")
}

fn load(path: &Path) -> Result<Value, ConfigError> {
    let raw = std::fs::read_to_string(path).map_err(|error| ConfigError::Read {
        path: path.display().to_string(),
        error: error.to_string(),
    })?;
    serde_json::from_str(&raw).map_err(|error| ConfigError::Parse {
        path: path.display().to_string(),
        error: error.to_string(),
    })
}

fn save(path: &Path, value: &Value) -> Result<(), ConfigError> {
    if read_only() {
        return Err(ConfigError::ReadOnly);
    }
    let text = serde_json::to_string_pretty(value).map_err(|error| ConfigError::Write {
        path: path.display().to_string(),
        error: error.to_string(),
    })?;
    // Write beside the target and rename, so a crash cannot truncate live config.
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|error| ConfigError::Write {
        path: temp.display().to_string(),
        error: error.to_string(),
    })?;
    std::fs::rename(&temp, path).map_err(|error| ConfigError::Write {
        path: path.display().to_string(),
        error: error.to_string(),
    })
}

/// Split a dotted path into keys, rejecting empty segments.
fn segments(path: &str) -> Result<Vec<&str>, ConfigError> {
    let parts: Vec<&str> = path.split('.').collect();
    if parts.is_empty() || parts.iter().any(|part| part.trim().is_empty()) {
        return Err(ConfigError::InvalidPath(path.to_owned()));
    }
    Ok(parts)
}

fn get_path<'a>(root: &'a Value, path: &str) -> Result<&'a Value, ConfigError> {
    let mut current = root;
    for part in segments(path)? {
        current = current
            .get(part)
            .ok_or_else(|| ConfigError::PathNotFound(path.to_owned()))?;
    }
    Ok(current)
}

/// Interpret a CLI value the way upstream does: JSON when it parses, else string.
fn typed(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return Value::String(raw.to_owned());
    }
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_owned()))
}

fn set_path(root: &mut Value, path: &str, value: Value) -> Result<(), ConfigError> {
    let parts = segments(path)?;
    let mut current = root;
    for part in &parts[..parts.len() - 1] {
        if !current.is_object() {
            *current = Value::Object(serde_json::Map::new());
        }
        current = current
            .as_object_mut()
            .ok_or_else(|| ConfigError::InvalidPath(path.to_owned()))?
            .entry((*part).to_owned())
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
    }
    current
        .as_object_mut()
        .ok_or_else(|| ConfigError::InvalidPath(path.to_owned()))?
        .insert(parts[parts.len() - 1].to_owned(), value);
    Ok(())
}

fn unset_path(root: &mut Value, path: &str) -> Result<(), ConfigError> {
    let parts = segments(path)?;
    let mut current = root;
    for part in &parts[..parts.len() - 1] {
        current = current
            .get_mut(*part)
            .ok_or_else(|| ConfigError::PathNotFound(path.to_owned()))?;
    }
    let removed = current
        .as_object_mut()
        .ok_or_else(|| ConfigError::PathNotFound(path.to_owned()))?
        .remove(parts[parts.len() - 1]);
    removed
        .map(|_| ())
        .ok_or_else(|| ConfigError::PathNotFound(path.to_owned()))
}

/// Merge a JSON patch object into the config.
fn merge(root: &mut Value, patch: &Value) {
    match (root, patch) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                merge(
                    target
                        .entry(key.clone())
                        .or_insert(Value::Null),
                    value,
                );
            }
        }
        (target, value) => *target = value.clone(),
    }
}

fn validate_file(path: &Path, raw: &Value) -> Result<Vec<String>, ConfigError> {
    // Reuse the schema owner so CLI validation matches Gateway startup.
    let text = serde_json::to_string(raw).map_err(|error| ConfigError::Parse {
        path: path.display().to_string(),
        error: error.to_string(),
    })?;
    let config: openclaw_config::Config =
        serde_json::from_str(&text).map_err(|error| ConfigError::Parse {
            path: path.display().to_string(),
            error: error.to_string(),
        })?;
    Ok(config.validate())
}

/// Run a `config` subcommand. Returns text to print on success.
pub fn run(args: &[String]) -> Result<String, ConfigError> {
    let sub = args.first().map(String::as_str).unwrap_or("help");
    let rest = &args[1..];
    let dry_run = rest.iter().any(|arg| arg == "--dry-run");
    let positional: Vec<&String> = rest.iter().filter(|arg| !arg.starts_with("--")).collect();

    match sub {
        "file" | "path" => Ok(config_file()?.display().to_string()),
        "get" => {
            let path = positional.first().ok_or(ConfigError::Usage)?;
            let file = config_file()?;
            let raw = load(&file)?;
            Ok(render(get_path(&raw, path)?))
        }
        "set" => {
            if positional.len() < 2 {
                return Err(ConfigError::Usage);
            }
            let key = positional[0].as_str();
            let value = positional[1..]
                .iter()
                .map(|part| part.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            if value.trim().is_empty() {
                return Err(ConfigError::BlankValue);
            }
            let file = config_file()?;
            let mut raw = load(&file)?;
            let value = typed(&value);
            set_path(&mut raw, key, value.clone())?;
            if dry_run {
                return Ok(format!("{key} = {}", render(&value)));
            }
            save(&file, &raw)?;
            Ok(format!("{key} = {}", render(&value)))
        }
        "unset" => {
            let key = positional.first().ok_or(ConfigError::Usage)?;
            let file = config_file()?;
            let mut raw = load(&file)?;
            unset_path(&mut raw, key)?;
            if dry_run {
                return Ok(format!("unset {key}"));
            }
            save(&file, &raw)?;
            Ok(format!("unset {key}"))
        }
        "patch" => {
            let patch_text = positional.first().ok_or(ConfigError::Usage)?;
            let patch: Value = serde_json::from_str(patch_text)
                .map_err(|error| ConfigError::Parse {
                    path: "patch".to_owned(),
                    error: error.to_string(),
                })?;
            if !patch.is_object() {
                return Err(ConfigError::InvalidPath("patch must be a JSON object".to_owned()));
            }
            let file = config_file()?;
            let mut raw = load(&file)?;
            merge(&mut raw, &patch);
            if dry_run {
                return Ok(serde_json::to_string_pretty(&raw).unwrap_or_default());
            }
            save(&file, &raw)?;
            Ok(serde_json::to_string_pretty(&patch).unwrap_or_default())
        }
        "validate" => {
            let file = config_file()?;
            let raw = load(&file)?;
            let problems = validate_file(&file, &raw)?;
            if problems.is_empty() {
                Ok(format!("{} is valid", file.display()))
            } else {
                Err(ConfigError::Invalid(problems))
            }
        }
        "schema" => Ok(schema_document()),
        "help" | "--help" | "-h" => Ok(usage()),
        other => Err(ConfigError::InvalidPath(format!(
            "unknown config subcommand: {other}"
        ))),
    }
}

fn render(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

fn usage() -> String {
    "usage: openclaw config <get|set|patch|unset|file|schema|validate> [--dry-run]\n\
     \n\
     openclaw config file                 Print the active config path\n\
     openclaw config get <path>           Read a dotted path\n\
     openclaw config set <path> <value>   Write a value (JSON-typed when possible)\n\
     openclaw config patch <json>         Merge a JSON object\n\
     openclaw config unset <path>         Remove a key\n\
     openclaw config validate             Validate the active config\n\
     openclaw config schema               Print the supported top-level schema"
        .to_owned()
}

fn schema_document() -> String {
    serde_json::json!({
        "topLevel": ["gateway", "database", "logging", "telemetry", "providers", "agents", "channels"],
        "gateway": [
            "listen", "requireAuth", "authMode", "authToken", "authPassword",
            "controlUiEnabled", "maxConnections", "maxFrameBytes", "pingIntervalSecs"
        ],
        "note": "Validation is owned by openclaw-config::Config::validate."
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dotted_paths_reject_empty_segments() {
        assert!(segments("gateway.listen").is_ok());
        assert!(segments("gateway..listen").is_err());
        assert!(segments("").is_err());
        assert!(segments(".gateway").is_err());
    }

    #[test]
    fn values_are_typed_like_upstream() {
        assert_eq!(typed("true"), Value::Bool(true));
        assert_eq!(typed("64"), Value::from(64));
        assert_eq!(typed("info"), Value::String("info".to_owned()));
        assert_eq!(typed("0.0.0.0:18789"), Value::String("0.0.0.0:18789".to_owned()));
    }

    #[test]
    fn set_creates_nested_objects_and_unset_removes_only_the_leaf() {
        let mut root = serde_json::json!({"gateway": {"listen": "127.0.0.1:18789"}});
        set_path(&mut root, "logging.level", Value::String("debug".to_owned())).unwrap();
        assert_eq!(root["logging"]["level"], "debug");
        unset_path(&mut root, "logging.level").unwrap();
        assert!(root["logging"].get("level").is_none());
        assert_eq!(root["gateway"]["listen"], "127.0.0.1:18789");
    }

    #[test]
    fn patch_merges_instead_of_replacing() {
        let mut root = serde_json::json!({"gateway": {"listen": "a", "maxConnections": 8}});
        merge(&mut root, &serde_json::json!({"gateway": {"maxConnections": 64}}));
        assert_eq!(root["gateway"]["listen"], "a");
        assert_eq!(root["gateway"]["maxConnections"], 64);
    }
}
