use crate::services::GatewayService;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::sync::Arc;
use tauri::State;

fn req_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn as_non_empty_string(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?.trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

fn as_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

fn as_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|n| n as i64)))
}

fn normalize_epoch_ms(value: Option<i64>) -> Option<i64> {
    let ts = value?;
    if ts <= 0 {
        return None;
    }
    if ts < 1_000_000_000_000 {
        Some(ts * 1000)
    } else {
        Some(ts)
    }
}

fn stringify_compact(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match value {
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Null => None,
        Value::Bool(_) | Value::Number(_) => Some(value.to_string()),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value).ok(),
    }
}

fn payload_prompt(payload: &Value) -> String {
    if let Some(kind) = as_non_empty_string(payload.get("kind")) {
        if kind == "systemEvent" {
            return as_non_empty_string(payload.get("text")).unwrap_or_default();
        }
        if kind == "agentTurn" {
            return as_non_empty_string(payload.get("message")).unwrap_or_default();
        }
    }
    as_non_empty_string(payload.get("text"))
        .or_else(|| as_non_empty_string(payload.get("message")))
        .unwrap_or_default()
}

fn schedule_summary(schedule: &Value) -> String {
    let kind = as_non_empty_string(schedule.get("kind")).unwrap_or_default();
    match kind.as_str() {
        "at" => as_non_empty_string(schedule.get("at"))
            .or_else(|| as_i64(schedule.get("atMs")).map(|ms| ms.to_string()))
            .map(|at| format!("at {}", at))
            .unwrap_or_else(|| "at (missing)".to_string()),
        "every" => as_i64(schedule.get("everyMs"))
            .map(|ms| format!("every {}ms", ms))
            .unwrap_or_else(|| "every (missing)".to_string()),
        "cron" => {
            let expr = as_non_empty_string(schedule.get("expr")).unwrap_or_default();
            let tz = as_non_empty_string(schedule.get("tz"));
            if expr.is_empty() {
                "cron (missing expression)".to_string()
            } else if let Some(tz) = tz {
                format!("cron {} ({})", expr, tz)
            } else {
                format!("cron {}", expr)
            }
        }
        _ => stringify_compact(Some(schedule)).unwrap_or_else(|| "unknown schedule".to_string()),
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CronJobInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub schedule: String,
    pub prompt: String,
    pub channel_id: Option<String>,
    pub last_run: Option<i64>,
    pub next_run: Option<i64>,
    pub created_at_ms: Option<i64>,
    pub updated_at_ms: Option<i64>,
    pub agent_id: Option<String>,
    pub session_key: Option<String>,
    pub session_target: Option<String>,
    pub wake_mode: Option<String>,
    pub delete_after_run: Option<bool>,
    pub schedule_data: Value,
    pub payload_data: Value,
    pub delivery_data: Option<Value>,
    pub state: Value,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub last_duration_ms: Option<i64>,
}

fn map_cron_job(value: Value, index: usize) -> CronJobInfo {
    let state = value
        .get("state")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let schedule_data = value
        .get("schedule")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let payload_data = value
        .get("payload")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let delivery_data = value.get("delivery").cloned();

    let prompt = payload_prompt(&payload_data);
    let name = as_non_empty_string(value.get("name"))
        .or_else(|| {
            if prompt.is_empty() {
                None
            } else {
                Some(prompt.clone())
            }
        })
        .unwrap_or_else(|| format!("Job {}", index + 1));

    let id = as_non_empty_string(value.get("id")).unwrap_or_else(|| format!("job-{}", index + 1));
    let channel_id = as_non_empty_string(
        delivery_data
            .as_ref()
            .and_then(|v| v.get("channel"))
            .or_else(|| payload_data.get("channel"))
            .or_else(|| payload_data.get("provider")),
    );

    let last_run = normalize_epoch_ms(
        as_i64(state.get("lastRunAtMs"))
            .or_else(|| as_i64(value.get("lastRunAtMs")))
            .or_else(|| as_i64(value.get("lastRun"))),
    );
    let next_run = normalize_epoch_ms(
        as_i64(state.get("nextRunAtMs"))
            .or_else(|| as_i64(value.get("nextRunAtMs")))
            .or_else(|| as_i64(value.get("nextRun"))),
    );
    let created_at_ms = normalize_epoch_ms(as_i64(value.get("createdAtMs")));
    let updated_at_ms = normalize_epoch_ms(as_i64(value.get("updatedAtMs")));
    let last_duration_ms = as_i64(state.get("lastDurationMs"));

    CronJobInfo {
        id,
        name,
        description: as_non_empty_string(value.get("description")),
        enabled: as_bool(value.get("enabled")).unwrap_or(true),
        schedule: schedule_summary(&schedule_data),
        prompt,
        channel_id,
        last_run,
        next_run,
        created_at_ms,
        updated_at_ms,
        agent_id: as_non_empty_string(value.get("agentId")),
        session_key: as_non_empty_string(value.get("sessionKey")),
        session_target: as_non_empty_string(value.get("sessionTarget")),
        wake_mode: as_non_empty_string(value.get("wakeMode")),
        delete_after_run: as_bool(value.get("deleteAfterRun")),
        schedule_data,
        payload_data,
        delivery_data,
        state: state.clone(),
        last_status: stringify_compact(state.get("lastStatus")),
        last_error: as_non_empty_string(state.get("lastError")),
        last_duration_ms,
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CronSchedulerStatus {
    pub enabled: bool,
    pub store_path: Option<String>,
    pub jobs: Option<i64>,
    pub next_wake_at_ms: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CronRunEntry {
    pub id: String,
    pub ts: i64,
    pub job_id: String,
    pub action: String,
    pub status: Option<String>,
    pub error: Option<String>,
    pub summary: Option<String>,
    pub session_id: Option<String>,
    pub session_key: Option<String>,
    pub run_at_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub next_run_at_ms: Option<i64>,
}

fn map_run_entry(value: Value, index: usize) -> CronRunEntry {
    let ts = normalize_epoch_ms(as_i64(value.get("ts"))).unwrap_or(0);
    let job_id = as_non_empty_string(value.get("jobId")).unwrap_or_default();
    let id = format!("{}-{}-{}", job_id, ts, index);

    CronRunEntry {
        id,
        ts,
        job_id,
        action: as_non_empty_string(value.get("action")).unwrap_or_else(|| "run".to_string()),
        status: stringify_compact(value.get("status")),
        error: as_non_empty_string(value.get("error")),
        summary: as_non_empty_string(value.get("summary")),
        session_id: as_non_empty_string(value.get("sessionId")),
        session_key: as_non_empty_string(value.get("sessionKey")),
        run_at_ms: normalize_epoch_ms(as_i64(value.get("runAtMs"))),
        duration_ms: as_i64(value.get("durationMs")),
        next_run_at_ms: normalize_epoch_ms(as_i64(value.get("nextRunAtMs"))),
    }
}

fn normalize_upsert_payload(raw: Value) -> crate::error::Result<(Option<String>, Value)> {
    let mut object = raw.as_object().cloned().ok_or_else(|| {
        crate::error::OpenClawError::Internal("cron payload must be an object".to_string())
    })?;

    let id = as_non_empty_string(object.get("id"));
    object.remove("id");

    if !matches!(object.get("schedule"), Some(Value::Object(_))) {
        return Err(crate::error::OpenClawError::Internal(
            "schedule must be an object".to_string(),
        ));
    }
    if !matches!(object.get("payload"), Some(Value::Object(_))) {
        return Err(crate::error::OpenClawError::Internal(
            "payload must be an object".to_string(),
        ));
    }
    if as_non_empty_string(object.get("name")).is_none() {
        return Err(crate::error::OpenClawError::Internal(
            "name is required".to_string(),
        ));
    }
    if as_non_empty_string(object.get("sessionTarget")).is_none() {
        return Err(crate::error::OpenClawError::Internal(
            "sessionTarget is required".to_string(),
        ));
    }
    if as_non_empty_string(object.get("wakeMode")).is_none() {
        return Err(crate::error::OpenClawError::Internal(
            "wakeMode is required".to_string(),
        ));
    }

    Ok((id, Value::Object(object)))
}

#[tauri::command]
pub async fn get_cron_jobs(
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<Vec<CronJobInfo>> {
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "cron.list",
        "params": {
            "includeDisabled": true
        }
    })
    .to_string();

    let result = gateway_service.request(req).await?;
    let jobs_value = result.get("jobs").cloned().unwrap_or(result);
    let jobs = jobs_value
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, value)| map_cron_job(value, index))
        .collect();

    Ok(jobs)
}

#[tauri::command]
pub async fn get_cron_status(
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<CronSchedulerStatus> {
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "cron.status",
        "params": {}
    })
    .to_string();

    let result = gateway_service.request(req).await?;
    Ok(CronSchedulerStatus {
        enabled: as_bool(result.get("enabled")).unwrap_or(true),
        store_path: as_non_empty_string(result.get("storePath")),
        jobs: as_i64(result.get("jobs")),
        next_wake_at_ms: normalize_epoch_ms(as_i64(result.get("nextWakeAtMs"))),
    })
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SaveCronJobCommandPayload {
    pub payload: Value,
}

#[tauri::command]
pub async fn save_cron_job(
    payload: SaveCronJobCommandPayload,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<serde_json::Value> {
    let (id, normalized_payload) = normalize_upsert_payload(payload.payload)?;
    let req = if let Some(id) = id {
        json!({
            "type": "req",
            "id": req_id(),
            "method": "cron.update",
            "params": {
                "id": id,
                "patch": normalized_payload
            }
        })
    } else {
        json!({
            "type": "req",
            "id": req_id(),
            "method": "cron.add",
            "params": normalized_payload
        })
    }
    .to_string();

    gateway_service.request(req).await
}

#[tauri::command]
pub async fn delete_cron_job(
    id: String,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<serde_json::Value> {
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "cron.remove",
        "params": {
            "id": id
        }
    })
    .to_string();

    gateway_service.request(req).await
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CronRunsPayload {
    pub id: String,
    pub limit: Option<u64>,
}

#[tauri::command]
pub async fn get_cron_runs(
    payload: CronRunsPayload,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<Vec<CronRunEntry>> {
    let limit = payload.limit.unwrap_or(200);
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "cron.runs",
        "params": {
            "id": payload.id,
            "limit": limit
        }
    })
    .to_string();

    let result = gateway_service.request(req).await?;
    let entries_value = result.get("entries").cloned().unwrap_or(result);
    let rows = entries_value
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, value)| map_run_entry(value, index))
        .collect();
    Ok(rows)
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunCronPayload {
    pub id: String,
    pub force: Option<bool>,
}

