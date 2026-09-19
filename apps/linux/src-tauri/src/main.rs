mod chrome_setup;
mod cli;
#[cfg(target_os = "linux")]
mod desktop_bridge;
mod discovery;
mod gateway;
mod gateway_device_identity;
mod gateway_operation_queue;
mod gateway_profiles;
#[cfg(any(target_os = "linux", test))]
mod gateway_sleep;
#[cfg(target_os = "linux")]
mod gateway_sleep_logind;
#[cfg(target_os = "linux")]
mod gateway_sleep_logind_listener;
mod gateway_windows;
mod gateway_ws;
mod installer;
mod native_browser;
mod native_browser_bridge;
mod native_browser_platform;
mod notify;
mod pending_approvals;
mod quickchat;
mod quickchat_widgets;
mod remote_gateway;
mod tray;
mod updater;
mod window_chrome;
#[cfg(target_os = "linux")]
mod window_chrome_linux;
#[cfg(target_os = "macos")]
mod window_chrome_macos;

use cli::{CliError, OpenClawCli};
use gateway::{GatewayAction, GatewaySnapshot, ReadyGateway};
use gateway_operation_queue::{GatewayOperation, GatewayOperationQueue};
use installer::InstallChannel;
use remote_gateway::{RemoteConnectionSource, RemoteGatewayRequest, TunnelRoute};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, State, Url, Webview, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{Code, Modifiers};
use tauri_plugin_opener::OpenerExt;

const CONNECTED_WATCH_INTERVAL: Duration = Duration::from_secs(15);
const RECONNECT_INTERVAL: Duration = Duration::from_secs(3);
fn external_browser_url_allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.has_host()
        && url.username().is_empty()
        && url.password().is_none()
}

pub(crate) fn native_auth_initialization_script(
    dashboard: &Url,
    gateway: &Url,
    request: &RemoteGatewayRequest,
) -> Result<String, String> {
    if request.transport == "direct" && request.tls_fingerprint.is_some() {
        return Err(
            "The desktop dashboard cannot securely verify a pinned Gateway TLS certificate. \
             Connect using Remote over SSH instead."
                .to_string(),
        );
    }
    let path = dashboard.path().trim_end_matches('/');
    let origin = serde_json::to_string(&dashboard.origin().ascii_serialization())
        .map_err(|_| "Could not prepare secure Gateway authentication.".to_string())?;
    let path = serde_json::to_string(if path.is_empty() { "/" } else { path })
        .map_err(|_| "Could not prepare secure Gateway authentication.".to_string())?;
    let auth = serde_json::json!({
        "gatewayUrl": gateway.as_str(),
        "token": request.token,
        "password": request.password,
    });
    let auth = serde_json::to_string(&auth)
        .map_err(|_| "Could not prepare secure Gateway authentication.".to_string())?;
    Ok(format!(
        r#"(() => {{
  try {{
    if (location.origin !== {origin}) return;
    const base = {path};
    if (base !== "/" && location.pathname !== base && !location.pathname.startsWith(`${{base}}/`)) return;
    Object.defineProperty(window, "__OPENCLAW_NATIVE_CONTROL_AUTH__", {{
      value: {auth},
      configurable: true,
    }});
  }} catch {{}}
}})();"#
    ))
}

fn remote_ws_config(
    request: &RemoteGatewayRequest,
    gateway_url: &Url,
) -> gateway_ws::GatewayWsConfig {
    gateway_ws::GatewayWsConfig::new(
        gateway_url.to_string(),
        request.token.clone(),
        request.password.clone(),
        if gateway_url.scheme() == "wss" {
            request.tls_fingerprint.clone()
        } else {
            None
        },
        gateway_ws::GatewayOwnership::Remote,
    )
}

fn open_external_browser(app: &AppHandle, url: &Url) {
    if external_browser_url_allowed(url)
        && app.opener().open_url(url.as_str(), None::<&str>).is_err()
    {
        eprintln!("Could not open the external sign-in page.");
    }
}

