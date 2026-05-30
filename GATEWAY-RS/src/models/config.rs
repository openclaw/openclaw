use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct OpenClawConfig {
    #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<ConfigMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<serde_json::Value>, // Placeholder for AuthConfig
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway: Option<GatewayConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<HashMap<String, serde_json::Value>>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConfigMeta {
    #[serde(rename = "lastTouchedVersion", skip_serializing_if = "Option::is_none")]
    pub last_touched_version: Option<String>,
    #[serde(rename = "lastTouchedAt", skip_serializing_if = "Option::is_none")]
    pub last_touched_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct GatewayConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<GatewayAuthConfig>,
    #[serde(rename = "trustedProxies", default)]
    pub trusted_proxies: Vec<String>,
    #[serde(rename = "allowRealIpFallback", skip_serializing_if = "Option::is_none")]
    pub allow_real_ip_fallback: Option<bool>,
    #[serde(rename = "handshakeTimeoutMs", skip_serializing_if = "Option::is_none")]
    pub handshake_timeout_ms: Option<u64>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GatewayAuthConfig {
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(rename = "rateLimit", skip_serializing_if = "Option::is_none")]
    pub rate_limit: Option<serde_json::Value>,
}
