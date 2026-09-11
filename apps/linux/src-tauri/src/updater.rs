use serde::Serialize;
use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

pub(crate) const NOT_AVAILABLE_EVENT: &str = "updater://not-available";
pub(crate) const AVAILABLE_EVENT: &str = "updater://available";
pub(crate) const AVAILABLE_MANUAL_EVENT: &str = "updater://available-manual";
pub(crate) const PROGRESS_EVENT: &str = "updater://progress";
pub(crate) const READY_EVENT: &str = "updater://ready";
pub(crate) const ERROR_EVENT: &str = "updater://error";

const RELEASE_URL: &str = "https://github.com/openclaw/openclaw/releases/latest";
#[cfg(any(target_os = "macos", target_os = "windows"))]
// Test desktop builds need a channel that Linux-only releases never replace.
const DESKTOP_TEST_UPDATE_ENDPOINT: &str =
    "https://github.com/openclaw/openclaw/releases/download/desktop-test/latest-desktop-test.json";
const AUTO_CHECK_DELAY: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InstallKind {
    SelfInstall,
    DeferredInstall,
    NotifyOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TerminalResultKind {
    NotAvailable,
    CheckFailed,
    PackageUpdateAvailable,
    UpdateReady,
    UpdateFailed,
    RelaunchFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ResultDestination {
    None,
    Notification,
    Webview,
    WebviewAndNotificationWhenUnfocused,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum UpdateAction {
    #[default]
    Unavailable,
    OpenDownloadPage,
    RestartToUpdate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
// Keep every discriminator available so one host can test all platform rules.
#[allow(dead_code)]
enum Platform {
    Linux,
    Macos,
    Windows,
}

#[derive(Default)]
pub struct UpdaterState {
    lifecycle: Mutex<UpdateLifecycle>,
    auto_check_started: AtomicBool,
    check_in_progress: Arc<AtomicBool>,
    // Set when a manual (tray/command) check is requested. The one in-flight
    // check reads this at emit time so a manual click that lands while the
    // silent startup auto-check is running still surfaces a result instead of
    // being coalesced away into silence.
    manual_pending: Arc<AtomicBool>,
}

#[derive(Debug)]
struct DeferredUpdate<T = Update> {
    update: T,
    bytes: Vec<u8>,
}

#[derive(Debug)]
enum ReadyUpdate<T = Update> {
    Installed,
    Deferred(DeferredUpdate<T>),
}

#[derive(Debug)]
enum ClaimedAction<T = Update> {
    None,
    OpenDownloadPage,
    Restart,
    Install(DeferredUpdate<T>),
}

// Readiness and its payload have one owner. A claimed installer is busy, not absent.
struct UpdateLifecycle<T = Update> {
    ready: Option<ReadyUpdate<T>>,
    download_available: bool,
    operation_in_progress: bool,
}

impl<T> Default for UpdateLifecycle<T> {
    fn default() -> Self {
        Self {
            ready: None,
            download_available: false,
            operation_in_progress: false,
        }
    }
}

impl<T> UpdateLifecycle<T> {
    fn action(&self) -> UpdateAction {
        if self.operation_in_progress {
            UpdateAction::Unavailable
        } else if self.ready.is_some() {
            UpdateAction::RestartToUpdate
        } else if self.download_available {
            UpdateAction::OpenDownloadPage
        } else {
            UpdateAction::Unavailable
        }
    }

    fn download_started(&mut self) {
        self.download_available = false;
    }

    fn record_result(&mut self, result: TerminalResultKind) {
        match result {
            TerminalResultKind::NotAvailable => self.download_available = false,
            TerminalResultKind::PackageUpdateAvailable
            | TerminalResultKind::UpdateFailed
            | TerminalResultKind::RelaunchFailed => self.download_available = true,
            TerminalResultKind::CheckFailed | TerminalResultKind::UpdateReady => {}
        }
    }

    fn replace_ready(&mut self, ready: ReadyUpdate<T>) {
        self.ready = Some(ready);
        self.download_available = false;
    }

    fn claim_action(&mut self, relaunch: bool) -> ClaimedAction<T> {
        if self.operation_in_progress {
            return ClaimedAction::None;
        }
        if relaunch || self.action() == UpdateAction::RestartToUpdate {
            self.operation_in_progress = true;
            return match self.ready.take() {
                Some(ReadyUpdate::Deferred(deferred)) => ClaimedAction::Install(deferred),
                Some(ReadyUpdate::Installed) | None => ClaimedAction::Restart,
            };
        }
        match self.action() {
            UpdateAction::OpenDownloadPage => ClaimedAction::OpenDownloadPage,
            _ => ClaimedAction::None,
        }
    }

    fn restore_failed_install(&mut self, deferred: DeferredUpdate<T>) {
        // A replacement may have finished downloading while the claimed install ran.
        if self.ready.is_none() {
            self.ready = Some(ReadyUpdate::Deferred(deferred));
        }
        self.operation_in_progress = false;
    }

    fn begin_self_install(&mut self) -> bool {
        if self.operation_in_progress {
            return false;
        }
        self.operation_in_progress = true;
        true
    }

    fn finish_self_install(&mut self, success: bool) {
        if success {
            self.replace_ready(ReadyUpdate::Installed);
        }
        self.operation_in_progress = false;
    }
}

struct CheckGuard {
    in_progress: Arc<AtomicBool>,
    manual_pending: Arc<AtomicBool>,
}

impl Drop for CheckGuard {
    fn drop(&mut self) {
        self.manual_pending.store(false, Ordering::Release);
        self.in_progress.store(false, Ordering::Release);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManualUpdateInfo {
    version: String,
    notes: Option<String>,
    release_url: &'static str,
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Clone, Serialize)]
struct UpdateError {
    message: String,
}

pub fn schedule_auto_check(app: AppHandle) {
    let state = app.state::<UpdaterState>();
    if state.auto_check_started.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(AUTO_CHECK_DELAY);
        // Auto-check is silent: a launch that finds no update (or hits a
        // transient network error) must not nag with a banner every time.
        tauri::async_runtime::block_on(run_check(app, false));
    });
}

pub fn spawn_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_check(app, true).await;
    });
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) {
    run_check(app, true).await;
}