fn is_active_onboarding_url(url: &Url) -> bool {
    let path = url.path().trim_end_matches('/');
    let query_key = if path.ends_with("/settings/model-setup") {
        "firstRun"
    } else if path.ends_with("/custodian") {
        "onboarding"
    } else {
        return false;
    };
    url.query_pairs()
        .find(|(key, _)| key == query_key)
        .is_some_and(|(_, value)| {
            if query_key == "firstRun" {
                return value == "1" || value == "explicit";
            }
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildInfo {
    version: String,
    release_build: bool,
    platform: &'static str,
}

fn is_release_version(version: &str) -> bool {
    // The committed 0.1.0 version identifies branch builds; release builds are stamped by CI.
    version != "0.1.0"
}

// The openclaw:// URL contract is deliberately tiny and handled entirely in
// Rust: `openclaw://dashboard` opens/connects the dashboard; anything else
// just focuses the app. New routes are added to this enum — the renderer
// (which is often navigated away to the remote dashboard) never sees URLs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DeepLinkRoute {
    Dashboard,
    FocusOnly,
}

fn deep_link_route(url: &Url) -> DeepLinkRoute {
    if url.scheme() == "openclaw" && url.host_str() == Some("dashboard") {
        DeepLinkRoute::Dashboard
    } else {
        DeepLinkRoute::FocusOnly
    }
}

fn handle_deep_links(app: &AppHandle, urls: Vec<Url>) {
    for url in urls {
        match deep_link_route(&url) {
            DeepLinkRoute::Dashboard => {
                tray::open_dashboard(app);
            }
            DeepLinkRoute::FocusOnly => tray::show_window(app),
        }
    }
}

#[cfg(test)]
mod deep_link_tests {
    use super::{deep_link_route, DeepLinkRoute, Url};

    #[test]
    fn dashboard_route_matches_only_the_openclaw_dashboard_host() {
        let dashboard = Url::parse("openclaw://dashboard/ignored?source=test").unwrap();
        let other = Url::parse("openclaw://settings/dashboard").unwrap();
        let other_scheme = Url::parse("https://dashboard/").unwrap();

        assert_eq!(deep_link_route(&dashboard), DeepLinkRoute::Dashboard);
        assert_eq!(deep_link_route(&other), DeepLinkRoute::FocusOnly);
        assert_eq!(deep_link_route(&other_scheme), DeepLinkRoute::FocusOnly);
    }
}

#[cfg(test)]
mod native_browser_tests {
    use super::{
        external_browser_url_allowed, native_auth_initialization_script, RemoteGatewayRequest, Url,
    };
    use std::process::Command;

    #[test]
    fn oauth_browser_accepts_http_urls_but_never_unsafe_schemes_or_userinfo() {
        for (candidate, allowed) in [
            (
                "https://auth.openai.com/oauth/authorize?state=fixture",
                true,
            ),
            ("http://127.0.0.1:1455/auth/callback", true),
            ("file:///etc/passwd", false),
            ("javascript:alert(1)", false),
            ("data:text/html,fixture", false),
            ("openclaw://dashboard", false),
        ] {
            assert_eq!(
                external_browser_url_allowed(&Url::parse(candidate).expect("URL")),
                allowed,
                "unexpected external-browser decision for {candidate}"
            );
        }
        let userinfo = ["operator", "fixture"].join(":");
        let credentialed = format!("https://{userinfo}@gateway.example.com");
        assert!(!external_browser_url_allowed(
            &Url::parse(&credentialed).expect("credentialed URL")
        ));
    }

    #[test]
    fn native_password_handoff_is_origin_scoped_and_consumed_before_page_code() {
        let request = RemoteGatewayRequest {
            transport: "direct".to_string(),
            url: Some("https://gateway.example.com/openclaw".to_string()),
            ssh_target: None,
            token: None,
            password: Some("fixture-password".to_string()),
            remote_port: None,
            tls_fingerprint: None,
        };
        let dashboard = Url::parse("https://gateway.example.com/openclaw").expect("dashboard");
        let gateway = Url::parse("wss://gateway.example.com/openclaw").expect("Gateway");
        let initialization_script =
            native_auth_initialization_script(&dashboard, &gateway, &request).expect("auth script");
        assert!(!dashboard.as_str().contains("fixture-password"));
        assert!(!gateway.as_str().contains("fixture-password"));

        let runner = r#"
            const init = new Function('window', 'location', process.argv[1]);
            const cases = [
              ['https://gateway.example.com', '/openclaw', true],
              ['https://gateway.example.com', '/openclaw/settings/model-setup', true],
              ['https://attacker.example.com', '/openclaw', false],
              ['https://gateway.example.com', '/openclaw-other', false],
              ['https://gateway.example.com', '/other', false],
            ];
            for (const [origin, pathname, allowed] of cases) {
              const window = {};
              init(window, {origin, pathname});
              const auth = window.__OPENCLAW_NATIVE_CONTROL_AUTH__;
              if (Boolean(auth) !== allowed) throw new Error('origin/path policy failed');
              if (allowed && (auth.gatewayUrl !== 'wss://gateway.example.com/openclaw' || auth.password !== 'fixture-password')) {
                throw new Error('native password was not delivered');
              }
            }
        "#;
        let output = Command::new("node")
            .args(["-e", runner, &initialization_script])
            .output()
            .expect("Node is required by the OpenClaw workspace");
        assert!(
            output.status.success(),
            "native auth handoff failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn pinned_remote_gateway_never_receives_credentials_through_an_unpinned_webview() {
        let request: RemoteGatewayRequest = serde_json::from_value(serde_json::json!({
            "transport": "direct",
            "url": "https://gateway.example.com/openclaw",
            "token": "fixture-token",
            "tlsFingerprint": "ab".repeat(32),
        }))
        .expect("pinned remote request");
        let dashboard = Url::parse("https://gateway.example.com/openclaw").expect("dashboard");
        let gateway = Url::parse("wss://gateway.example.com/openclaw").expect("Gateway");
        let result = native_auth_initialization_script(&dashboard, &gateway, &request);

        assert!(
            result.is_err(),
            "a certificate-pinned Gateway must never receive credentials through an unpinned WebView"
        );
        assert!(
            result
                .err()
                .expect("rejected pin")
                .contains("Remote over SSH"),
            "the rejection must explain the secure supported transport"
        );

        let mut tunneled = request;
        tunneled.transport = "ssh".to_string();
        let tunneled_dashboard = Url::parse("http://127.0.0.1:18789").expect("tunneled dashboard");
        let tunneled_gateway = Url::parse("ws://127.0.0.1:18789").expect("tunneled Gateway");
        assert!(
            native_auth_initialization_script(&tunneled_dashboard, &tunneled_gateway, &tunneled)
                .is_ok(),
            "host-key-verified SSH tunneling must remain available"
        );
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum SettingsReturnTarget {
    Local(Url),
    Remote(Url),
    SavedGateway,
}

struct SettingsReturn {
    generation: u64,
    target: SettingsReturnTarget,
    failure: Option<GatewaySnapshot>,
}

#[derive(Default)]
struct NavigationState {
    // Navigation commits run on the main thread; workers only prepare connections.
    remote_dashboard: bool,
    watch_generation: u64,
    retired_preparation: Option<u64>,
    onboarding_pending: bool,
    remote_snapshot: Option<GatewaySnapshot>,
    settings_return: Option<SettingsReturn>,
    #[cfg(target_os = "linux")]
    remote_presentation_generation: Option<u64>,
}

impl NavigationState {
    fn remote_page_is_current(&self, generation: u64) -> bool {
        self.remote_dashboard
            && self.watch_generation == generation
            && self.settings_return.is_none()
    }

    fn record_remote_page_load(
        &mut self,
        generation: u64,
        loaded: bool,
    ) -> Option<GatewaySnapshot> {
        if !self.remote_page_is_current(generation)
            || self
                .remote_snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.phase == "remoteError")
        {
            return None;
        }
        let mut snapshot = GatewaySnapshot::remote_opening();
        if loaded {
            // A loaded document is not proof of authenticated Gateway health.
            snapshot.phase = "remoteDashboard";
            snapshot.status = "Remote dashboard".to_string();
        }
        self.remote_snapshot = Some(snapshot.clone());
        Some(snapshot)
    }

    fn preparation_is_current(&self, generation: u64, selection: u64) -> bool {
        self.watch_generation == generation && self.retired_preparation != Some(selection)
    }

    fn while_preparing<T>(
        &mut self,
        generation: u64,
        selection: u64,
        publish: impl FnOnce(&mut Self) -> Result<T, String>,
    ) -> Result<T, String> {
        if !self.preparation_is_current(generation, selection) {
            return Err("The connection was superseded by navigation.".to_string());
        }
        publish(self)
    }

    fn cancel_watchdog(&mut self) {
        self.watch_generation = self.watch_generation.wrapping_add(1);
        self.settings_return = None;
    }

    fn select_remote(&mut self) {
        self.cancel_watchdog();
        self.remote_dashboard = true;
    }

    fn permit_local(&mut self, force: bool, expected_generation: Option<u64>) -> bool {
        if expected_generation.is_some_and(|expected| expected != self.watch_generation) {
            return false;
        }
        if (self.remote_dashboard || self.settings_return.is_some()) && !force {
            return false;
        }
        if force {
            self.cancel_watchdog();
            self.remote_dashboard = false;
        }
        true
    }

    fn permits_local_completion(&self, quitting: bool) -> bool {
        if quitting || self.remote_dashboard {
            return false;
        }
        let Some(previous) = &self.settings_return else {
            return true;
        };
        if previous.generation != self.watch_generation {
            return false;
        }
        match &previous.target {
            SettingsReturnTarget::Local(url) => !url
                .query_pairs()
                .any(|(key, value)| key == "mode" && value == "remoteError"),
            SettingsReturnTarget::Remote(_) => false,
            SettingsReturnTarget::SavedGateway => true,
        }
    }

    fn begin_watchdog(&mut self) -> Option<u64> {
        if self.remote_dashboard || self.settings_return.is_some() {
            return None;
        }
        self.cancel_watchdog();
        Some(self.watch_generation)
    }

    fn watchdog_is_current(&self, generation: u64) -> bool {
        !self.remote_dashboard
            && self.settings_return.is_none()
            && self.watch_generation == generation
    }

    fn watchdog_recovery_is_current(
        &self,
        generation: u64,
        local_url: &Url,
        expected_url: &Url,
        current_url: &Url,
    ) -> bool {
        if !self.watchdog_is_current(generation) || current_url != expected_url {
            return false;
        }
        let mut current_base = current_url.clone();
        let mut local_base = local_url.clone();
        current_base.set_query(None);
        current_base.set_fragment(None);
        local_base.set_query(None);
        local_base.set_fragment(None);
        current_base == local_base
            && current_url
                .query_pairs()
                .find(|(key, _)| key == "mode")
                .is_some_and(|(_, mode)| matches!(mode.as_ref(), "stopped" | "reconnecting"))
    }

    fn begin_settings(
        &mut self,
        selection: u64,
        target: SettingsReturnTarget,
    ) -> Result<(), String> {
        if let Some(previous) = &self.settings_return {
            return if previous.generation == self.watch_generation {
                Ok(())
            } else {
                Err("Another connection now owns the dashboard.".to_string())
            };
        }
        // Remote page callbacks retain their captured owner generation. Only
        // local monitoring needs to retire while its view is the settings form.
        if !self.remote_dashboard {
            self.cancel_watchdog();
        }
        // Retiring preparation must survive Back without changing the committed
        // remote page's callback generation or its transport owner.
        self.retired_preparation = Some(selection);
        self.settings_return = Some(SettingsReturn {
            generation: self.watch_generation,
            target,
            failure: None,
        });
        Ok(())
    }

    fn record_remote_failure(&mut self, snapshot: GatewaySnapshot, child: Option<u64>) -> bool {
        // The caller holds the request guard. Feedback belongs to the editor;
        // request intent does not replace its presentation return authority.
        if child.is_none() {
            if let Some(previous) = self.settings_return.as_mut() {
                if previous.generation == self.watch_generation {
                    previous.failure = Some(snapshot);
                    return false;
                }
            }
            // A failed replacement is not health evidence for the committed page.
            // Once publication changes its generation, the old handle cannot mask errors.
            #[cfg(target_os = "linux")]
            if self.remote_dashboard
                && self
                    .remote_presentation_generation
                    .is_some_and(|generation| generation == self.watch_generation)
            {
                return false;
            }
        }
        self.remote_snapshot = Some(snapshot);
        true
    }

    fn settings_detail(&self) -> Option<String> {
        self.settings_return
            .as_ref()
            .and_then(|previous| previous.failure.as_ref())
            .or(self.remote_snapshot.as_ref())
            .filter(|snapshot| snapshot.phase == "remoteError")
            .and_then(|snapshot| snapshot.detail.clone())
    }

    fn finish_settings_return(&mut self) -> Option<u64> {
        let previous = self.settings_return.take()?;
        if let SettingsReturnTarget::Local(url) = previous.target {
            if url
                .query_pairs()
                .any(|(key, value)| key == "mode" && value == "remoteError")
            {
                return None;
            }
            // Local presentation must not inherit feedback from a failed edit.
            self.remote_snapshot = None;
        }
        self.begin_watchdog()
    }

    fn finish_settings_handoff(&mut self) -> Option<u64> {
        self.settings_return.take()?;
        if self.remote_dashboard {
            return None;
        }
        self.remote_snapshot = None;
        // Entry already retired the old local watcher. A requested session must
        // not retire otherwise-current preparation again while leaving Settings.
        Some(self.watch_generation)
    }

    fn mark_onboarding_pending(&mut self) {
        self.onboarding_pending = true;
    }

    fn prepare_dashboard_url(&mut self, target: &str) -> Result<Url, String> {
        let mut url =
            Url::parse(target).map_err(|_| "Dashboard returned an invalid URL.".to_string())?;
        if self.onboarding_pending {
            // Setup owns inference before chat; preserve Gateway base paths and fragment auth.
            // Saved first-run links may use either marker; new links use explicit.
            url.path_segments_mut()
                .map_err(|_| "Dashboard returned an invalid URL.".to_string())?
                .pop_if_empty()
                .extend(["settings", "model-setup"]);
            let existing_query = url
                .query_pairs()
                .filter(|(key, _)| key != "firstRun")
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect::<Vec<_>>();
            url.query_pairs_mut()
                .clear()
                .extend_pairs(existing_query)
                .append_pair("firstRun", "explicit");
            self.onboarding_pending = false;
        }
        Ok(url)
    }
}

struct DesktopInner {
    cli: Mutex<Option<OpenClawCli>>,
    chrome_setup: chrome_setup::ChromeSetup,
    navigation: Mutex<NavigationState>,
    operation: Mutex<()>,
    pending_approvals: Mutex<pending_approvals::PendingApprovalState>,
    local_url: Url,
    tray: Mutex<Option<Arc<tray::TrayHandles>>>,
    remote_tunnels: remote_gateway::TunnelManager,
    quitting: AtomicBool,
    ssh_shutdown_complete: AtomicBool,
}

#[derive(Clone)]
pub struct DesktopState {
    inner: Arc<DesktopInner>,
}

impl DesktopState {
    fn new(local_url: Url) -> Self {
        Self {
            inner: Arc::new(DesktopInner {
                cli: Mutex::new(None),
                chrome_setup: chrome_setup::ChromeSetup::default(),
                navigation: Mutex::new(NavigationState::default()),
                operation: Mutex::new(()),
                pending_approvals: Mutex::new(pending_approvals::PendingApprovalState::default()),
                local_url,
                tray: Mutex::new(None),
                remote_tunnels: remote_gateway::TunnelManager::default(),
                quitting: AtomicBool::new(false),
                ssh_shutdown_complete: AtomicBool::new(false),
            }),
        }
    }

    fn set_tray(&self, handles: tray::TrayHandles) {
        *self.inner.tray.lock().expect("tray mutex poisoned") = Some(Arc::new(handles));
    }

    fn with_tray(&self, update: impl FnOnce(&tray::TrayHandles)) {
        let tray = self.inner.tray.lock().expect("tray mutex poisoned").clone();
        // Menu setters synchronously dispatch to the main thread.
        if let Some(tray) = tray {
            update(&tray);
        }
    }

    pub(crate) fn set_quickchat_shortcut_checked(&self, checked: bool) {
        self.with_tray(|tray| tray.set_quickchat_shortcut_checked(checked));
    }

    pub(crate) fn refresh_update_action(&self, app: &AppHandle) {
        self.with_tray(|tray| tray.refresh_update_action(app));
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn present_remote_dashboard(&self, app: &AppHandle) -> Result<bool, String> {
        if self.is_quitting()
            || app
                .state::<gateway_windows::GatewayWindows>()
                .present_main_dashboard(app)?
        {
            return Ok(true);
        }
        // Settings and failed remote startup retain their recovery presentation.
        Ok(self
            .inner
            .navigation
            .lock()
            .expect("navigation")
            .remote_dashboard)
    }

    fn on_main<T: Send + 'static>(
        &self,
        app: &AppHandle,
        action: impl FnOnce(DesktopState, AppHandle) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (sender, receiver) = mpsc::channel();
        let state = self.clone();
        let current_app = app.clone();
        app.run_on_main_thread(move || {
            let _ = sender.send(action(state, current_app));
        })
        .map_err(|_| "The desktop event loop is unavailable.".to_string())?;
        receiver
            .recv()
            .map_err(|_| "The desktop operation was interrupted.".to_string())?
    }

    pub fn connect(&self, app: &AppHandle, selection: u64) -> Result<GatewaySnapshot, String> {
        let result = self.connect_selected(app, false, selection);
        if let Err(error) = &result {
            if remote_gateway::saved_settings()?.is_some() {
                return self.remote_failure(app, error.clone(), selection, None);
            }
        }
        result
    }

    fn retry_remote(&self, app: &AppHandle, selection: u64) -> Result<GatewaySnapshot, String> {
        let _operation = self.inner.operation.lock().expect("Gateway operation");
        let result = remote_gateway::load_saved_remote()
            .and_then(|request| {
                request.ok_or_else(|| {
                    "No remote Gateway is saved. Edit the connection settings.".to_string()
                })
            })
            .and_then(|request| {
                self.connect_remote_locked(app, request, RemoteConnectionSource::Saved, selection)
            });
        match result {
            Ok(snapshot) => Ok(snapshot),
            Err(error) => self.remote_failure(app, error, selection, None),
        }
    }

    fn connect_selected(
        &self,
        app: &AppHandle,
        explicit_local: bool,
        selection: u64,
    ) -> Result<GatewaySnapshot, String> {
        let _operation = self
            .inner
            .operation
            .lock()
            .map_err(|_| "Gateway operation lock is unavailable.".to_string())?;
        if !explicit_local {
            if let Some(remote) = remote_gateway::load_saved_remote()? {
                return self.connect_remote_locked(
                    app,
                    remote,
                    RemoteConnectionSource::Saved,
                    selection,
                );
            }
            self.on_main(app, move |state, app| {
                let mut navigation = state.inner.navigation.lock().expect("navigation");
                app.state::<GatewayOperationQueue>()
                    .while_current(selection, || {
                        navigation.permit_local(true, None);
                    });
                Ok(())
            })?;
        }
        let cli = self.resolve_cli();
        if !explicit_local && !remote_gateway::has_configured_gateway()? {
            // First-run setup belongs to the pending bootstrap reply. Navigating
            // here replaces its WebView and loses the local/remote choice.
            let snapshot = match cli {
                Ok(_) => GatewaySnapshot::unconfigured(),
                Err(CliError::Missing) => GatewaySnapshot::missing_cli(),
                Err(error) => return Err(error.to_string()),
            };
            self.update_tray(&snapshot);
            return Ok(snapshot);
        }
        let cli = match cli {
            Ok(cli) => cli,
            Err(CliError::Missing) => {
                return self.show_missing_cli(app, explicit_local, None);
            }
            Err(error) => return Err(error.to_string()),
        };
        if explicit_local {
            self.inner.remote_tunnels.clear();
        }
        let ready = gateway::ensure_ready(&cli)?;
        self.finish_local_connection(app, cli, ready)
    }

    pub fn install_cli(
        &self,
        app: &AppHandle,
        channel: InstallChannel,
    ) -> Result<GatewaySnapshot, String> {
        let _operation = self
            .inner
            .operation
            .lock()
            .map_err(|_| "Installer lock is unavailable.".to_string())?;
        installer::install(app, channel)?;
        let cli = OpenClawCli::discover().map_err(|error| {
            format!("OpenClaw is installed, but the CLI could not be found: {error}")
        })?;
        *self.inner.cli.lock().expect("CLI mutex poisoned") = Some(cli.clone());

        // The installed CLI owns config/state migrations; repair before any
        // Gateway readiness checks consume an outdated home.
        let repair_error = match cli.output(["doctor", "--fix", "--non-interactive"]) {
            Ok(output) if !output.status.success() => Some(
                cli::output_tail(&output.stderr)
                    .unwrap_or_else(|| format!("OpenClaw repair exited with {}", output.status)),
            ),
            Err(error) => Some(format!("OpenClaw repair could not start: {error}")),
            _ => None,
        };
        if let Some(error) = repair_error {
            for line in error.lines() {
                let _ = app.emit_to(
                    "main",
                    "install-progress",
                    serde_json::json!({ "stream": "stderr", "line": line }),
                );
            }
        }

        self.inner.chrome_setup.installed(app.clone(), cli.clone());

        self.inner
            .navigation
            .lock()
            .map_err(|_| {
                "OpenClaw is installed, but preparing the Gateway dashboard failed: \
                 Dashboard navigation lock is unavailable."
                    .to_string()
            })?
            .mark_onboarding_pending();
        let ready = gateway::ensure_ready(&cli).map_err(|error| {
            format!("OpenClaw is installed, but connecting to the Gateway failed: {error}")
        })?;
        self.finish_local_connection(app, cli, ready)
            .map_err(|error| {
                format!("OpenClaw is installed, but opening the Gateway dashboard failed: {error}")
            })
    }

    pub fn gateway_action(
        &self,
        app: &AppHandle,
        action: GatewayAction,
    ) -> Result<GatewaySnapshot, String> {
        let _operation = self
            .inner
            .operation
            .lock()
            .map_err(|_| "Gateway operation lock is unavailable.".to_string())?;
        if matches!(action, GatewayAction::Stop) {
            self.cancel_watchdog();
        }
        let cli = self.resolve_cli().map_err(|error| error.to_string())?;
        let snapshot = gateway::act(&cli, action)?;
        if matches!(action, GatewayAction::Stop) {
            app.state::<gateway_ws::GatewayClient>()
                .clear_configuration(app);
            self.show_local(app, "stopped", false, None)?;
            self.update_tray(&snapshot);
            return Ok(snapshot);
        }

        let ready = gateway::dashboard(&cli, snapshot)?;
        self.finish_local_connection(app, cli, ready)
    }

    fn finish_local_connection(
        &self,
        app: &AppHandle,
        cli: OpenClawCli,
        ready: ReadyGateway,
    ) -> Result<GatewaySnapshot, String> {
        let snapshot = ready.snapshot.clone();
        let generation = self.on_main(app, move |state, app| {
            let mut navigation = state.inner.navigation.lock().expect("navigation");
            if !navigation.permits_local_completion(state.is_quitting()) {
                return Ok(None);
            }
            if navigation.settings_return.is_none() {
                state.navigate_local_document(
                    &app,
                    &mut navigation,
                    &ready.dashboard_url,
                    true,
                    true,
                )?;
            }
            // Explicit completion publishes fresh credentials even while Settings owns the page.
            app.state::<gateway_ws::GatewayClient>()
                .configure(&app, ready.gateway_ws);
            state.update_tray(&ready.snapshot);
            Ok(navigation.begin_watchdog())
        })?;
        if let Some(generation) = generation {
            self.watch_local(app.clone(), cli, generation);
        }
        Ok(snapshot)
    }

    pub fn connect_explicit_local(
        &self,
        app: &AppHandle,
        selection: u64,
    ) -> Result<GatewaySnapshot, String> {
        self.on_main(app, |state, app| {
            state
                .inner
                .navigation
                .lock()
                .expect("navigation")
                .permit_local(true, None);
            // Keep the first-run page that owns the pending bootstrap reply.
            if !state.main_window_has_local_content(&main_window(&app)?) {
                let mut url = state.inner.local_url.clone();
                url.query_pairs_mut()
                    .clear()
                    .append_pair("mode", "reconnecting");
                app.state::<native_browser_bridge::NativeBrowserBridgeState>()
                    .clear(&app);
                replace_main_webview(&app, url, None, None)?;
            }
            Ok(())
        })?;
        self.connect_selected(app, true, selection)
    }

    pub(crate) fn connect_remote(
        &self,
        app: &AppHandle,
        request: RemoteGatewayRequest,
        selection: u64,
    ) -> Result<GatewaySnapshot, String> {
        let _operation = self
            .inner
            .operation
            .lock()
            .map_err(|_| "Gateway operation lock is unavailable.".to_string())?;
        let result =
            self.connect_remote_locked(app, request, RemoteConnectionSource::Submitted, selection);
        if let Err(error) = &result {
            let _ = self.remote_failure(app, error.clone(), selection, None);
        }
        result
    }

    fn connect_remote_locked(
        &self,
        app: &AppHandle,
        request: RemoteGatewayRequest,
        source: RemoteConnectionSource,
        selection: u64,
    ) -> Result<GatewaySnapshot, String> {
        self.connect_remote_guarded(app, request, source, selection, None)
    }

    fn promote_profile(
        &self,
        app: &AppHandle,
        request: RemoteGatewayRequest,
        selection: u64,
        guard: gateway_windows::PromotionGuard,
    ) -> Result<GatewaySnapshot, String> {
        let _operation = self
            .inner
            .operation
            .lock()
            .map_err(|_| "Gateway operation is unavailable.")?;
        self.connect_remote_guarded(
            app,
            request,
            RemoteConnectionSource::Submitted,
            selection,
            Some(guard),
        )
    }

    fn connect_remote_guarded(
        &self,
        app: &AppHandle,
        mut request: RemoteGatewayRequest,
        source: RemoteConnectionSource,
        selection: u64,
        promotion: Option<gateway_windows::PromotionGuard>,
    ) -> Result<GatewaySnapshot, String> {
        if self.is_quitting() {
            return Err("OpenClaw is quitting.".to_string());
        }
        if promotion.as_ref().is_some_and(|guard| !guard.current(app)) {
            return Err("The Primary Gateway change was cancelled.".into());
        }
        let view_generation = {
            let navigation = self.inner.navigation.lock().expect("navigation");
            if navigation.retired_preparation == Some(selection) {
                return Err("The connection was superseded by navigation.".to_string());
            }
            navigation.watch_generation
        };
        remote_gateway::validate_request(&request)?;
        let work = if request.transport == "ssh" || self.inner.remote_tunnels.has_route() {
            Some(self.inner.remote_tunnels.begin()?)
        } else {
            None
        };
        let reusable = (request.transport == "ssh")
            .then(|| self.inner.remote_tunnels.reusable(&request))
            .flatten();
        let (tunnel, gateway_url) = if request.transport == "ssh" {
            if let Some(route) = &reusable {
                (None, route.url.clone())
            } else {
                let saved_url = request
                    .url
                    .as_deref()
                    .map(remote_gateway::normalize_gateway_url)
                    .transpose()?;
                let (tunnel, url) =
                    remote_gateway::start_tunnel(&request, saved_url.as_ref(), || {
                        self.is_quitting()
                            || promotion.as_ref().is_some_and(|guard| !guard.current(app))
                            || !self
                                .inner
                                .navigation
                                .lock()
                                .expect("navigation")
                                .preparation_is_current(view_generation, selection)
                    })?;
                (Some(tunnel), url)
            }
        } else {
            let raw = request
                .url
                .as_deref()
                .ok_or_else(|| "Enter the URL of your remote Gateway.".to_string())?;
            (None, remote_gateway::normalize_gateway_url(raw)?)
        };
        remote_gateway::resolve_remote_tls_fingerprint(&mut request, &gateway_url)?;
        // Blank Settings fields retain configured credentials for this endpoint.
        // Runtime resolution must not turn that intent into a plaintext save.
        let submitted_request = request.clone();
        if matches!(source, RemoteConnectionSource::Submitted) {
            request = remote_gateway::resolve_submitted_credentials_at(
                &remote_gateway::config_path()?,
                &request,
            )?;
        }
        let target = remote_gateway::dashboard_url(&gateway_url)?;
        let script = native_auth_initialization_script(&target, &gateway_url, &request)?;
        let pending = Arc::new(Mutex::new(tunnel));
        let commit_pending = Arc::clone(&pending);
        let result = self.on_main(app, move |state, app| {
            if state.is_quitting() {
                return Err("OpenClaw is quitting.".to_string());
            }
            let mut navigation = state.inner.navigation.lock().expect("navigation");
            let snapshot = app
                .state::<GatewayOperationQueue>()
                .while_current(selection, || {
                    navigation.while_preparing(view_generation, selection, |navigation| {
                        if promotion.as_ref().is_some_and(|guard| !guard.current(&app)) {
                            return Err("The Primary Gateway change was cancelled.".into());
                        }
                        // Settings entry and publication share these guards. No
                        // prepared connection may save or publish after retirement.
                        remote_gateway::save_config_at(
                            &remote_gateway::config_path()?,
                            &submitted_request,
                            &gateway_url,
                            source,
                        )?;
                        if request.transport == "ssh" {
                            state.inner.remote_tunnels.publish(
                                &mut commit_pending.lock().expect("pending SSH"),
                                TunnelRoute {
                                    id: 0,
                                    selection,
                                    request: request.clone(),
                                    url: gateway_url.clone(),
                                },
                                reusable.as_ref().map(|route| route.id),
                                true,
                            )?;
                        } else {
                            *commit_pending.lock().expect("pending SSH") =
                                state.inner.remote_tunnels.take();
                        }
                        app.state::<gateway_ws::GatewayClient>()
                            .configure(&app, remote_ws_config(&request, &gateway_url));
                        // The submitting view will be destroyed. Its IPC reply
                        // cannot own completion or prove Gateway health.
                        let snapshot = GatewaySnapshot::remote_opening();
                        navigation.select_remote();
                        navigation.remote_snapshot = Some(snapshot.clone());
                        state.navigate_authenticated_remote(&app, target, script, navigation)?;
                        Ok(snapshot)
                    })
                })
                .ok_or_else(|| "Another connection now owns the dashboard.".to_string())??;
            drop(navigation);
            state.update_tray(&snapshot);
            Ok(snapshot)
        });
        // Includes retired and cancelled children. No native thread or state
        // lock waits for a subprocess to exit.
        let retired = pending.lock().expect("pending SSH").take();
        drop(retired);
        drop(work);
        result
    }

    fn navigate_authenticated_remote(
        &self,
        app: &AppHandle,
        dashboard: Url,
        script: String,
        navigation: &mut NavigationState,
    ) -> Result<(), String> {
        if !app
            .state::<gateway_windows::GatewayWindows>()
            .primary_selected(
                app,
                &dashboard,
                Some(script.clone()),
                gateway_ws::GatewayOwnership::Remote,
            )?
        {
            if main_window(app)
                .ok()
                .and_then(|view| view.url().ok())
                .is_some_and(|url| self.main_window_has_connection_settings_url(&url))
            {
                gateway_windows::restore_selected_main(app)?;
            }
            return Ok(());
        }
        let generation = navigation.watch_generation;
        let bridge = app.state::<native_browser_bridge::NativeBrowserBridgeState>();
        let bridge_script = bridge
            .select(app, &dashboard, true)?
            .ok_or_else(|| "Could not prepare the native browser.".to_string())?;
        match replace_main_webview(
            app,
            dashboard.clone(),
            Some(format!("{script}\n{bridge_script}")),
            Some(generation),
        ) {
            Ok(_) => {}
            Err(_) => {
                navigation.cancel_watchdog();
                bridge.clear(app);
                let mut local = self.inner.local_url.clone();
                local
                    .query_pairs_mut()
                    .append_pair("mode", "connectionSettings");
                let _ = replace_main_webview(app, local, None, None);
                return Err(
                    "Could not open the remote Gateway dashboard. Try connecting again."
                        .to_string(),
                );
            }
        };
        #[cfg(target_os = "linux")]
        {
            if !self.is_quitting()
                && navigation.remote_dashboard
                && navigation.watch_generation == generation
            {
                navigation.remote_presentation_generation = Some(generation);
            }
        }
        tray::show_window(app);
        gateway_windows::startup(app);
        Ok(())
    }

    fn remote_failure(
        &self,
        app: &AppHandle,
        error: String,
        selection: u64,
        child: Option<u64>,
    ) -> Result<GatewaySnapshot, String> {
        self.on_main(app, move |state, app| {
            let snapshot = GatewaySnapshot::remote_error(error);
            let mut navigation = state.inner.navigation.lock().expect("navigation");
            if state.is_quitting()
                || (child.is_none() && navigation.retired_preparation == Some(selection))
                || child.is_some_and(|child| !state.inner.remote_tunnels.route_is_current(child))
            {
                return Ok(snapshot);
            }
            let published = app
                .state::<GatewayOperationQueue>()
                .while_current(selection, || {
                    navigation.record_remote_failure(snapshot.clone(), child)
                });
            drop(navigation);
            if published == Some(true) {
                state.update_tray(&snapshot);
            }
            Ok(snapshot)
        })
    }

    pub(crate) fn show_connection_settings(&self, app: &AppHandle) -> Result<(), String> {
        self.enter_connection_settings(app, true)
    }

    fn enter_connection_settings(&self, app: &AppHandle, navigate: bool) -> Result<(), String> {
        if self.is_quitting() {
            return Err("OpenClaw is quitting.".to_string());
        }
        let mut navigation = self.inner.navigation.lock().expect("navigation");
        let operations = app.state::<GatewayOperationQueue>();
        let selection = operations.current_selection();
        let selected_gateway = app
            .state::<gateway_windows::GatewayWindows>()
            .main_has_selected_gateway();
        let target = if let Some(previous) = &navigation.settings_return {
            previous.target.clone()
        } else if selected_gateway {
            SettingsReturnTarget::SavedGateway
        } else {
            #[cfg(target_os = "linux")]
            let remote_url = navigation
                .remote_presentation_generation
                .filter(|generation| {
                    navigation.remote_dashboard && *generation == navigation.watch_generation
                })
                .map(|_| {
                    main_window(app)?.url().map_err(|_| {
                        "Could not retain the current dashboard. Try again.".to_string()
                    })
                })
                .transpose()?;
            #[cfg(not(target_os = "linux"))]
            let remote_url: Option<Url> = None;
            if let Some(url) = remote_url {
                SettingsReturnTarget::Remote(url)
            } else {
                let window = main_window(app)?;
                let mut target = window.url().map_err(|_| {
                    "Could not retain the current dashboard. Try again.".to_string()
                })?;
                if self.main_window_has_local_content(&window)
                    && (navigation.remote_dashboard
                        || navigation
                            .remote_snapshot
                            .as_ref()
                            .is_some_and(|snapshot| snapshot.phase == "remoteError"))
                {
                    // Startup failure has no committed remote page. Return to its
                    // recovery panel without running bootstrap/Connect again.
                    target
                        .query_pairs_mut()
                        .clear()
                        .append_pair("mode", "remoteError");
                }
                SettingsReturnTarget::Local(target)
            }
        };
        let mut url = self.inner.local_url.clone();
        url.query_pairs_mut()
            .clear()
            .append_pair("mode", "connectionSettings");
        operations
            .while_current(selection, || {
                navigation.begin_settings(selection, target)?;
                app.state::<gateway_windows::GatewayWindows>()
                    .cancel_pending(app, "main");
                if navigate {
                    if selected_gateway {
                        replace_main_webview(app, url, None, None)?;
                        tray::show_window(app);
                    } else {
                        self.navigate_locked(app, url, true)?;
                    }
                }
                Ok(())
            })
            .unwrap_or_else(|| Err("Another connection now owns the dashboard.".to_string()))
    }

    pub(crate) fn return_from_connection_settings(&self, app: &AppHandle) -> Result<bool, String> {
        let mut navigation = self.inner.navigation.lock().expect("navigation");
        let Some(previous) = navigation.settings_return.as_ref() else {
            return Ok(false);
        };
        if self.is_quitting() || previous.generation != navigation.watch_generation {
            return Err("The previous dashboard is no longer available.".to_string());
        }
        match previous.target.clone() {
            SettingsReturnTarget::SavedGateway => {
                gateway_windows::restore_selected_main(app)?;
            }
            SettingsReturnTarget::Local(url) => {
                main_window(app)?
                    .navigate(url)
                    .map_err(|_| "Could not return to the dashboard. Try again.".to_string())?;
            }
            #[cfg(target_os = "linux")]
            SettingsReturnTarget::Remote(url) => {
                navigation
                    .remote_presentation_generation
                    .filter(|generation| {
                        navigation.remote_dashboard && *generation == navigation.watch_generation
                    })
                    .ok_or_else(|| {
                        "The previous dashboard is unavailable. Retry or edit the connection."
                            .to_string()
                    })?;
                main_window(app)?
                    .navigate(url)
                    .map_err(|_| "Could not return to the dashboard. Try again.".to_string())?;
            }
            #[cfg(not(target_os = "linux"))]
            SettingsReturnTarget::Remote(_) => {
                return Err("The previous dashboard is unavailable.".to_string());
            }
        }
        let monitor = navigation.finish_settings_return();
        drop(navigation);
        if let Some(generation) = monitor {
            // Reuse the connected CLI without discovery or a connection operation.
            if let Some(cli) = self.inner.cli.lock().expect("CLI mutex poisoned").clone() {
                self.watch_local(app.clone(), cli, generation);
            }
        }
        Ok(true)
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn show_desktop_session(
        &self,
        app: &AppHandle,
        generation: u64,
        session_key: &str,
        agent_id: &str,
    ) -> Result<(), String> {
        // Match connection publication's NAV -> Gateway config lock order.
        // This entry is already on the native thread; do not nest on_main.
        let monitor = {
            let mut navigation = self.inner.navigation.lock().expect("navigation");
            app.state::<gateway_ws::GatewayClient>()
                .with_desktop_route(generation, |ws_url| {
                    if self.is_quitting()
                        || navigation.settings_return.as_ref().is_some_and(|previous| {
                            previous.generation != navigation.watch_generation
                        })
                    {
                        return Err("The dashboard is no longer available.".to_string());
                    }
                    let ws_url = ws_url.ok_or("Select a Gateway in the desktop app first.")?;
                    let target = desktop_bridge::session_url(ws_url, session_key, agent_id)?;
                    if !app.state::<gateway_windows::GatewayWindows>().main_is_primary(app) {
                        gateway_windows::show_primary_url(app, target)?;
                        return Ok(None);
                    }
                    if navigation.remote_dashboard {
                        self.navigate_locked(app, target, false)?;
                    } else {
                        let base = remote_gateway::dashboard_url(
                            &Url::parse(ws_url).map_err(|error| error.to_string())?,
                        )?;
                        // Recovery must stay explicit: the bare local URL runs Connect.
                        let mode = if navigation.settings_return.is_some() {
                            "connectionSettings".to_string()
                        } else {
                            let window = main_window(app)?;
                            if self.main_window_has_local_content(&window) {
                                window
                                    .url()
                                    .map_err(|_| {
                                        "Could not retain the connection view. Try again.".to_string()
                                    })?
                                    .query_pairs()
                                    .find(|(key, value)| {
                                        key == "mode"
                                            && matches!(
                                                value.as_ref(),
                                                "stopped"
                                                    | "reconnecting"
                                                    | "missingCli"
                                                    | "remoteError"
                                                    | "error"
                                            )
                                    })
                                    .map(|(_, value)| value.into_owned())
                                    .unwrap_or_else(|| "reconnecting".to_string())
                            } else {
                                "reconnecting".to_string()
                            }
                        };
                        let mut recovery = self.inner.local_url.clone();
                        recovery.set_fragment(None);
                        recovery.query_pairs_mut().clear().append_pair("mode", &mode);
                        let bridge =
                            app.state::<native_browser_bridge::NativeBrowserBridgeState>();
                        // The bridge scopes the whole dashboard, not just this session.
                        if let Some(script) = bridge.select(app, &base, false)? {
                            if let Err(error) = replace_main_webview(app, base, Some(script), None)
                                .and_then(|_| self.navigate_locked(app, target, false))
                            {
                                bridge.clear(app);
                                return match replace_main_webview(app, recovery, None, None) {
                                    Ok(_) => Err(error),
                                    Err(restoration) => Err(format!(
                                        "{error}; could not restore the connection view: {restoration}"
                                    )),
                                };
                            }
                        } else {
                            self.navigate_locked(app, target, false)?;
                        }
                    }
                    // Navigation failure leaves the original return controls intact.
                    Ok(navigation.finish_settings_handoff())
                })?
        };
        tray::show_window(app);
        if let Some(generation) = monitor {
            if let Some(cli) = self.inner.cli.lock().expect("CLI mutex poisoned").clone() {
                self.watch_local(app.clone(), cli, generation);
            }
        }
        Ok(())
    }

    fn start_tunnel_monitor(&self, app: AppHandle) {
        let state = self.clone();
        thread::spawn(move || {
            while !state.is_quitting() {
                if let Some((route, recover)) = state.inner.remote_tunnels.exited() {
                    if recover {
                        app.state::<GatewayOperationQueue>()
                            .submit_recovery(route.id);
                    } else {
                        let _ = state.remote_child_closed(&app, route.id);
                    }
                }
                thread::sleep(Duration::from_millis(200));
            }
        });
    }

    fn remote_child_closed(&self, app: &AppHandle, child_id: u64) -> Result<(), String> {
        self.on_main(app, move |state, _app| {
            let mut navigation = state.inner.navigation.lock().expect("navigation");
            if state.is_quitting() || !state.inner.remote_tunnels.route_is_current(child_id) {
                return Ok(());
            }
            // Monitor evidence belongs to the committed child, not the request
            // that originally created it or a failed edit's newer intent.
            let snapshot = GatewaySnapshot::remote_error(
                "The SSH connection closed again. Open Connection Settings to retry or edit it."
                    .to_string(),
            );
            navigation.remote_snapshot = Some(snapshot.clone());
            drop(navigation);
            state.update_tray(&snapshot);
            Ok(())
        })
    }

    fn recover_remote(
        &self,
        app: &AppHandle,
        selection: u64,
        child_id: u64,
    ) -> Result<GatewaySnapshot, String> {
        let _operation = self.inner.operation.lock().expect("Gateway operation");
        let Some(route) = self.inner.remote_tunnels.route(child_id) else {
            return Ok(GatewaySnapshot::remote_opening());
        };
        let cancelled = || {
            self.is_quitting()
                || !app
                    .state::<GatewayOperationQueue>()
                    .selection_is_current(selection)
                || !self.inner.remote_tunnels.route_is_current(child_id)
        };
        if cancelled() {
            return Ok(GatewaySnapshot::remote_opening());
        }
        let _work = self.inner.remote_tunnels.begin()?;
        let tunnel = remote_gateway::start_tunnel(&route.request, Some(&route.url), cancelled);
        match tunnel {
            Err(error) => self.remote_failure(app, error, selection, Some(child_id)),
            Ok((tunnel, url)) => {
                let pending = Arc::new(Mutex::new(Some(tunnel)));
                let commit_pending = Arc::clone(&pending);
                let result = self.on_main(app, move |state, app| {
                    let published =
                        app.state::<GatewayOperationQueue>()
                            .while_current(selection, || {
                                state.inner.remote_tunnels.publish(
                                    &mut commit_pending.lock().expect("pending SSH"),
                                    TunnelRoute { url, ..route },
                                    Some(child_id),
                                    false,
                                )
                            });
                    let Some(published) = published else {
                        return Ok(GatewaySnapshot::remote_opening());
                    };
                    published?;
                    // Same route, same document and native client generation. A
                    // replacement gets no further automatic retry until user intent.
                    app.state::<gateway_ws::GatewayClient>().resume_reconnect();
                    let mut snapshot = GatewaySnapshot::remote_opening();
                    snapshot.status = "Remote dashboard".to_string();
                    state
                        .inner
                        .navigation
                        .lock()
                        .expect("navigation")
                        .remote_snapshot = Some(snapshot.clone());
                    state.update_tray(&snapshot);
                    Ok(snapshot)
                });
                let retired = pending.lock().expect("pending SSH").take();
                drop(retired);
                match result {
                    Ok(snapshot) => Ok(snapshot),
                    Err(error) => self.remote_failure(app, error, selection, Some(child_id)),
                }
            }
        }
    }

    pub fn show_error(&self, app: &AppHandle, _error: &str) {
        let _ = self.show_local(app, "error", false, None);
        self.update_tray(&GatewaySnapshot::reconnecting("Gateway action failed."));
        tray::show_window(app);
    }

    pub fn quit(&self, app: &AppHandle) {
        self.quit_with_code(app, 0);
    }

    fn quit_with_code(&self, app: &AppHandle, code: i32) {
        if self.claim_quit() {
            self.finish_quit(app, code);
        }
    }

    pub(crate) fn claim_quit(&self) -> bool {
        !self.inner.quitting.swap(true, Ordering::SeqCst)
    }

    // Only the successful claim owner calls this, after releasing any route guard.
    pub(crate) fn finish_quit(&self, app: &AppHandle, code: i32) {
        self.cancel_watchdog();
        app.state::<GatewayOperationQueue>().invalidate_recovery();
        self.inner.remote_tunnels.close();
        app.state::<gateway_windows::GatewayWindows>().shutdown(app);
        let state = self.clone();
        let app = app.clone();
        thread::spawn(move || {
            state.inner.remote_tunnels.wait_closed();
            app.state::<gateway_windows::GatewayWindows>().wait_closed();
            state
                .inner
                .ssh_shutdown_complete
                .store(true, Ordering::SeqCst);
            app.exit(code);
        });
    }

    fn is_quitting(&self) -> bool {
        self.inner.quitting.load(Ordering::SeqCst)
    }

    pub(crate) fn resolve_cli(&self) -> Result<OpenClawCli, CliError> {
        let mut cached = self.inner.cli.lock().expect("CLI mutex poisoned");
        if let Some(cli) = cached.clone().filter(OpenClawCli::is_available) {
            return Ok(cli);
        }
        let cli = OpenClawCli::discover()?;
        *cached = Some(cli.clone());
        Ok(cli)
    }

    pub(crate) fn main_window_has_local_content(&self, window: &Webview) -> bool {
        window
            .url()
            .is_ok_and(|url| self.main_window_has_local_url(&url))
    }

    pub(crate) fn main_window_has_local_url(&self, url: &Url) -> bool {
        let mut current_url = url.clone();
        let mut local_url = self.inner.local_url.clone();
        current_url.set_query(None);
        current_url.set_fragment(None);
        local_url.set_query(None);
        local_url.set_fragment(None);
        current_url == local_url
    }

    pub(crate) fn main_window_has_connection_settings_url(&self, url: &Url) -> bool {
        self.main_window_has_local_url(url)
            && url
                .query_pairs()
                .find(|(key, _)| key == "mode")
                .is_some_and(|(_, mode)| mode == "connectionSettings")
    }

    fn update_tray(&self, snapshot: &GatewaySnapshot) {
        self.with_tray(|tray| tray.update(snapshot));
    }

    fn show_missing_cli(
        &self,
        app: &AppHandle,
        force: bool,
        expected_generation: Option<u64>,
    ) -> Result<GatewaySnapshot, String> {
        let snapshot = GatewaySnapshot::missing_cli();
        let navigation = self.show_local(app, "missingCli", force, expected_generation);
        if !local_recovery_owns_gateway(&navigation) {
            return Ok(snapshot);
        }
        app.state::<gateway_ws::GatewayClient>()
            .clear_configuration(app);
        self.update_tray(&snapshot);
        navigation.map(|_| snapshot)
    }

    fn show_cli_recovery_error(&self, app: &AppHandle, generation: u64, error: CliError) {
        let mut snapshot = GatewaySnapshot::missing_cli();
        snapshot.status = "CLI unavailable".to_string();
        snapshot.detail = Some(error.to_string());
        let navigation = self.show_local(app, "error", false, Some(generation));
        if local_recovery_owns_gateway(&navigation) {
            app.state::<gateway_ws::GatewayClient>()
                .clear_configuration(app);
            self.update_tray(&snapshot);
        }
    }

    fn poll_pending_approvals(&self, app: &AppHandle, cli: &OpenClawCli, generation: u64) {
        let pending = match pending_approvals::fetch(cli) {
            Ok(pending) => pending,
            Err(error) => {
                eprintln!("Could not poll pending approvals: {error}");
                return;
            }
        };
        if !self.watchdog_is_current(generation) {
            return;
        }
        let diff = self
            .inner
            .pending_approvals
            .lock()
            .expect("pending approval mutex poisoned")
            .update(pending);
        self.with_tray(|tray| tray.update_pending_count(diff.count));
        if !main_window(app).is_ok_and(|view| matches!(view.window().is_focused(), Ok(false))) {
            return;
        }
        // Notifications are a doorbell only; approval stays in the dashboard or CLI.
        for request in diff.new {
            notify::notify(app, "OpenClaw", &request.notification_body());
        }
    }

    // Page-load observers defer their navigation-owner reads to avoid reentrancy.
    fn navigate_locked(
        &self,
        app: &AppHandle,
        url: Url,
        reveal_window: bool,
    ) -> Result<(), String> {
        let view = main_window(app)?;
        if !app
            .state::<gateway_windows::GatewayWindows>()
            .navigate_document(&view, url.clone())?
        {
            view.navigate(url)
                .map_err(|error| format!("Could not open dashboard: {error}"))?;
        }
        if reveal_window {
            tray::show_window(app);
        }
        Ok(())
    }

    fn navigate_local(
        &self,
        app: &AppHandle,
        target: &str,
        force: bool,
        expected_generation: Option<u64>,
        reveal_window: bool,
        dashboard: bool,
    ) -> Result<bool, String> {
        let target = target.to_string();
        self.on_main(app, move |state, app| {
            let mut navigation = state.inner.navigation.lock().expect("navigation");
            if state.is_quitting() || !navigation.permit_local(force, expected_generation) {
                return Ok(false);
            }
            state.navigate_local_document(
                &app,
                &mut navigation,
                &target,
                reveal_window,
                dashboard,
            )?;
            Ok(true)
        })
    }

    // Runs on the native thread under the caller's navigation owner guard.
    fn navigate_local_document(
        &self,
        app: &AppHandle,
        navigation: &mut NavigationState,
        target: &str,
        reveal_window: bool,
        dashboard: bool,
    ) -> Result<(), String> {
        let windows = app.state::<gateway_windows::GatewayWindows>();
        let base = Url::parse(target).map_err(|_| "Dashboard returned an invalid URL.")?;
        if dashboard {
            if !windows.primary_selected(app, &base, None, gateway_ws::GatewayOwnership::Local)? {
                return Ok(());
            }
        } else if !windows.main_is_primary(app) {
            // Primary recovery must not replace an independently selected dashboard.
            return Ok(());
        }
        let onboarding_was_pending = dashboard && navigation.onboarding_pending;
        let bridge = app.state::<native_browser_bridge::NativeBrowserBridgeState>();
        let bridge_script = if dashboard {
            bridge.select(app, &base, false)?
        } else {
            bridge.clear(app);
            None
        };
        let result = if dashboard {
            let initial_url = navigation.prepare_dashboard_url(target)?;
            if let Some(script) = bridge_script {
                // The first page must not narrow authority to its onboarding or session path.
                replace_main_webview(app, base, Some(script), None)
                    .and_then(|_| self.navigate_locked(app, initial_url, false))
            } else {
                self.navigate_locked(app, initial_url, false)
            }
        } else {
            replace_main_webview(app, base, None, None).map(|_| ())
        };
        if let Err(error) = result {
            bridge.clear(app);
            let _ = replace_main_webview(app, self.inner.local_url.clone(), None, None);
            if onboarding_was_pending {
                navigation.mark_onboarding_pending();
            }
            return Err(error);
        }
        #[cfg(target_os = "linux")]
        if !navigation.remote_dashboard {
            navigation.remote_presentation_generation = None;
        }
        if reveal_window {
            tray::show_window(app);
        }
        if dashboard {
            gateway_windows::startup(app);
        }
        Ok(())
    }

    fn show_local(
        &self,
        app: &AppHandle,
        mode: &str,
        force: bool,
        expected_generation: Option<u64>,
    ) -> Result<bool, String> {
        let mut url = self.inner.local_url.clone();
        url.query_pairs_mut().clear().append_pair("mode", mode);
        // Status/watchdog updates may change the hidden WebView, but must not reveal it.
        self.navigate_local(app, url.as_str(), force, expected_generation, false, false)
    }

    fn cancel_watchdog(&self) {
        if let Ok(mut navigation) = self.inner.navigation.lock() {
            navigation.cancel_watchdog();
        }
    }

    fn watchdog_is_current(&self, generation: u64) -> bool {
        self.inner
            .navigation
            .lock()
            .is_ok_and(|navigation| navigation.watchdog_is_current(generation))
    }

    fn restore_healthy_local_dashboard(
        &self,
        app: &AppHandle,
        cli: &OpenClawCli,
        snapshot: GatewaySnapshot,
        generation: u64,
    ) -> Result<(), String> {
        let previous_url = self.on_main(app, move |state, app| {
            let navigation = state.inner.navigation.lock().expect("navigation");
            let current = main_window(&app)?
                .url()
                .map_err(|error| error.to_string())?;
            Ok((!state.is_quitting()
                && navigation.watchdog_recovery_is_current(
                    generation,
                    &state.inner.local_url,
                    &current,
                    &current,
                ))
            .then_some(current))
        })?;
        let Some(previous_url) = previous_url else {
            return Ok(());
        };
        let ready = gateway::dashboard(cli, snapshot)?;
        self.on_main(app, move |state, app| {
            let mut navigation = state.inner.navigation.lock().expect("navigation");
            let current = main_window(&app)?
                .url()
                .map_err(|error| error.to_string())?;
            if state.is_quitting()
                || !navigation.watchdog_recovery_is_current(
                    generation,
                    &state.inner.local_url,
                    &previous_url,
                    &current,
                )
            {
                return Ok(());
            }
            // The transport is already owned; initialize only its dashboard document.
            state.navigate_local_document(&app, &mut navigation, &ready.dashboard_url, false, true)
        })
    }

    fn watch_local(&self, app: AppHandle, mut cli: OpenClawCli, generation: u64) {
        let state = self.clone();
        thread::spawn(move || loop {
            thread::sleep(CONNECTED_WATCH_INTERVAL);
            if !state.watchdog_is_current(generation) {
                return;
            }
            let Ok(_operation) = state.inner.operation.try_lock() else {
                continue;
            };
            let snapshot = match gateway::status(&cli) {
                Ok(snapshot) => snapshot,
                Err(error) => GatewaySnapshot::reconnecting(error),
            };
            if snapshot.reachable {
                state.update_tray(&snapshot);
                if let Err(error) =
                    state.restore_healthy_local_dashboard(&app, &cli, snapshot, generation)
                {
                    eprintln!("Could not restore the local dashboard: {error}");
                }
                drop(_operation);
                // Pairing polls ride connected watchdog ticks; the reconnect loop never runs them.
                state.poll_pending_approvals(&app, &cli, generation);
                continue;
            }

            // Onboarding keeps verification and guided-session state in its live page. Latch it
            // for this outage so neither recovery screen nor dashboard reload erases that state.
            let preserve_dashboard = main_window(&app)
                .ok()
                .and_then(|window| window.url().ok())
                .is_some_and(|url| is_active_onboarding_url(&url));
            let mut displayed_phase = snapshot.phase;
            if !preserve_dashboard
                && matches!(
                    state.show_local(&app, local_mode(&snapshot), false, Some(generation)),
                    Ok(false)
                )
            {
                return;
            }
            state.update_tray(&snapshot);
            drop(_operation);
            loop {
                if !state.watchdog_is_current(generation) {
                    return;
                }
                if let Ok(_operation) = state.inner.operation.try_lock() {
                    if !cli.is_available() {
                        match state.resolve_cli() {
                            Ok(discovered) => cli = discovered,
                            Err(error) => {
                                if matches!(error, CliError::Missing) {
                                    let _ = state.show_missing_cli(&app, false, Some(generation));
                                } else {
                                    state.show_cli_recovery_error(&app, generation, error);
                                }
                                return;
                            }
                        }
                    }
                    let snapshot = match gateway::status(&cli) {
                        Ok(snapshot) => snapshot,
                        Err(error) => GatewaySnapshot::reconnecting(error),
                    };
                    state.update_tray(&snapshot);
                    if snapshot.reachable {
                        if let Ok(ready) = gateway::dashboard(&cli, snapshot) {
                            app.state::<gateway_ws::GatewayClient>()
                                .configure(&app, ready.gateway_ws.clone());
                            if preserve_dashboard {
                                state.update_tray(&ready.snapshot);
                                break;
                            }
                            match state.navigate_local(
                                &app,
                                &ready.dashboard_url,
                                false,
                                Some(generation),
                                false,
                                true,
                            ) {
                                Ok(true) => {
                                    state.update_tray(&ready.snapshot);
                                    break;
                                }
                                Ok(false) => return,
                                Err(_) => {}
                            }
                        }
                    } else if !preserve_dashboard && snapshot.phase != displayed_phase {
                        displayed_phase = snapshot.phase;
                        if matches!(
                            state.show_local(&app, local_mode(&snapshot), false, Some(generation),),
                            Ok(false)
                        ) {
                            return;
                        }
                    }
                }
                thread::sleep(RECONNECT_INTERVAL);
            }
        });
    }
}

fn local_mode(snapshot: &GatewaySnapshot) -> &'static str {
    if snapshot.phase == "stopped" {
        "stopped"
    } else {
        "reconnecting"
    }
}

fn local_recovery_owns_gateway(navigation: &Result<bool, String>) -> bool {
    !matches!(navigation, Ok(false))
}

#[cfg(test)]
mod navigation_tests {
    use super::{
        is_active_onboarding_url, is_release_version, local_mode, local_recovery_owns_gateway,
        GatewayAction, GatewayOperationQueue, GatewaySnapshot, NavigationState,
        SettingsReturnTarget, Url,
    };

    fn remote_target() -> SettingsReturnTarget {
        SettingsReturnTarget::Remote(Url::parse("https://gateway.example.com/").unwrap())
    }

    #[test]
    fn dashboard_handoff_consumes_editor_without_retiring_pending_preparation() {
        for remote in [false, true] {
            let mut navigation = NavigationState::default();
            if remote {
                navigation.select_remote();
            }
            let previous_watchdog = navigation.watch_generation;
            let target = if remote {
                remote_target()
            } else {
                SettingsReturnTarget::Local(Url::parse("tauri://localhost/?mode=stopped").unwrap())
            };
            navigation.begin_settings(10, target).unwrap();
            let generation = navigation.watch_generation;
            navigation.remote_snapshot = Some(GatewaySnapshot::remote_error("SSH closed"));
            navigation.settings_return.as_mut().unwrap().failure =
                Some(GatewaySnapshot::remote_error("Edited connection failed"));
            navigation.mark_onboarding_pending();

            assert_eq!(
                navigation.finish_settings_handoff(),
                (!remote).then_some(generation)
            );
            assert!(navigation.settings_return.is_none());
            assert_eq!(navigation.watch_generation, generation);
            assert_eq!(navigation.retired_preparation, Some(10));
            assert!(!navigation.preparation_is_current(generation, 10));
            assert!(navigation.preparation_is_current(generation, 11));
            assert!(navigation.onboarding_pending);
            assert_eq!(navigation.remote_snapshot.is_some(), remote);
            if remote {
                assert!(navigation.remote_page_is_current(generation));
            } else {
                assert!(navigation.watchdog_is_current(generation));
                assert!(!navigation.watchdog_is_current(previous_watchdog));
            }
            assert_eq!(navigation.finish_settings_handoff(), None);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn desktop_quit_claim_requires_current_route_and_has_one_teardown_owner() {
        let gateway = crate::gateway_ws::GatewayClient::new();
        let (generation, _) = gateway.desktop_state();
        for normal_quit_first in [false, true] {
            let state = super::DesktopState::new(Url::parse("tauri://localhost/").unwrap());
            state
                .inner
                .navigation
                .lock()
                .unwrap()
                .begin_settings(
                    10,
                    SettingsReturnTarget::Local(Url::parse("tauri://localhost/").unwrap()),
                )
                .unwrap();
            assert!(gateway
                .with_desktop_route(generation.wrapping_add(1), |_| Ok(state.claim_quit()))
                .is_err());
            assert!(!state.is_quitting());
            if normal_quit_first {
                assert!(state.claim_quit());
            }
            assert_eq!(
                gateway
                    .with_desktop_route(generation, |_| Ok(state.claim_quit()))
                    .unwrap(),
                !normal_quit_first
            );
            assert!(state.is_quitting());
            assert!(!state.claim_quit());
            // Claim must not take NAV or start teardown under the route guard.
            assert!(state
                .inner
                .navigation
                .lock()
                .unwrap()
                .settings_return
                .is_some());
        }
    }

    #[test]
    fn unknown_gateway_status_keeps_recovery_active() {
        let unknown = GatewaySnapshot::reconnecting("Gateway service inspection failed.");
        assert_eq!(local_mode(&unknown), "reconnecting");

        let stopped = GatewaySnapshot {
            phase: "stopped",
            status: "Stopped".to_string(),
            detail: None,
            ..unknown
        };
        assert_eq!(local_mode(&stopped), "stopped");
    }

    #[test]
    fn only_active_onboarding_preserves_the_dashboard_during_reconnect() {
        for (url, preserve) in [
            ("http://127.0.0.1/settings/model-setup?firstRun=1", true),
            (
                "http://127.0.0.1/settings/model-setup?firstRun=explicit",
                true,
            ),
            (
                "http://127.0.0.1/openclaw/settings/model-setup/?tab=ai&firstRun=1#token=redacted",
                true,
            ),
            ("http://127.0.0.1/settings/model-setup", false),
            ("http://127.0.0.1/settings/model-setup?firstRun=0", false),
            (
                "http://127.0.0.1/settings/model-setup?firstRun=0&firstRun=1",
                false,
            ),
            ("http://127.0.0.1/settings/providers?firstRun=1", false),
            ("http://127.0.0.1/custodian?onboarding=1", true),
            (
                "http://127.0.0.1/openclaw/custodian/?tab=chat&onboarding=YES",
                true,
            ),
            ("http://127.0.0.1/custodian", false),
            ("http://127.0.0.1/custodian?onboarding=0", false),
            (
                "http://127.0.0.1/custodian?onboarding=0&onboarding=1",
                false,
            ),
            ("http://127.0.0.1/chat?onboarding=1", false),
        ] {
            assert_eq!(
                is_active_onboarding_url(&Url::parse(url).expect("dashboard URL")),
                preserve,
                "unexpected reconnect policy for {url}"
            );
        }
    }

    #[test]
    fn committed_package_version_is_a_development_build() {
        assert!(!is_release_version("0.1.0"));
    }

    #[test]
    fn stamped_package_versions_are_release_builds() {
        assert!(is_release_version("2026.7.2"));
        assert!(is_release_version("2026.7.2-beta.1"));
    }

    #[test]
    fn newer_remote_selection_blocks_older_local_navigation() {
        let mut navigation = NavigationState::default();
        assert!(navigation.permit_local(false, None));

        navigation.select_remote();

        assert!(!navigation.permit_local(false, None));
        assert!(navigation.remote_dashboard);
    }

    #[test]
    fn newer_remote_selection_invalidates_watchdog_navigation() {
        let mut navigation = NavigationState::default();
        let watchdog = navigation.begin_watchdog().expect("watchdog generation");

        navigation.select_remote();

        assert!(!navigation.permit_local(false, Some(watchdog)));
        assert!(!navigation.watchdog_is_current(watchdog));
    }

    #[test]
    fn healthy_watchdog_only_replaces_owned_local_recovery_pages() {
        let local = Url::parse("tauri://localhost/").unwrap();
        let mut navigation = NavigationState::default();
        let generation = navigation.begin_watchdog().unwrap();
        for (url, restore) in [
            ("tauri://localhost/?mode=stopped", true),
            ("tauri://localhost/?mode=reconnecting", true),
            ("tauri://localhost/?mode=connectionSettings", false),
            ("tauri://localhost/?mode=remoteError", false),
            ("tauri://localhost/?mode=missingCli", false),
            ("tauri://localhost/", false),
            ("tauri://localhost/other?mode=stopped", false),
            ("tauri://other/?mode=stopped", false),
            ("http://127.0.0.1:18789/?mode=stopped", false),
            (
                "http://127.0.0.1:18789/settings/model-setup?firstRun=explicit",
                false,
            ),
        ] {
            let current = Url::parse(url).unwrap();
            assert_eq!(
                navigation.watchdog_recovery_is_current(generation, &local, &current, &current),
                restore,
                "{url}"
            );
        }
    }

    #[test]
    fn healthy_watchdog_resolution_cannot_replace_a_newer_owner_or_page() {
        let local = Url::parse("tauri://localhost/").unwrap();
        let stopped = Url::parse("tauri://localhost/?mode=stopped").unwrap();
        let reconnecting = Url::parse("tauri://localhost/?mode=reconnecting").unwrap();
        for change in ["generation", "settings", "remote", "page"] {
            let mut navigation = NavigationState::default();
            let generation = navigation.begin_watchdog().unwrap();
            assert!(navigation.watchdog_recovery_is_current(generation, &local, &stopped, &stopped));
            let current = match change {
                "generation" => {
                    navigation.cancel_watchdog();
                    &stopped
                }
                "settings" => {
                    navigation
                        .begin_settings(1, SettingsReturnTarget::Local(stopped.clone()))
                        .unwrap();
                    &stopped
                }
                "remote" => {
                    navigation.select_remote();
                    &stopped
                }
                _ => &reconnecting,
            };
            assert!(
                !navigation.watchdog_recovery_is_current(generation, &local, &stopped, current),
                "{change}"
            );
        }
    }

    #[test]
    fn local_settings_suspend_monitoring_without_selecting_remote() {
        let mut navigation = NavigationState::default();
        let watchdog = navigation.begin_watchdog().expect("local monitor");
        let dashboard = Url::parse("http://127.0.0.1:18789/chat").unwrap();
        navigation
            .begin_settings(4, SettingsReturnTarget::Local(dashboard.clone()))
            .unwrap();

        assert!(!navigation.remote_dashboard);
        assert!(!navigation.watchdog_is_current(watchdog));
        assert!(!navigation.permit_local(false, None));
        assert!(navigation.begin_watchdog().is_none());
        let generation = navigation.watch_generation;
        navigation.begin_settings(4, remote_target()).unwrap();
        let retained = navigation.settings_return.as_ref().unwrap();
        assert_eq!(retained.target, SettingsReturnTarget::Local(dashboard));
        assert_eq!(retained.generation, generation);
        assert_eq!(navigation.watch_generation, generation);
    }

    #[test]
    fn remote_settings_preserve_the_committed_page_callback_owner() {
        let mut navigation = NavigationState::default();
        navigation.select_remote();
        let generation = navigation.watch_generation;
        navigation.begin_settings(8, remote_target()).unwrap();
        navigation.begin_settings(8, remote_target()).unwrap();

        assert!(navigation.remote_dashboard);
        assert_eq!(navigation.watch_generation, generation);
        assert_eq!(navigation.retired_preparation, Some(8));
        assert!(navigation.begin_watchdog().is_none());
    }

    #[test]
    fn remote_settings_retain_the_open_session_through_projection_and_failed_edit() {
        let mut navigation = NavigationState::default();
        navigation.select_remote();
        let generation = navigation.watch_generation;
        let session = SettingsReturnTarget::Remote(
            Url::parse("https://gateway.example.com/chat?session=agent%3Amain%3Afixture").unwrap(),
        );
        navigation.begin_settings(4, session.clone()).unwrap();
        navigation.begin_settings(5, remote_target()).unwrap();
        navigation.record_remote_failure(GatewaySnapshot::remote_error("failed edit"), None);

        let previous = navigation.settings_return.as_ref().unwrap();
        assert_eq!(previous.target, session);
        assert_eq!(previous.generation, generation);
        assert_eq!(navigation.retired_preparation, Some(4));
        assert_eq!(navigation.settings_detail().as_deref(), Some("failed edit"));
        assert!(navigation.finish_settings_return().is_none());
        assert!(navigation.settings_return.is_none());
        assert!(navigation.remote_page_is_current(generation));
    }

    #[test]
    fn settings_retire_prepared_remote_effects_even_after_return() {
        for returned in [false, true] {
            let mut navigation = NavigationState::default();
            navigation.select_remote();
            let page_generation = navigation.watch_generation;
            // Intent 8 is a retry; the existing page still belongs to intent 7.
            navigation.begin_settings(8, remote_target()).unwrap();
            if returned {
                navigation.settings_return = None;
            }
            let mut published = false;
            let result = navigation.while_preparing(page_generation, 8, |navigation| {
                published = true;
                navigation.select_remote();
                Ok(())
            });
            assert!(result.is_err(), "retired preparation must not commit");
            assert!(
                !published,
                "config, tunnel, client and navigation share this gate"
            );
            assert_eq!(navigation.watch_generation, page_generation);
            assert!(navigation.remote_dashboard);
        }
    }

    #[test]
    fn fresh_settings_submission_can_publish_without_reviving_older_preparation() {
        let mut navigation = NavigationState::default();
        navigation.select_remote();
        let generation = navigation.watch_generation;
        navigation.begin_settings(8, remote_target()).unwrap();
        navigation.begin_settings(8, remote_target()).unwrap();
        assert_eq!(navigation.watch_generation, generation);
        assert!(navigation
            .while_preparing(generation, 8, |_| Ok(()))
            .is_err());
        navigation
            .while_preparing(generation, 9, |navigation| {
                navigation.select_remote();
                Ok(())
            })
            .unwrap();
        assert!(navigation.settings_return.is_none());
    }

    #[test]
    fn settings_projection_does_not_adopt_a_new_request_as_its_return_target() {
        let mut navigation = NavigationState::default();
        let dashboard = Url::parse("http://127.0.0.1:18789/chat").unwrap();
        navigation
            .begin_settings(4, SettingsReturnTarget::Local(dashboard.clone()))
            .unwrap();
        navigation.begin_settings(5, remote_target()).unwrap();
        let retained = navigation.settings_return.as_ref().unwrap();
        assert_eq!(retained.target, SettingsReturnTarget::Local(dashboard));
        assert_eq!(navigation.retired_preparation, Some(4));
        navigation.select_remote();
        assert!(navigation.settings_return.is_none());
    }

    #[test]
    fn local_start_and_restart_do_not_retire_the_visible_settings_return() {
        for action in [GatewayAction::Start, GatewayAction::Restart] {
            for target in [
                SettingsReturnTarget::Local(Url::parse("tauri://localhost/?mode=stopped").unwrap()),
                SettingsReturnTarget::SavedGateway,
            ] {
                let queue = GatewayOperationQueue::new(
                    |_, _| Ok(GatewaySnapshot::remote_opening()),
                    |_| {},
                );
                let mut navigation = NavigationState::default();
                navigation.begin_settings(0, target.clone()).unwrap();
                let generation = navigation.watch_generation;
                queue.submit_action(action);
                assert_eq!(queue.current_selection(), 1);
                assert!(!navigation.permit_local(false, None));
                assert!(navigation.permits_local_completion(false));
                assert!(navigation.begin_watchdog().is_none());
                navigation.begin_settings(1, remote_target()).unwrap();
                let previous = navigation.settings_return.as_ref().unwrap();
                assert_eq!(previous.target, target);
                assert_eq!(previous.generation, generation);
                assert_eq!(navigation.retired_preparation, Some(0));
                assert!(navigation.finish_settings_return().is_some());
                assert!(navigation.settings_return.is_none());
            }
        }
    }

    #[test]
    fn local_completion_rejects_remote_quitting_and_expired_settings_owners() {
        let mut navigation = NavigationState::default();
        assert!(navigation.permits_local_completion(false));
        assert!(!navigation.permits_local_completion(true));
        navigation.select_remote();
        assert!(!navigation.permits_local_completion(false));

        for target in [
            remote_target(),
            SettingsReturnTarget::Local(Url::parse("tauri://localhost/?mode=remoteError").unwrap()),
        ] {
            let mut navigation = NavigationState::default();
            navigation.begin_settings(0, target).unwrap();
            assert!(!navigation.permits_local_completion(false));
        }

        let mut navigation = NavigationState::default();
        navigation
            .begin_settings(
                0,
                SettingsReturnTarget::Local(Url::parse("tauri://localhost/?mode=stopped").unwrap()),
            )
            .unwrap();
        assert!(!navigation.permits_local_completion(true));
        navigation.watch_generation = navigation.watch_generation.wrapping_add(1);
        assert!(!navigation.permits_local_completion(false));
    }

    #[test]
    fn settings_back_preserves_local_and_remote_pending_save_ordering() {
        for remote in [false, true] {
            let mut navigation = NavigationState::default();
            if remote {
                navigation.select_remote();
            }
            let target = if remote {
                remote_target()
            } else {
                SettingsReturnTarget::Local(Url::parse("tauri://localhost/?mode=stopped").unwrap())
            };
            navigation.begin_settings(8, target.clone()).unwrap();
            let generation = navigation.watch_generation;
            // A repeated projection during Save does not recapture its target
            // or retire the newer preparation.
            navigation.begin_settings(9, remote_target()).unwrap();
            assert_eq!(navigation.retired_preparation, Some(8));
            assert_eq!(navigation.settings_return.as_ref().unwrap().target, target);
            navigation.finish_settings_return();
            let mut committed = false;
            let result = navigation.while_preparing(generation, 9, |navigation| {
                committed = true;
                navigation.select_remote();
                Ok(())
            });
            assert_eq!(result.is_ok(), remote);
            assert_eq!(committed, remote);
            assert!(navigation.settings_return.is_none());
        }
    }

    #[test]
    fn retired_settings_context_cannot_be_restored() {
        for explicit_local in [false, true] {
            let mut navigation = NavigationState::default();
            navigation.select_remote();
            navigation.begin_settings(4, remote_target()).unwrap();
            let generation = navigation.watch_generation;
            if explicit_local {
                navigation.permit_local(true, None);
            } else {
                // Stop and Quit use this same presentation retirement owner.
                navigation.cancel_watchdog();
            }
            assert!(navigation.settings_return.is_none());
            assert_ne!(navigation.watch_generation, generation);
            assert!(navigation.finish_settings_return().is_none());
            assert!(navigation.settings_return.is_none());
        }
    }

    #[test]
    fn latest_failed_preparation_preserves_the_settings_return_target() {
        for remote in [false, true] {
            let queue = GatewayOperationQueue::new(|_, _| unreachable!(), |_| {});
            let mut navigation = NavigationState::default();
            if remote {
                navigation.select_remote();
            }
            let dashboard = Url::parse("http://127.0.0.1:18789/chat").unwrap();
            let target = if remote {
                SettingsReturnTarget::Remote(dashboard)
            } else {
                SettingsReturnTarget::Local(dashboard)
            };
            navigation.begin_settings(0, target.clone()).unwrap();
            let generation = navigation.watch_generation;
            // Save and Retry share failure publication after a fresh intent.
            queue.invalidate_recovery();
            navigation.begin_settings(1, remote_target()).unwrap();
            queue
                .while_current(1, || {
                    navigation.record_remote_failure(
                        GatewaySnapshot::remote_error("fixture".to_string()),
                        None,
                    );
                })
                .unwrap();
            navigation.begin_settings(1, remote_target()).unwrap();
            let previous = navigation.settings_return.as_ref().unwrap();
            assert_eq!(previous.generation, generation);
            assert_eq!(previous.target, target);
            assert_eq!(navigation.watch_generation, generation);
            assert_eq!(navigation.remote_dashboard, remote);
            assert_eq!(navigation.retired_preparation, Some(0));
            assert!(
                navigation.remote_snapshot.is_none(),
                "an editor failure must not replace committed route health"
            );
            assert_eq!(navigation.settings_detail().as_deref(), Some("fixture"));
        }
    }

    #[test]
    fn failed_edit_return_preserves_committed_callback_and_passive_open_authority() {
        let queue = GatewayOperationQueue::new(|_, _| unreachable!(), |_| {});
        let mut navigation = NavigationState::default();
        navigation.select_remote();
        let generation = navigation.watch_generation;
        navigation.begin_settings(0, remote_target()).unwrap();
        queue.invalidate_recovery();
        queue
            .while_current(1, || {
                navigation.record_remote_failure(
                    GatewaySnapshot::remote_error("failed retry".to_string()),
                    None,
                )
            })
            .unwrap();
        assert!(navigation
            .record_remote_page_load(generation, true)
            .is_none());
        assert!(navigation.finish_settings_return().is_none());
        assert!(!queue.selection_is_current(0));
        assert!(navigation.remote_page_is_current(generation));
        let snapshot = navigation
            .record_remote_page_load(generation, true)
            .unwrap();
        assert_eq!(snapshot.phase, "remoteDashboard");
        assert!(
            !snapshot.running,
            "document load does not prove authentication"
        );
        navigation.select_remote();
        assert!(!navigation.remote_page_is_current(generation));
        assert!(navigation
            .record_remote_page_load(generation, true)
            .is_none());
    }

    #[test]
    fn returning_from_settings_preserves_newer_child_failure_not_entry_health() {
        let mut navigation = NavigationState::default();
        navigation.select_remote();
        let generation = navigation.watch_generation;
        navigation
            .record_remote_page_load(generation, true)
            .unwrap();
        navigation.begin_settings(0, remote_target()).unwrap();
        navigation.record_remote_failure(
            GatewaySnapshot::remote_error("failed edit".to_string()),
            None,
        );
        navigation.record_remote_failure(
            GatewaySnapshot::remote_error("current SSH child closed".to_string()),
            Some(7),
        );
        assert_eq!(
            navigation.settings_return.as_ref().unwrap().generation,
            generation
        );
        assert_eq!(navigation.settings_detail().as_deref(), Some("failed edit"));
        navigation.finish_settings_return();
        assert_eq!(
            navigation
                .remote_snapshot
                .as_ref()
                .unwrap()
                .detail
                .as_deref(),
            Some("current SSH child closed")
        );
        assert!(navigation
            .record_remote_page_load(generation, true)
            .is_none());
    }

    #[test]
    fn local_settings_return_drops_failed_edit_feedback_without_rewriting_the_target() {
        for mode in ["missingCli", "stopped", "reconnecting", "remoteError"] {
            let mut navigation = NavigationState::default();
            let target = Url::parse(&format!("tauri://localhost/?mode={mode}")).unwrap();
            if mode == "remoteError" {
                navigation.remote_snapshot = Some(GatewaySnapshot::remote_error(
                    "saved route failed".to_string(),
                ));
            }
            navigation
                .begin_settings(0, SettingsReturnTarget::Local(target.clone()))
                .unwrap();
            navigation.record_remote_failure(
                GatewaySnapshot::remote_error("failed edit".to_string()),
                None,
            );
            assert_eq!(
                navigation.settings_return.as_ref().unwrap().target,
                SettingsReturnTarget::Local(target.clone())
            );
            let monitor = navigation.finish_settings_return();
            if mode == "remoteError" {
                assert!(monitor.is_none());
                assert_eq!(
                    navigation.settings_detail().as_deref(),
                    Some("saved route failed")
                );
            } else {
                assert!(monitor.is_some());
                assert!(navigation.remote_snapshot.is_none());
                assert!(navigation.settings_detail().is_none());
            }
            navigation
                .begin_settings(1, SettingsReturnTarget::Local(target.clone()))
                .unwrap();
            assert_eq!(
                navigation.settings_return.as_ref().unwrap().target,
                SettingsReturnTarget::Local(target)
            );
        }
    }

    #[test]
    fn failed_preparation_cannot_adopt_a_newer_intent_or_page() {
        let queue = GatewayOperationQueue::new(|_, _| unreachable!(), |_| {});
        let mut navigation = NavigationState::default();
        let target =
            SettingsReturnTarget::Local(Url::parse("tauri://localhost/?mode=remoteError").unwrap());
        navigation.begin_settings(0, target.clone()).unwrap();
        queue.invalidate_recovery();
        queue.invalidate_recovery();
        assert!(queue
            .while_current(1, || {
                navigation.record_remote_failure(
                    GatewaySnapshot::remote_error("older failure".to_string()),
                    None,
                );
            })
            .is_none());
        navigation.begin_settings(2, target).unwrap();
        assert!(navigation
            .settings_return
            .as_ref()
            .unwrap()
            .failure
            .is_none());

        navigation.record_remote_failure(
            GatewaySnapshot::remote_error("same-route recovery".to_string()),
            Some(7),
        );
        assert!(navigation
            .settings_return
            .as_ref()
            .unwrap()
            .failure
            .is_none());

        navigation.watch_generation += 1;
        navigation.record_remote_failure(
            GatewaySnapshot::remote_error("different page".to_string()),
            None,
        );
        assert!(navigation
            .settings_return
            .as_ref()
            .unwrap()
            .failure
            .is_none());
        navigation.settings_return = None;
        navigation.record_remote_failure(
            GatewaySnapshot::remote_error("no settings".to_string()),
            None,
        );
        assert!(navigation.settings_return.is_none());
    }

    #[test]
    fn remote_failure_without_a_committed_handle_still_publishes() {
        for remote in [false, true] {
            let mut navigation = NavigationState::default();
            if remote {
                navigation.select_remote();
            }
            assert!(navigation.record_remote_failure(
                GatewaySnapshot::remote_error("no committed dashboard".to_string()),
                None,
            ));
            assert_eq!(
                navigation.remote_snapshot.as_ref().unwrap().phase,
                "remoteError"
            );
        }
    }

    #[test]
    fn explicit_local_then_later_remote_preserves_latest_intent() {
        let mut navigation = NavigationState::default();
        navigation.select_remote();
        assert!(navigation.permit_local(true, None));
        assert!(!navigation.remote_dashboard);

        navigation.select_remote();

        assert!(!navigation.permit_local(false, None));
        assert!(navigation.remote_dashboard);
    }

    #[test]
    fn local_recovery_clears_retained_gateway_unless_remote_navigation_won() {
        assert!(local_recovery_owns_gateway(&Ok(true)));
        assert!(local_recovery_owns_gateway(&Err(
            "local navigation failed".to_string()
        )));
        assert!(!local_recovery_owns_gateway(&Ok(false)));
    }

    #[test]
    fn first_run_url_preserves_gateway_base_path_query_and_auth_fragment() {
        let mut navigation = NavigationState::default();
        navigation.mark_onboarding_pending();

        let url = navigation
            .prepare_dashboard_url(
                "http://127.0.0.1:18789/openclaw/?foo=bar&firstRun=1#token=secret",
            )
            .expect("dashboard URL");

        assert_eq!(url.path(), "/openclaw/settings/model-setup");
        assert_eq!(url.query(), Some("foo=bar&firstRun=explicit"));
        assert_eq!(url.fragment(), Some("token=secret"));
    }

    #[test]
    fn first_run_model_setup_is_opened_only_once() {
        let mut navigation = NavigationState::default();
        navigation.mark_onboarding_pending();

        let first = navigation
            .prepare_dashboard_url("http://127.0.0.1:18789/#token=secret")
            .expect("first dashboard URL");
        let second = navigation
            .prepare_dashboard_url("http://127.0.0.1:18789/#token=secret")
            .expect("second dashboard URL");

        assert_eq!(first.path(), "/settings/model-setup");
        assert_eq!(first.query(), Some("firstRun=explicit"));
        assert!(is_active_onboarding_url(&first));
        assert_eq!(second.path(), "/");
        assert_eq!(second.query(), None);
        assert!(!is_active_onboarding_url(&second));
    }

    #[test]
    fn regular_navigation_has_no_onboarding_marker() {
        let mut navigation = NavigationState::default();

        let url = navigation
            .prepare_dashboard_url("http://127.0.0.1:18789/?foo=bar#token=secret")
            .expect("dashboard URL");

        assert_eq!(url.query(), Some("foo=bar"));
        assert_eq!(url.fragment(), Some("token=secret"));
    }
}

fn main_window(app: &AppHandle) -> Result<Webview, String> {
    app.get_webview("main")
        .ok_or_else(|| "Main window is unavailable.".to_string())
}

pub(crate) async fn confirm_gateway_primary(app: &AppHandle, name: &str) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "Set {name} as Primary? Quick Chat and the desktop connection will use this Gateway. Other saved Gateway windows stay open."
        ))
        .title("Change Primary Gateway")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Set as Primary".into(),
            "Cancel".into(),
        ))
        .show(move |accepted| {
            let _ = sender.send(accepted);
        });
    receiver
        .await
        .map_err(|_| "Primary Gateway confirmation was closed.".into())
}

pub(crate) async fn promote_gateway_profile(
    app: &AppHandle,
    request: RemoteGatewayRequest,
    guard: gateway_windows::PromotionGuard,
) -> Result<(), String> {
    app.state::<GatewayOperationQueue>()
        .execute(GatewayOperation::PromoteProfile { request, guard })
        .await
        .map(|_| ())
}

// Called on the native thread after the window owner retires the failed document.
pub(crate) fn recover_primary_navigation(
    app: &AppHandle,
    failed_label: &str,
    error: &str,
    present: bool,
) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    if state.is_quitting() {
        return Ok(());
    }
    let snapshot = GatewaySnapshot::remote_error(error.to_string());
    if failed_label != "main" {
        if present {
            state.show_connection_settings(app)?;
        }
        let mut navigation = state.inner.navigation.lock().expect("navigation");
        navigation.record_remote_failure(snapshot.clone(), None);
        drop(navigation);
        state.update_tray(&snapshot);
        if !present {
            notify::notify(app, "Primary Gateway unavailable", error);
        }
        return Ok(());
    }

    let mut navigation = state.inner.navigation.lock().expect("navigation");
    let mut recovery = state.inner.local_url.clone();
    recovery
        .query_pairs_mut()
        .clear()
        .append_pair("mode", "remoteError");
    // Back must return to local recovery, never to the failed browser document.
    navigation.settings_return = None;
    navigation.begin_settings(
        app.state::<GatewayOperationQueue>().current_selection(),
        SettingsReturnTarget::Local(recovery),
    )?;
    navigation.record_remote_failure(snapshot.clone(), None);
    navigation.remote_snapshot = Some(snapshot.clone());
    let mut settings = state.inner.local_url.clone();
    settings
        .query_pairs_mut()
        .clear()
        .append_pair("mode", "connectionSettings");
    app.state::<native_browser_bridge::NativeBrowserBridgeState>()
        .clear(app);
    replace_main_webview(app, settings, None, None)?;
    drop(navigation);
    state.update_tray(&snapshot);
    if present {
        tray::show_window(app);
    }
    Ok(())
}

