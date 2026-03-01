use crate::services::{GatewayService, TalkService, VoiceWakeService};
use serde::Serialize;
use std::sync::Arc;
use tauri::{
    utils::config::WindowEffectsConfig, window::Effect, AppHandle, Manager, PhysicalPosition,
    PhysicalSize,
};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayStatus {
    pub gateway_connected: bool,
    pub gateway_address: String,
    pub voice_wake_enabled: bool,
    pub talk_mode_enabled: bool,
    pub node_name: String,
}

/// Returns live status for the tray popup menu.
#[tauri::command]
pub async fn get_tray_status(app: AppHandle) -> crate::error::Result<TrayStatus> {
    let gateway_service = app.state::<Arc<GatewayService>>();
    let talk_service = app.state::<Arc<TalkService>>();
    let voice_wake_service = app.state::<Arc<VoiceWakeService>>();

    let gateway_status = gateway_service.get_status().await?;
    let connected = gateway_status["connected"].as_bool().unwrap_or(false);
    let address = gateway_status["address"].as_str().unwrap_or("").to_string();
    let port = gateway_status["port"].as_u64().unwrap_or(0);

    let node_name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "This PC".to_string());

    let voice_wake_enabled = *voice_wake_service.is_enabled.lock().await;

    Ok(TrayStatus {
        gateway_connected: connected,
        gateway_address: if connected && !address.is_empty() {
            format!("{}:{}", address, port)
        } else {
            String::new()
        },
        voice_wake_enabled,
        talk_mode_enabled: talk_service.is_enabled().await,
        node_name,
    })
}

/// Inner helper called by the tray icon event handler.
pub async fn toggle_tray_menu_inner(
    app: &AppHandle,
    cursor_x: i32,
    cursor_y: i32,
) -> crate::error::Result<()> {
    let window = app.get_webview_window("tray_menu").ok_or_else(|| {
        crate::error::OpenClawError::Internal("tray_menu window not found".into())
    })?;

    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return Ok(());
    }

    let scale = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);

    // Use current logical size if available, otherwise fallback to design defaults
    let (l_width, l_height) = window
        .inner_size()
        .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
        .unwrap_or((320.0, 520.0));

    // Ensure the window has a valid initial size if it was just zeroed out
    let final_l_width = if l_width < 10.0 { 320.0 } else { l_width };
    let final_l_height = if l_height < 10.0 { 520.0 } else { l_height };

    // Find the monitor containing the cursor (cursor_x/y are physical)
    let monitors = app.available_monitors().unwrap_or_default();
    let monitor = monitors.into_iter().find(|m| {
        let pos = m.position();
        let size = m.size();
        cursor_x >= pos.x
            && cursor_x < pos.x + size.width as i32
            && cursor_y >= pos.y
            && cursor_y < pos.y + size.height as i32
    });

    let (m_pos, m_size, m_scale) = if let Some(m) = monitor {
        (m.position().clone(), m.size().clone(), m.scale_factor())
    } else {
        (
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1080),
            1.0,
        )
    };

    // Use monitor-specific scale for calculations
    let c_lx = cursor_x as f64 / m_scale;
    let c_ly = cursor_y as f64 / m_scale;
    let s_lx = m_pos.x as f64 / m_scale;
    let s_ly = m_pos.y as f64 / m_scale;
    let s_lw = m_size.width as f64 / m_scale;
    let s_lh = m_size.height as f64 / m_scale;

    // Center window horizontally on cursor, and position above
    let mut x = c_lx - (final_l_width / 2.0);
    let mut y = c_ly - final_l_height;

    // Clamp to monitor (logical)
    x = x.clamp(s_lx, s_lx + s_lw - final_l_width);
    y = y.clamp(s_ly, s_ly + s_lh - final_l_height);

    let _ = window.set_size(tauri::LogicalSize::new(final_l_width, final_l_height));
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));

    let _ = window.set_effects(Some(WindowEffectsConfig {
        effects: vec![Effect::Mica],
        ..Default::default()
    }));
    let _ = window.show();
    let _ = window.set_focus();

    Ok(())
}

#[tauri::command]
pub async fn toggle_tray_menu(
    app: AppHandle,
    cursor_x: i32,
    cursor_y: i32,
) -> crate::error::Result<()> {
    toggle_tray_menu_inner(&app, cursor_x, cursor_y).await
}
#[tauri::command]
pub async fn set_tray_menu_size(
    app: AppHandle,
    width: f64,
    height: f64,
) -> crate::error::Result<()> {
    let window = app.get_webview_window("tray_menu").ok_or_else(|| {
        crate::error::OpenClawError::Internal("tray_menu window not found".into())
    })?;

    let scale = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);

    let current_l_size = window
        .inner_size()
        .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
        .unwrap_or((0.0, 0.0));

    let final_l_width = if width == 0.0 {
        current_l_size.0
    } else {
        width
    };
    let final_l_height = height;

    let current_l_pos = window
        .outer_position()
        .map(|p| (p.x as f64 / scale, p.y as f64 / scale))
        .unwrap_or((0.0, 0.0));

    // Adjust y to keep bottom edge anchored (in logical pixels)
    let y_diff = final_l_height - current_l_size.1;
    let new_l_y = current_l_pos.1 - y_diff;

    let _ = window.set_size(tauri::LogicalSize::new(final_l_width, final_l_height));
    let _ = window.set_position(tauri::LogicalPosition::new(current_l_pos.0, new_l_y));

    Ok(())
}