#[tauri::command]
pub fn updater_ready(app: AppHandle) {
    schedule_auto_check(app);
}

#[tauri::command]
pub fn relaunch(app: AppHandle) {
    activate(&app, true);
}

#[tauri::command]
pub fn open_release_page(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(RELEASE_URL, None::<&str>)
        .map_err(|error| format!("Could not open release page: {error}"))
}

pub(crate) fn perform_action(app: &AppHandle) {
    activate(app, false);
}

fn activate(app: &AppHandle, relaunch: bool) {
    let action = app
        .state::<UpdaterState>()
        .lifecycle
        .lock()
        .expect("updater lifecycle lock poisoned")
        .claim_action(relaunch);
    refresh_action(app);
    match action {
        ClaimedAction::None => {}
        ClaimedAction::OpenDownloadPage => {
            if let Err(error) = open_release_page(app.clone()) {
                crate::notify::notify(app, "OpenClaw", &error);
            }
        }
        ClaimedAction::Restart => app.restart(),
        ClaimedAction::Install(deferred) => {
            let app = app.clone();
            // Installation may block or ask the main thread for native platform work.
            std::thread::spawn(move || match deferred.update.install(&deferred.bytes) {
                Ok(()) => app.restart(),
                Err(error) => {
                    app.state::<UpdaterState>()
                        .lifecycle
                        .lock()
                        .expect("updater lifecycle lock poisoned")
                        .restore_failed_install(deferred);
                    deliver_error(&app, true, TerminalResultKind::RelaunchFailed, error);
                }
            });
        }
    }
}

