use crate::services::DiscoveryService;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn start_discovery(
    app: AppHandle,
    service: State<'_, Arc<DiscoveryService>>,
) -> crate::error::Result<()> {
    service.start_browsing(app)
}

#[tauri::command]
pub fn stop_discovery(service: State<'_, Arc<DiscoveryService>>) -> crate::error::Result<()> {
    service.stop_browsing();
    Ok(())
}
