use gpui_kit::{Bounds, Pixels, Window};
use wry::{NewWindowResponse, PageLoadEvent, WebView, WebViewBuilder};

use super::{
    Command, ControlUiCommand, Events, SurfaceBounds, WebViewEvent, WebViewSpec, WebViewStore,
    is_web_url,
};

#[cfg(target_os = "macos")]
#[path = "webview_surface_macos.rs"]
mod macos;

#[cfg(target_os = "windows")]
#[path = "webview_surface_windows.rs"]
mod windows;

#[derive(Default)]
pub(super) struct PresentationMask {
    #[cfg(target_os = "macos")]
    view: Option<objc2::rc::Weak<wry::WryWebView>>,
    #[cfg(target_os = "windows")]
    view: Option<windows::Mask>,
}

impl PresentationMask {
    pub fn attach(&mut self, view: &WebView) {
        #[cfg(target_os = "macos")]
        {
            use wry::WebViewExtMacOS;
            self.view = Some(objc2::rc::Weak::from_retained(&view.webview()));
        }
        #[cfg(target_os = "windows")]
        {
            self.view = windows::Mask::attach(view);
        }
    }

    pub fn hide(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        if let Some(view) = self.view.as_ref().and_then(|view| view.load()) {
            macos::hide(&view);
        }
        #[cfg(target_os = "windows")]
        if let Some(view) = &self.view {
            view.hide()?;
        }
        Ok(())
    }
}

pub(super) fn present(view: &WebView, render: bool, reveal: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::present(view, render, reveal);
    }
    #[cfg(target_os = "windows")]
    {
        windows::present(view, render, reveal)?;
    }
    Ok(())
}

pub(super) fn set_bounds(view: &WebView, bounds: SurfaceBounds) {
    #[cfg(target_os = "macos")]
    let _ = macos::set_bounds(view, bounds);
    #[cfg(target_os = "windows")]
    let _ = view.set_bounds(rect(bounds));
}

pub(super) fn detach(view: &WebView) {
    #[cfg(target_os = "macos")]
    macos::detach(view);
    #[cfg(target_os = "windows")]
    windows::detach(view);
}

pub(super) fn rect(bounds: SurfaceBounds) -> wry::Rect {
    wry::Rect {
        position: wry::dpi::LogicalPosition::new(bounds.x, bounds.y).into(),
        size: wry::dpi::LogicalSize::new(bounds.width, bounds.height).into(),
    }
}

pub(super) fn build(
    spec: &WebViewSpec,
    store: &WebViewStore,
    events: &Events,
    bounds: Bounds<Pixels>,
    window: &Window,
) -> Result<WebView, String> {
    #[cfg(target_os = "macos")]
    {
        // WebKit's identifier factory returns autoreleased store/configuration
        // references. Do not let GPUI's outer pool keep retired sessions in use.
        objc2::rc::autoreleasepool(|_| build_view(spec, store, events, bounds, window))
    }
    #[cfg(target_os = "windows")]
    build_view(spec, store, events, bounds, window)
}