pub(crate) fn replace_dashboard_webview(
    app: &AppHandle,
    url: Url,
    auth_script: Option<String>,
    target: &str,
) -> Result<Webview, String> {
    let bridge = app.state::<native_browser_bridge::NativeBrowserBridgeState>();
    let script = bridge
        .select(app, &url, true)?
        .ok_or("Could not prepare the dashboard.")?;
    replace_main_webview_for_target(
        app,
        url,
        Some(format!("{}\n{script}", auth_script.unwrap_or_default())),
        None,
        Some(target),
    )
}

fn replace_main_webview(
    app: &AppHandle,
    url: Url,
    initialization_script: Option<String>,
    remote_generation: Option<u64>,
) -> Result<Webview, String> {
    let target = initialization_script
        .as_ref()
        .map(|_| gateway_windows::PRIMARY);
    replace_main_webview_for_target(app, url, initialization_script, remote_generation, target)
}

fn replace_main_webview_for_target(
    app: &AppHandle,
    url: Url,
    initialization_script: Option<String>,
    remote_generation: Option<u64>,
    target: Option<&str>,
) -> Result<Webview, String> {
    let window = app
        .get_window("main")
        .ok_or("Main window is unavailable.")?;
    let previous = app.get_webview("main");
    if let Some(previous) = &previous {
        window_chrome::loading(previous);
    }
    let size = window
        .inner_size()
        .map_err(|error| format!("Could not measure the dashboard: {error}"))?;
    // Replace only the dashboard document, retaining the native window, tray and geometry.
    if let Some(previous) = previous {
        native_browser_platform::detach_surface(&previous)?;
        previous
            .close()
            .map_err(|error| format!("Could not replace the dashboard: {error}"))?;
    }
    let browser_app = app.clone();
    let document_token = app
        .state::<native_browser_bridge::NativeBrowserBridgeState>()
        .document_token();
    let routes = app.state::<gateway_windows::GatewayWindows>();
    let registration = target
        .map(|target| routes.prepare_document(app, "main", target, &url))
        .transpose()?;
    if registration.is_none() {
        if routes.main_has_selected_gateway()
            && app
                .state::<DesktopState>()
                .main_window_has_connection_settings_url(&url)
        {
            routes.suspend_document(app, "main");
        } else {
            routes.closed(app, "main");
        }
    }
    let mut script =
        initialization_script.unwrap_or_else(|| window_chrome::initialization_script(None, true));
    if let Some(registration) = &registration {
        script.push('\n');
        script.push_str(&registration.script);
    }
    let initial_url = registration
        .as_ref()
        .map_or(WebviewUrl::External(url), |registration| {
            registration.initial_url()
        });
    let builder = WebviewBuilder::new("main", initial_url)
        .incognito(target.is_some_and(|target| target != gateway_windows::PRIMARY))
        .initialization_script(script)
        .on_new_window(move |url, _| {
            open_external_browser(&browser_app, &url);
            NewWindowResponse::Deny
        });
    let builder = match &registration {
        Some(registration) => registration.configure(builder),
        None => builder,
    };
    let startup_registration = registration.clone();
    let readiness_token = document_token.clone();
    let builder = builder
        .on_page_load(move |webview, payload| {
            let loaded = matches!(payload.event(), PageLoadEvent::Finished);
            let app = webview.app_handle().clone();
            if let Some(registration) = &registration {
                registration.page_load(webview.clone(), payload.url(), !loaded);
                if payload.url().as_str() == "about:blank" || loaded {
                    return;
                }
            } else {
                gateway_windows::local_page_load(webview.clone(), payload.url(), !loaded);
            }
            native_browser_bridge::page_load(webview, !loaded, document_token.as_deref());
            if remote_generation.is_some() && !loaded {
                let state = app.state::<DesktopState>().inner().clone();
                let current_app = app.clone();
                let expected_document = document_token.clone();
                let on_load = move || {
                    if state.is_quitting()
                        || current_app
                            .state::<native_browser_bridge::NativeBrowserBridgeState>()
                            .document_token()
                            != expected_document
                    {
                        return;
                    }
                    let mut navigation = state.inner.navigation.lock().expect("navigation");
                    let snapshot = remote_generation.and_then(|generation| {
                        navigation.record_remote_page_load(generation, false)
                    });
                    drop(navigation);
                    if let Some(snapshot) = snapshot {
                        state.update_tray(&snapshot);
                    }
                };
                // Wry can invoke this while the caller still holds navigation guards.
                #[cfg(target_os = "linux")]
                gtk::glib::idle_add_once(on_load);
                #[cfg(not(target_os = "linux"))]
                tauri::async_runtime::spawn(async move {
                    let _ = app.run_on_main_thread(on_load);
                });
            }
        })
        .auto_resize();
    let view = window
        .add_child(builder, LogicalPosition::new(0, 0), size)
        .and_then(|view| {
            #[cfg(target_os = "macos")]
            window_chrome_macos::install_webview(&view)?;
            window_chrome::observe_history(&view);
            Ok(view)
        })
        .map_err(|error| format!("Could not open the dashboard: {error}"))?;
    if let Some(registration) = startup_registration {
        registration.start(view.clone(), move |view| {
            dashboard_document_ready(view, readiness_token.as_deref(), remote_generation);
        });
    }
    Ok(view)
}

