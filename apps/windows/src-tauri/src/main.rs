#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::process::{Command, Stdio, Child};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use std::io::{BufReader, BufRead};
use serde::Serialize;
use sysinfo::{ProcessRefreshKind, System};
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
    watchdog_session: Arc<AtomicU32>,
    start_time: Arc<Mutex<Option<Instant>>>,
    sys: Arc<Mutex<System>>,
}

impl GatewayState {
    fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();
        Self {
            process: Arc::new(Mutex::new(None)),
            restart_count: Arc::new(AtomicU32::new(0)),
            last_notification: Arc::new(Mutex::new(None)),
            watchdog_session: Arc::new(AtomicU32::new(0)),
            start_time: Arc::new(Mutex::new(None)),
            sys: Arc::new(Mutex::new(sys)),
        }
    }
}

#[derive(Serialize)]
struct GatewayMetrics {
    online: bool,
    cpu_usage: f32,
    memory_mb: u64,
    total_memory_mb: u64,
    uptime_secs: u64,
    restarts: u32,
}

// Determines the command to launch OpenClaw (handles Tauri-suffixed sidecars)
fn get_openclaw_command() -> (String, Vec<String>) {
    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "i686"
    };

    let target_triples = vec![
        format!("{}-pc-windows-msvc", arch),
        format!("{}-pc-windows-gnu", arch),
    ];
    let legacy_sidecar = "openclaw.exe";
    let fallback_name = "openclaw.cmd";

    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let mut candidates = Vec::new();
            for triple in &target_triples {
                let sidecar_name = format!("openclaw-{}.exe", triple);
                candidates.push(exe_dir.join("binaries").join(&sidecar_name));
                candidates.push(exe_dir.join(&sidecar_name));
            }
            candidates.push(exe_dir.join(legacy_sidecar));

            for sidecar in candidates {
                if sidecar.exists() {
                    let is_self = if let (Ok(s), Ok(c)) = (sidecar.canonicalize(), exe_path.canonicalize()) {
                        s == c
                    } else {
                        false
                    };

                    if !is_self {
                        if let Ok(metadata) = sidecar.metadata() {
                            if metadata.len() > 0 {
                                return (sidecar.to_string_lossy().to_string(), vec![]);
                            }
                        }
                    }
                }
            }
        }
    }
    // Final fallback: hope it's on the system PATH
    (fallback_name.to_string(), vec![])
}

fn get_gateway_port() -> u16 {
    let (program, args_base) = get_openclaw_command();
    let mut args = args_base;
    args.push("config".to_string());
    args.push("get".to_string());
    args.push("gateway.port".to_string());
    
    if let Ok(output) = Command::new(&program).args(&args).output() {
        if output.status.success() {
            if let Ok(port_str) = String::from_utf8(output.stdout) {
                if let Ok(port) = port_str.trim().parse::<u16>() {
                    return port;
                }
            }
        }
    }
    18789
}

#[tauri::command]
fn get_port() -> u16 {
    get_gateway_port()
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
    state.watchdog_session.fetch_add(1, Ordering::SeqCst);
    if let Some(mut child) = state.process.lock().map_err(|e| e.to_string())?.take() {
        match child.kill() {
            Ok(_) => Ok("Gateway stopped".to_string()),
            Err(e) => Err(format!("Stop error: {}", e)),
        }
    } else {
        Err("Gateway is not running".to_string())
    }
}

#[tauri::command]
async fn get_metrics(state: State<'_, GatewayState>) -> Result<GatewayMetrics, String> {
    let mut sys = state.sys.lock().map_err(|e| e.to_string())?;
    let process_lock = state.process.lock().map_err(|e| e.to_string())?;
    
    let mut metrics = GatewayMetrics {
        online: false,
        cpu_usage: 0.0,
        memory_mb: 0,
        total_memory_mb: 0,
        uptime_secs: 0,
        restarts: state.restart_count.load(Ordering::SeqCst),
    };

    if let Some(ref child) = *process_lock {
        let pid = sysinfo::Pid::from(child.id() as usize);
        
        // Refresh only relevant data
        sys.refresh_processes();
        
        if let Some(process) = sys.process(pid) {
            metrics.online = true;
            metrics.cpu_usage = process.cpu_usage();
            metrics.memory_mb = process.memory() / 1024 / 1024;
            metrics.total_memory_mb = sys.total_memory() / 1024 / 1024;
            if let Some(start) = *state.start_time.lock().unwrap() {
                metrics.uptime_secs = start.elapsed().as_secs();
            }
        }
    }
    
    Ok(metrics)
}

