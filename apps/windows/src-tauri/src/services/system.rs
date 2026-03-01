use crate::error::{recover_mutex_poison, OpenClawError};
use crate::providers::system::{PtyHandle, SystemProvider};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, State};

pub struct SystemService {
    provider: Arc<dyn SystemProvider>,
    // Use std::sync::Mutex (not tokio) so it's safe to lock inside spawn_blocking.
    registry: Arc<std::sync::Mutex<HashMap<String, PtyHandle>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccentColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub hex: String,
}

#[derive(Serialize, Clone)]
struct TerminalOutput {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct TerminalExit {
    id: String,
    code: i32,
}

impl SystemService {
    pub fn new(provider: Arc<dyn SystemProvider>) -> Self {
        Self {
            provider,
            registry: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    pub fn get_accent_color(&self) -> crate::error::Result<AccentColor> {
        self.provider
            .get_accent_color()
            .map(|(r, g, b, hex)| AccentColor { r, g, b, hex })
            .ok_or_else(|| OpenClawError::Internal("Failed to get accent color".to_string()))
    }

    /// Internal helper to spawn a terminal session WITHOUT security validation.
    /// Use only for statically defined commands in the backend.
    fn spawn_terminal_session(
        &self,
        app: AppHandle,
        id: String,
        command: String,
        args: Vec<String>,
        rows: u16,
        cols: u16,
    ) -> crate::error::Result<String> {
        let id_clone = id.clone();
        let app_handle = app.clone();
        let provider = self.provider.clone();
        let registry = self.registry.clone();

        tauri::async_runtime::spawn_blocking(move || {
            let pty = match provider.create_pty(&command, &args, rows, cols) {
                Ok(p) => p,
                Err(e) => {
                    tracing::error!("[SystemService] Failed to spawn command: {}", e);
                    let _ = app_handle.emit(
                        "terminal-output",
                        TerminalOutput {
                            id: id_clone.clone(),
                            data: format!("\x1b[31mFailed to spawn command: {}\x1b[0m\r\n", e),
                        },
                    );
                    let _ = app_handle.emit(
                        "terminal-exit",
                        TerminalExit {
                            id: id_clone,
                            code: 1,
                        },
                    );
                    return;
                }
            };

            let mut reader = match pty.master.try_clone_reader() {
                Ok(r) => r,
                Err(e) => {
                    tracing::error!("[SystemService] Failed to open reader: {}", e);
                    let _ = app_handle.emit(
                        "terminal-output",
                        TerminalOutput {
                            id: id_clone.clone(),
                            data: format!("\x1b[31mFailed to open reader: {}\x1b[0m\r\n", e),
                        },
                    );
                    let _ = app_handle.emit(
                        "terminal-exit",
                        TerminalExit {
                            id: id_clone,
                            code: 1,
                        },
                    );
                    return;
                }
            };

            // Store handle in registry.
            {
                tracing::info!(
                    "[SystemService] Storing interaction handles for id: {}",
                    id_clone
                );
                let mut map = registry
                    .lock()
                    .unwrap_or_else(|e| recover_mutex_poison(e, "terminal_registry_insert"));
                map.insert(id_clone.clone(), pty);
            }

            let id_output = id_clone.clone();
            let app_output = app_handle.clone();
            let registry_wait = registry.clone();
            let id_wait = id_clone.clone();
            let app_wait = app_handle.clone();

            // Reader thread emits terminal-output.
            thread::spawn(move || {
                tracing::info!(
                    "[SystemService] Reader thread started for id: {}",
                    id_output
                );
                let mut buffer = [0u8; 4096];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(n) if n > 0 => {
                            let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                            let _ = app_output.emit(
                                "terminal-output",
                                TerminalOutput {
                                    id: id_output.clone(),
                                    data,
                                },
                            );
                        }
                        _ => {
                            tracing::info!(
                                "[SystemService] Reader loop broke for id: {}",
                                id_output
                            );
                            break;
                        }
                    }
                }
                tracing::info!(
                    "[SystemService] Reader thread exiting for id: {}",
                    id_output
                );
            });

            // Independent exit waiter thread.
            thread::spawn(move || {
                tracing::info!("[SystemService] Exit waiter started for id: {}", id_wait);

                let code = loop {
                    {
                        let mut map = registry_wait.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(pty) = map.get_mut(&id_wait) {
                            match pty.child.try_wait() {
                                Ok(Some(status)) => {
                                    let c = if status.success() { 0 } else { 1 };
                                    tracing::info!("[SystemService] Child exited naturally with code: {} for id: {}", c, id_wait);
                                    break c;
                                }
                                Ok(None) => {
                                    // Still running
                                }
                                Err(e) => {
                                    tracing::error!(
                                        "[SystemService] Error waiting for child {}: {}",
                                        id_wait,
                                        e
                                    );
                                    break 1;
                                }
                            }
                        } else {
                            tracing::info!("[SystemService] Session removed from registry (likely killed) for id: {}", id_wait);
                            break 0;
                        }
                    }
                    thread::sleep(std::time::Duration::from_millis(100));
                };

                // Cleanup registry if it's still there.
                {
                    let mut map = registry_wait
                        .lock()
                        .unwrap_or_else(|e| recover_mutex_poison(e, "terminal_registry_cleanup"));
                    if map.remove(&id_wait).is_some() {
                        tracing::info!(
                            "[SystemService] Removed session from registry for id: {}",
                            id_wait
                        );
                    }
                }

                tracing::info!(
                    "[SystemService] Emitting terminal-exit for id: {} with code: {}",
                    id_wait,
                    code
                );
                let _ = app_wait.emit("terminal-exit", TerminalExit { id: id_wait, code });
            });
        });

        Ok(id)
    }