fn build_view(
    spec: &WebViewSpec,
    store: &WebViewStore,
    events: &Events,
    bounds: Bounds<Pixels>,
    window: &Window,
) -> Result<WebView, String> {
    let mut store = store.0.borrow_mut();
    #[cfg(target_os = "macos")]
    let identifier = store.identifier;
    #[cfg(target_os = "macos")]
    let configuration = if identifier.is_none() {
        use objc2::MainThreadMarker;
        use objc2_web_kit::{WKWebViewConfiguration, WKWebsiteDataStore};
        let main = MainThreadMarker::new().ok_or("Webviews require the main thread")?;
        let data_store = store
            .data_store
            .get_or_insert_with(|| unsafe { WKWebsiteDataStore::nonPersistentDataStore(main) });
        let configuration = unsafe { WKWebViewConfiguration::new(main) };
        unsafe {
            configuration.setWebsiteDataStore(data_store);
        }
        Some(configuration)
    } else {
        None
    };
    let mut builder = WebViewBuilder::new_with_web_context(&mut store.context)
        .with_visible(false)
        .with_focused(false)
        .with_bounds(rect(
            SurfaceBounds::from(bounds).pixel_aligned(window.scale_factor()),
        ))
        .with_back_forward_navigation_gestures(true)
        .with_accept_first_mouse(true);
    #[cfg(target_os = "macos")]
    {
        use wry::{WebViewBuilderExtDarwin, WebViewBuilderExtMacos};
        if let Some(identifier) = identifier {
            builder = builder.with_data_store_identifier(identifier);
        } else if let Some(configuration) = configuration {
            builder = builder.with_webview_configuration(configuration);
        }
    }
    if let Some(auth) = &spec.auth {
        builder = builder.with_initialization_script(auth.initialization_script()?);
    }
    let shortcut_nonce = uuid::Uuid::new_v4().to_string();
    builder = builder.with_initialization_script(SHORTCUT_SCRIPT.replace(
        "__GPUI_SHORTCUT_NONCE__",
        &serde_json::json!(shortcut_nonce).to_string(),
    ));
    builder = builder.with_initialization_script(
        include_str!("webview_presentation.js")
            .replace(
                "__GPUI_NONCE__",
                &serde_json::json!(shortcut_nonce).to_string(),
            )
            .replace(
                "__GPUI_CONTROL__",
                if spec.auth.is_some() { "true" } else { "false" },
            ),
    );
    if spec.auth.is_some() {
        builder = builder.with_initialization_script(format!(
            r#"(() => {{
              const publish = () => window.ipc.postMessage(JSON.stringify({{
                type:'gpui-ready', nonce:{nonce},
                ready:window.__OPENCLAW_NATIVE_COMMANDS_READY__ === true &&
                  window.__OPENCLAW_NATIVE_GATEWAY_HEALTH__?.health === 'ok'
              }}));
              addEventListener('openclaw:native-commands-state', publish);
              addEventListener('openclaw:native-gateway-health-changed', publish);
              publish();
            }})();"#,
            nonce = serde_json::json!(shortcut_nonce)
        ));
    }
    let auth = spec.auth.clone();
    let navigation_events = events.clone();
    builder = builder.with_navigation_handler(move |url| {
        if url == "about:blank" {
            return true;
        }
        if is_web_url(&url) {
            if auth.as_ref().is_none_or(|auth| {
                auth.trusts(&url) || (auth.access_session.is_some() && url.starts_with("https://"))
            }) {
                navigation_events.push(WebViewEvent::Loading(true));
                return true;
            }
            navigation_events.push(WebViewEvent::External(url));
        } else if external_scheme(&url) {
            navigation_events.push(WebViewEvent::External(url));
        }
        false
    });
    let window_events = events.clone();
    let reading = spec.auth.is_none();
    builder = builder.with_new_window_req_handler(move |url, _| {
        if is_web_url(&url) {
            window_events.push(if reading {
                WebViewEvent::NewWindow(url)
            } else {
                WebViewEvent::External(url)
            });
        } else if external_scheme(&url) {
            window_events.push(WebViewEvent::External(url));
        }
        NewWindowResponse::Deny
    });
    let title_events = events.clone();
    builder = builder.with_document_title_changed_handler(move |title| {
        title_events.push(WebViewEvent::Title(title))
    });
    let load_events = events.clone();
    builder = builder.with_on_page_load_handler(move |event, url| {
        if matches!(event, PageLoadEvent::Started) {
            load_events.document_committed(&url);
        }
        if reading {
            load_events.set_ready(matches!(event, PageLoadEvent::Finished));
        } else if matches!(event, PageLoadEvent::Started) {
            load_events.set_ready(false);
        }
        if url == "about:blank" {
            return;
        }
        if reading {
            load_events.push(WebViewEvent::Url(url));
        }
        load_events.push(WebViewEvent::Loading(matches!(
            event,
            PageLoadEvent::Started
        )));
    });
    let auth = spec.auth.clone();
    let ipc_events = events.clone();
    builder = builder.with_ipc_handler(move |request| {
        let source = request.uri().to_string();
        let trusted_control = auth.as_ref().is_some_and(|auth| auth.trusts(&source));
        let reading_document = (auth.is_none()
            || auth
                .as_ref()
                .is_some_and(|auth| auth.access_session.is_some()))
            && (is_web_url(&source) || source == "about:blank");
        if !trusted_control && !reading_document && source != "about:blank" {
            return;
        }
        let body = request.body();
        if body.len() > 1_048_576 {
            return;
        }
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(body) else {
            return;
        };
        match payload["type"].as_str() {
            Some("gpui-route-ack")
                if trusted_control
                    && payload["nonce"].as_str() == Some(shortcut_nonce.as_str()) =>
            {
                if let (Some(document), Some(url), Some(generation)) = (
                    payload["document"].as_str(),
                    payload["url"].as_str(),
                    payload["generation"].as_u64(),
                ) {
                    ipc_events
                        .presentation
                        .borrow_mut()
                        .acknowledge_route(document, url, generation);
                }
            }
            Some("gpui-document-available")
                if payload["nonce"].as_str() == Some(shortcut_nonce.as_str()) =>
            {
                ipc_events.document_requested.set(true);
                let _ = ipc_events.wake.try_send(());
            }
            Some("gpui-document") if payload["nonce"].as_str() == Some(shortcut_nonce.as_str()) => {
                if let (Some(document), Some(url), Some(navigation)) = (
                    payload["document"].as_str(),
                    payload["url"].as_str(),
                    payload["navigation"].as_u64(),
                ) && ipc_events
                    .presentation
                    .borrow_mut()
                    .document(document, url, navigation)
                {
                    ipc_events.presentation_requested.set(true);
                    let _ = ipc_events.wake.try_send(());
                }
            }
            Some("openclaw-presentation-state")
                if trusted_control
                    && payload["nonce"].as_str() == Some(shortcut_nonce.as_str()) =>
            {
                #[derive(serde::Deserialize)]
                struct Signal {
                    document: String,
                    generation: u64,
                    phase: String,
                    pathname: String,
                    search: String,
                    hash: String,
                    #[serde(rename = "viewportWidth")]
                    viewport_width: f64,
                    #[serde(rename = "viewportHeight")]
                    viewport_height: f64,
                }
                if let Ok(signal) = serde_json::from_value::<Signal>(payload.clone())
                    && matches!(signal.phase.as_str(), "loading" | "ready")
                    && (signal.phase != "ready"
                        || ipc_events
                            .viewport_matches(signal.viewport_width, signal.viewport_height))
                    && let Ok(mut url) = url::Url::parse(&source)
                {
                    url.set_path(&signal.pathname);
                    url.set_query(signal.search.strip_prefix('?'));
                    url.set_fragment(signal.hash.strip_prefix('#'));
                    if auth.as_ref().is_some_and(|auth| auth.trusts(url.as_str())) {
                        ipc_events.presentation(
                            &signal.document,
                            signal.generation,
                            url.as_str(),
                            signal.phase == "ready",
                        );
                    }
                }
            }
            Some("gpui-reading-ready")
                if payload["nonce"].as_str() == Some(shortcut_nonce.as_str())
                    && (reading_document || source == "about:blank") =>
            {
                if let (Some(document), Some(url), Some(width), Some(height)) = (
                    payload["document"].as_str(),
                    payload["url"].as_str(),
                    payload["viewportWidth"].as_f64(),
                    payload["viewportHeight"].as_f64(),
                ) && ipc_events.viewport_matches(width, height)
                {
                    ipc_events.presentation(document, 0, url, true);
                }
            }
            Some("gpui-ready")
                if trusted_control
                    && payload["nonce"].as_str() == Some(shortcut_nonce.as_str()) =>
            {
                ipc_events.set_ready(payload["ready"].as_bool() == Some(true));
            }
            Some("gpui-history") if payload["nonce"].as_str() == Some(shortcut_nonce.as_str()) => {
                ipc_events.history_changed()
            }
            Some("gpui-escape") if payload["nonce"].as_str() == Some(shortcut_nonce.as_str()) => {
                ipc_events.push(WebViewEvent::Escape)
            }
            Some("gpui-shortcut") if payload["nonce"].as_str() == Some(shortcut_nonce.as_str()) => {
                if let (Some(key), Some(shift), Some(alt)) = (
                    payload["key"].as_str(),
                    payload["shift"].as_bool(),
                    payload["alt"].as_bool(),
                ) && matches!(
                    key,
                    "," | "k"
                        | "n"
                        | "o"
                        | "b"
                        | "r"
                        | "["
                        | "]"
                        | "w"
                        | "j"
                        | "s"
                        | "u"
                        | "d"
                        | "g"
                        | "e"
                        | "`"
                ) {
                    ipc_events.push(WebViewEvent::Shortcut {
                        key: key.into(),
                        shift,
                        alt,
                    });
                }
            }
            Some("openclaw-panel-state" | "openclaw-panel-link") if trusted_control => {
                ipc_events.push(WebViewEvent::Ipc(body.clone()))
            }
            _ => {}
        }
    });
    // Build blank first: cookies must reach the platform store before the first
    // Control UI document or its WebSocket/subresource requests start.
    log::debug!(
        "webview_create background={} control={} begin",
        spec.background,
        spec.auth.is_some()
    );
    let view = builder
        .build_as_child(window)
        .map_err(|_| "Could not create the native webview")?;
    drop(store);
    if let Some(auth) = &spec.auth
        && let Some(session) = &auth.access_session
    {
        session
            .authorization_header(&spec.url, crate::gateway::access::now())
            .ok_or("Cloudflare Access authorization expired. Sign in again.")?;
        let origin =
            url::Url::parse(&session.application.origin).map_err(|_| "Invalid Access origin")?;
        let cookie = wry::cookie::Cookie::build(("CF_Authorization", session.token.clone()))
            .domain(origin.host_str().ok_or("Invalid Access origin")?.to_owned())
            .path("/")
            .secure(true)
            .http_only(true)
            .same_site(wry::cookie::SameSite::None)
            .build();
        view.set_cookie(&cookie)
            .map_err(|_| "Could not transfer the Access session to the webview")?;
    }
    navigate(&view, spec)?;
    #[cfg(target_os = "macos")]
    macos::configure(&view)?;
    #[cfg(target_os = "windows")]
    windows::configure(&view)?;
    events.mask.borrow_mut().attach(&view);
    present(&view, true, false)?;
    log::debug!("webview_create attached");
    Ok(view)
}

