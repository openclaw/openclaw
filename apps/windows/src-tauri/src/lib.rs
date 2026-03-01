use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

pub mod error;
mod gateway;
mod models;
pub mod providers;
mod screens;
pub mod services;

struct AppState {
    is_quitting: AtomicBool,
    _log_guard: tracing_appender::non_blocking::WorkerGuard,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_frame::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            let log_dir = app.path().app_log_dir().expect("failed to get log dir");
            std::fs::create_dir_all(&log_dir).expect("failed to create log dir");

            let file_appender =
                tracing_appender::rolling::daily(log_dir.clone(), "openclaw.log");
            let (non_blocking, log_guard) = tracing_appender::non_blocking(file_appender);

            let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                EnvFilter::new(
                    "info,openclaw_windows_lib::services::voice_wake=debug,openclaw_windows_lib::providers::speech=debug",
                )
            });

            tracing_subscriber::registry()
                .with(env_filter)
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(non_blocking)
                        .with_ansi(false),
                )
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(std::io::stderr)
                        .with_ansi(true),
                )
                .init();
            tracing::info!("Logger initialized at {}", log_dir.display());

            // Keep log_guard in app state so buffered logs flush on shutdown.
            app.manage(AppState {
                is_quitting: AtomicBool::new(false),
                _log_guard: log_guard,
            });

            let events = Arc::new(services::EventDispatcher::new(app.handle().clone()));
            let exec_approvals_service =
                Arc::new(services::ExecApprovalsService::new(app.handle().clone()));

            let system_provider = Arc::new(providers::system::RealSystemProvider);
            let system_service = Arc::new(services::system::SystemService::new(system_provider));
            let config_provider = Box::new(providers::config::JsonConfigProvider);
            let config_service = Arc::new(services::ConfigService::new(
                app.handle().clone(),
                config_provider,
            ));
            let wsl_provider: Arc<dyn providers::WslProvider> =
                Arc::new(providers::wsl::RealWslProvider);
            let install_service = Arc::new(services::WslInstallService::new(
                wsl_provider.clone(),
                events.clone(),
            ));
            let gateway_service = Arc::new(services::GatewayService::new(
                config_service.clone(),
                events.clone(),
            ));

            let discovery_service = Arc::new(services::discovery::DiscoveryService::new());
             let media_provider = Arc::new(providers::media::RealMediaProvider);
            let media_service = Arc::new(services::media::MediaService::new(media_provider));

            let audio_provider = Arc::new(providers::audio::RealAudioProvider);
            let talk_service = Arc::new(services::talk::TalkService::new(audio_provider));

            let speech_provider = Arc::new(providers::speech::WindowsSpeechProvider::new());
            let voice_wake_service = Arc::new(services::VoiceWakeService::new(
                speech_provider,
                gateway_service.clone(),
                config_service.clone(),
            ));
            let gateway_watcher_service = Arc::new(services::GatewayWatcherService::new(
                config_service.clone(),
                wsl_provider.clone(),
            ));

            app.manage(wsl_provider.clone());
            app.manage(services::install_handlers::InstallerState(Arc::new(
                tokio::sync::Mutex::new(None),
            )));
            app.manage(events);
            app.manage(system_service);
            app.manage(config_service.clone());
            app.manage(install_service);
            app.manage(gateway_service.clone());
            app.manage(exec_approvals_service.clone());
            app.manage(media_service.clone());
            app.manage(talk_service.clone());
            app.manage(voice_wake_service.clone());
            app.manage(discovery_service.clone());
            app.manage(gateway_watcher_service.clone());

            let runtime_manager = services::runtime::RuntimeManager::new(app.handle().clone());

            let rm = runtime_manager.clone();
            let rm2 = runtime_manager.clone();
            let rm3 = runtime_manager.clone();
            let rm4 = runtime_manager.clone();
            let rm5 = runtime_manager.clone();
            let rm6 = runtime_manager.clone();

            tauri::async_runtime::block_on(async move {
                let _ = rm.register(media_service).await;
                let _ = rm2.register(talk_service).await;
                let _ = rm3
                    .register(discovery_service)
                    .await;
                let _ = rm4.register(gateway_service).await;
                let _ = rm5.register(voice_wake_service).await;
                let _ = rm6.register(gateway_watcher_service).await;
            });

            app.manage(runtime_manager);
            // Keep a simple fallback tray menu with a quit action.
            let quit_i = MenuItem::with_id(app, "quit", "Quit OpenClaw", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit_i])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        let state = app.state::<AppState>();
                        state.is_quitting.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // Left click toggles the custom tray popup window.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        let app = tray.app_handle().clone();
                        let x = position.x as i32;
                        let y = position.y as i32;
                        tauri::async_runtime::spawn(async move {
                            let _ = services::tray_menu::toggle_tray_menu_inner(&app, x, y).await;
                        });
                    }
                })
                .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
                    tracing::warn!("Default window icon not found, using empty fallback");
                    tauri::image::Image::new(&[], 0, 0)
                }))
                .build(app)?;

            let startup_config = tauri::async_runtime::block_on(async {
                config_service.load().await.ok()
            });
            let is_setup_completed = startup_config
                .as_ref()
                .map(|c| c.is_setup_completed)
                .unwrap_or(false);

            if !is_setup_completed {
                screens::setup::open(app.handle());
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            gateway::discovery::start_discovery,
            gateway::discovery::stop_discovery,
            gateway::client::connect_gateway,
            gateway::openclaw_config::get_gateway_token,
            gateway::openclaw_config::read_openclaw_config,
            gateway::client::get_gateway_status,
            gateway::client::gateway_request,
            services::media::start_screen_capture,
            services::media::stop_screen_capture,
            services::talk::set_talk_mode_enabled,
            services::talk::get_talk_mode_status,
            services::voice_wake::set_voice_wake_enabled,
            services::voice_wake::get_voice_wake_settings,
            services::voice_wake::set_voice_wake_triggers,
            services::voice_wake::get_voice_wake_hardware,
            services::voice_wake::set_voice_wake_hardware,
            services::voice_wake::set_voice_wake_additional_locales,
            services::voice_wake::set_voice_wake_chimes,
            services::voice_wake::set_voice_wake_session_key,
            services::voice_wake::set_voice_wake_ptt,
            services::voice_wake::voice_overlay_send,
            services::voice_wake::voice_overlay_dismiss,
            screens::setup::mark_setup_completed,
            services::system::get_accent_color,
            services::system::run_onboarding_terminal,
            services::system::kill_terminal_command,
            services::system::write_terminal_stdin,
            services::system::resize_terminal,
            services::tray_menu::get_tray_status,
            services::tray_menu::toggle_tray_menu,
            services::tray_menu::set_tray_menu_size,
            services::install_handlers::check_wsl_status,
            services::install_handlers::check_systemd_status,
            services::install_handlers::get_wsl_distro,
            services::install_handlers::install_wsl,
            services::install_handlers::install_openclaw,
            services::install_handlers::abort_installation,
            screens::settings::open_settings,
            screens::dashboard::open_dashboard,
            services::settings::get_full_config,
            services::settings::save_general_settings,
            services::settings::get_log_path,
            services::settings::get_gateway_health,
            services::settings::test_remote_connection,
            services::settings::get_openclaw_json,
            services::settings::save_openclaw_json,
            services::settings::get_config_schema,
            services::settings::get_channels,
            services::settings::set_channel_api_key,
            services::settings::channels_whatsapp_login_start,
            services::settings::channels_whatsapp_login_wait,
            services::settings::channels_logout,
            services::instances::get_instances,
            services::sessions::get_sessions,
            services::skills::get_skills,
            services::skills::set_skill_enabled,
            services::skills::set_skill_env,
            services::skills::install_skill,
            services::cron::get_cron_jobs,
            services::cron::get_cron_status,
            services::cron::save_cron_job,
            services::cron::delete_cron_job,
            services::cron::get_cron_runs,
            services::cron::run_cron_job,
            services::cron::set_cron_job_enabled,
            services::cron::get_cron_transcript,
            services::permissions::get_permissions_status,
            services::permissions::open_windows_permission,
            services::settings::get_build_info,
            services::settings::clear_artifact_cache,
            services::settings::reset_setup,
            services::exec_approvals::resolve_exec_approval_handler,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<AppState>();
                if !state.is_quitting.load(Ordering::SeqCst) {
                    // Closing windows should not terminate the tray app.
                    api.prevent_exit();
                } else {
                    // Full quit path: stop background services before exit.
                    let runtime_manager = app.state::<services::runtime::RuntimeManager>();
                    let rt = runtime_manager.inner().clone();
                    tauri::async_runtime::block_on(async move {
                        rt.stop_all().await;
                    });

                    // Ensure spawned terminal processes are cleaned up.
                    let system_service = app.state::<Arc<services::system::SystemService>>();
                    tauri::async_runtime::block_on(async move {
                        system_service.kill_all().await;
                    });
                }
            }
        });
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    state.is_quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}