fn dashboard_document_ready(
    view: &Webview,
    document_token: Option<&str>,
    remote_generation: Option<u64>,
) {
    let app = view.app_handle();
    let state = app.state::<DesktopState>();
    if state.is_quitting()
        || document_token.is_none()
        || app
            .state::<native_browser_bridge::NativeBrowserBridgeState>()
            .document_token()
            .as_deref()
            != document_token
        || !view.url().is_ok_and(|url| {
            app.state::<gateway_windows::GatewayWindows>()
                .authorized_source("main", &url)
        })
    {
        return;
    }
    native_browser_bridge::page_load(view.clone(), false, document_token);
    let mut navigation = state.inner.navigation.lock().expect("navigation");
    let monitor = navigation.finish_settings_handoff();
    let snapshot = remote_generation
        .and_then(|generation| navigation.record_remote_page_load(generation, true));
    drop(navigation);
    if let Some(snapshot) = snapshot {
        state.update_tray(&snapshot);
    }
    if let Some(generation) = monitor {
        let cli = state.inner.cli.lock().expect("CLI mutex poisoned").clone();
        if let Some(cli) = cli {
            state.watch_local(app.clone(), cli, generation);
        }
    }
}

#[tauri::command]
fn build_info(app: AppHandle) -> BuildInfo {
    let version = app.package_info().version.to_string();
    BuildInfo {
        release_build: is_release_version(&version),
        version,
        platform: std::env::consts::OS,
    }
}