    pub async fn run_onboarding_terminal(
        &self,
        app: AppHandle,
        id: String,
        rows: u16,
        cols: u16,
    ) -> crate::error::Result<String> {
        // Trusted internal command: Skip validation
        let command = "wsl".to_string();
        let args = vec![
            "bash".to_string(),
            "-c".to_string(),
            "export PATH=\"$HOME/.npm-global/bin:$PATH\" && openclaw onboard --install-daemon"
                .to_string(),
        ];

        tracing::info!("[SystemService] Spawning trusted onboarding terminal session");
        self.spawn_terminal_session(app, id, command, args, rows, cols)
    }

    pub async fn write_terminal_stdin(&self, id: &str, input: &str) -> crate::error::Result<()> {
        let mut map = self
            .registry
            .lock()
            .unwrap_or_else(|e| recover_mutex_poison(e, "terminal_registry_write"));
        if let Some(handle) = map.get_mut(id) {
            handle
                .writer
                .write_all(input.as_bytes())
                .map_err(OpenClawError::from)?;
            Ok(())
        } else {
            Err(OpenClawError::Internal("Session not found".to_string()))
        }
    }

    pub async fn resize_terminal(
        &self,
        id: &str,
        rows: u16,
        cols: u16,
    ) -> crate::error::Result<()> {
        let mut map = self
            .registry
            .lock()
            .unwrap_or_else(|e| recover_mutex_poison(e, "terminal_registry_resize"));
        if let Some(handle) = map.get_mut(id) {
            handle
                .master
                .resize(portable_pty::PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| OpenClawError::Internal(e.to_string()))?;
            Ok(())
        } else {
            Err(OpenClawError::Internal("Session not found".to_string()))
        }
    }

    pub async fn kill_terminal(&self, id: &str) -> crate::error::Result<()> {
        let mut map = self
            .registry
            .lock()
            .unwrap_or_else(|e| recover_mutex_poison(e, "terminal_registry_kill"));
        if let Some(mut pty) = map.remove(id) {
            let _ = pty.child.kill();
            Ok(())
        } else {
            Err(OpenClawError::Internal("Session not found".to_string()))
        }
    }

    pub async fn kill_all(&self) {
        let mut map = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        map.clear();
    }

    pub async fn kill_process_tree(&self, pid: u32) -> crate::error::Result<()> {
        let provider = self.provider.clone();
        tauri::async_runtime::spawn_blocking(move || provider.kill_process_tree(pid))
            .await
            .map_err(|e| crate::error::OpenClawError::Internal(e.to_string()))?
    }

    pub async fn run_command(
        &self,
        command: &[String],
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        timeout_ms: Option<u64>,
    ) -> crate::error::Result<std::process::Output> {
        let provider = self.provider.clone();
        let cmd = command.to_vec();
        tauri::async_runtime::spawn_blocking(move || {
            provider.run_command(&cmd, cwd, env, timeout_ms)
        })
        .await
        .map_err(|e| crate::error::OpenClawError::Internal(e.to_string()))?
    }
}

#[tauri::command]
pub async fn get_accent_color(
    service: State<'_, Arc<SystemService>>,
) -> crate::error::Result<AccentColor> {
    service.get_accent_color()
}

#[tauri::command]
pub async fn run_onboarding_terminal(
    app: AppHandle,
    service: State<'_, Arc<SystemService>>,
    id: String,
    rows: u16,
    cols: u16,
) -> crate::error::Result<String> {
    service.run_onboarding_terminal(app, id, rows, cols).await
}

#[tauri::command]
pub async fn write_terminal_stdin(
    service: State<'_, Arc<SystemService>>,
    id: String,
    input: String,
) -> crate::error::Result<()> {
    service.write_terminal_stdin(&id, &input).await
}

#[tauri::command]
pub async fn resize_terminal(
    service: State<'_, Arc<SystemService>>,
    id: String,
    rows: u16,
    cols: u16,
) -> crate::error::Result<()> {
    service.resize_terminal(&id, rows, cols).await
}

#[tauri::command]
pub async fn kill_terminal_command(
    service: State<'_, Arc<SystemService>>,
    id: String,
) -> crate::error::Result<()> {
    service.kill_terminal(&id).await
}
