use crate::services::GatewayService;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tauri::State;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstanceInfo {
    pub id: String,
    pub host: Option<String>,
    pub ip: Option<String>,
    pub version: Option<String>,
    pub platform: Option<String>,
    pub device_family: Option<String>,
    pub model_identifier: Option<String>,
    pub mode: Option<String>,
    pub reason: Option<String>,
    pub last_input_seconds: Option<u64>,
    pub ts: f64,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct GatewayPresence {
    host: Option<String>,
    ip: Option<String>,
    version: Option<String>,
    platform: Option<String>,
    device_family: Option<String>,
    model_identifier: Option<String>,
    mode: Option<String>,
    reason: Option<String>,
    last_input_seconds: Option<u64>,
    device_id: Option<String>,
    instance_id: Option<String>,
    ts: Option<f64>,
}

#[tauri::command]
pub async fn get_instances(
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<Vec<InstanceInfo>> {
    let req = json!({
        "type": "req",
        "id": uuid::Uuid::new_v4().simple().to_string(),
        "method": "system-presence",
        "params": {}
    })
    .to_string();

    let result = gateway_service.request(req).await?;

    let presences: Vec<GatewayPresence> = serde_json::from_value(result).unwrap_or_default();
    let instances = presences
        .into_iter()
        .enumerate()
        .map(|(idx, p)| InstanceInfo {
            id: p
                .instance_id
                .clone()
                .or(p.device_id.clone())
                .or_else(|| p.host.clone())
                .or_else(|| p.ip.clone())
                .unwrap_or_else(|| format!("presence-{}", idx)),
            host: p.host,
            ip: p.ip,
            version: p.version,
            platform: p.platform,
            device_family: p.device_family,
            model_identifier: p.model_identifier,
            mode: p.mode,
            reason: p.reason,
            last_input_seconds: p.last_input_seconds,
            ts: p.ts.unwrap_or(0.0),
        })
        .collect();

    Ok(instances)
}
