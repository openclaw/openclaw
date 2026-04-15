#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::process::{Command, Stdio, Child};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use std::io::{BufReader, BufRead};
use tauri::{
    AppHandle, Manager, State, SystemTray, SystemTrayEvent, CustomMenuItem, SystemTrayMenu, SystemTrayMenuItem
};
use tauri::api::notification::Notification;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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

// Determines the command to launch OpenClaw (binary directly, no cmd /C)
fn get_openclaw_command() -> (String, Vec<String>) {
    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let sidecar = exe_dir.join("openclaw.exe");
            // Validate sidecar exists and is > 0 bytes (not just a placeholder)
            if sidecar.exists() {
                if let Ok(metadata) = sidecar.metadata() {
                    if metadata.len() > 0 {
                        return (sidecar.to_string_lossy().to_string(), vec![]);
                    }
                }
            }
        }
    }
    // Fallback: direct binary invocation
    ("openclaw".to_string(), vec![])
}

#[tauri::command]
async fn start_gateway(app: AppHandle, state: State<'_, GatewayState>) -> Result<String, String> {
    {
        let process_lock = state.process.lock().map_err(|e| e.to_string())?;
        if process_lock.is_some() {
            return Err("Gateway is already running".to_string());
        }
    }
    state.restart_count.store(0, Ordering::SeqCst);
    if let Err(e) = spawn_gateway(app.clone(), state.inner().clone()) {
        show_notification(&app, "Gateway Error", &format!("Failed to start gateway: {}", e));
        return Err(e);
    }
    Ok("Gateway started with Watchdog protection".into())
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

fn drain_stream<R: std::io::Read + Send + 'static>(stream: R, prefix: &'static str) {
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            if let Ok(line) = line {
                log::info!("[OUT] {} {}", prefix, line);
            }
        }
    });
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
    
    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;
    
    // Actively drain stdout and stderr to prevent OS buffer full hanging
    if let Some(stdout) = child.stdout.take() {
        drain_stream(stdout, "STDOUT:");
    }
    if let Some(stderr) = child.stderr.take() {
        drain_stream(stderr, "STDERR:");
    }
    
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
    let mut last_start = Instant::now();
    
    loop {
        thread::sleep(Duration::from_secs(5));
        
        // Stability reset: if running for more than 120 seconds, reset the budget
        if last_start.elapsed() > Duration::from_secs(120) {
            state.restart_count.store(0, Ordering::SeqCst);
        }
        
        // HTTP Readiness Probe
        let _ = ureq::get("http://localhost:18789/health").timeout(Duration::from_secs(2)).call();
        
        let mut process_lock = match state.process.lock() {
            Ok(guard) => guard,
            Err(_) => break, // Poisoned
        };
        
        if let Some(ref mut child) = *process_lock {
            match child.try_wait() {
                Ok(Some(status)) => {
                    // Process exited unexpectedly
                    drop(process_lock);
                    
                    let count = state.restart_count.fetch_add(1, Ordering::SeqCst) + 1;
                    
                    if count > max_restarts {
                        show_notification(&app, "OpenClaw Gateway", 
                            "Critical error. Gateway crashed multiple times. Manual restart required.");
                        break;
                    }
                    
                    log::error!("Gateway exited with code {:?}. Restart attempt {}/{}", status.code(), count, max_restarts);
                    
                    // Exponential backoff
                    thread::sleep(Duration::from_secs(5 * (1 << (count - 1))));
                    last_start = Instant::now();
                    if let Err(e) = spawn_gateway(app.clone(), state.clone()) {
                        log::error!("Restart failed: {}", e);
                        show_notification(&app, "Restart Error", &format!("Failed to restart gateway: {}", e));
                        continue;
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

fn setup_logging() -> Result<(), fern::InitError> {
    let mut log_dir = std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_owned()));
    log_dir.push("OpenClaw");
    log_dir.push("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    
    fern::Dispatch::new()
        .format(|out, message, record| {
            out.finish(format_args!(
                "[{} {}] {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                record.level(),
                message
            ))
        })
        .level(log::LevelFilter::Info)
        .chain(std::io::stdout())
        .chain(fern::log_file(log_dir.join("watchdog.log"))?)
        .apply()?;
        
    Ok(())
}

fn handle_uninstall() {
    println!("Cleaning up OpenClaw data from AppData...");
    if let Some(data_dir) = dirs::data_dir() {
        let app_data = data_dir.join("com.openclaw.desktop");
        if app_data.exists() {
            let _ = std::fs::remove_dir_all(&app_data);
        }
    }
    if let Some(local_data) = dirs::data_local_dir() {
        let cache_dir = local_data.join("com.openclaw.desktop");
        if cache_dir.exists() {
            let _ = std::fs::remove_dir_all(&cache_dir);
        }
    }
    // Remove Run registry key
    let _ = Command::new("powershell")
        .args(&["-NoProfile", "-Command", "Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'OpenClaw' -ErrorAction SilentlyContinue"])
        .output();
    std::process::exit(0);
}

fn main() {
    let _ = setup_logging();
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
        .setup(|app| {
            let state = app.state::<GatewayState>();
            // Auto-boot
            let _ = spawn_gateway(app.handle(), state.inner().clone());
            Ok(())
        })
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
                    log::info!("Quitting OpenClaw Desktop");
                    if let Ok(mut state) = app.state::<GatewayState>().process.lock() {
                        if let Some(mut child) = state.take() {
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