#[tauri::command]
async fn bootstrap(
    app: AppHandle,
    state: State<'_, DesktopState>,
    operations: State<'_, GatewayOperationQueue>,
    explicit_local: Option<bool>,
    connection_settings: Option<bool>,
    remote_retry: Option<bool>,
) -> Result<BootstrapReply, String> {
    if connection_settings == Some(true) {
        state.on_main(&app, |state, app| {
            state.enter_connection_settings(&app, false)
        })?;
        return Ok(BootstrapReply::Settings {
            remote: remote_gateway::saved_settings()?,
            detail: state
                .inner
                .navigation
                .lock()
                .expect("navigation")
                .settings_detail(),
        });
    }
    let operation = if remote_retry == Some(true) {
        GatewayOperation::RetryRemote
    } else if explicit_local == Some(true) {
        GatewayOperation::ConnectExplicitLocal
    } else {
        GatewayOperation::Connect
    };
    let pending = operations.execute(operation);
    // Restore a saved dashboard only after Primary's startup request is owned
    // by the native queue, without waiting for the connection to succeed.
    gateway_windows::bootstrap_admitted(&app);
    pending.await.map(BootstrapReply::Gateway)
}

#[tauri::command]
async fn close_connection_settings(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state.on_main(&app, |state, app| {
        if state.return_from_connection_settings(&app)? {
            Ok(())
        } else {
            Err("The previous dashboard is unavailable. Retry or edit the connection.".to_string())
        }
    })
}