pub(super) fn retire(view: WebView, visible: bool) -> super::WebViewRetirement {
    #[cfg(target_os = "macos")]
    {
        use wry::WebViewExtMacOS;
        objc2::rc::autoreleasepool(|_| {
            let native = view.webview();
            let retired = super::WebViewRetirement {
                view: objc2::rc::Weak::from_retained(&native),
            };
            unsafe {
                native.stopLoading();
            }
            if visible {
                let _ = view.focus_parent();
            }
            detach(&view);
            drop(view);
            retired
        })
    }
    #[cfg(target_os = "windows")]
    {
        let _ = visible;
        detach(&view);
        drop(view);
        super::WebViewRetirement {}
    }
}

pub(super) fn navigate(view: &WebView, spec: &WebViewSpec) -> Result<(), String> {
    if let Some(auth) = &spec.auth
        && let Some(session) = &auth.access_session
    {
        let token = session
            .authorization_header(&spec.url, crate::gateway::access::now())
            .ok_or("Cloudflare Access authorization expired. Sign in again.")?;
        let mut headers = wry::http::HeaderMap::new();
        headers.insert(
            "cf-access-token",
            token.parse().map_err(|_| "Invalid Access credential")?,
        );
        view.load_url_with_headers(&spec.url, headers)
            .map_err(|_| "Could not load the Control UI".into())
    } else {
        view.load_url(&spec.url)
            .map_err(|_| "Could not load the page".into())
    }
}