// A manual (tray/command) check surfaces the "up to date" and check-error
// notices; the launch auto-check runs silent. Manual intent is recorded on the
// shared state before racing for the single-flight guard, so a manual click
// that lands while the silent auto-check is running still gets a response
// (`manual_requested` reads it). Once an update is found, download
// progress/ready/errors always surface, since the user has been told an update
// is coming.
async fn run_check(app: AppHandle, manual: bool) {
    let manual_pending = Arc::clone(&app.state::<UpdaterState>().manual_pending);
    if manual {
        manual_pending.store(true, Ordering::Release);
    }
    let Some(_guard) = begin_check(&app) else {
        return;
    };
    let manual_requested = || manual_pending.load(Ordering::Acquire);
    #[cfg(target_os = "linux")]
    let updater = app.updater();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let updater = app
        .updater_builder()
        .endpoints(vec![DESKTOP_TEST_UPDATE_ENDPOINT
            .parse()
            .expect("desktop test updater endpoint is valid")])
        .and_then(|builder| builder.build());
    let updater = match updater {
        Ok(updater) => updater,
        Err(error) => {
            deliver_error(
                &app,
                manual_requested(),
                TerminalResultKind::CheckFailed,
                error,
            );
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            deliver_result(
                &app,
                manual_requested(),
                TerminalResultKind::NotAvailable,
                NOT_AVAILABLE_EVENT,
                (),
                "OpenClaw is up to date — no update is available",
            );
            return;
        }
        Err(error) => {
            deliver_error(
                &app,
                manual_requested(),
                TerminalResultKind::CheckFailed,
                error,
            );
            return;
        }
    };
    let info = UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
    };

    app.state::<UpdaterState>()
        .lifecycle
        .lock()
        .expect("updater lifecycle lock poisoned")
        .download_started();
    refresh_action(&app);
    let install_kind = install_kind();
    if install_kind == InstallKind::NotifyOnly {
        let version = info.version.clone();
        let notification_body = manual_notification_body(&version);
        deliver_result(
            &app,
            manual_requested(),
            TerminalResultKind::PackageUpdateAvailable,
            AVAILABLE_MANUAL_EVENT,
            ManualUpdateInfo {
                version: info.version,
                notes: info.notes,
                release_url: RELEASE_URL,
            },
            &notification_body,
        );
        return;
    }

    emit(&app, AVAILABLE_EVENT, info.clone());
    let result = update.download(progress_callback(app.clone()), || {}).await;
    let result = match result {
        Ok(bytes) if install_kind == InstallKind::SelfInstall => {
            let admitted = app
                .state::<UpdaterState>()
                .lifecycle
                .lock()
                .expect("updater lifecycle lock poisoned")
                .begin_self_install();
            if !admitted {
                // A relaunch already owns the process; do not replace files beneath it.
                return;
            }
            refresh_action(&app);
            let result = update.install(&bytes);
            app.state::<UpdaterState>()
                .lifecycle
                .lock()
                .expect("updater lifecycle lock poisoned")
                .finish_self_install(result.is_ok());
            result
        }
        Ok(bytes) => {
            app.state::<UpdaterState>()
                .lifecycle
                .lock()
                .expect("updater lifecycle lock poisoned")
                .replace_ready(ReadyUpdate::Deferred(DeferredUpdate { update, bytes }));
            Ok(())
        }
        Err(error) => Err(error),
    };
    match result {
        Ok(()) => {
            let version = info.version.clone();
            let notification_body = ready_notification_body(&version);
            deliver_result(
                &app,
                manual_requested(),
                TerminalResultKind::UpdateReady,
                READY_EVENT,
                info,
                &notification_body,
            );
        }
        Err(error) => deliver_error(
            &app,
            manual_requested(),
            TerminalResultKind::UpdateFailed,
            error,
        ),
    }
}

fn result_delivery(
    manual: bool,
    main_content_is_remote: bool,
    result: TerminalResultKind,
) -> ResultDestination {
    if !manual
        && matches!(
            result,
            TerminalResultKind::NotAvailable | TerminalResultKind::CheckFailed
        )
    {
        return ResultDestination::None;
    }
    if main_content_is_remote {
        return ResultDestination::Notification;
    }
    match result {
        TerminalResultKind::PackageUpdateAvailable
        | TerminalResultKind::UpdateReady
        | TerminalResultKind::RelaunchFailed => {
            ResultDestination::WebviewAndNotificationWhenUnfocused
        }
        TerminalResultKind::NotAvailable
        | TerminalResultKind::CheckFailed
        | TerminalResultKind::UpdateFailed => ResultDestination::Webview,
    }
}

pub(crate) fn current_action(app: &AppHandle) -> UpdateAction {
    app.state::<UpdaterState>()
        .lifecycle
        .lock()
        .expect("updater lifecycle lock poisoned")
        .action()
}

fn refresh_action(app: &AppHandle) {
    app.state::<crate::DesktopState>()
        .refresh_update_action(app);
}

fn begin_check(app: &AppHandle) -> Option<CheckGuard> {
    let state = app.state::<UpdaterState>();
    let in_progress = Arc::clone(&state.check_in_progress);
    let manual_pending = Arc::clone(&state.manual_pending);
    in_progress
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .ok()
        .map(|_| CheckGuard {
            in_progress,
            manual_pending,
        })
}

