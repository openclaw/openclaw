use crate::services::GatewayService;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tauri::State;

fn req_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct GatewaySessionDefaults {
    model: Option<String>,
    context_tokens: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct GatewaySessionEntry {
    key: String,
    display_name: Option<String>,
    updated_at: Option<f64>,
    session_id: Option<String>,
    thinking_level: Option<String>,
    verbose_level: Option<String>,
    system_sent: Option<bool>,
    aborted_last_run: Option<bool>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
    model: Option<String>,
    context_tokens: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct GatewaySessionsListResponse {
    defaults: Option<GatewaySessionDefaults>,
    sessions: Vec<GatewaySessionEntry>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub key: String,
    pub label: String,
    pub kind: String,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub context_used: u64,
    pub context_max: u64,
    pub flags: Vec<String>,
    pub updated_at: Option<f64>,
}

fn session_kind(key: &str) -> &'static str {
    if key == "global" {
        "global"
    } else if key.starts_with("group:") || key.contains(":group:") || key.contains(":channel:") {
        "group"
    } else if key == "unknown" {
        "unknown"
    } else {
        "direct"
    }
}

fn normalize_epoch_ms(ts: Option<f64>) -> Option<f64> {
    let value = ts?;
    if value <= 0.0 {
        return None;
    }
    // Some payloads use seconds, others milliseconds.
    if value < 1_000_000_000_000.0 {
        Some(value * 1000.0)
    } else {
        Some(value)
    }
}

fn derive_flags(entry: &GatewaySessionEntry) -> Vec<String> {
    let mut flags: Vec<String> = Vec::new();
    if let Some(level) = entry.thinking_level.as_deref().filter(|s| !s.is_empty()) {
        flags.push(format!("think {}", level));
    }
    if let Some(level) = entry.verbose_level.as_deref().filter(|s| !s.is_empty()) {
        flags.push(format!("verbose {}", level));
    }
    if entry.system_sent.unwrap_or(false) {
        flags.push("system sent".to_string());
    }
    if entry.aborted_last_run.unwrap_or(false) {
        flags.push("aborted".to_string());
    }
    flags
}

#[tauri::command]
pub async fn get_sessions(
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<Vec<SessionRow>> {
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "sessions.list",
        "params": {
            "includeGlobal": true,
            "includeUnknown": true
        }
    })
    .to_string();

    let result = gateway_service.request(req).await?;
    let decoded: GatewaySessionsListResponse = serde_json::from_value(result.clone())
        .or_else(|_| {
            result
                .get("payload")
                .cloned()
                .ok_or_else(|| serde_json::Error::io(std::io::Error::other("missing payload")))
                .and_then(serde_json::from_value)
        })
        .unwrap_or_default();

    let defaults = decoded.defaults.unwrap_or_default();
    let default_context = defaults.context_tokens.unwrap_or(200_000);

    let mut rows: Vec<SessionRow> = decoded
        .sessions
        .into_iter()
        .map(|entry| {
            let input = entry.input_tokens.unwrap_or(0);
            let output = entry.output_tokens.unwrap_or(0);
            let total = entry.total_tokens.unwrap_or(input.saturating_add(output));
            let context_max = entry.context_tokens.unwrap_or(default_context);

            SessionRow {
                label: entry
                    .display_name
                    .clone()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| entry.key.clone()),
                kind: session_kind(&entry.key).to_string(),
                model: entry.model.clone().or_else(|| defaults.model.clone()),
                session_id: entry.session_id.clone(),
                input_tokens: input,
                output_tokens: output,
                context_used: total,
                context_max,
                flags: derive_flags(&entry),
                updated_at: normalize_epoch_ms(entry.updated_at),
                key: entry.key,
            }
        })
        .collect();

    rows.sort_by(|a, b| {
        b.updated_at
            .partial_cmp(&a.updated_at)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(rows)
}