pub(super) fn navigate_control(view: &WebView, spec: &WebViewSpec) -> Result<(), String> {
    let auth = spec
        .auth
        .as_ref()
        .ok_or("Control UI authentication is missing")?;
    let path = crate::model::web_urls::control_page_path(&auth.gateway_url, &spec.url)
        .ok_or("Embedded panels must stay on their Gateway")?;
    let destination = url::Url::parse(&spec.url).map_err(|_| "Invalid Control UI route")?;
    let detail = serde_json::json!({
        "path":path.split(['?', '#']).next().unwrap_or("/"),
        "search":destination.query().map(|query| format!("?{query}")).unwrap_or_default(),
        "hash":destination.fragment().map(|hash| format!("#{hash}")).unwrap_or_default(),
    });
    let url = serde_json::json!(spec.url);
    let origin = serde_json::json!(destination.origin().ascii_serialization());
    // A handled event preserves the booted document, its Gateway socket and store.
    // Unknown routes retain the native host contract's ordinary URL navigation.
    view.evaluate_script(&format!(
        "if (location.origin === {origin}) {{ const event = new CustomEvent('openclaw:native-navigate', {{cancelable:true, detail:{detail}}}); if (location.href === {url} || !window.dispatchEvent(event)) {{ window.__OPENCLAW_GPUI_ROUTE_ACK__?.({url}); window.dispatchEvent(new Event('openclaw:native-presentation-request')); }} else location.assign({url}); }}"
    )).map_err(|_| "Could not navigate the Control UI".into())
}

