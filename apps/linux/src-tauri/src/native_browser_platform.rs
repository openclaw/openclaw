use serde_json::{json, Value};
use tauri::{LogicalPosition, LogicalSize, Manager, Webview};

#[derive(Clone)]
struct DownloadAuthority {
    app: tauri::AppHandle,
    generation: u64,
}

impl DownloadAuthority {
    fn new(webview: &Webview, generation: u64) -> Self {
        Self {
            app: webview.app_handle().clone(),
            generation,
        }
    }

    fn ensure_current(&self) -> Result<(), String> {
        if crate::native_browser_bridge::generation_is_current(&self.app, self.generation) {
            Ok(())
        } else {
            Err("The native browser document changed.".to_string())
        }
    }
}

pub async fn configure_browser(
    builder: tauri::webview::WebviewBuilder<tauri::Wry>,
    sibling: Option<&Webview>,
) -> Result<tauri::webview::WebviewBuilder<tauri::Wry>, String> {
    let Some(sibling) = sibling else {
        return Ok(builder.incognito(true));
    };
    native(sibling, move |platform| {
        #[cfg(target_os = "windows")]
        {
            Ok(builder
                .incognito(true)
                .with_environment(platform.environment()))
        }
        #[cfg(target_os = "linux")]
        {
            Ok(builder.incognito(true).with_related_view(platform.inner()))
        }
        #[cfg(target_os = "macos")]
        unsafe {
            let mtm = objc2_foundation::MainThreadMarker::new()
                .ok_or("The browser is not on the application thread.")?;
            let browser = &*platform.inner().cast::<objc2_web_kit::WKWebView>();
            // Only browsing data is shared. Every child gets its own content manager and scripts.
            let configuration = objc2_web_kit::WKWebViewConfiguration::new(mtm);
            configuration.setWebsiteDataStore(&browser.configuration().websiteDataStore());
            Ok(builder
                .incognito(true)
                .with_webview_configuration(configuration))
        }
    })
    .await
}

async fn response<T>(
    response: tokio::sync::oneshot::Receiver<Result<T, String>>,
) -> Result<T, String> {
    tokio::time::timeout(std::time::Duration::from_secs(30), response)
        .await
        .map_err(|_| "The browser did not respond. Try again after the page loads.".to_string())?
        .map_err(|_| "The browser tab closed before the operation completed.".to_string())?
}

async fn native<T: Send + 'static>(
    webview: &Webview,
    operation: impl FnOnce(tauri::webview::PlatformWebview) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (reply, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| {
            let _ = reply.send(operation(platform));
        })
        .map_err(|error| error.to_string())?;
    response(receiver).await
}

