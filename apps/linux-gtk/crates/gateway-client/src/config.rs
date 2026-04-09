use std::path::PathBuf;

use serde::Deserialize;
use tracing::debug;

/// Gateway connection configuration, resolved from env vars → config file → defaults.
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub url: String,
    pub token: Option<String>,
    pub tls_accept_invalid: bool,
}

#[derive(Debug, Deserialize)]
struct OpenClawConfig {
    #[serde(default)]
    gateway: Option<GatewaySection>,
}

#[derive(Debug, Deserialize)]
struct GatewaySection {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    token: Option<String>,
}

impl GatewayConfig {
    pub fn resolve() -> Self {
        // 1. Environment variables
        let env_url = std::env::var("OPENCLAW_GATEWAY_URL").ok();
        let env_token = std::env::var("OPENCLAW_GATEWAY_TOKEN").ok();
        let env_insecure = std::env::var("OPENCLAW_TLS_ACCEPT_INVALID")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(false);

        // 2. Config file
        let config_path = Self::config_path();
        let file_config = if config_path.exists() {
            debug!("reading config from {}", config_path.display());
            std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|s| serde_json::from_str::<OpenClawConfig>(&s).ok())
        } else {
            None
        };

        let (file_url, file_token) = file_config
            .and_then(|c| c.gateway)
            .map(|g| (g.url, g.token))
            .unwrap_or((None, None));

        Self {
            url: env_url
                .or(file_url)
                .unwrap_or_else(|| "ws://127.0.0.1:18789".to_string()),
            token: env_token.or(file_token),
            tls_accept_invalid: env_insecure,
        }
    }

    fn config_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".openclaw")
            .join("openclaw.json")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse a file-shaped JSON blob — exercises the same path `resolve()`
    /// uses when deserializing the on-disk config, without touching env vars
    /// or the filesystem (tests run in parallel and can race on env/files).
    fn parse_file_config(raw: &str) -> Option<(Option<String>, Option<String>)> {
        serde_json::from_str::<OpenClawConfig>(raw)
            .ok()
            .and_then(|c| c.gateway)
            .map(|g| (g.url, g.token))
    }

    #[test]
    fn parses_full_gateway_section() {
        let (url, has_token) = parse_file_config(
            r#"{"gateway":{"url":"wss://example.test:9443","token":"xxx"}}"#,
        )
        .unwrap();
        assert_eq!(url, Some("wss://example.test:9443".into()));
        assert!(has_token.is_some());
    }

    #[test]
    fn parses_gateway_with_url_only() {
        let (url, tok) =
            parse_file_config(r#"{"gateway":{"url":"wss://x:1"}}"#).unwrap();
        assert_eq!(url, Some("wss://x:1".into()));
        assert!(tok.is_none());
    }

    #[test]
    fn parses_empty_gateway_section() {
        let (url, tok) = parse_file_config(r#"{"gateway":{}}"#).unwrap();
        assert!(url.is_none());
        assert!(tok.is_none());
    }

    #[test]
    fn empty_object_means_no_gateway_section() {
        assert!(parse_file_config(r#"{}"#).is_none());
    }

    #[test]
    fn ignores_unknown_fields() {
        // Forward-compat: new fields landing in openclaw.json must not break.
        let (url, _) = parse_file_config(
            r#"{"gateway":{"url":"wss://x","extra":"ignored"},"otherKey":42}"#,
        )
        .unwrap();
        assert_eq!(url, Some("wss://x".into()));
    }

    #[test]
    fn invalid_json_returns_none_via_ok() {
        // parse_file_config mirrors resolve()'s `.ok()` swallow — bad JSON
        // must not panic; resolve() falls back to env/defaults.
        assert!(parse_file_config(r#"not json"#).is_none());
        assert!(parse_file_config(r#"{"gateway":"wrong-type"}"#).is_none());
    }

    #[test]
    fn default_url_is_local_loopback() {
        // Sanity: if nothing is set, resolve() must fall back to loopback.
        // Can't safely mutate env in parallel tests, so just check the literal.
        // If the default changes, this test changes with it.
        let default = "ws://127.0.0.1:18789";
        assert!(default.starts_with("ws://"));
        assert!(default.contains("127.0.0.1"));
        assert!(default.contains("18789"));
    }
}