#[tauri::command]
pub async fn run_cron_job(
    payload: RunCronPayload,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<serde_json::Value> {
    let mode = if payload.force.unwrap_or(true) {
        "force"
    } else {
        "due"
    };
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "cron.run",
        "params": {
            "id": payload.id,
            "mode": mode
        }
    })
    .to_string();

    gateway_service.request(req).await
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SetCronJobEnabledPayload {
    pub id: String,
    pub enabled: bool,
}

#[tauri::command]
pub async fn set_cron_job_enabled(
    payload: SetCronJobEnabledPayload,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<serde_json::Value> {
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "cron.update",
        "params": {
            "id": payload.id,
            "patch": {
                "enabled": payload.enabled
            }
        }
    })
    .to_string();

    gateway_service.request(req).await
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CronTranscriptPayload {
    pub id: String,
    pub session_key: Option<String>,
    pub limit: Option<u64>,
}

#[tauri::command]
pub async fn get_cron_transcript(
    payload: CronTranscriptPayload,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<serde_json::Value> {
    let limit = payload.limit.unwrap_or(200);
    let session_key = payload
        .session_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("cron:{}", payload.id.trim()));
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "chat.history",
        "params": {
            "sessionKey": session_key,
            "limit": limit
        }
    })
    .to_string();

    gateway_service.request(req).await
}