/// Capture one native navigation state on the UI thread so overlapping events cannot mix pages.
pub async fn navigation_state(webview: &Webview) -> Result<(String, String, bool, bool), String> {
    native(webview, |platform| {
        #[cfg(target_os = "windows")]
        unsafe {
            use webview2_com::take_pwstr;
            use windows::core::{BOOL, PWSTR};
            let browser = platform
                .controller()
                .CoreWebView2()
                .map_err(|e| e.to_string())?;
            let mut url = PWSTR::null();
            browser.Source(&mut url).map_err(|e| e.to_string())?;
            let url = take_pwstr(url);
            let mut title = PWSTR::null();
            browser
                .DocumentTitle(&mut title)
                .map_err(|e| e.to_string())?;
            let title = take_pwstr(title);
            let mut back = BOOL::default();
            let mut forward = BOOL::default();
            browser.CanGoBack(&mut back).map_err(|e| e.to_string())?;
            browser
                .CanGoForward(&mut forward)
                .map_err(|e| e.to_string())?;
            Ok((url, title, back.as_bool(), forward.as_bool()))
        }
        #[cfg(target_os = "linux")]
        {
            use webkit2gtk::WebViewExt;
            let browser = platform.inner();
            Ok((
                browser.uri().map(|uri| uri.to_string()).unwrap_or_default(),
                browser
                    .title()
                    .map(|title| title.to_string())
                    .unwrap_or_default(),
                browser.can_go_back(),
                browser.can_go_forward(),
            ))
        }
        #[cfg(target_os = "macos")]
        unsafe {
            let browser = &*platform.inner().cast::<objc2_web_kit::WKWebView>();
            Ok((
                browser
                    .URL()
                    .and_then(|url| url.absoluteString())
                    .map(|url| url.to_string())
                    .unwrap_or_default(),
                browser
                    .title()
                    .map(|title| title.to_string())
                    .unwrap_or_default(),
                browser.canGoBack(),
                browser.canGoForward(),
            ))
        }
    })
    .await
}
pub async fn observe_navigation(
    webview: &Webview,
    changed: impl Fn() + Send + Sync + 'static,
) -> Result<(), String> {
    let changed = std::sync::Arc::new(changed);
    native(webview, move |platform| {
        #[cfg(target_os = "windows")]
        unsafe {
            use webview2_com::{
                DocumentTitleChangedEventHandler, HistoryChangedEventHandler,
                SourceChangedEventHandler,
            };
            let browser = platform
                .controller()
                .CoreWebView2()
                .map_err(|e| e.to_string())?;
            let callback = changed.clone();
            let mut token = 0;
            browser
                .add_HistoryChanged(
                    &HistoryChangedEventHandler::create(Box::new(move |_, _| {
                        callback();
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|e| e.to_string())?;
            let callback = changed.clone();
            browser
                .add_SourceChanged(
                    &SourceChangedEventHandler::create(Box::new(move |_, _| {
                        callback();
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|e| e.to_string())?;
            browser
                .add_DocumentTitleChanged(
                    &DocumentTitleChangedEventHandler::create(Box::new(move |_, _| {
                        changed();
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "linux")]
        {
            use gtk::prelude::*;
            use webkit2gtk::WebViewExt;
            let browser = platform.inner();
            for property in ["uri", "title", "is-loading"] {
                let changed = changed.clone();
                browser.connect_notify_local(Some(property), move |_, _| {
                    changed();
                });
            }
            if let Some(history) = browser.back_forward_list() {
                // gtk-rs cannot type WebKit's removed-items pointer; the callback only signals a refresh.
                history.connect_local("changed", false, move |_| {
                    changed();
                    None
                });
            }
        }
        #[cfg(target_os = "macos")]
        unsafe {
            mac_observer::observe(platform.inner().cast(), changed);
        }
        Ok(())
    })
    .await
}

pub async fn observe_navigation_failure(
    webview: &Webview,
    failed: impl Fn() + Send + Sync + 'static,
) -> Result<(), String> {
    let failed = std::sync::Arc::new(failed);
    native(webview, move |platform| {
        #[cfg(target_os = "windows")]
        unsafe {
            use std::{cell::Cell, rc::Rc};
            use webview2_com::{
                Microsoft::Web::WebView2::Win32::{
                    COREWEBVIEW2_WEB_ERROR_STATUS, COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED,
                },
                NavigationCompletedEventHandler, NavigationStartingEventHandler,
            };
            use windows::core::BOOL;
            let browser = platform
                .controller()
                .CoreWebView2()
                .map_err(|e| e.to_string())?;
            let latest = Rc::new(Cell::new(0_u64));
            let started = latest.clone();
            let mut token = 0;
            browser
                .add_NavigationStarting(
                    &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let mut id = 0;
                            args.NavigationId(&mut id)?;
                            started.set(id);
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|e| e.to_string())?;
            browser
                .add_NavigationCompleted(
                    &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            let mut success = BOOL::default();
                            let mut id = 0;
                            let mut error = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                            args.IsSuccess(&mut success)?;
                            args.NavigationId(&mut id)?;
                            args.WebErrorStatus(&mut error)?;
                            if !success.as_bool()
                                && (latest.get() == 0 || latest.get() == id)
                                && error != COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED
                            {
                                failed();
                            }
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "linux")]
        {
            use webkit2gtk::WebViewExt;
            platform.inner().connect_load_failed(move |_, _, _, error| {
                if !error.matches(webkit2gtk::NetworkError::Cancelled) {
                    failed();
                }
                // Preserve WebKit's default error-page handling.
                false
            });
        }
        #[cfg(target_os = "macos")]
        unsafe {
            mac_navigation_failure::observe(platform.inner().cast(), failed)?;
        }
        Ok(())
    })
    .await
}

#[derive(Clone, Copy)]
enum Navigation {
    Back,
    Forward,
    Stop,
}

async fn navigate(webview: &Webview, action: Navigation) -> Result<(), String> {
    native(webview, move |platform| {
        #[cfg(target_os = "windows")]
        unsafe {
            let browser = platform
                .controller()
                .CoreWebView2()
                .map_err(|e| e.to_string())?;
            match action {
                Navigation::Back => browser.GoBack(),
                Navigation::Forward => browser.GoForward(),
                Navigation::Stop => browser.Stop(),
            }
            .map_err(|e| e.to_string())
        }
        #[cfg(target_os = "linux")]
        {
            use webkit2gtk::WebViewExt;
            let browser = platform.inner();
            match action {
                Navigation::Back => browser.go_back(),
                Navigation::Forward => browser.go_forward(),
                Navigation::Stop => browser.stop_loading(),
            }
            Ok(())
        }
        #[cfg(target_os = "macos")]
        unsafe {
            let browser = &*platform.inner().cast::<objc2_web_kit::WKWebView>();
            match action {
                Navigation::Back => {
                    browser.goBack();
                }
                Navigation::Forward => {
                    browser.goForward();
                }
                Navigation::Stop => browser.stopLoading(),
            }
            Ok(())
        }
    })
    .await
}

pub async fn go_back(webview: &Webview) -> Result<(), String> {
    navigate(webview, Navigation::Back).await
}
pub async fn go_forward(webview: &Webview) -> Result<(), String> {
    navigate(webview, Navigation::Forward).await
}
pub async fn stop(webview: &Webview) -> Result<(), String> {
    navigate(webview, Navigation::Stop).await
}

async fn evaluate(webview: &Webview, script: String) -> Result<Value, String> {
    let (reply, receiver) = tokio::sync::oneshot::channel();
    let reply = std::sync::Mutex::new(Some(reply));
    webview
        .eval_with_callback(script, move |value| {
            if let Some(reply) = reply.lock().ok().and_then(|mut reply| reply.take()) {
                let _ = reply.send(serde_json::from_str(&value).map_err(|e| e.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;
    response(receiver).await
}

pub async fn inspect(webview: &Webview, x: f64, y: f64) -> Result<Value, String> {
    if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
        return Err("Choose a point inside the browser page.".to_string());
    }
    // Use the same source as Chromium and native WebKit. String.raw contains plain JavaScript.
    let source = include_str!("../../../../ui/src/components/browser/browser-inspect-script.ts");
    let script = source
        .split_once("String.raw`")
        .and_then(|(_, source)| source.rsplit_once('`'))
        .map(|(source, _)| source)
        .ok_or_else(|| "Browser inspection script is unavailable.".to_string())?;
    let node = evaluate(webview, format!("({script})({x},{y})")).await?;
    Ok(json!({"ok": true, "node": node}))
}

pub async fn snapshot(webview: &Webview) -> Result<Value, String> {
    let viewport = evaluate(
        webview,
        "({width:innerWidth,height:innerHeight})".to_string(),
    )
    .await?;
    let width = viewport["width"]
        .as_f64()
        .filter(|v| *v > 0.0)
        .ok_or("The browser viewport is empty.")?;
    let height = viewport["height"]
        .as_f64()
        .filter(|v| *v > 0.0)
        .ok_or("The browser viewport is empty.")?;
    let data = snapshot_png(webview).await?;
    Ok(
        json!({"ok": true, "dataUrl": format!("data:image/png;base64,{data}"), "cssWidth": width, "cssHeight": height}),
    )
}

#[cfg(target_os = "windows")]
async fn snapshot_png(webview: &Webview) -> Result<String, String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::w;
    let (reply, receiver) = tokio::sync::oneshot::channel();
    let reply = std::sync::Arc::new(std::sync::Mutex::new(Some(reply)));
    webview
        .with_webview(move |platform| {
            let completion = reply.clone();
            let result = (|| unsafe {
                let browser = platform.controller().CoreWebView2()?;
                browser.CallDevToolsProtocolMethod(
                    w!("Page.captureScreenshot"),
                    w!("{\"format\":\"png\",\"captureBeyondViewport\":false}"),
                    &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                        move |status, result| {
                            let result = status.map_err(|e| e.to_string()).and_then(|_| {
                                let value: Value =
                                    serde_json::from_str(&result).map_err(|e| e.to_string())?;
                                value["data"]
                                    .as_str()
                                    .filter(|data| !data.is_empty())
                                    .map(str::to_owned)
                                    .ok_or_else(|| {
                                        "The browser returned an empty screenshot.".to_string()
                                    })
                            });
                            if let Some(reply) =
                                completion.lock().ok().and_then(|mut reply| reply.take())
                            {
                                let _ = reply.send(result);
                            }
                            Ok(())
                        },
                    )),
                )
            })();
            if let Err(error) = result {
                if let Some(reply) = reply.lock().ok().and_then(|mut reply| reply.take()) {
                    let _ = reply.send(Err(error.to_string()));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    response(receiver).await
}

#[cfg(target_os = "linux")]
async fn snapshot_png(webview: &Webview) -> Result<String, String> {
    use base64::Engine;
    use webkit2gtk::WebViewExt;
    let (reply, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| {
            platform.inner().snapshot(
                webkit2gtk::SnapshotRegion::Visible,
                webkit2gtk::SnapshotOptions::NONE,
                None::<&gtk::gio::Cancellable>,
                move |result| {
                    let result = result.map_err(|e| e.to_string()).and_then(|surface| {
                        let mut png = Vec::new();
                        surface.write_to_png(&mut png).map_err(|e| e.to_string())?;
                        Ok(base64::engine::general_purpose::STANDARD.encode(png))
                    });
                    let _ = reply.send(result);
                },
            );
        })
        .map_err(|e| e.to_string())?;
    response(receiver).await
}

#[cfg(target_os = "macos")]
async fn snapshot_png(webview: &Webview) -> Result<String, String> {
    use base64::Engine;
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    let (reply, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| unsafe {
            let reply = std::cell::RefCell::new(Some(reply));
            let completion =
                block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    let result = (|| {
                        if !error.is_null() {
                            return Err((&*error).localizedDescription().to_string());
                        }
                        let image = image
                            .as_ref()
                            .ok_or("The browser returned an empty screenshot.")?;
                        let tiff = image
                            .TIFFRepresentation()
                            .ok_or("Could not encode the browser screenshot.")?;
                        let bitmap =
                            NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)
                                .ok_or("Could not encode the browser screenshot.")?;
                        let png = bitmap
                            .representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &NSDictionary::new(),
                            )
                            .ok_or("Could not encode the browser screenshot.")?;
                        Ok(base64::engine::general_purpose::STANDARD
                            .encode(png.as_bytes_unchecked()))
                    })();
                    if let Some(reply) = reply.borrow_mut().take() {
                        let _ = reply.send(result);
                    }
                });
            let browser = &*platform.inner().cast::<objc2_web_kit::WKWebView>();
            browser.takeSnapshotWithConfiguration_completionHandler(None, &completion);
        })
        .map_err(|e| e.to_string())?;
    response(receiver).await
}

#[cfg(target_os = "windows")]
pub async fn download(webview: &Webview, generation: u64) -> Result<Value, String> {
    windows_download::download(webview, generation).await
}

#[cfg(target_os = "windows")]
mod windows_download {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        collections::HashMap,
        path::PathBuf,
        rc::Rc,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
    };
    use webview2_com::{
        take_pwstr, CallDevToolsProtocolMethodCompletedHandler, DownloadStartingEventHandler,
        Microsoft::Web::WebView2::Win32::*, PermissionRequestedEventHandler,
        StateChangedEventHandler,
    };
    use windows::{
        core::{implement, Interface, Ref, HRESULT, HSTRING, PWSTR},
        Win32::{
            Foundation::{ERROR_CANCELLED, HWND, LPARAM, WPARAM},
            System::{
                Com::{
                    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                    COINIT_APARTMENTTHREADED,
                },
                Ole::IOleWindow,
            },
            UI::{
                Shell::{
                    FileSaveDialog, IFileDialog, IFileDialogEvents, IFileDialogEvents_Impl,
                    IFileSaveDialog, IShellItem, FDEOR_DEFAULT, FDESVR_DEFAULT,
                    FDE_OVERWRITE_RESPONSE, FDE_SHAREVIOLATION_RESPONSE, FOS_FORCEFILESYSTEM,
                    FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST, SIGDN_FILESYSPATH,
                },
                WindowsAndMessaging::{GetWindowThreadProcessId, PostMessageW, WM_CLOSE},
            },
        },
    };

    type Reply = tokio::sync::oneshot::Sender<Result<Value, String>>;
    thread_local! {
        // WebView2 COM objects stay on the thread that owns the WebView.
        static TRANSFERS: RefCell<HashMap<String, Rc<Transfer>>> = RefCell::new(HashMap::new());
    }

    #[derive(Default)]
    struct PickerCancellation {
        cancelled: AtomicBool,
        // Only this picker's observed window and owning thread may receive WM_CLOSE.
        window: Mutex<Option<(isize, u32)>>,
    }

    impl PickerCancellation {
        fn cancel(&self) {
            self.cancelled.store(true, Ordering::Release);
            if let Ok(window) = self.window.lock() {
                if let Some((handle, thread)) = *window {
                    unsafe {
                        let window = HWND(handle as *mut _);
                        if GetWindowThreadProcessId(window, None) == thread {
                            let _ = PostMessageW(Some(window), WM_CLOSE, WPARAM(0), LPARAM(0));
                        }
                    }
                }
            }
        }

        fn observe(&self, dialog: Ref<'_, IFileDialog>) -> windows::core::Result<()> {
            let dialog = dialog.ok()?;
            unsafe {
                if let Ok(window) = dialog
                    .cast::<IOleWindow>()
                    .and_then(|window| window.GetWindow())
                {
                    if let Ok(mut current) = self.window.lock() {
                        *current =
                            Some((window.0 as isize, GetWindowThreadProcessId(window, None)));
                    }
                }
                if self.cancelled.load(Ordering::Acquire) {
                    dialog.Close(HRESULT::from_win32(ERROR_CANCELLED.0))?;
                }
            }
            Ok(())
        }
    }

    #[implement(IFileDialogEvents)]
    struct PickerEvents(Arc<PickerCancellation>);

    #[allow(non_snake_case)]
    impl IFileDialogEvents_Impl for PickerEvents_Impl {
        fn OnFileOk(&self, dialog: Ref<'_, IFileDialog>) -> windows::core::Result<()> {
            self.0.observe(dialog)
        }
        fn OnFolderChanging(
            &self,
            dialog: Ref<'_, IFileDialog>,
            _folder: Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            self.0.observe(dialog)
        }
        fn OnFolderChange(&self, dialog: Ref<'_, IFileDialog>) -> windows::core::Result<()> {
            self.0.observe(dialog)
        }
        fn OnSelectionChange(&self, dialog: Ref<'_, IFileDialog>) -> windows::core::Result<()> {
            self.0.observe(dialog)
        }
        fn OnShareViolation(
            &self,
            dialog: Ref<'_, IFileDialog>,
            _item: Ref<'_, IShellItem>,
        ) -> windows::core::Result<FDE_SHAREVIOLATION_RESPONSE> {
            self.0.observe(dialog)?;
            Ok(FDESVR_DEFAULT)
        }
        fn OnTypeChange(&self, dialog: Ref<'_, IFileDialog>) -> windows::core::Result<()> {
            self.0.observe(dialog)
        }
        fn OnOverwrite(
            &self,
            dialog: Ref<'_, IFileDialog>,
            _item: Ref<'_, IShellItem>,
        ) -> windows::core::Result<FDE_OVERWRITE_RESPONSE> {
            self.0.observe(dialog)?;
            Ok(FDEOR_DEFAULT)
        }
    }

    fn choose_destination(
        parent: isize,
        suggested: PathBuf,
        cancellation: Arc<PickerCancellation>,
        authority: DownloadAuthority,
    ) -> Result<Option<PathBuf>, String> {
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe { CoUninitialize() };
            }
        }
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|e| e.to_string())?;
            let _apartment = Apartment;
            authority.ensure_current()?;
            if cancellation.cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            let dialog: IFileSaveDialog =
                CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| e.to_string())?;
            dialog
                .SetOptions(FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT | FOS_PATHMUSTEXIST)
                .map_err(|e| e.to_string())?;
            let filename = suggested
                .file_name()
                .unwrap_or_else(|| std::ffi::OsStr::new("download"));
            dialog
                .SetFileName(&HSTRING::from(filename))
                .map_err(|e| e.to_string())?;
            if let Some(extension) = suggested.extension() {
                dialog
                    .SetDefaultExtension(&HSTRING::from(extension))
                    .map_err(|e| e.to_string())?;
            }
            let events: IFileDialogEvents = PickerEvents(cancellation.clone()).into();
            let token = dialog.Advise(&events).map_err(|e| e.to_string())?;
            let choice = dialog.Show(Some(HWND(parent as *mut _)));
            if let Ok(mut window) = cancellation.window.lock() {
                *window = None;
            }
            let _ = dialog.Unadvise(token);
            authority.ensure_current()?;
            if cancellation.cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            if let Err(error) = choice {
                if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                    return Ok(None);
                }
                return Err(format!("Could not choose a download destination: {error}"));
            }
            let path = dialog
                .GetResult()
                .and_then(|item| item.GetDisplayName(SIGDN_FILESYSPATH))
                .map_err(|e| e.to_string())?;
            Ok(Some(PathBuf::from(take_pwstr(path))))
        }
    }

    struct Transfer {
        id: String,
        label: String,
        authority: DownloadAuthority,
        url: tauri::Url,
        browser: ICoreWebView2_4,
        parent: HWND,
        reply: RefCell<Option<Reply>>,
        start_token: Cell<Option<i64>>,
        permission_token: Cell<Option<i64>>,
        permission_consumed: Cell<bool>,
        state_token: Cell<Option<i64>>,
        operation: RefCell<Option<ICoreWebView2DownloadOperation>>,
        args: RefCell<Option<ICoreWebView2DownloadStartingEventArgs>>,
        deferral: RefCell<Option<ICoreWebView2Deferral>>,
        dialog: RefCell<Option<Arc<PickerCancellation>>>,
        destination: RefCell<Option<(PathBuf, PathBuf)>>,
    }

    impl Transfer {
        fn pending(&self) -> bool {
            self.reply.borrow().is_some()
        }

        unsafe fn finish(&self, result: Result<Value, String>) {
            let Some(reply) = self.reply.borrow_mut().take() else {
                return;
            };
            if let Some(token) = self.start_token.take() {
                let _ = self.browser.remove_DownloadStarting(token);
            }
            if let Some(token) = self.permission_token.take() {
                let _ = self.browser.remove_PermissionRequested(token);
            }
            let operation = self.operation.borrow_mut().take();
            if let (Some(operation), Some(token)) = (operation.as_ref(), self.state_token.take()) {
                let _ = operation.remove_StateChanged(token);
            }
            let dialog = self.dialog.borrow_mut().take();
            if let Some(dialog) = dialog {
                dialog.cancel();
            }
            let args = self.args.borrow_mut().take();
            if let Some(args) = args {
                let _ = args.SetCancel(true);
            }
            let deferral = self.deferral.borrow_mut().take();
            if let Some(deferral) = deferral {
                let _ = deferral.Complete();
            }
            if let Some(operation) = operation {
                let _ = operation.Cancel();
            }
            if let Some((staging, _)) = self.destination.borrow_mut().take() {
                let _ = std::fs::remove_file(staging);
            }
            TRANSFERS.with(|transfers| {
                transfers.borrow_mut().remove(&self.id);
            });
            let _ = reply.send(result);
        }

        unsafe fn update(&self) -> Result<(), String> {
            if !self.pending() {
                return Ok(());
            }
            self.authority.ensure_current()?;
            let Some(operation) = self.operation.borrow().clone() else {
                return Ok(());
            };
            let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
            operation.State(&mut state).map_err(|e| e.to_string())?;
            if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                let destination = self.destination.borrow_mut().take();
                let result = destination
                    .ok_or_else(|| {
                        "The download completed without a selected destination.".to_string()
                    })
                    .and_then(|(staging, destination)| {
                        let saved = self.authority.ensure_current().and_then(|()| {
                            std::fs::rename(&staging, destination)
                                .map_err(|e| format!("Could not save this asset: {e}"))
                        });
                        if saved.is_err() {
                            let _ = std::fs::remove_file(staging);
                        }
                        saved.map(|_| json!({"ok": true, "cancelled": false}))
                    });
                self.finish(result);
            } else if state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
                let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default();
                operation
                    .InterruptReason(&mut reason)
                    .map_err(|e| e.to_string())?;
                if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED
                    || reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_SHUTDOWN
                {
                    self.finish(Ok(json!({"ok": true, "cancelled": true})));
                } else {
                    self.finish(Err(
                        "The download was interrupted. Check the connection and try again."
                            .to_string(),
                    ));
                }
            }
            Ok(())
        }

        unsafe fn choose(&self) -> Result<(), String> {
            if !self.pending() {
                return Ok(());
            }
            self.authority.ensure_current()?;
            let args = self
                .args
                .borrow()
                .clone()
                .ok_or("The download request is no longer available.")?;
            let mut suggested = PWSTR::null();
            args.ResultFilePath(&mut suggested)
                .map_err(|e| e.to_string())?;
            let suggested = PathBuf::from(take_pwstr(suggested));
            let cancellation = Arc::new(PickerCancellation::default());
            self.dialog.replace(Some(cancellation.clone()));
            let id = self.id.clone();
            let app = self.authority.app.clone();
            let authority = self.authority.clone();
            // HWNDs are process-wide handles; no WebView2 or dialog COM interface
            // crosses apartments. A modal picker must not block Tauri's event loop.
            let parent = self.parent.0 as isize;
            std::thread::Builder::new()
                .name("browser-save-dialog".into())
                .spawn(move || {
                    let result = choose_destination(parent, suggested, cancellation, authority);
                    let _ = app.run_on_main_thread(move || {
                        let transfer =
                            TRANSFERS.with(|transfers| transfers.borrow().get(&id).cloned());
                        if let Some(transfer) = transfer {
                            unsafe {
                                let result = result.and_then(|path| transfer.chosen(path));
                                if let Err(error) = result {
                                    transfer.finish(Err(error));
                                }
                            }
                        }
                    });
                })
                .map_err(|e| format!("Could not open the download picker: {e}"))?;
            Ok(())
        }

        unsafe fn chosen(&self, destination: Option<PathBuf>) -> Result<(), String> {
            self.dialog.borrow_mut().take();
            if !self.pending() {
                return Ok(());
            }
            self.authority.ensure_current()?;
            let Some(destination) = destination else {
                self.finish(Ok(json!({"ok": true, "cancelled": true})));
                return Ok(());
            };
            let args = self
                .args
                .borrow()
                .clone()
                .ok_or("The download request is no longer available.")?;
            let staging = destination.with_file_name(format!(".openclaw-download-{}", self.id));
            args.SetResultFilePath(&HSTRING::from(staging.as_path()))
                .map_err(|e| e.to_string())?;
            self.destination.replace(Some((staging, destination)));
            self.args.borrow_mut().take();
            let deferral = self.deferral.borrow_mut().take();
            if let Some(deferral) = deferral {
                deferral.Complete().map_err(|e| e.to_string())?;
            }
            self.update()
        }

        unsafe fn permission_requested(
            &self,
            args: ICoreWebView2PermissionRequestedEventArgs,
        ) -> Result<(), String> {
            if !self.pending() || self.operation.borrow().is_some() {
                return Ok(());
            }
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind).map_err(|e| e.to_string())?;
            let mut uri = PWSTR::null();
            args.Uri(&mut uri).map_err(|e| e.to_string())?;
            let uri = take_pwstr(uri);
            // WebView2 reports IsUserInitiated=false for a deliberate host download.
            // The pending host request owns intent; page gesture state is not authority.
            if !matches_download_permission(
                &self.url,
                &uri,
                kind,
                self.authority.ensure_current().is_ok(),
                self.permission_consumed.get(),
            ) {
                return Ok(());
            }
            self.authority.ensure_current()?;
            let scoped = args
                .cast::<ICoreWebView2PermissionRequestedEventArgs3>()
                .map_err(|_| {
                    "Update Microsoft Edge WebView2 to download this asset.".to_string()
                })?;
            // WebView2 reports the requesting origin, not the asset URI. Keep the
            // DownloadStarting gate until completion to reject other queued files.
            scoped.SetSavesInProfile(false).map_err(|e| e.to_string())?;
            self.authority.ensure_current()?;
            self.permission_consumed.set(true);
            args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)
                .map_err(|e| e.to_string())
        }

        unsafe fn started(
            self: &Rc<Self>,
            args: ICoreWebView2DownloadStartingEventArgs,
            app: &tauri::AppHandle,
        ) -> Result<(), String> {
            if !self.pending() {
                return Ok(());
            }
            if self.operation.borrow().is_some() {
                if self.permission_consumed.get() {
                    args.SetCancel(true).map_err(|e| e.to_string())?;
                }
                return Ok(());
            }
            let operation = args.DownloadOperation().map_err(|e| e.to_string())?;
            let mut uri = PWSTR::null();
            operation.Uri(&mut uri).map_err(|e| e.to_string())?;
            let Ok(mut uri) = tauri::Url::parse(&take_pwstr(uri)) else {
                if self.permission_consumed.get() {
                    args.SetCancel(true).map_err(|e| e.to_string())?;
                }
                return Ok(());
            };
            uri.set_fragment(None);
            let mut requested = self.url.clone();
            requested.set_fragment(None);
            if uri != requested {
                if self.permission_consumed.get() {
                    args.SetCancel(true).map_err(|e| e.to_string())?;
                }
                return Ok(());
            }
            if let Err(error) = self.authority.ensure_current() {
                let _ = args.SetCancel(true);
                return Err(error);
            }
            args.SetHandled(true).map_err(|e| e.to_string())?;
            let deferral = args.GetDeferral().map_err(|e| e.to_string())?;
            self.args.replace(Some(args));
            self.deferral.replace(Some(deferral));
            self.operation.replace(Some(operation.clone()));
            let weak = Rc::downgrade(self);
            let mut token = 0;
            operation
                .add_StateChanged(
                    &StateChangedEventHandler::create(Box::new(move |_, _| {
                        if let Some(transfer) = weak.upgrade() {
                            if let Err(error) = transfer.update() {
                                transfer.finish(Err(error));
                            }
                        }
                        Ok(())
                    })),
                    &mut token,
                )
                .map_err(|e| e.to_string())?;
            self.state_token.set(Some(token));
            let app = app.clone();
            let id = self.id.clone();
            // Dispatch from a worker: Tauri executes same-thread tasks inline, while WebView2
            // requires leaving DownloadStarting before opening a modal picker.
            tauri::async_runtime::spawn(async move {
                let _ = app.run_on_main_thread(move || {
                    let transfer = TRANSFERS.with(|transfers| transfers.borrow().get(&id).cloned());
                    if let Some(transfer) = transfer {
                        unsafe {
                            if let Err(error) = transfer.choose() {
                                transfer.finish(Err(error));
                            }
                        }
                    }
                });
            });
            Ok(())
        }
    }

    fn matches_download_permission(
        requested: &tauri::Url,
        uri: &str,
        kind: COREWEBVIEW2_PERMISSION_KIND,
        current_host_request: bool,
        consumed: bool,
    ) -> bool {
        !consumed
            && current_host_request
            && kind == COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS
            && tauri::Url::parse(uri).is_ok_and(|uri| uri.origin() == requested.origin())
    }

    pub async fn download(webview: &Webview, generation: u64) -> Result<Value, String> {
        let authority = DownloadAuthority::new(webview, generation);
        authority.ensure_current()?;
        let url = download_url(webview)?;
        let label = webview.label().to_owned();
        let app = webview.app_handle().clone();
        let (reply, receiver) = tokio::sync::oneshot::channel();
        webview.with_webview(move |platform| unsafe {
            if let Err(error) = authority.ensure_current() { let _ = reply.send(Err(error)); return; }
            let browser = match platform.controller().CoreWebView2().and_then(|browser| browser.cast::<ICoreWebView2_4>()) {
                Ok(browser) => browser,
                Err(error) => { let _ = reply.send(Err(error.to_string())); return; }
            };
            let mut parent = HWND::default();
            if let Err(error) = platform.controller().ParentWindow(&mut parent) { let _ = reply.send(Err(error.to_string())); return; }
            let id = uuid::Uuid::new_v4().to_string();
            let transfer = Rc::new(Transfer { id: id.clone(), label, authority, url: url.clone(), browser, parent, reply: RefCell::new(Some(reply)), start_token: Cell::new(None), permission_token: Cell::new(None), permission_consumed: Cell::new(false), state_token: Cell::new(None), operation: RefCell::new(None), args: RefCell::new(None), deferral: RefCell::new(None), dialog: RefCell::new(None), destination: RefCell::new(None) });
            TRANSFERS.with(|transfers| { transfers.borrow_mut().insert(id.clone(), transfer.clone()); });
            let weak = Rc::downgrade(&transfer);
            let event_app = app.clone();
            let mut token = 0;
            let registered = transfer.browser.add_DownloadStarting(&DownloadStartingEventHandler::create(Box::new(move |_, args| {
                if let (Some(transfer), Some(args)) = (weak.upgrade(), args) {
                    if let Err(error) = transfer.started(args, &event_app) { transfer.finish(Err(error)); }
                }
                Ok(())
            })), &mut token);
            if let Err(error) = registered { transfer.finish(Err(error.to_string())); return; }
            transfer.start_token.set(Some(token));
            let weak = Rc::downgrade(&transfer);
            let mut token = 0;
            let registered = transfer.browser.add_PermissionRequested(&PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                if let (Some(transfer), Some(args)) = (weak.upgrade(), args) {
                    if let Err(error) = transfer.permission_requested(args) { transfer.finish(Err(error)); }
                }
                Ok(())
            })), &mut token);
            if let Err(error) = registered { transfer.finish(Err(error.to_string())); return; }
            transfer.permission_token.set(Some(token));
            // A user-requested download of the current same-origin URL uses WebView2's regular
            // download engine. Page Save As has no completion event and cannot own this contract.
            let url_json = serde_json::to_string(url.as_str()).expect("URL is JSON serializable");
            let script = format!("(()=>{{try{{const a=document.createElement('a');a.href={url_json};a.download='';a.click();return true}}catch(e){{return false}}}})()");
            let weak = Rc::downgrade(&transfer);
            let parameters = json!({"expression": script, "returnByValue": true, "userGesture": true}).to_string();
            let requested = transfer.browser.CallDevToolsProtocolMethod(&HSTRING::from("Runtime.evaluate"), &HSTRING::from(parameters), &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, value| {
                if let Some(transfer) = weak.upgrade() {
                    let started = serde_json::from_str::<Value>(&value).ok().is_some_and(|value| value["result"]["value"] == true);
                    if transfer.operation.borrow().is_none() && (status.is_err() || !started) {
                        transfer.finish(Err("Could not start this download. Try again after the page loads.".to_string()));
                    }
                }
                Ok(())
            })));
            if let Err(error) = requested { transfer.finish(Err(error.to_string())); return; }
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                let _ = app.run_on_main_thread(move || {
                    let transfer = TRANSFERS.with(|transfers| transfers.borrow().get(&id).cloned());
                    if let Some(transfer) = transfer {
                        if transfer.operation.borrow().is_none() {
                            transfer.finish(Err("The page did not start the download. Try again after it finishes loading.".to_string()));
                        }
                    }
                });
            });
        }).map_err(|e| e.to_string())?;
        receiver
            .await
            .map_err(|_| "The browser closed before saving completed.".to_string())?
    }

    pub unsafe fn cancel(label: &str) {
        let transfers: Vec<_> = TRANSFERS.with(|transfers| {
            transfers
                .borrow()
                .values()
                .filter(|transfer| transfer.label == label)
                .cloned()
                .collect()
        });
        for transfer in transfers {
            transfer.finish(Ok(json!({"ok": true, "cancelled": true})));
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn host_download_permission_requires_current_origin_kind_and_unused_allowance() {
            let requested =
                tauri::Url::parse("https://example.test:8443/assets/report.pdf").unwrap();
            let downloads = COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS;
            // A current host request is sufficient even though WebView2 reports no
            // page gesture for this flow. The adapter deliberately never reads that bit.
            assert!(matches_download_permission(
                &requested,
                "https://example.test:8443/",
                downloads,
                true,
                false
            ));
            for uri in [
                "https://other.test:8443/",
                "http://example.test:8443/",
                "https://example.test/",
                "not a URL",
            ] {
                assert!(!matches_download_permission(
                    &requested, uri, downloads, true, false
                ));
            }
            assert!(!matches_download_permission(
                &requested,
                requested.as_str(),
                downloads,
                false,
                false
            ));
            assert!(!matches_download_permission(
                &requested,
                requested.as_str(),
                COREWEBVIEW2_PERMISSION_KIND_CAMERA,
                true,
                false
            ));
            assert!(!matches_download_permission(
                &requested,
                requested.as_str(),
                downloads,
                true,
                true
            ));
        }
    }
}

