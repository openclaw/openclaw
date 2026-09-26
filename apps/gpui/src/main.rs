mod assets;
mod gateway;
#[cfg(target_os = "macos")]
mod gateway_menu_macos;
mod gateway_windows;
#[cfg(target_os = "macos")]
mod macos_app_icon;
mod model;
mod ui;
mod web_data_store;

use gpui_kit::{component::input, *};

gpui_kit::actions!(
    openclaw,
    [
        Quit,
        ManageGateways,
        Refresh,
        FocusComposer,
        NewChat,
        ToggleSidebar,
        SearchSessions,
        PreviousSession,
        NextSession,
        Escape,
        CloseWindow,
        MinimizeWindow,
        OpenSettings,
        SystemBusyness,
        SignOutGateway,
        TogglePanels,
        PanelBrowser,
        PanelTerminal,
        PanelWorkspace,
        PanelCompanion,
        PanelTasks,
        PanelDesktop,
        PanelDiscussion,
        PanelDashboard,
        PanelDetail
    ]
);

fn main() {
    env_logger::Builder::from_env(env_logger::Env::new().filter("OPENCLAW_GPUI_LOG"))
        .format_timestamp_millis()
        .init();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("create Gateway runtime");
    let handle = runtime.handle().clone();
    if let Some(code) = probe_access(&runtime) {
        std::process::exit(code);
    }
    #[cfg(target_os = "macos")]
    if let Some(index) = std::env::args().position(|arg| arg == "--web-data-stores") {
        let action = std::env::args().nth(index + 1).unwrap_or_default();
        gpui_kit::application().run(move |cx| web_data_store::maintenance(action, cx));
        return;
    }
    let args: Vec<_> = std::env::args().skip(1).collect();
    let _cli_lock = if args.first().is_some_and(|arg| arg == "gateways")
        && args.get(1).is_none_or(|arg| arg != "list")
    {
        match gateway::profiles::ProfileStore::app_lock() {
            Ok(lock) => Some(lock),
            Err(error) => {
                eprintln!("{}", serde_json::json!({"error": error}));
                std::process::exit(1);
            }
        }
    } else {
        None
    };
    match gateway::cli::run(&args) {
        Ok(Some(value)) => {
            let scopes: Vec<String> = value
                .get("webScopes")
                .and_then(|v| v.as_array())
                .map(|rows| {
                    rows.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            if scopes.is_empty() {
                println!("{value}");
            } else {
                let failed = std::rc::Rc::new(std::cell::Cell::new(false));
                let result_flag = failed.clone();
                gpui_kit::application().run(move |cx| {
                    let executor = cx.background_executor().clone();
                    cx.spawn(async move |cx| {
                        let result = async {
                            web_data_store::remove_scopes(
                                &mut gateway::identity::Identity::load()?,
                                &scopes,
                                &executor,
                            )
                            .await
                        }
                        .await;
                        match result {
                            Ok(()) => println!("{value}"),
                            Err(error) => {
                                result_flag.set(true);
                                eprintln!(
                                    "{}",
                                    serde_json::json!({"error":error,"pendingWebCleanup":true})
                                );
                            }
                        }
                        cx.update(|cx| cx.quit());
                    })
                    .detach();
                });
                if failed.get() {
                    std::process::exit(1);
                }
            }
            return;
        }
        Ok(None) => {}
        Err(error) => {
            eprintln!("{}", serde_json::json!({"error": error}));
            std::process::exit(1);
        }
    }
    let store = match gateway::profiles::ProfileStore::load() {
        Ok(store) => store,
        Err(error) => {
            eprintln!("Could not load saved Gateways: {error}");
            return;
        }
    };
    let _app_lock = match gateway::profiles::ProfileStore::app_lock() {
        Ok(lock) => lock,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    let initial = initial_gateway(&args, &store);
    gpui_kit::application()
        .with_assets(assets::AppAssets)
        .run(move |cx| {
            gpui_kit::init(cx);
            #[cfg(target_os = "macos")]
            macos_app_icon::install();
            ui::init_session_menu_shortcuts(cx);
            if let Err(error) = cx.text_system().add_fonts(vec![
                std::borrow::Cow::Borrowed(include_bytes!(
                    "../assets/fonts/instrument-sans-400.ttf"
                )),
                std::borrow::Cow::Borrowed(include_bytes!(
                    "../assets/fonts/instrument-sans-500.ttf"
                )),
                std::borrow::Cow::Borrowed(include_bytes!(
                    "../assets/fonts/instrument-sans-600.ttf"
                )),
                std::borrow::Cow::Borrowed(include_bytes!(
                    "../assets/fonts/instrument-sans-700.ttf"
                )),
                std::borrow::Cow::Borrowed(include_bytes!(
                    "../assets/fonts/instrument-sans-400-italic.ttf"
                )),
                std::borrow::Cow::Borrowed(include_bytes!(
                    "../assets/fonts/instrument-sans-500-italic.ttf"
                )),
                std::borrow::Cow::Borrowed(include_bytes!(
                    "../assets/fonts/instrument-sans-600-italic.ttf"
                )),
                std::borrow::Cow::Borrowed(include_bytes!(
                    "../assets/fonts/instrument-sans-700-italic.ttf"
                )),
            ]) {
                log::warn!("Could not load Instrument Sans; using the system font: {error}");
            }
            cx.on_action(|_: &Quit, cx| cx.quit());
            cx.on_app_quit(|_| {
                gateway::remote_tunnel::shutdown_all();
                gateway::connection::shutdown_all()
            })
            .detach();
            cx.bind_keys([
                KeyBinding::new("cmd-q", Quit, None),
                KeyBinding::new("cmd-r", Refresh, None),
                KeyBinding::new("cmd-n", NewChat, None),
                KeyBinding::new("cmd-shift-o", NewChat, None),
                KeyBinding::new("up", PreviousSession, Some("SidebarList")),
                KeyBinding::new("down", NextSession, Some("SidebarList")),
                KeyBinding::new("cmd-k", SearchSessions, None),
                KeyBinding::new("cmd-b", ToggleSidebar, None),
                KeyBinding::new("cmd-[", PreviousSession, None),
                KeyBinding::new("cmd-]", NextSession, None),
                KeyBinding::new("escape", Escape, None),
                KeyBinding::new("cmd-w", CloseWindow, None),
                KeyBinding::new("cmd-m", MinimizeWindow, None),
                KeyBinding::new("cmd-shift-,", OpenSettings, None),
                KeyBinding::new("cmd-shift-d", SystemBusyness, None),
                KeyBinding::new("ctrl-`", PanelTerminal, None),
                KeyBinding::new("cmd-shift-b", PanelWorkspace, None),
                KeyBinding::new("cmd-shift-s", PanelCompanion, None),
                KeyBinding::new("cmd-alt-shift-u", PanelBrowser, None),
                KeyBinding::new("cmd-alt-shift-k", PanelTasks, None),
                KeyBinding::new("cmd-alt-shift-d", PanelDesktop, None),
                KeyBinding::new("cmd-alt-shift-j", PanelDiscussion, None),
                KeyBinding::new("cmd-alt-shift-g", PanelDashboard, None),
                KeyBinding::new("cmd-alt-shift-e", PanelDetail, None),
            ]);
            gateway_windows::install(handle, &store, cx);
            match initial {
                Ok((Some(profile), _)) => gateway_windows::open_profile(profile, cx),
                Ok((None, config)) => gateway_windows::open(None, Ok(config), cx),
                Err(error) => gateway_windows::open(None, Err(error), cx),
            }
        });
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
}

fn set_menus(gateways: Menu, cx: &mut App) {
    cx.set_menus([
        Menu::new("OpenClaw").items([
            MenuItem::action("Settings…", OpenSettings),
            MenuItem::action("Sign Out of Gateway…", SignOutGateway),
            MenuItem::separator(),
            MenuItem::action("Quit OpenClaw", Quit),
        ]),
        gateways,
        Menu::new("File").items([
            MenuItem::action("New Chat", NewChat),
            MenuItem::action("Search Conversations…", SearchSessions),
            MenuItem::separator(),
            MenuItem::action("Close Window", CloseWindow),
        ]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", input::Undo, OsAction::Undo),
            MenuItem::os_action("Redo", input::Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", input::Cut, OsAction::Cut),
            MenuItem::os_action("Copy", input::Copy, OsAction::Copy),
            MenuItem::os_action("Paste", input::Paste, OsAction::Paste),
            MenuItem::os_action("Select All", input::SelectAll, OsAction::SelectAll),
        ]),
        Menu::new("View").items([
            MenuItem::action("Toggle Sidebar", ToggleSidebar),
            MenuItem::action("Toggle Panels", TogglePanels),
            MenuItem::action("Browser", PanelBrowser),
            MenuItem::action("Terminal", PanelTerminal),
            MenuItem::action("Files", PanelWorkspace),
            MenuItem::action("Side Chat", PanelCompanion),
            MenuItem::action("Tasks", PanelTasks),
            MenuItem::action("Desktop", PanelDesktop),
            MenuItem::action("Discussion", PanelDiscussion),
            MenuItem::action("Dashboard", PanelDashboard),
            MenuItem::action("Review", PanelDetail),
            MenuItem::action("Refresh", Refresh),
            MenuItem::action("Previous Conversation", PreviousSession),
            MenuItem::action("Next Conversation", NextSession),
        ]),
        Menu::new("Window").items([MenuItem::action("Minimize", MinimizeWindow)]),
    ]);
}

fn initial_gateway(
    args: &[String],
    store: &gateway::profiles::ProfileStore,
) -> Result<
    (
        Option<gateway::profiles::GatewayProfile>,
        gateway::config::ConnectionConfig,
    ),
    String,
> {
    if args
        .first()
        .is_some_and(|arg| arg == "--gateway" || arg.starts_with("--gateway="))
    {
        let name = if let Some((_, name)) = args[0].split_once('=') {
            if args.len() != 1 {
                return Err("Use --gateway NAME_OR_ID without ad-hoc options".into());
            }
            name
        } else {
            if args.len() != 2 {
                return Err("Use --gateway NAME_OR_ID".into());
            }
            &args[1]
        };
        return Ok((Some(store.find(name)?), Default::default()));
    }
    if !args.is_empty() || std::env::var_os("OPENCLAW_GATEWAY_URL").is_some() {
        return Ok((None, gateway::config::load()?));
    }
    if let Some(profile) = store.list().first().cloned() {
        return Ok((Some(profile), Default::default()));
    }
    Ok((None, Default::default()))
}

/// Read-only edge discovery: no app state, browser, credentials, or WebSocket.
fn probe_access(runtime: &tokio::runtime::Runtime) -> Option<i32> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--probe-access") {
        return None;
    }
    let result = (|| {
        let input = args
            .next()
            .ok_or("Usage: openclaw-gpui --probe-access HTTPS_URL")?;
        if args.next().is_some() {
            return Err("Usage: openclaw-gpui --probe-access HTTPS_URL".to_owned());
        }
        let url = gateway::config::normalize_url(&input)?;
        let client = gateway::access::AccessClient::new()?;
        runtime.block_on(client.discover(&url))
    })();
    Some(match result {
        Ok(Some(application)) => {
            println!(
                "{}",
                serde_json::json!({
                    "cloudflareAccess": true,
                    "signatureVerified": true,
                    "origin": application.origin,
                    "audience": application.audience,
                    "issuer": application.issuer,
                })
            );
            0
        }
        Ok(None) => {
            println!("{{\"cloudflareAccess\":false}}");
            0
        }
        Err(message) => {
            eprintln!("{message}");
            1
        }
    })
}
