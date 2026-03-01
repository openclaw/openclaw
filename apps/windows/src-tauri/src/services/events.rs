use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub struct EventDispatcher {
    app: AppHandle,
}

impl EventDispatcher {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    pub fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> crate::error::Result<()> {
        self.app.emit(event, payload).map_err(|e| {
            crate::error::OpenClawError::Internal(format!("Failed to emit event {}: {}", event, e))
        })
    }
}