fn install_kind() -> InstallKind {
    #[cfg(target_os = "linux")]
    let platform = Platform::Linux;
    #[cfg(target_os = "macos")]
    let platform = Platform::Macos;
    #[cfg(target_os = "windows")]
    let platform = Platform::Windows;

    install_kind_from_appimage_env(std::env::var_os("APPIMAGE"), platform)
}

fn install_kind_from_appimage_env(appimage: Option<OsString>, platform: Platform) -> InstallKind {
    match platform {
        Platform::Linux if appimage.is_some() => InstallKind::SelfInstall,
        Platform::Linux => {
            // Package managers own deb/rpm files, so replacing them would corrupt their contract.
            InstallKind::NotifyOnly
        }
        Platform::Macos => {
            // Tauri owns .app replacement and returns after installing, like the AppImage path.
            InstallKind::SelfInstall
        }
        Platform::Windows => {
            // Tauri's NSIS install exits the process, so wait for user-confirmed relaunch.
            InstallKind::DeferredInstall
        }
    }
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn main_content_is_remote(app: &AppHandle, window: Option<&WebviewWindow>) -> bool {
    !window.is_some_and(|window| {
        app.state::<crate::DesktopState>()
            .main_window_has_local_content(window)
    })
}

fn progress_callback(app: AppHandle) -> impl FnMut(usize, Option<u64>) {
    let mut downloaded = 0_u64;
    move |chunk_size, total| {
        downloaded = downloaded.saturating_add(chunk_size as u64);
        emit(&app, PROGRESS_EVENT, Progress { downloaded, total });
    }
}

fn emit<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Some(window) = main_window(app) {
        if !main_content_is_remote(app, Some(&window)) {
            let _ = window.emit(event, payload);
        }
    }
}

fn deliver_result<S: Serialize + Clone>(
    app: &AppHandle,
    manual: bool,
    result: TerminalResultKind,
    event: &str,
    payload: S,
    notification_body: &str,
) {
    app.state::<UpdaterState>()
        .lifecycle
        .lock()
        .expect("updater lifecycle lock poisoned")
        .record_result(result);
    refresh_action(app);
    let window = main_window(app);
    let destination = result_delivery(manual, main_content_is_remote(app, window.as_ref()), result);
    if matches!(
        destination,
        ResultDestination::Webview | ResultDestination::WebviewAndNotificationWhenUnfocused
    ) {
        if let Some(window) = window.as_ref() {
            let _ = window.emit(event, payload);
        }
    }
    let notify = match destination {
        ResultDestination::None | ResultDestination::Webview => false,
        ResultDestination::Notification => true,
        ResultDestination::WebviewAndNotificationWhenUnfocused => window
            .as_ref()
            .is_some_and(|window| matches!(window.is_focused(), Ok(false))),
    };
    if notify {
        crate::notify::notify(app, "OpenClaw", notification_body);
    }
}

fn deliver_error(
    app: &AppHandle,
    manual: bool,
    result: TerminalResultKind,
    error: impl std::fmt::Display,
) {
    let message = error.to_string();
    let notification_body = error_notification_body(result, &message);
    deliver_result(
        app,
        manual,
        result,
        ERROR_EVENT,
        UpdateError { message },
        &notification_body,
    );
}

fn error_notification_body(result: TerminalResultKind, message: &str) -> String {
    let prefix = match result {
        TerminalResultKind::CheckFailed => "Update check failed",
        TerminalResultKind::UpdateFailed | TerminalResultKind::RelaunchFailed => "Update failed",
        _ => unreachable!("only error results have error notification copy"),
    };
    format!("{prefix}: {message}")
}

fn ready_notification_body(version: &str) -> String {
    format!("Update ready — restart OpenClaw to install v{version}")
}