pub(super) fn request_presentation(view: &WebView) {
    let _ = view.evaluate_script("window.dispatchEvent(new Event('openclaw:native-presentation-request')); window.__OPENCLAW_GPUI_READING_FRAME__?.();");
}

pub(super) fn control_command(
    view: &WebView,
    spec: &WebViewSpec,
    wake: async_channel::Sender<()>,
    command: ControlUiCommand,
) -> Result<async_channel::Receiver<bool>, String> {
    let auth = spec
        .auth
        .as_ref()
        .ok_or("Control UI authentication is missing")?;
    let base = crate::model::web_urls::control_base_url(&auth.gateway_url)?;
    let origin = serde_json::json!(base.origin().ascii_serialization());
    let mount = serde_json::json!(base.path().trim_end_matches('/'));
    let event = match command {
        ControlUiCommand::SystemBusyness => "openclaw:debug-overlay-request",
    };
    let event = serde_json::json!(event);
    let (completed, reply) = async_channel::bounded(1);
    // Readiness is owned by ShellChromeOwner; recheck the document at dispatch
    // so a navigation or Access redirect cannot receive a stale native action.
    view.evaluate_script_with_callback(
        &format!(
            "(() => {{ const mount = {mount}; if (location.origin !== {origin} || (mount && location.pathname !== mount && !location.pathname.startsWith(mount + '/')) || window.__OPENCLAW_NATIVE_COMMANDS_READY__ !== true) return false; window.dispatchEvent(new CustomEvent({event})); return true; }})()"
        ),
        move |result| {
            let _ = completed.try_send(result == "true");
            let _ = wake.try_send(());
        },
    ).map_err(|_| "Could not open System busyness.".to_owned())?;
    Ok(reply)
}

fn external_scheme(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "mailto" | "tel"))
}

