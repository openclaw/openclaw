// Prevents additional console window on Windows in release
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod commands;
mod gateway;
mod pairing;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_window("main").unwrap();
            window.set_title("OpenClaw - Windows").ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect_gateway,
            commands::disconnect_gateway,
            commands::get_paired_devices,
            commands::send_message,
            commands::start_pairing,
            commands::get_camera_snapshot,
            commands::get_location,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