#[cfg(target_os = "linux")]
pub async fn download(webview: &Webview, generation: u64) -> Result<Value, String> {
    use gtk::prelude::*;
    use webkit2gtk::{DownloadExt, URIResponseExt, WebViewExt};
    let authority = DownloadAuthority::new(webview, generation);
    authority.ensure_current()?;
    let url = download_url(webview)?;
    let (reply, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| {
            if let Err(error) = authority.ensure_current() {
                let _ = reply.send(Err(error));
                return;
            }
            let browser = platform.inner();
            let Some(download) = browser.download_uri(url.as_str()) else {
                let _ = reply.send(Err("Could not start the download.".to_string()));
                return;
            };
            let reply = std::rc::Rc::new(std::cell::RefCell::new(Some(reply)));
            let destination = std::rc::Rc::new(std::cell::RefCell::new(
                None::<(std::path::PathBuf, std::path::PathBuf)>,
            ));
            let dialog = std::rc::Rc::new(std::cell::RefCell::new(None::<gtk::FileChooserNative>));
            let cancellation = reply.clone();
            let cancelled_download = download.downgrade();
            let cancelled_dialog = dialog.clone();
            let cancelled_destination = destination.clone();
            let destroy_handler = browser.connect_destroy(move |_| {
                if let Some(reply) = cancellation.borrow_mut().take() {
                    let _ = reply.send(Ok(json!({"ok": true, "cancelled": true})));
                }
                if let Some(dialog) = cancelled_dialog.borrow_mut().take() {
                    dialog.destroy();
                }
                if let Some(download) = cancelled_download.upgrade() {
                    download.cancel();
                }
                if let Some((staging, _)) = cancelled_destination.borrow_mut().take() {
                    let _ = std::fs::remove_file(staging);
                }
            });
            let destroy_handler = std::rc::Rc::new(std::cell::RefCell::new(Some(destroy_handler)));
            let completion = reply.clone();
            let completed_destination = destination.clone();
            let completed_browser = browser.downgrade();
            let completed_handler = destroy_handler.clone();
            let completed_authority = authority.clone();
            download.connect_finished(move |_| {
                if let Some(reply) = completion.borrow_mut().take() {
                    let result = completed_destination
                        .borrow_mut()
                        .take()
                        .ok_or_else(|| {
                            "The browser did not select a download destination.".to_string()
                        })
                        .and_then(|(staging, destination)| {
                            let result = completed_authority.ensure_current().and_then(|()| {
                                std::fs::rename(&staging, destination)
                                    .map_err(|e| format!("Could not save this asset: {e}"))
                            });
                            if result.is_err() {
                                let _ = std::fs::remove_file(staging);
                            }
                            result.map(|_| json!({"ok": true, "cancelled": false}))
                        });
                    let _ = reply.send(result);
                }
                if let (Some(browser), Some(handler)) = (
                    completed_browser.upgrade(),
                    completed_handler.borrow_mut().take(),
                ) {
                    browser.disconnect(handler);
                }
            });
            let completion = reply.clone();
            let failed_destination = destination.clone();
            let failed_browser = browser.downgrade();
            let failed_dialog = dialog.clone();
            download.connect_failed(move |_, error| {
                let reply = completion.borrow_mut().take();
                let dialog = failed_dialog.borrow_mut().take();
                if let Some(dialog) = dialog {
                    dialog.destroy();
                }
                if let Some((staging, _)) = failed_destination.borrow_mut().take() {
                    let _ = std::fs::remove_file(staging);
                }
                if let (Some(browser), Some(handler)) = (
                    failed_browser.upgrade(),
                    destroy_handler.borrow_mut().take(),
                ) {
                    browser.disconnect(handler);
                }
                if let Some(reply) = reply {
                    let _ = reply.send(Err(format!("Could not download this asset: {error}")));
                }
            });
            let parent = browser
                .toplevel()
                .and_then(|widget| widget.downcast::<gtk::Window>().ok());
            download.connect_decide_destination(move |download, filename| {
                if reply.borrow().is_none() {
                    download.cancel();
                    return true;
                }
                if let Err(error) = authority.ensure_current() {
                    if let Some(reply) = reply.borrow_mut().take() {
                        let _ = reply.send(Err(error));
                    }
                    download.cancel();
                    return true;
                }
                if download
                    .response()
                    .is_some_and(|response| !(200..300).contains(&response.status_code()))
                {
                    if let Some(reply) = reply.borrow_mut().take() {
                        let _ = reply.send(Err(
                            "The server did not return a downloadable asset.".to_string()
                        ));
                    }
                    download.cancel();
                    return true;
                }
                let chooser = gtk::FileChooserNative::new(
                    Some("Save browser asset"),
                    parent.as_ref(),
                    gtk::FileChooserAction::Save,
                    Some("Save"),
                    Some("Cancel"),
                );
                chooser.set_current_name(filename);
                chooser.set_do_overwrite_confirmation(true);
                dialog.replace(Some(chooser.clone()));
                let accepted = chooser.run() == gtk::ResponseType::Accept;
                dialog.borrow_mut().take();
                if reply.borrow().is_none() {
                    download.cancel();
                    return true;
                }
                if let Err(error) = authority.ensure_current() {
                    if let Some(reply) = reply.borrow_mut().take() {
                        let _ = reply.send(Err(error));
                    }
                    download.cancel();
                    return true;
                }
                if accepted {
                    if let Some(path) = chooser.filename() {
                        let staging = path
                            .with_file_name(format!(".openclaw-download-{}", uuid::Uuid::new_v4()));
                        let uri = gtk::gio::File::for_path(&staging).uri();
                        destination.replace(Some((staging, path)));
                        download.set_destination(uri.as_str());
                        return true;
                    }
                }
                if let Some(reply) = reply.borrow_mut().take() {
                    let _ = reply.send(Ok(json!({"ok": true, "cancelled": true})));
                }
                download.cancel();
                true
            });
        })
        .map_err(|e| e.to_string())?;
    receiver
        .await
        .map_err(|_| "The browser closed before saving completed.".to_string())?
}