fn manual_notification_body(version: &str) -> String {
    format!("Update available: v{version} — download from the release page")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_kind_covers_every_platform_path() {
        assert_eq!(
            install_kind_from_appimage_env(None, Platform::Linux),
            InstallKind::NotifyOnly
        );
        assert_eq!(
            install_kind_from_appimage_env(
                Some(OsString::from("/tmp/OpenClaw.AppImage")),
                Platform::Linux,
            ),
            InstallKind::SelfInstall
        );
        assert_eq!(
            install_kind_from_appimage_env(None, Platform::Macos),
            InstallKind::SelfInstall
        );
        assert_eq!(
            install_kind_from_appimage_env(None, Platform::Windows),
            InstallKind::DeferredInstall
        );
    }

    #[test]
    fn updater_event_names_are_stable() {
        assert_eq!(NOT_AVAILABLE_EVENT, "updater://not-available");
        assert_eq!(AVAILABLE_EVENT, "updater://available");
        assert_eq!(AVAILABLE_MANUAL_EVENT, "updater://available-manual");
        assert_eq!(PROGRESS_EVENT, "updater://progress");
        assert_eq!(READY_EVENT, "updater://ready");
        assert_eq!(ERROR_EVENT, "updater://error");
    }

    #[test]
    fn notification_copy_includes_update_version() {
        assert_eq!(
            ready_notification_body("2026.7.16"),
            "Update ready — restart OpenClaw to install v2026.7.16"
        );
        assert_eq!(
            manual_notification_body("2026.7.16"),
            "Update available: v2026.7.16 — download from the release page"
        );
        assert_eq!(
            error_notification_body(TerminalResultKind::CheckFailed, "offline"),
            "Update check failed: offline"
        );
        assert_eq!(
            error_notification_body(TerminalResultKind::UpdateFailed, "disk full"),
            "Update failed: disk full"
        );
    }

    #[test]
    fn every_manual_terminal_result_notifies_when_main_content_is_remote() {
        for result in [
            TerminalResultKind::NotAvailable,
            TerminalResultKind::CheckFailed,
            TerminalResultKind::PackageUpdateAvailable,
            TerminalResultKind::UpdateReady,
            TerminalResultKind::UpdateFailed,
            TerminalResultKind::RelaunchFailed,
        ] {
            assert_eq!(
                observable_delivery(result_delivery(true, true, result)),
                (false, NotificationDelivery::Always),
                "manual {result:?} must use native-only delivery when the WebView is remote"
            );
        }
    }

    #[test]
    fn background_result_delivery_uses_a_compatible_visible_sink() {
        let local_expected = [
            (
                TerminalResultKind::NotAvailable,
                (false, NotificationDelivery::Never),
            ),
            (
                TerminalResultKind::CheckFailed,
                (false, NotificationDelivery::Never),
            ),
            (
                TerminalResultKind::PackageUpdateAvailable,
                (true, NotificationDelivery::WhenUnfocused),
            ),
            (
                TerminalResultKind::UpdateReady,
                (true, NotificationDelivery::WhenUnfocused),
            ),
            (
                TerminalResultKind::UpdateFailed,
                (true, NotificationDelivery::Never),
            ),
        ];
        let remote_expected = [
            (
                TerminalResultKind::NotAvailable,
                (false, NotificationDelivery::Never),
            ),
            (
                TerminalResultKind::CheckFailed,
                (false, NotificationDelivery::Never),
            ),
            (
                TerminalResultKind::PackageUpdateAvailable,
                (false, NotificationDelivery::Always),
            ),
            (
                TerminalResultKind::UpdateReady,
                (false, NotificationDelivery::Always),
            ),
            (
                TerminalResultKind::UpdateFailed,
                (false, NotificationDelivery::Always),
            ),
        ];
        for (main_content_is_remote, expected) in [(false, local_expected), (true, remote_expected)]
        {
            for (result, observable) in expected {
                assert_eq!(
                    observable_delivery(result_delivery(false, main_content_is_remote, result)),
                    observable
                );
            }
        }
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum NotificationDelivery {
        Never,
        WhenUnfocused,
        Always,
    }

    fn observable_delivery(destination: ResultDestination) -> (bool, NotificationDelivery) {
        match destination {
            ResultDestination::None => (false, NotificationDelivery::Never),
            ResultDestination::Notification => (false, NotificationDelivery::Always),
            ResultDestination::Webview => (true, NotificationDelivery::Never),
            ResultDestination::WebviewAndNotificationWhenUnfocused => {
                (true, NotificationDelivery::WhenUnfocused)
            }
        }
    }

    fn deferred(version: &'static str, bytes: &[u8]) -> ReadyUpdate<&'static str> {
        ReadyUpdate::Deferred(DeferredUpdate {
            update: version,
            bytes: bytes.to_vec(),
        })
    }

    fn claimed_installer(action: ClaimedAction<&'static str>) -> DeferredUpdate<&'static str> {
        match action {
            ClaimedAction::Install(deferred) => deferred,
            other => panic!("expected the retained installer, got {other:?}"),
        }
    }

    #[test]
    fn ready_update_survives_failed_replacement_download() {
        for relaunch in [false, true] {
            let mut lifecycle = UpdateLifecycle::default();
            lifecycle.replace_ready(deferred("release-a", b"verified A\0\xff"));

            lifecycle.download_started();
            assert_eq!(lifecycle.action(), UpdateAction::RestartToUpdate);
            lifecycle.record_result(TerminalResultKind::UpdateFailed);
            assert_eq!(lifecycle.action(), UpdateAction::RestartToUpdate);

            let selected = claimed_installer(lifecycle.claim_action(relaunch));
            assert_eq!(selected.update, "release-a");
            assert_eq!(selected.bytes, b"verified A\0\xff");
        }
    }

    #[test]
    fn empty_or_failed_checks_preserve_deferred_and_installed_readiness() {
        for result in [
            TerminalResultKind::NotAvailable,
            TerminalResultKind::CheckFailed,
        ] {
            let mut lifecycle = UpdateLifecycle::default();
            lifecycle.replace_ready(deferred("release-a", b"verified A"));
            lifecycle.record_result(result);
            assert_eq!(lifecycle.action(), UpdateAction::RestartToUpdate);
            let selected = claimed_installer(lifecycle.claim_action(false));
            assert_eq!(selected.update, "release-a");
            assert_eq!(selected.bytes, b"verified A");

            let mut installed = UpdateLifecycle::<()>::default();
            installed.replace_ready(ReadyUpdate::Installed);
            installed.record_result(result);
            assert_eq!(installed.action(), UpdateAction::RestartToUpdate);
            assert!(matches!(
                installed.claim_action(true),
                ClaimedAction::Restart
            ));
        }
    }

    #[test]
    fn successful_replacement_selects_new_identity_and_bytes() {
        let mut lifecycle = UpdateLifecycle::default();
        lifecycle.replace_ready(deferred("release-a", b"verified A"));
        lifecycle.download_started();
        lifecycle.replace_ready(deferred("release-b", b"verified B\0\xff"));
        lifecycle.record_result(TerminalResultKind::UpdateReady);

        assert_eq!(lifecycle.action(), UpdateAction::RestartToUpdate);
        let selected = claimed_installer(lifecycle.claim_action(false));
        assert_eq!(selected.update, "release-b");
        assert_eq!(selected.bytes, b"verified B\0\xff");
    }

    #[test]
    fn failed_install_can_be_retried_from_either_entry_point() {
        for first_relaunch in [false, true] {
            let mut lifecycle = UpdateLifecycle::default();
            lifecycle.replace_ready(deferred("release-a", b"verified A"));
            let claimed = claimed_installer(lifecycle.claim_action(first_relaunch));
            assert!(matches!(
                lifecycle.claim_action(!first_relaunch),
                ClaimedAction::None
            ));
            lifecycle.restore_failed_install(claimed);
            lifecycle.record_result(TerminalResultKind::RelaunchFailed);

            assert_eq!(lifecycle.action(), UpdateAction::RestartToUpdate);
            let retry = claimed_installer(lifecycle.claim_action(!first_relaunch));
            assert_eq!(retry.update, "release-a");
            assert_eq!(retry.bytes, b"verified A");
        }
    }

    #[test]
    fn replacement_and_failed_install_interleavings_never_restore_stale_bytes() {
        for replacement_finishes_first in [false, true] {
            let lifecycle = Mutex::new(UpdateLifecycle::default());
            lifecycle
                .lock()
                .unwrap()
                .replace_ready(deferred("release-a", b"verified A"));
            let (claimed_tx, claimed_rx) = std::sync::mpsc::channel();
            let (finish_tx, finish_rx) = std::sync::mpsc::channel();
            std::thread::scope(|scope| {
                let lifecycle = &lifecycle;
                let installer = scope.spawn(move || {
                    let claimed = claimed_installer(lifecycle.lock().unwrap().claim_action(false));
                    claimed_tx.send(()).unwrap();
                    finish_rx.recv().unwrap();
                    assert_eq!(claimed.update, "release-a");
                    assert_eq!(claimed.bytes, b"verified A");
                    lifecycle.lock().unwrap().restore_failed_install(claimed);
                });
                claimed_rx.recv().unwrap();
                {
                    let mut state = lifecycle.lock().unwrap();
                    state.download_started();
                    state.record_result(TerminalResultKind::CheckFailed);
                    assert!(matches!(state.claim_action(true), ClaimedAction::None));
                    if replacement_finishes_first {
                        state.replace_ready(deferred("release-b", b"verified B"));
                        assert!(matches!(state.claim_action(true), ClaimedAction::None));
                    }
                }
                finish_tx.send(()).unwrap();
                installer.join().unwrap();
                if !replacement_finishes_first {
                    lifecycle
                        .lock()
                        .unwrap()
                        .replace_ready(deferred("release-b", b"verified B"));
                }
            });
            let mut state = lifecycle.lock().unwrap();
            // Delivery of A's error can itself run after B becomes ready.
            state.record_result(TerminalResultKind::RelaunchFailed);
            assert_eq!(state.action(), UpdateAction::RestartToUpdate);
            let selected = claimed_installer(state.claim_action(true));
            assert_eq!(selected.update, "release-b");
            assert_eq!(selected.bytes, b"verified B");
        }
    }

    #[test]
    fn installed_update_survives_retry_and_installation_fences_relaunch() {
        for success in [false, true] {
            let mut lifecycle = UpdateLifecycle::<()>::default();
            lifecycle.replace_ready(ReadyUpdate::Installed);
            lifecycle.download_started();
            lifecycle.record_result(TerminalResultKind::UpdateFailed);
            assert_eq!(lifecycle.action(), UpdateAction::RestartToUpdate);

            lifecycle.download_started();
            assert!(lifecycle.begin_self_install());
            assert!(!lifecycle.begin_self_install());
            for relaunch in [false, true] {
                assert!(matches!(
                    lifecycle.claim_action(relaunch),
                    ClaimedAction::None
                ));
            }
            lifecycle.finish_self_install(success);
            lifecycle.record_result(if success {
                TerminalResultKind::UpdateReady
            } else {
                TerminalResultKind::UpdateFailed
            });
            assert_eq!(lifecycle.action(), UpdateAction::RestartToUpdate);
            assert!(matches!(
                lifecycle.claim_action(false),
                ClaimedAction::Restart
            ));
            assert!(!lifecycle.begin_self_install());
        }
    }

    #[test]
    fn without_ready_update_failures_offer_download_instead_of_install() {
        for result in [
            TerminalResultKind::PackageUpdateAvailable,
            TerminalResultKind::UpdateFailed,
            TerminalResultKind::RelaunchFailed,
        ] {
            let mut lifecycle = UpdateLifecycle::<()>::default();
            lifecycle.record_result(result);
            assert_eq!(lifecycle.action(), UpdateAction::OpenDownloadPage);
            assert!(matches!(
                lifecycle.claim_action(false),
                ClaimedAction::OpenDownloadPage
            ));
            lifecycle.record_result(TerminalResultKind::CheckFailed);
            assert_eq!(lifecycle.action(), UpdateAction::OpenDownloadPage);
            lifecycle.record_result(TerminalResultKind::NotAvailable);
            assert_eq!(lifecycle.action(), UpdateAction::Unavailable);
            assert!(matches!(lifecycle.claim_action(false), ClaimedAction::None));
            // The existing local relaunch command also supports an ordinary restart.
            assert!(matches!(
                lifecycle.claim_action(true),
                ClaimedAction::Restart
            ));
        }
    }

    #[test]
    fn manual_local_results_keep_the_in_page_delivery_path() {
        let expected = [
            (
                TerminalResultKind::NotAvailable,
                (true, NotificationDelivery::Never),
            ),
            (
                TerminalResultKind::CheckFailed,
                (true, NotificationDelivery::Never),
            ),
            (
                TerminalResultKind::PackageUpdateAvailable,
                (true, NotificationDelivery::WhenUnfocused),
            ),
            (
                TerminalResultKind::UpdateReady,
                (true, NotificationDelivery::WhenUnfocused),
            ),
            (
                TerminalResultKind::UpdateFailed,
                (true, NotificationDelivery::Never),
            ),
            (
                TerminalResultKind::RelaunchFailed,
                (true, NotificationDelivery::WhenUnfocused),
            ),
        ];
        for (result, observable) in expected {
            assert_eq!(
                observable_delivery(result_delivery(true, false, result)),
                observable
            );
        }
    }
}