const SHORTCUT_SCRIPT: &str = r#"(() => {
  const nonce = __GPUI_SHORTCUT_NONCE__;
  const post = window.ipc.postMessage.bind(window.ipc);
  const changed = () => post(JSON.stringify({type:'gpui-history',nonce}));
  for (const method of ['pushState','replaceState']) {
    const original = history[method];
    history[method] = function(...args) {
      const result = Reflect.apply(original, this, args);
      changed();
      return result;
    };
  }
  addEventListener('popstate', changed);
  addEventListener('keydown', event => {
    if (!event.isTrusted) return;
    if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      post(JSON.stringify({type:'gpui-escape',nonce}));
      return;
    }
    const key = event.code === 'Backquote' ? '`' : event.code === 'Comma' ? ',' : event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
    const mod = /Mac/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
    const app = mod && !event.altKey && !event.shiftKey && [',','k','n','b','r','[',']','w','1','2','3','4','5','6','7','8','9'].includes(key);
    const panel = (event.ctrlKey && !event.metaKey && key === '`') || (mod && !event.altKey && event.shiftKey && ['b','s'].includes(key)) || (mod && event.altKey && event.shiftKey && ['u','k','d','j','g','e'].includes(key));
    const shell = mod && event.shiftKey && !event.altKey && ['o',',','d'].includes(key);
    if (!app && !panel && !shell) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    post(JSON.stringify({type:'gpui-shortcut',nonce,key,shift:event.shiftKey,alt:event.altKey}));
  }, true);
})();"#;

pub(super) fn command(view: &WebView, command: Command) -> Result<(), ()> {
    match command {
        Command::Reload => view.reload().map_err(|_| ()),
        Command::FocusParent => view.focus_parent().map_err(|_| ()),
        #[cfg(target_os = "macos")]
        Command::Back | Command::Forward | Command::Stop => {
            use wry::WebViewExtMacOS;
            // The surface is created and operated exclusively on GPUI's main thread.
            unsafe {
                match command {
                    Command::Back => {
                        view.webview().goBack();
                    }
                    Command::Forward => {
                        view.webview().goForward();
                    }
                    Command::Stop => view.webview().stopLoading(),
                    _ => unreachable!(),
                }
            }
            Ok(())
        }
        #[cfg(target_os = "windows")]
        Command::Back | Command::Forward | Command::Stop => {
            use wry::WebViewExtWindows;
            unsafe {
                match command {
                    Command::Back => view.webview().GoBack(),
                    Command::Forward => view.webview().GoForward(),
                    Command::Stop => view.webview().Stop(),
                    _ => unreachable!(),
                }
            }
            .map_err(|_| ())
        }
    }
}

pub(super) fn history(view: &WebView) -> (bool, bool) {
    #[cfg(target_os = "macos")]
    {
        use wry::WebViewExtMacOS;
        unsafe { (view.webview().canGoBack(), view.webview().canGoForward()) }
    }
    #[cfg(target_os = "windows")]
    {
        use wry::WebViewExtWindows;
        let mut back = Default::default();
        let mut forward = Default::default();
        unsafe {
            let _ = view.webview().CanGoBack(&mut back);
            let _ = view.webview().CanGoForward(&mut forward);
        }
        (back.as_bool(), forward.as_bool())
    }
}

pub(super) fn set_dark(view: &WebView, dark: bool) {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{
            NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
        };
        use wry::WebViewExtMacOS;
        // A view-scoped appearance updates WebKit's prefers-color-scheme without
        // changing the user's system preference or the remote Control UI settings.
        unsafe {
            let appearance = NSAppearance::appearanceNamed(if dark {
                NSAppearanceNameDarkAqua
            } else {
                NSAppearanceNameAqua
            });
            view.webview().setAppearance(appearance.as_deref());
        }
    }
    #[cfg(target_os = "windows")]
    {
        use wry::WebViewExtWindows;
        let _ = view.set_theme(if dark {
            wry::Theme::Dark
        } else {
            wry::Theme::Light
        });
    }
}
