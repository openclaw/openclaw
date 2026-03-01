use crate::providers::WslProvider;
use crate::services::system::SystemService;
use crate::services::WslInstallService;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

pub struct InstallerState(pub Arc<Mutex<Option<u32>>>);

#[tauri::command]
pub async fn abort_installation(
    state: State<'_, InstallerState>,
    system: State<'_, Arc<SystemService>>,
) -> crate::error::Result<()> {
    let mut lock = state.0.lock().await;
    if let Some(pid) = *lock {
        let _ = system.kill_process_tree(pid).await;
        *lock = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn check_wsl_status(
    _install_service: State<'_, Arc<WslInstallService>>,
    wsl_provider: State<'_, Arc<dyn WslProvider>>,
) -> crate::error::Result<bool> {
    Ok(wsl_provider.get_status())
}

#[tauri::command]
pub async fn check_systemd_status(
    wsl_provider: State<'_, Arc<dyn WslProvider>>,
) -> crate::error::Result<bool> {
    let output = match wsl_provider
        .run_command(&["-e", "bash", "-c", "systemctl is-system-running"], false)
    {
        Ok(o) => o,
        Err(_) => return Ok(false),
    };

    let status = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(status == "running" || status == "degraded" || status == "starting")
}

#[tauri::command]
pub async fn get_wsl_distro(
    wsl_provider: State<'_, Arc<dyn WslProvider>>,
) -> crate::error::Result<Option<String>> {
    Ok(wsl_provider.get_distro())
}

#[tauri::command]
pub async fn install_wsl(
    _app: AppHandle,
    install_service: State<'_, Arc<WslInstallService>>,
    installer_state: State<'_, InstallerState>,
) -> crate::error::Result<()> {
    {
        let mut slot = installer_state.0.lock().await;
        *slot = None;
    }

    let pid_slot = installer_state.0.clone();
    let result = install_service
        .check_and_install(move |pid| {
            let pid_slot = pid_slot.clone();
            tokio::spawn(async move {
                *pid_slot.lock().await = Some(pid);
            });
        })
        .await;

    {
        let mut slot = installer_state.0.lock().await;
        *slot = None;
    }

    result
}

#[tauri::command]
pub async fn install_openclaw(
    _app: AppHandle,
    install_service: State<'_, Arc<WslInstallService>>,
    installer_state: State<'_, InstallerState>,
) -> crate::error::Result<()> {
    {
        let mut slot = installer_state.0.lock().await;
        *slot = None;
    }

    let pid_slot = installer_state.0.clone();
    let result = install_service
        .install_openclaw(move |pid| {
            // Store the child PID so abort_installation can kill it
            let pid_slot = pid_slot.clone();
            tokio::spawn(async move {
                *pid_slot.lock().await = Some(pid);
            });
        })
        .await;

    {
        let mut slot = installer_state.0.lock().await;
        *slot = None;
    }

    result
}
