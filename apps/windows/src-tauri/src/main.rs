#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::process::{Command, Stdio, Child};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Manager, State, SystemTray, SystemTrayEvent, CustomMenuItem, SystemTrayMenu, SystemTrayMenuItem
};
use tauri::api::notification::Notification;

// Import Windows-specific command extensions for creation_flags
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// State must be Clone for thread safety (Arc provides 'static lifetime)
#[derive(Clone)]
struct GatewayState {
    process: Arc<Mutex<Option<Child>>>,
    restart_count: Arc<AtomicU32>,
    last_notification: Arc<Mutex<Option<Instant>>>,
}

impl GatewayState {
    fn new() -> Self {
        Self {
            process: Arc::new(Mutex::new(None)),
            restart_count: Arc::new(AtomicU32::new(0)),
            last_notification: Arc::new(Mutex::new(None)),
        }
    }
}

/// Determines the command to launch OpenClaw
fn get_openclaw_command() -> (String, Vec<String>) {
    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let sidecar = exe_dir.join("openclaw.exe");
            if sidecar.exists() {
                return (sidecar.to_string_lossy().to_string(), vec![]);
            }
        }
    }
    ("cmd".to_string(), vec!["/C".to_string(), "openclaw".to_string()])
}

#[tauri::command]
async fn start_gateway(app: AppHandle, state: State<'_, GatewayState>) -> Result<String, String> {
    state.restart_count.store(0, Ordering::SeqCst);
    spawn_gateway(app, state.inner().clone())
}

#[tauri::command]
async fn stop_gateway(state: State<'_, GatewayState>) -> Result<String, String> {
    if let Some(mut child) = state.process.lock().map_err(|e| e.to_string())?.take() {
        match child.kill() {
            Ok(_) => Ok("Gateway stopped".to_string()),
            Err(e) => Err(format!("Stop error: {}", e)),
        }
    } else {
        Err("Gateway is not running".to_string())
    }
}

fn spawn_gateway(app: AppHandle, state: GatewayState) -> Result<String, String> {
    let (program, args_base) = get_openclaw_command();
    let mut args = args_base;
    args.push("gateway".to_string());
    args.push("run".to_string());
    
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    
    let child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;
    
    *state.process.lock().map_err(|e| e.to_string())? = Some(child);
    
    let state_clone = state.clone();
    let app_clone = app.clone();
    
    thread::spawn(move || {
        watchdog_thread(app_clone, state_clone);
    });
    
    Ok("Gateway started with Watchdog protection".into())
}

fn watchdog_thread(app: AppHandle, state: GatewayState) {
    let max_restarts = 3;
    
    loop {
        thread::sleep(Duration::from_secs(5));
        
        // Locking to check status
        let mut process_lock = match state.process.lock() {
            Ok(guard) => guard,
            Err(_) => break, // Poisoned
        };
        
        if let Some(ref mut child) = *process_lock {
            match child.try_wait() {
                Ok(Some(status)) => {
                    // Process exited unexpectedly
                    drop(process_lock);
                    
                    let _code = status.code().unwrap_or(-1);
                    let count = state.restart_count.fetch_add(1, Ordering::SeqCst) + 1;
                    
                    if count >= max_restarts {
                        show_notification(&app, "OpenClaw Gateway", 
                            "Critical error. Manual restart required.");
                        break;
                    }
                    
                    // Exponential backoff
                    thread::sleep(Duration::from_secs(5 * (1 << (count - 1))));
                    
                    if let Err(e) = spawn_gateway(app.clone(), state.clone()) {
                        eprintln!("Restart failed: {}", e);
                    }
                    break; 
                }
                Ok(None) => {} // Still running
                Err(_) => break,
            }
        } else {
            // state.process is None, which means it was stopped manually
            break; 
        }
    }
}

fn show_notification(app: &AppHandle, title: &str, body: &str) {
    if let Some(state) = app.try_state::<GatewayState>() {
        let mut last = state.last_notification.lock().unwrap();
        
        // Throttling: no more than once every 5 minutes
        if last.map_or(true, |t| t.elapsed() > Duration::from_secs(300)) {
            *last = Some(Instant::now());
            drop(last);
            
            let identifier = &app.config().tauri.bundle.identifier;
            let _ = Notification::new(identifier)
                .title(title)
                .body(body)
                .show();
        }
    }
}

fn handle_uninstall() {
    println!("Cleaning up OpenClaw data from AppData...");
    if let Some(data_dir) = dirs::data_dir() {
        let app_data = data_dir.join("com.openclaw.gateway");
        if app_data.exists() {
            let _ = std::fs::remove_dir_all(&app_data);
        }
    }
    if let Some(local_data) = dirs::data_local_dir() {
        let cache_dir = local_data.join("com.openclaw.gateway");
        if cache_dir.exists() {
            let _ = std::fs::remove_dir_all(&cache_dir);
        }
    }
    std::process::exit(0);
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.contains(&"--uninstall".to_string()) || args.contains(&"-u".to_string()) {
        handle_uninstall();
    }
    
    let quit = CustomMenuItem::new("quit".to_string(), "Quit");
    let show = CustomMenuItem::new("show".to_string(), "Show Window");
    let tray_menu = SystemTrayMenu::new()
        .add_item(show)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);

    tauri::Builder::default()
        .manage(GatewayState::new())
        .invoke_handler(tauri::generate_handler![start_gateway, stop_gateway])
        .system_tray(SystemTray::new().with_menu(tray_menu))
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::LeftClick { .. } => {
                if let Some(window) = app.get_window("main") {
                    window.show().unwrap();
                    window.set_focus().unwrap();
                }
            }
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "quit" => {
                    if let Ok(mut state) = app.state::<GatewayState>().process.lock() {
                        if let Some(child) = state.as_mut() {
                            let _ = child.kill();
                        }
                    }
                    std::process::exit(0);
                }
                "show" => {
                    if let Some(window) = app.get_window("main") {
                        window.show().unwrap();
                        window.set_focus().unwrap();
                    }
                }
                _ => {}
            },
            _ => {}
        })
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                event.window().hide().unwrap();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