#[derive(Serialize)]
#[serde(untagged)]
enum BootstrapReply {
    Gateway(GatewaySnapshot),
    Settings {
        remote: Option<remote_gateway::RemoteSettings>,
        detail: Option<String>,
    },
}

#[tauri::command]
async fn connect_remote_gateway(
    operations: State<'_, GatewayOperationQueue>,
    transport: String,
    url: Option<String>,
    ssh_target: Option<String>,
    token: Option<String>,
    password: Option<String>,
    remote_port: Option<u16>,
) -> Result<GatewaySnapshot, String> {
    operations
        .execute(GatewayOperation::ConnectRemote(RemoteGatewayRequest {
            transport,
            url,
            ssh_target,
            token,
            password,
            remote_port,
            tls_fingerprint: None,
        }))
        .await
}

#[tauri::command]
async fn install_cli(
    operations: State<'_, GatewayOperationQueue>,
    channel: InstallChannel,
) -> Result<GatewaySnapshot, String> {
    operations.execute(GatewayOperation::Install(channel)).await
}

#[tauri::command]
async fn gateway_action(
    operations: State<'_, GatewayOperationQueue>,
    action: GatewayAction,
) -> Result<GatewaySnapshot, String> {
    operations.execute(GatewayOperation::Action(action)).await
}