#[tauri::command]
fn get_config(key: String) -> Result<String, String> {
    let (program, args_base) = get_openclaw_command();
    let mut args = args_base;
    args.push("config".to_string());
    args.push("get".to_string());
    args.push(key);
    
    let output = Command::new(&program)
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        let val = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(val)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn set_config(key: String, value: String) -> Result<(), String> {
    let (program, args_base) = get_openclaw_command();
    let mut args = args_base;
    args.push("config".to_string());
    args.push("set".to_string());
    args.push(key);
    args.push(value);
    
    let output = Command::new(&program)
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn is_autostart_enabled() -> bool {
    let run_path = "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run"; // Use HKCU for easier access
    let output = Command::new("powershell")
        .args(&["-NoProfile", "-Command", &format!("Get-ItemProperty -Path '{}' -Name 'OpenClaw' -ErrorAction SilentlyContinue", run_path)])
        .output();
    
    match output {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

#[tauri::command]
fn toggle_autostart(enabled: bool) -> Result<(), String> {
    let run_path = "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
    let exe_path = env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().to_string();
    
    let command = if enabled {
        format!("Set-ItemProperty -Path '{}' -Name 'OpenClaw' -Value '\"{}\"'", run_path, exe_path)
    } else {
        format!("Remove-ItemProperty -Path '{}' -Name 'OpenClaw' -ErrorAction SilentlyContinue", run_path)
    };

    let output = Command::new("powershell")
        .args(&["-NoProfile", "-Command", &command])
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

fn drain_stream<R: std::io::Read + Send + 'static>(app: AppHandle, stream: R, prefix: &'static str, is_error: bool) {
    let thread_name = format!("drain-{}", prefix.to_lowercase().replace(':', ""));
    let _ = thread::Builder::new()
        .name(thread_name)
        .spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        let log_entry = format!("[{}] {}", prefix, l);
                        if is_error {
                            log::warn!("{}", log_entry);
                        } else {
                            log::info!("{}", log_entry);
                        }
                        // Emit to frontend
                        let _ = app.emit_all("gateway-log", l);
                    }
                    Err(e) => log::trace!("Stream error for {}: {}", prefix, e),
                }
            }
        });
}

fn spawn_gateway(app: AppHandle, state: GatewayState) -> Result<String, String> {
    let (program, args_base) = get_openclaw_command();
    let mut args = args_base;
    args.push("gateway".to_string());
    args.push("run".to_string());
    args.push("--allow-unconfigured".to_string());
    
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    
    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;
    
    if let Some(stdout) = child.stdout.take() {
        drain_stream(app.clone(), stdout, "STDOUT:", false);
    }
    if let Some(stderr) = child.stderr.take() {
        drain_stream(app.clone(), stderr, "STDERR:", true);
    }

    let mut process_guard = state.process.lock().map_err(|e| e.to_string())?;
    *process_guard = Some(child);

    // Set start time while holding process lock (matching the lock order in get_metrics)
    if let Ok(mut start) = state.start_time.lock() {
        *start = Some(Instant::now());
    }
    let session_id = state.watchdog_session.fetch_add(1, Ordering::SeqCst) + 1;
    
    let state_clone = state.clone();
    let app_clone = app.clone();
    
    thread::spawn(move || {
        watchdog_thread(app_clone, state_clone, session_id);
    });
    
    Ok("Gateway started with Watchdog protection".into())
}

// ... rest of main.rs including watchdog_thread, get_port, start_gateway, stop_gateway, main ...

fn watchdog_thread(app: AppHandle, state: GatewayState, session_id: u32) {
    let max_restarts = 3;
    let mut last_start = Instant::now();
    
    loop {
        thread::sleep(Duration::from_secs(5));
        
        // Refresh metrics in background so they are ready for the dashboard
        if let Ok(mut sys) = state.sys.lock() {
            sys.refresh_cpu();
            sys.refresh_processes();
        }

        if state.watchdog_session.load(Ordering::SeqCst) != session_id {
            break; // Retiring: A new session has taken over or the process was legally stopped
        }
        
        // Stability reset: if running for more than 120 seconds, reset the budget
        if last_start.elapsed() > Duration::from_secs(120) {
            state.restart_count.store(0, Ordering::SeqCst);
        }
        
        // HTTP Readiness Probe
        let port = get_gateway_port();
        let _ = ureq::get(&format!("http://localhost:{}/health", port)).timeout(Duration::from_secs(2)).call();
        
        let (needs_restart, exit_code) = {
            let mut process_lock = match state.process.lock() {
                Ok(guard) => guard,
                Err(_) => break, // Poisoned
            };

            match *process_lock {
                Some(ref mut child) => match child.try_wait() {
                    Ok(Some(status)) => (true, status.code()),
                    Ok(None) => (false, None),
                    Err(_) => (true, None),
                },
                None => (true, None),
            }
        };

        if needs_restart {
            let count = state.restart_count.fetch_add(1, Ordering::SeqCst) + 1;

            if count > max_restarts {
                show_notification(&app, "OpenClaw Gateway",
                    "Critical error. Gateway crashed multiple times. Manual restart required.");
                if let Ok(mut final_lock) = state.process.lock() {
                    let _ = final_lock.take();
                }
                break;
            }

            if let Some(code) = exit_code {
                log::error!("Gateway exited with code {:?}. Restart attempt {}/{}", code, count, max_restarts);
            } else {
                log::error!("Gateway is not running. Restart attempt {}/{}", count, max_restarts);
            }

            // Exponential backoff
            thread::sleep(Duration::from_secs(5 * (1 << (count - 1))));
            last_start = Instant::now();
            if let Err(e) = spawn_gateway(app.clone(), state.clone()) {
                log::error!("Restart failed: {}", e);
                show_notification(&app, "Restart Error", &format!("Failed to restart gateway: {}", e));
                continue;
            }
            break; // New watchdog session created by spawn_gateway, this one can retire
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
        .invoke_handler(tauri::generate_handler![
            start_gateway, 
            stop_gateway, 
            get_port, 
            get_metrics,
            get_config,
            set_config,
            is_autostart_enabled,
            toggle_autostart
        ])
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
