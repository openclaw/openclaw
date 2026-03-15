use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct GatewayConfig {
    pub url: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub device_type: String,
    pub online: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Message {
    pub to: String,
    pub content: String,
    pub message_type: String,
}

#[tauri::command]
pub async fn connect_gateway(url: String, api_key: Option<String>) -> Result<bool, String> {
    // Implementation would connect to gateway WebSocket
    Ok(true)
}

#[tauri::command]
pub async fn disconnect_gateway() -> Result<bool, String> {
    Ok(true)
}

#[tauri::command]
pub async fn get_paired_devices() -> Result<Vec<Device>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn send_message(to: String, content: String, message_type: String) -> Result<bool, String> {
    Ok(true)
}

#[tauri::command]
pub async fn start_pairing(code: String) -> Result<Device, String> {
    Ok(Device {
        id: "new-device".to_string(),
        name: "New Device".to_string(),
        device_type: "unknown".to_string(),
        online: true,
    })
}

#[tauri::command]
pub async fn get_camera_snapshot(device_id: String) -> Result<Vec<u8>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn get_location(device_id: String) -> Result<(f64, f64), String> {
    Ok((0.0, 0.0))
}