fn main() {
    // AppIndicator uses the GTK application name for the tray menu heading.
    #[cfg(target_os = "linux")]
    gtk::glib::set_application_name("OpenClaw");

    let global_shortcuts_supported = tray::global_shortcuts_supported();
    let quickchat_state = quickchat::QuickChatState::new(global_shortcuts_supported);
    let quickchat_shortcut_state = quickchat_state.clone();
    // Single-instance must run first so it can pass deep-link argv to the primary process.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
    // global-hotkey's Linux backend is X11-only; omit it on Wayland instead of using XWayland.
    // A GlobalShortcuts portal can follow later.
    let builder = if global_shortcuts_supported {
        builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if quickchat_shortcut_state.matches_shortcut(shortcut) {
                            quickchat::toggle_quickchat(app);
                        } else if shortcut
                            .matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyO)
                        {
                            tray::show_window(app);
                        }
                    }
                })
                .build(),
        )
    } else {
        builder
    };
    let builder = notify::register(builder)
        .plugin(
            tauri_plugin_opener::Builder::new()
                // Dashboard links use the native handler; its renderer has no opener IPC grant.
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&[quickchat::QUICKCHAT_LABEL])
                .build(),
        );

    let builder = builder.setup(move |app| {
        let namespace = remote_gateway::config_path()?
            .to_string_lossy()
            .into_owned();
        app.manage(gateway_windows::GatewayWindows::new(&namespace));
        app.manage(native_browser::NativeBrowserState::default());
        app.manage(native_browser_bridge::NativeBrowserBridgeState::default());
        let window_config = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .cloned()
            .expect("tauri.conf.json must define the main window");
        let browser_app = app.handle().clone();
        let window = WebviewWindowBuilder::from_config(app.handle(), &window_config)?
            .initialization_script(window_chrome::initialization_script(None, true))
            .on_page_load(|window, payload| {
                let webview: Webview = window.as_ref().clone();
                gateway_windows::local_page_load(
                    webview.clone(),
                    payload.url(),
                    matches!(payload.event(), PageLoadEvent::Started),
                );
                native_browser_bridge::page_load(
                    webview,
                    matches!(payload.event(), PageLoadEvent::Started),
                    None,
                );
            })
            .on_new_window(move |url, _features| {
                open_external_browser(&browser_app, &url);
                NewWindowResponse::Deny
            })
            .build()?;
        window_chrome::install(&window.as_ref().window())?;
        #[cfg(target_os = "macos")]
        if let Some(view) = app.get_webview("main") {
            window_chrome_macos::install_webview(&view)?;
        }
        let state = DesktopState::new(window.url()?);
        app.manage(state.clone());
        app.manage(gateway_ws::GatewayClient::new());
        #[cfg(target_os = "linux")]
        app.manage(gateway_sleep_logind::SleepBridge::start(
            app.handle().clone(),
        ));
        let operation_app = app.handle().clone();
        let operation_state = state.clone();
        let error_app = app.handle().clone();
        let error_state = state.clone();
        // Every caller of the operation mutex enters this queue so UI source cannot reorder work.
        app.manage(GatewayOperationQueue::new(
            move |operation, selection| match operation {
                GatewayOperation::Connect => {
                    gateway_windows::bootstrap_admitted(&operation_app);
                    operation_state.connect(&operation_app, selection)
                }
                GatewayOperation::ConnectExplicitLocal => {
                    operation_state.connect_explicit_local(&operation_app, selection)
                }
                GatewayOperation::ConnectRemote(request) => {
                    operation_state.connect_remote(&operation_app, request, selection)
                }
                GatewayOperation::PromoteProfile { request, guard } => {
                    operation_state.promote_profile(&operation_app, request, selection, guard)
                }
                GatewayOperation::RetryRemote => {
                    operation_state.retry_remote(&operation_app, selection)
                }
                GatewayOperation::Install(channel) => {
                    operation_state.install_cli(&operation_app, channel)
                }
                GatewayOperation::Action(action) => {
                    operation_state.gateway_action(&operation_app, action)
                }
                GatewayOperation::RecoverRemote { child_id } => {
                    operation_state.recover_remote(&operation_app, selection, child_id)
                }
            },
            move |error| error_state.show_error(&error_app, error),
        ));
        let deep_link_app = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
            handle_deep_links(&deep_link_app, event.urls());
        });
        if let Some(urls) = app.deep_link().get_current()? {
            handle_deep_links(app.handle(), urls);
        }
        #[cfg(any(target_os = "linux", all(debug_assertions, target_os = "windows")))]
        if let Err(error) = app.deep_link().register_all() {
            eprintln!("Deep-link registration unavailable: {error}");
        }

        app.manage(discovery::GatewayDiscovery::default());
        app.manage(quickchat_state.clone());
        app.manage(updater::UpdaterState::default());
        state.set_tray(tray::build(app, state.clone(), global_shortcuts_supported)?);
        if let Some(menu) = app.menu() {
            menu.append(&gateway_windows::menu(app.handle())?)?;
        }
        app.on_menu_event(|app, event| {
            gateway_windows::handle_menu(app, event.id().as_ref());
        });
        #[cfg(target_os = "linux")]
        desktop_bridge::start(app.handle().clone());
        state.start_tunnel_monitor(app.handle().clone());
        // Single-instance admission is complete; Chrome setup never follows a remote dashboard.
        state.inner.chrome_setup.start(app.handle().clone());
        Ok(())
    });
    let builder = builder.invoke_handler(tauri::generate_handler![
        bootstrap,
        close_connection_settings,
        build_info,
        updater::check_for_updates,
        discovery::connect_discovered_gateway,
        connect_remote_gateway,
        discovery::discover_gateways,
        install_cli,
        gateway_action,
        native_browser_bridge::native_browser_request,
        gateway_windows::gateway_request,
        gateway_windows::gateway_profile_request,
        quickchat::quickchat_activate,
        quickchat::quickchat_agents,
        quickchat::quickchat_hide,
        quickchat::quickchat_identity,
        quickchat::quickchat_ready,
        quickchat::quickchat_select_agent,
        quickchat::quickchat_send,
        quickchat::quickchat_set_expanded,
        quickchat::quickchat_set_shortcut,
        quickchat::quickchat_shortcut,
        quickchat::quickchat_show_dashboard,
        quickchat_widgets::quickchat_refresh_widget_surface,
        quickchat_widgets::quickchat_sync_widgets,
        updater::open_release_page,
        updater::relaunch,
        updater::updater_ready,
        #[cfg(not(target_os = "macos"))]
        window_chrome::window_chrome_drag,
        window_chrome::window_chrome_request
    ]);

    let app = builder
        .on_window_event(|window, event| {
            if let Some(routes) = window
                .app_handle()
                .try_state::<gateway_windows::GatewayWindows>()
            {
                match event {
                    tauri::WindowEvent::CloseRequested { .. } => {
                        routes.cancel_pending(window.app_handle(), window.label())
                    }
                    tauri::WindowEvent::Destroyed => {
                        routes.closed(window.app_handle(), window.label())
                    }
                    _ => {}
                }
            }
            if (window.label() == "main" || window.label().starts_with("gateway-"))
                && matches!(
                    event,
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_)
                )
            {
                window_chrome::publish(window);
            }
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Resized(_)) {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<native_browser::NativeBrowserState>()
                        .resize(&app)
                        .await;
                });
            }
            if window.label() == quickchat::QUICKCHAT_LABEL {
                match event {
                    tauri::WindowEvent::Focused(false) => {
                        // GTK queues focus events; a stale blur must not hide a refocused window.
                        if cfg!(target_os = "linux") && window.is_focused().unwrap_or(false) {
                            return;
                        }
                        quickchat::request_hide(window.app_handle());
                        return;
                    }
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        quickchat::request_hide(window.app_handle());
                        return;
                    }
                    _ => {}
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label().starts_with("gateway-") {
                    return;
                }
                let state = window.app_handle().state::<DesktopState>();
                if !state.is_quitting() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("OpenClaw desktop app failed");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
            if let Some(state) = app.try_state::<DesktopState>() {
                if !state.inner.ssh_shutdown_complete.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    state.quit_with_code(app, code.unwrap_or(0));
                }
            }
        }
        #[cfg(target_os = "linux")]
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(bridge) = app.try_state::<gateway_sleep_logind::SleepBridge>() {
                bridge.shutdown();
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (app, event);
    });
}
