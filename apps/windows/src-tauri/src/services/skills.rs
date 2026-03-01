use crate::services::runtime::BackgroundService;
use crate::services::ConfigService;
use crate::services::GatewayService;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

// Skills data models used by settings commands.

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillMissing {
    pub bins: Vec<String>,
    pub env: Vec<String>,
    pub config: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallOption {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub bins: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillRequirements {
    pub bins: Vec<String>,
    pub env: Vec<String>,
    pub config: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillStatusConfigCheck {
    pub path: String,
    pub value: Option<serde_json::Value>,
    pub satisfied: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillStatus {
    pub skill_key: String,
    pub name: String,
    pub description: String,
    pub source: String,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub base_dir: Option<String>,
    #[serde(default)]
    pub emoji: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub always: Option<bool>,
    pub disabled: bool,
    pub eligible: bool,
    #[serde(default)]
    pub primary_env: Option<String>,
    #[serde(default)]
    pub requirements: SkillRequirements,
    #[serde(default)]
    pub missing: SkillMissing,
    #[serde(default)]
    pub config_checks: Vec<SkillStatusConfigCheck>,
    #[serde(default)]
    pub install: Vec<SkillInstallOption>,
}

fn req_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

// Skills commands.

#[tauri::command]
pub async fn get_skills(
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<Vec<SkillStatus>> {
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "skills.status",
        "params": {}
    })
    .to_string();

    let result = gateway_service.request(req).await?;

    let skills: Vec<SkillStatus> = result
        .get("skills")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    Ok(skills)
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetSkillEnabledPayload {
    pub skill_key: String,
    pub enabled: bool,
}

#[tauri::command]
pub async fn set_skill_enabled(
    payload: SetSkillEnabledPayload,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<serde_json::Value> {
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "skills.update",
        "params": {
            "skillKey": payload.skill_key,
            "enabled": payload.enabled
        }
    })
    .to_string();

    gateway_service.request(req).await
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetSkillEnvPayload {
    pub skill_key: String,
    pub env_key: String,
    pub value: String,
    pub is_primary: bool,
}

#[tauri::command]
pub async fn set_skill_env(
    payload: SetSkillEnvPayload,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<serde_json::Value> {
    let params = if payload.is_primary {
        json!({
            "skillKey": payload.skill_key,
            "apiKey": payload.value
        })
    } else {
        json!({
            "skillKey": payload.skill_key,
            "env": { payload.env_key: payload.value }
        })
    };

    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "skills.update",
        "params": params
    })
    .to_string();

    gateway_service.request(req).await
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallSkillPayload {
    pub skill_key: String,
    pub skill_name: Option<String>,
    pub install_id: String,
    pub target: Option<String>,
    pub timeout_ms: Option<u64>,
}

async fn maybe_switch_to_local_mode(
    app: &AppHandle,
    config_service: &Arc<ConfigService>,
) -> crate::error::Result<bool> {
    let before = config_service.load().await?;
    if before.gateway_mode == "local" {
        return Ok(false);
    }

    config_service
        .update(|config| {
            config.gateway_mode = "local".to_string();
            config.gateway_type = "local".to_string();
            if config.address.trim().is_empty() {
                config.address = "127.0.0.1".to_string();
            }
            if config.port == 0 {
                config.port = 18789;
            }
        })
        .await?;

    let after = config_service.load().await?;
    if after.gateway_mode != "local" {
        return Ok(false);
    }

    let gateway = app.state::<Arc<GatewayService>>().inner().clone();
    <GatewayService as BackgroundService>::stop(gateway.as_ref())
        .await
        .map_err(|e| {
            crate::error::OpenClawError::Internal(format!(
                "Failed to stop gateway service for local switch: {}",
                e
            ))
        })?;
    if !after.is_paused {
        <GatewayService as BackgroundService>::start(gateway.as_ref(), app.clone())
            .await
            .map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to restart gateway service after local switch: {}",
                    e
                ))
            })?;
    }

    Ok(true)
}

#[tauri::command]
pub async fn install_skill(
    payload: InstallSkillPayload,
    app: AppHandle,
    config_service: State<'_, Arc<ConfigService>>,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<serde_json::Value> {
    let target = payload
        .target
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("gateway");
    let timeout_ms = payload.timeout_ms.unwrap_or(300_000);
    let mut switched_to_local = false;

    if target.eq_ignore_ascii_case("local") {
        switched_to_local = maybe_switch_to_local_mode(&app, config_service.inner()).await?;
    }

    let skill_name = payload
        .skill_name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(payload.skill_key.as_str());

    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "skills.install",
        "params": {
            "name": skill_name,
            "installId": payload.install_id,
            "timeoutMs": timeout_ms
        }
    })
    .to_string();

    let result = gateway_service.request(req).await?;
    if switched_to_local {
        let message = result
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("Install request sent");
        let mut object = result.as_object().cloned().unwrap_or_default();
        object.insert(
            "message".to_string(),
            serde_json::Value::String(format!(
                "Switched to Local mode to install on this Windows. {}",
                message
            )),
        );
        return Ok(serde_json::Value::Object(object));
    }

    Ok(result)
}