#[cfg(target_os = "macos")]
pub async fn download(webview: &Webview, generation: u64) -> Result<Value, String> {
    mac_download::download(webview, generation).await
}

fn download_url(webview: &Webview) -> Result<tauri::Url, String> {
    let url = webview.url().map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Open an HTTP or HTTPS page before downloading an asset.".to_string());
    }
    Ok(url)
}

#[cfg(target_os = "macos")]
mod mac_navigation_failure {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject, Sel};
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly, Message};
    use objc2_foundation::{MainThreadMarker, NSError, NSObject, NSObjectProtocol};
    use objc2_web_kit::{WKNavigation, WKNavigationDelegate, WKWebView};
    use std::{cell::RefCell, sync::Arc};

    static PROXY_KEY: u8 = 0;

    struct FailureState {
        original: Retained<ProtocolObject<dyn WKNavigationDelegate>>,
        latest: RefCell<Option<Retained<WKNavigation>>>,
        failed: Arc<dyn Fn() + Send + Sync>,
    }

    define_class!(
        #[unsafe(super = NSObject)]
        #[name = "OpenClawTauriNavigationFailureProxy"]
        #[thread_kind = MainThreadOnly]
        #[ivars = FailureState]
        struct FailureProxy;

        unsafe impl NSObjectProtocol for FailureProxy {
            #[unsafe(method(respondsToSelector:))]
            fn responds(&self, selector: Sel) -> bool {
                let own: bool = unsafe { msg_send![super(self), respondsToSelector: selector] };
                own || self.ivars().original.respondsToSelector(selector)
            }
        }

        impl FailureProxy {
            #[unsafe(method(forwardingTargetForSelector:))]
            fn forwarding_target(&self, selector: Sel) -> Option<&AnyObject> {
                self.ivars().original.respondsToSelector(selector)
                    .then(|| AsRef::<AnyObject>::as_ref(&*self.ivars().original))
            }
        }

        unsafe impl WKNavigationDelegate for FailureProxy {
            #[unsafe(method(webView:didStartProvisionalNavigation:))]
            unsafe fn started(&self, browser: &WKWebView, navigation: Option<&WKNavigation>) {
                self.ivars().latest.replace(navigation.map(|navigation| navigation.retain()));
                let original = &self.ivars().original;
                if original.respondsToSelector(sel!(webView:didStartProvisionalNavigation:)) {
                    original.webView_didStartProvisionalNavigation(browser, navigation);
                }
            }

            #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
            unsafe fn provisional_failed(&self, browser: &WKWebView, navigation: Option<&WKNavigation>, error: &NSError) {
                self.report(navigation, error);
                let original = &self.ivars().original;
                if original.respondsToSelector(sel!(webView:didFailProvisionalNavigation:withError:)) {
                    original.webView_didFailProvisionalNavigation_withError(browser, navigation, error);
                }
            }

            #[unsafe(method(webView:didFailNavigation:withError:))]
            unsafe fn failed(&self, browser: &WKWebView, navigation: Option<&WKNavigation>, error: &NSError) {
                self.report(navigation, error);
                let original = &self.ivars().original;
                if original.respondsToSelector(sel!(webView:didFailNavigation:withError:)) {
                    original.webView_didFailNavigation_withError(browser, navigation, error);
                }
            }
        }
    );

    impl FailureProxy {
        fn report(&self, navigation: Option<&WKNavigation>, error: &NSError) {
            if error.domain().to_string() == "NSURLErrorDomain" && error.code() == -999 {
                return;
            }
            let latest = self.ivars().latest.borrow();
            if let (Some(latest), Some(navigation)) = (latest.as_ref(), navigation) {
                if !std::ptr::eq(&**latest, navigation) {
                    return;
                }
            }
            drop(latest);
            (self.ivars().failed)();
        }
    }

    pub unsafe fn observe(
        browser: *mut WKWebView,
        failed: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<(), String> {
        clear(browser);
        let mtm = MainThreadMarker::new().ok_or("The browser is not on the application thread.")?;
        let original = (&*browser)
            .navigationDelegate()
            .ok_or("The browser navigation delegate is unavailable.")?;
        let proxy = FailureProxy::alloc(mtm).set_ivars(FailureState {
            original,
            latest: RefCell::new(None),
            failed,
        });
        let proxy: Retained<FailureProxy> = msg_send![super(proxy), init];
        // WKWebView's delegate is weak. Retain the forwarding proxy for this view's
        // lifetime, preserving every original Wry policy, script and download callback.
        objc2::ffi::objc_setAssociatedObject(
            browser.cast(),
            (&PROXY_KEY as *const u8).cast(),
            Retained::as_ptr(&proxy).cast_mut().cast(),
            objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
        (&*browser).setNavigationDelegate(Some(ProtocolObject::from_ref(&*proxy)));
        Ok(())
    }

    pub unsafe fn clear(browser: *mut WKWebView) {
        let key = (&PROXY_KEY as *const u8).cast();
        let proxy =
            objc2::ffi::objc_getAssociatedObject(browser.cast(), key).cast::<FailureProxy>();
        if let Some(proxy) = proxy.as_ref() {
            (&*browser).setNavigationDelegate(Some(&proxy.ivars().original));
            objc2::ffi::objc_setAssociatedObject(
                browser.cast(),
                key,
                std::ptr::null_mut(),
                objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
            );
        }
    }
}

#[cfg(target_os = "macos")]
mod mac_observer {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
    use objc2_foundation::{
        MainThreadMarker, NSDictionary, NSKeyValueChangeKey, NSKeyValueObservingOptions, NSObject,
        NSObjectNSKeyValueObserverRegistration, NSObjectProtocol, NSString,
    };
    use objc2_web_kit::WKWebView;
    use std::{ffi::c_void, sync::Arc};

    static OBSERVER_KEY: u8 = 0;
    const KEYS: [&str; 5] = ["URL", "title", "loading", "canGoBack", "canGoForward"];

    define_class!(
        #[unsafe(super = NSObject)]
        #[name = "OpenClawTauriBrowserObserver"]
        #[thread_kind = MainThreadOnly]
        #[ivars = Arc<dyn Fn() + Send + Sync>]
        struct BrowserObserver;

        unsafe impl NSObjectProtocol for BrowserObserver {}

        impl BrowserObserver {
            #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
            fn changed(&self, _key: Option<&NSString>, _object: Option<&AnyObject>, _change: Option<&NSDictionary<NSKeyValueChangeKey, AnyObject>>, _context: *mut c_void) {
                (self.ivars())();
            }
        }
    );

    pub unsafe fn observe(browser: *mut WKWebView, changed: Arc<dyn Fn() + Send + Sync>) {
        clear(browser);
        let mtm = MainThreadMarker::new().expect("WebKit view callbacks run on the main thread");
        let this = BrowserObserver::alloc(mtm).set_ivars(changed);
        let observer: Retained<BrowserObserver> = msg_send![super(this), init];
        for key in KEYS {
            (&*browser).addObserver_forKeyPath_options_context(
                &observer,
                &NSString::from_str(key),
                NSKeyValueObservingOptions(0),
                std::ptr::null_mut(),
            );
        }
        // Retention follows the native view lifetime; the observer does not retain the view.
        objc2::ffi::objc_setAssociatedObject(
            browser.cast(),
            (&OBSERVER_KEY as *const u8).cast(),
            Retained::as_ptr(&observer).cast_mut().cast(),
            objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
    }

    pub unsafe fn clear(browser: *mut WKWebView) {
        let key = (&OBSERVER_KEY as *const u8).cast();
        let observer = objc2::ffi::objc_getAssociatedObject(browser.cast(), key).cast::<NSObject>();
        if let Some(observer) = observer.as_ref() {
            for path in KEYS {
                (&*browser).removeObserver_forKeyPath(observer, &NSString::from_str(path));
            }
            objc2::ffi::objc_setAssociatedObject(
                browser.cast(),
                key,
                std::ptr::null_mut(),
                objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
            );
        }
    }
}

pub async fn release(webview: &Webview) -> Result<(), String> {
    let label = webview.label().to_owned();
    native(webview, move |platform| {
        #[cfg(target_os = "macos")]
        unsafe {
            mac_observer::clear(platform.inner().cast());
            mac_navigation_failure::clear(platform.inner().cast());
            mac_download::cancel(&label);
        }
        #[cfg(target_os = "windows")]
        unsafe {
            let _ = platform;
            windows_download::cancel(&label);
        }
        #[cfg(target_os = "linux")]
        {
            let _ = (platform, label);
        }
        Ok(())
    })
    .await
}

#[cfg(target_os = "macos")]
mod mac_download {
    use super::*;
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
    use objc2_app_kit::{NSModalResponseOK, NSSavePanel};
    use objc2_foundation::{
        MainThreadMarker, NSData, NSError, NSHTTPURLResponse, NSObject, NSObjectProtocol, NSString,
        NSURLRequest, NSURLResponse, NSURL,
    };
    use objc2_web_kit::{WKDownload, WKDownloadDelegate, WKWebView};
    use std::{cell::RefCell, collections::HashMap, path::PathBuf, ptr::NonNull};

    type Reply = tokio::sync::oneshot::Sender<Result<Value, String>>;

    // WKDownload's delegate is weak. This registry retains delegates only while WebKit owns a transfer.
    thread_local! {
        static TRANSFERS: RefCell<HashMap<String, Retained<BrowserDownloadDelegate>>> = RefCell::new(HashMap::new());
    }

    struct DownloadState {
        id: String,
        label: String,
        authority: DownloadAuthority,
        reply: RefCell<Option<Reply>>,
        download: RefCell<Option<Retained<WKDownload>>>,
        panel: RefCell<Option<Retained<NSSavePanel>>>,
        destination: RefCell<Option<PathBuf>>,
        staging: RefCell<Option<PathBuf>>,
    }

    impl Drop for DownloadState {
        fn drop(&mut self) {
            if let Some(path) = self.staging.get_mut().take() {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    define_class!(
        #[unsafe(super = NSObject)]
        #[name = "OpenClawTauriBrowserDownloadDelegate"]
        #[thread_kind = MainThreadOnly]
        #[ivars = DownloadState]
        struct BrowserDownloadDelegate;

        unsafe impl NSObjectProtocol for BrowserDownloadDelegate {}

        unsafe impl WKDownloadDelegate for BrowserDownloadDelegate {
            #[unsafe(method(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:))]
            unsafe fn destination(
                &self,
                _download: &WKDownload,
                response: &NSURLResponse,
                filename: &NSString,
                completion: &DynBlock<dyn Fn(*mut NSURL)>,
            ) {
                let _retained = Retained::retain(self as *const Self as *mut Self);
                if self.ivars().reply.borrow().is_none() {
                    completion.call((std::ptr::null_mut(),));
                    return;
                }
                if let Err(error) = self.ivars().authority.ensure_current() {
                    self.finish(Err(error));
                    completion.call((std::ptr::null_mut(),));
                    return;
                }
                if response
                    .downcast_ref::<NSHTTPURLResponse>()
                    .is_some_and(|response| !(200..300).contains(&response.statusCode()))
                {
                    self.finish(Err(
                        "The server did not return a downloadable asset.".to_string()
                    ));
                    completion.call((std::ptr::null_mut(),));
                    return;
                }
                let panel = NSSavePanel::savePanel(self.mtm());
                panel.setNameFieldStringValue(filename);
                self.ivars().panel.replace(Some(panel.clone()));
                let accepted = panel.runModal() == NSModalResponseOK;
                self.ivars().panel.borrow_mut().take();
                if self.ivars().reply.borrow().is_none() {
                    completion.call((std::ptr::null_mut(),));
                    return;
                }
                if let Err(error) = self.ivars().authority.ensure_current() {
                    self.finish(Err(error));
                    completion.call((std::ptr::null_mut(),));
                    return;
                }
                if !accepted {
                    self.finish(Ok(json!({"ok": true, "cancelled": true})));
                    completion.call((std::ptr::null_mut(),));
                    return;
                }
                let Some(path) = panel
                    .URL()
                    .and_then(|url| url.path())
                    .map(|path| PathBuf::from(path.to_string()))
                else {
                    self.finish(Err(
                        "Choose a local destination for the download.".to_string()
                    ));
                    completion.call((std::ptr::null_mut(),));
                    return;
                };
                // WebKit requires a destination that does not exist. Stage beside the selected file
                // so completion can atomically replace it, including files on another volume.
                let staging =
                    path.with_file_name(format!(".openclaw-download-{}", self.ivars().id));
                let url = NSURL::fileURLWithPath(&NSString::from_str(&staging.to_string_lossy()));
                self.ivars().destination.replace(Some(path));
                self.ivars().staging.replace(Some(staging));
                completion.call((Retained::as_ptr(&url).cast_mut(),));
            }

            #[unsafe(method(downloadDidFinish:))]
            unsafe fn completed(&self, _download: &WKDownload) {
                let _retained = Retained::retain(self as *const Self as *mut Self);
                if self.ivars().reply.borrow().is_none() {
                    return;
                }
                let result = (|| {
                    let staging = self.ivars().staging.borrow();
                    let destination = self.ivars().destination.borrow();
                    let (Some(staging), Some(destination)) =
                        (staging.as_ref(), destination.as_ref())
                    else {
                        return Err(
                            "The browser did not select a download destination.".to_string()
                        );
                    };
                    self.ivars().authority.ensure_current()?;
                    std::fs::rename(staging, destination)
                        .map_err(|e| format!("Could not save this asset: {e}"))?;
                    Ok(json!({"ok": true, "cancelled": false}))
                })();
                self.finish(result);
            }

            #[unsafe(method(download:didFailWithError:resumeData:))]
            unsafe fn failed(
                &self,
                _download: &WKDownload,
                error: &NSError,
                _resume: Option<&NSData>,
            ) {
                let _retained = Retained::retain(self as *const Self as *mut Self);
                self.finish(Err(format!(
                    "Could not download this asset: {}",
                    error.localizedDescription()
                )));
            }
        }
    );

    impl BrowserDownloadDelegate {
        fn new(
            mtm: MainThreadMarker,
            id: String,
            label: String,
            authority: DownloadAuthority,
            reply: Reply,
        ) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(DownloadState {
                id,
                label,
                authority,
                reply: RefCell::new(Some(reply)),
                download: RefCell::new(None),
                panel: RefCell::new(None),
                destination: RefCell::new(None),
                staging: RefCell::new(None),
            });
            unsafe { msg_send![super(this), init] }
        }

        fn finish(&self, result: Result<Value, String>) {
            // Keep self alive while removing WebKit's weak delegate retention entry.
            let _retained = unsafe { Retained::retain(self as *const Self as *mut Self) };
            let Some(reply) = self.ivars().reply.borrow_mut().take() else {
                return;
            };
            // Clear Rust borrows before native calls, which may reenter delegate methods.
            let panel = self.ivars().panel.borrow_mut().take();
            let download = self.ivars().download.borrow_mut().take();
            unsafe {
                if let Some(panel) = panel {
                    panel.cancel(None);
                }
                if let Some(download) = download {
                    download.setDelegate(None);
                    download.cancel(None);
                }
            }
            if let Some(staging) = self.ivars().staging.borrow_mut().take() {
                let _ = std::fs::remove_file(staging);
            }
            TRANSFERS.with(|transfers| {
                transfers.borrow_mut().remove(&self.ivars().id);
            });
            let _ = reply.send(result);
        }
    }

    pub async fn download(webview: &Webview, generation: u64) -> Result<Value, String> {
        let authority = DownloadAuthority::new(webview, generation);
        authority.ensure_current()?;
        let label = webview.label().to_owned();
        let url = download_url(webview)?.to_string();
        let (reply, receiver) = tokio::sync::oneshot::channel();
        webview
            .with_webview(move |platform| unsafe {
                if let Err(error) = authority.ensure_current() {
                    let _ = reply.send(Err(error));
                    return;
                }
                let Some(url) = NSURL::URLWithString(&NSString::from_str(&url)) else {
                    let _ = reply.send(Err("The browser URL is invalid.".to_string()));
                    return;
                };
                let Some(mtm) = MainThreadMarker::new() else {
                    let _ = reply.send(Err(
                        "The browser is not on the application thread.".to_string()
                    ));
                    return;
                };
                let id = uuid::Uuid::new_v4().to_string();
                let delegate =
                    BrowserDownloadDelegate::new(mtm, id.clone(), label, authority, reply);
                TRANSFERS.with(|transfers| {
                    transfers.borrow_mut().insert(id, delegate.clone());
                });
                let completion = RcBlock::new(move |download: NonNull<WKDownload>| {
                    if delegate.ivars().reply.borrow().is_none() {
                        download.as_ref().cancel(None);
                        return;
                    }
                    delegate.ivars().download.replace(Some(
                        Retained::retain(download.as_ptr()).expect("WebKit provided a download"),
                    ));
                    if let Err(error) = delegate.ivars().authority.ensure_current() {
                        delegate.finish(Err(error));
                        return;
                    }
                    download
                        .as_ref()
                        .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
                });
                let browser = &*platform.inner().cast::<WKWebView>();
                browser.startDownloadUsingRequest_completionHandler(
                    &NSURLRequest::requestWithURL(&url),
                    &completion,
                );
            })
            .map_err(|e| e.to_string())?;
        receiver
            .await
            .map_err(|_| "The browser closed before saving completed.".to_string())?
    }

    pub unsafe fn cancel(label: &str) {
        let transfers: Vec<_> = TRANSFERS.with(|transfers| {
            transfers
                .borrow()
                .values()
                .filter(|transfer| transfer.ivars().label == label)
                .cloned()
                .collect()
        });
        for transfer in transfers {
            transfer.finish(Ok(json!({"ok": true, "cancelled": true})));
        }
    }
}

#[cfg(target_os = "linux")]
const BROWSER_OVERLAY_NAME: &str = "openclaw-dashboard-browser-overlay";

/// Queue teardown before replacing the dashboard WebView. Native window children
/// outlive an individual WebView, so leaving this wrapper behind would give the
/// replacement dashboard a second expanding row in the GTK window.
pub fn detach_surface(webview: &Webview) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return webview
        .with_webview(|platform| {
            use gtk::prelude::*;
            let primary = platform.inner();
            let Some(overlay) = primary
                .parent()
                .and_then(|parent| parent.downcast::<gtk::Overlay>().ok())
            else {
                return;
            };
            if overlay.widget_name().as_str() != BROWSER_OVERLAY_NAME {
                return;
            }
            let Some(vbox) = overlay
                .parent()
                .and_then(|parent| parent.downcast::<gtk::Box>().ok())
            else {
                return;
            };
            // Keep child WebViews owned by Tauri until the browser host retires them.
            // Hidden children do not contribute another row to GtkBox allocation.
            for child in overlay.children() {
                if let Ok(fixed) = child.downcast::<gtk::Fixed>() {
                    for child in fixed.children() {
                        child.hide();
                        fixed.remove(&child);
                        vbox.pack_start(&child, true, true, 0);
                    }
                }
            }
            overlay.remove(&primary);
            vbox.pack_start(&primary, true, true, 0);
            vbox.remove(&overlay);
        })
        .map_err(|error| format!("Could not detach the native browser surface: {error}"));
    #[cfg(not(target_os = "linux"))]
    {
        let _ = webview;
        Ok(())
    }
}

pub async fn prepare_surface(webview: &Webview) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return native(webview, |platform| {
        use gtk::prelude::*;
        let primary = platform.inner();
        let parent = primary
            .parent()
            .ok_or("The browser has no layout container.")?;
        if parent.is::<gtk::Overlay>() {
            return Ok(());
        }
        let vbox = parent
            .downcast::<gtk::Box>()
            .map_err(|_| "The browser layout container is unavailable.")?;
        let overlay = gtk::Overlay::new();
        overlay.set_widget_name(BROWSER_OVERLAY_NAME);
        let fixed = gtk::Fixed::new();
        vbox.remove(&primary);
        overlay.add(&primary);
        fixed.set_halign(gtk::Align::Fill);
        fixed.set_valign(gtk::Align::Fill);
        overlay.add_overlay(&fixed);
        overlay.set_overlay_pass_through(&fixed, true);
        vbox.pack_start(&overlay, true, true, 0);
        fixed.show();
        overlay.show();
        Ok(())
    })
    .await;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = webview;
        Ok(())
    }
}

pub async fn set_bounds(
    webview: &Webview,
    position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return native(webview, move |platform| {
        use gtk::prelude::*;
        let widget = platform.inner();
        let parent = widget
            .parent()
            .ok_or("The browser has no layout container.")?;
        let fixed = match parent.downcast::<gtk::Fixed>() {
            Ok(fixed) => fixed,
            Err(parent) => {
                let vbox = parent
                    .downcast::<gtk::Box>()
                    .map_err(|_| "The browser layout is unavailable.")?;
                let overlay = vbox
                    .children()
                    .into_iter()
                    .find_map(|child| child.downcast::<gtk::Overlay>().ok())
                    .ok_or("The browser surface is unavailable.")?;
                let fixed = overlay
                    .children()
                    .into_iter()
                    .find_map(|child| child.downcast::<gtk::Fixed>().ok())
                    .ok_or("The browser layout is unavailable.")?;
                vbox.remove(&widget);
                fixed.put(&widget, 0, 0);
                fixed
            }
        };
        let (x, y) = (position.x.round() as i32, position.y.round() as i32);
        let (width, height) = (size.width.round() as i32, size.height.round() as i32);
        widget.set_size_request(width, height);
        fixed.move_(&widget, x, y);
        widget.size_allocate(&gtk::Allocation::new(x, y, width, height));
        Ok(())
    })
    .await;
    #[cfg(not(target_os = "linux"))]
    {
        webview.set_position(position).map_err(|e| e.to_string())?;
        webview.set_size(size).map_err(|e| e.to_string())
    }
}
