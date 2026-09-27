use super::theme::tokens::{radius, shell, space, text};
use gpui_kit::{
    component::{
        Sizable, StyledExt,
        button::{Button, ButtonVariants},
        input::{Input, InputEvent, InputState},
    },
    prelude::FluentBuilder,
    *,
};
use openclaw_gateway_client::GatewaySession;
use std::{cell::Cell, rc::Rc, sync::Arc};
use tokio::runtime::Handle;

use super::theme::Palette;
use crate::{
    gateway::browser_rpc::{
        BrowserCommand, BrowserConnection, BrowserEvent, BrowserTab, BrowserTarget, FrameMetadata,
    },
    model::panels::normalize_reading_url,
};

/// One entity belongs to one connection and conversation. Hiding retires its stream.
pub struct AgentBrowser {
    runtime: Handle,
    gateway: GatewaySession,
    gateway_url: String,
    access_token: Option<String>,
    _session_key: String,
    _agent_id: Option<String>,
    target: Option<BrowserTarget>,
    connection: Option<BrowserConnection>,
    events: Option<Task<()>>,
    generation: u64,
    revision: u64,
    presented: bool,
    tabs: Vec<BrowserTab>,
    active: Option<String>,
    running: bool,
    error: Option<String>,
    image: Option<Arc<Image>>,
    metadata: Option<FrameMetadata>,
    bounds: Rc<Cell<Bounds<Pixels>>>,
    focus: FocusHandle,
    url: Entity<InputState>,
    _subscription: Subscription,
}

impl AgentBrowser {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        runtime: Handle,
        gateway: GatewaySession,
        gateway_url: String,
        access_token: Option<String>,
        session_key: String,
        agent_id: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let url = cx.new(|cx| InputState::new(window, cx).placeholder("Agent browser URL"));
        let subscription = cx.subscribe_in(&url, window, |this, input, event, _, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                if let Some(url) = normalize_reading_url(&input.read(cx).value()) {
                    let command = if this.active.is_some() {
                        BrowserCommand::Navigate(url)
                    } else {
                        BrowserCommand::NewTab(url)
                    };
                    this.send(command, cx);
                } else {
                    this.error = Some("Enter an HTTP or HTTPS address".into());
                    cx.notify();
                }
            }
        });
        Self {
            runtime,
            gateway,
            gateway_url,
            access_token,
            _session_key: session_key,
            _agent_id: agent_id,
            target: None,
            connection: None,
            events: None,
            generation: 0,
            revision: 0,
            presented: false,
            tabs: Vec::new(),
            active: None,
            running: false,
            error: None,
            image: None,
            metadata: None,
            bounds: Rc::new(Cell::new(Bounds::default())),
            focus: cx.focus_handle(),
            url,
            _subscription: subscription,
        }
    }

    pub fn set_presented(&mut self, presented: bool, cx: &mut Context<Self>) {
        if self.presented == presented {
            return;
        }
        self.presented = presented;
        self.generation += 1;
        self.connection = None;
        self.events = None;
        self.image = None;
        self.metadata = None;
        if presented {
            let scopes = self
                .gateway
                .hello()
                .pointer("/auth/scopes")
                .and_then(serde_json::Value::as_array);
            if !scopes.is_some_and(|scopes| {
                scopes
                    .iter()
                    .any(|scope| scope.as_str() == Some("operator.admin"))
            }) {
                self.error =
                    Some("Agent browser requires an operator.admin grant for this device".into());
                cx.notify();
                return;
            }
            self.error = None;
            let (connection, events) = BrowserConnection::start(
                &self.runtime,
                self.gateway.clone(),
                self.gateway_url.clone(),
                self.access_token.clone(),
                self.target.clone(),
            );
            self.connection = Some(connection);
            let generation = self.generation;
            self.events = Some(cx.spawn(async move |this, cx| {
                while let Ok(event) = events.recv().await {
                    if this
                        .update(cx, |this, cx| {
                            if this.generation == generation && this.presented {
                                this.receive(event);
                                cx.notify();
                            }
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }));
        }
        cx.notify();
    }

    pub fn set_target(&mut self, target: Option<BrowserTarget>, cx: &mut Context<Self>) {
        if self.target == target {
            return;
        }
        let presented = self.presented;
        self.set_presented(false, cx);
        self.target = target;
        self.tabs.clear();
        self.active = None;
        self.set_presented(presented, cx);
    }

    fn receive(&mut self, event: BrowserEvent) {
        match event {
            BrowserEvent::Tabs {
                running,
                tabs,
                active,
                revision,
            } => {
                self.running = running;
                self.tabs = tabs;
                self.active = active;
                self.revision = revision;
                self.image = None;
                self.metadata = None;
            }
            BrowserEvent::Metadata {
                url,
                title,
                revision,
            } if revision == self.revision => {
                if let Some(tab) = self
                    .tabs
                    .iter_mut()
                    .find(|tab| Some(tab.id()) == self.active.as_deref())
                {
                    tab.url = url;
                    tab.title = title;
                }
            }
            BrowserEvent::Frame {
                metadata,
                jpeg,
                revision,
            } if revision == self.revision => {
                self.error = None;
                self.image = Some(Arc::new(Image::from_bytes(ImageFormat::Jpeg, jpeg)));
                self.metadata = Some(metadata);
            }
            BrowserEvent::Snapshot {
                metadata,
                png,
                revision,
            } if revision == self.revision => {
                self.error = None;
                self.image = Some(Arc::new(Image::from_bytes(ImageFormat::Png, png)));
                self.metadata = Some(metadata);
            }
            BrowserEvent::Error(error) => {
                self.image = None;
                self.metadata = None;
                self.error = Some(error);
            }
            BrowserEvent::StreamError { message, revision } if revision == self.revision => {
                self.image = None;
                self.metadata = None;
                self.error = Some(message);
            }
            _ => {}
        }
    }

    fn send(&mut self, command: BrowserCommand, cx: &mut Context<Self>) {
        if let Some(connection) = &self.connection {
            if connection.commands.try_send(command).is_err() {
                self.error = Some("Browser is busy; wait for the current operation".into());
            } else {
                self.error = None;
            }
            cx.notify();
        }
    }

    fn page_url(&self) -> Option<String> {
        self.metadata
            .as_ref()
            .map(|metadata| metadata.url.as_str())
            .or_else(|| {
                self.tabs
                    .iter()
                    .find(|tab| Some(tab.id()) == self.active.as_deref())
                    .map(|tab| tab.url.as_str())
            })
            .and_then(normalize_reading_url)
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        let command = self
            .page_url()
            .map(BrowserCommand::Navigate)
            .unwrap_or(BrowserCommand::Refresh);
        self.send(command, cx);
    }

    fn remote_point(&self, position: Point<Pixels>) -> Option<(f32, f32)> {
        let bounds = self.bounds.get();
        let metadata = self.metadata.as_ref()?;
        remote_point(
            f32::from(position.x - bounds.origin.x),
            f32::from(position.y - bounds.origin.y),
            f32::from(bounds.size.width),
            f32::from(bounds.size.height),
            metadata.css_width,
            metadata.css_height,
        )
    }

    fn key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        if self.image.is_none() {
            return;
        }
        let stroke = &event.keystroke;
        if (stroke.modifiers.platform || stroke.modifiers.control) && stroke.key == "v" {
            if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                self.send(BrowserCommand::Insert(text), cx);
                cx.stop_propagation();
            }
            return;
        }
        // Keep app/menu shortcuts native, matching browser-panel-controller-input.ts.
        if stroke.modifiers.platform || stroke.modifiers.control || stroke.modifiers.alt {
            return;
        }
        let key = match stroke.key.as_str() {
            "enter" => "Enter",
            "backspace" => "Backspace",
            "delete" => "Delete",
            "tab" => "Tab",
            "escape" => "Escape",
            "left" => "ArrowLeft",
            "right" => "ArrowRight",
            "up" => "ArrowUp",
            "down" => "ArrowDown",
            "home" => "Home",
            "end" => "End",
            "pageup" => "PageUp",
            "pagedown" => "PageDown",
            "space" => " ",
            _ => stroke.key_char.as_deref().unwrap_or(&stroke.key),
        };
        if key.chars().count() == 1 || key != stroke.key {
            self.send(BrowserCommand::Key(key.into()), cx);
            cx.stop_propagation();
        }
    }
}

impl Render for AgentBrowser {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.url.focus_handle(cx).is_focused(window) {
            let url = self
                .metadata
                .as_ref()
                .map(|metadata| metadata.url.clone())
                .or_else(|| {
                    self.tabs
                        .iter()
                        .find(|tab| Some(tab.id()) == self.active.as_deref())
                        .map(|tab| tab.url.clone())
                })
                .unwrap_or_default();
            if self.url.read(cx).value() != url {
                self.url
                    .update(cx, |input, cx| input.set_value(url, window, cx));
            }
        }
        let p = Palette::get(cx);
        let mut root = div()
            .size_full()
            .v_flex()
            .min_w_0()
            .min_h_0()
            .bg(p.bg)
            .text_color(p.text);
        let tabs = self.tabs.iter().enumerate().map(|(index, tab)| {
            let selected = Some(tab.id()) == self.active.as_deref();
            let id = tab.id().to_owned();
            let close = id.clone();
            div()
                .h_flex()
                .gap(space::REM_XS)
                .rounded(radius::WIDGET_MD)
                .when(selected, |d| d.bg(p.hover))
                .child(
                    Button::new(("agent-tab", index))
                        .label(if tab.title.is_empty() {
                            tab.url.clone()
                        } else {
                            tab.title.clone()
                        })
                        .small()
                        .ghost()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.send(BrowserCommand::Select(id.clone()), cx)
                        })),
                )
                .child(
                    Button::new(("agent-tab-close", index))
                        .label("×")
                        .small()
                        .ghost()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.send(BrowserCommand::Close(close.clone()), cx)
                        })),
                )
        });
        root = root.child(
            div()
                .h_flex()
                .w_full()
                .min_w_0()
                .flex_wrap()
                .gap(space::REM_XS)
                .p(space::REM_XS)
                .children(tabs)
                .child(
                    Button::new("agent-new-tab")
                        .label("+")
                        .small()
                        .ghost()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.send(BrowserCommand::NewTab("about:blank".into()), cx)
                        })),
                ),
        );
        root =
            root.child(
                div()
                    .h_flex()
                    .gap(space::REM_XS)
                    .px(space::REM_SM)
                    .pb(space::REM_SM)
                    .child(
                        Button::new("agent-back")
                            .label("←")
                            .small()
                            .ghost()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.send(BrowserCommand::History(-1), cx)
                            })),
                    )
                    .child(
                        Button::new("agent-forward")
                            .label("→")
                            .small()
                            .ghost()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.send(BrowserCommand::History(1), cx)
                            })),
                    )
                    .child(
                        Button::new("agent-refresh")
                            .label("↻")
                            .small()
                            .ghost()
                            .on_click(cx.listener(|this, _, _, cx| this.reload(cx))),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(Input::new(&self.url).small()),
                    )
                    .child(
                        Button::new("agent-external")
                            .label("↗")
                            .small()
                            .ghost()
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(url) = this.page_url() {
                                    cx.open_url(&url);
                                }
                            })),
                    ),
            );
        if let Some(error) = &self.error {
            root = root.child(
                div()
                    .p(space::REM_MD)
                    .text_size(text::WIDGET_SM_SIZE)
                    .text_color(p.danger)
                    .child(error.clone()),
            );
        }
        if !self.running && self.error.is_none() {
            root = root.child(
                div().p(space::REM_MD).child(
                    Button::new("agent-start")
                        .label("Start agent browser")
                        .small()
                        .on_click(
                            cx.listener(|this, _, _, cx| this.send(BrowserCommand::Start, cx)),
                        ),
                ),
            );
        }
        let bounds = self.bounds.clone();
        let mut stage = div()
            .id("agent-browser-stage")
            .relative()
            .flex_1()
            .size_full()
            .min_h_0()
            .track_focus(&self.focus)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    this.focus.focus(window, cx);
                    if let Some((x, y)) = this.remote_point(event.position) {
                        this.send(BrowserCommand::Click { x, y }, cx);
                        cx.stop_propagation();
                    }
                }),
            )
            .on_key_down(cx.listener(|this, event, _, cx| this.key(event, cx)))
            .on_scroll_wheel(cx.listener(|this, event: &ScrollWheelEvent, _, cx| {
                if this.image.is_none() {
                    return;
                }
                let (x, y) = match event.delta {
                    ScrollDelta::Pixels(delta) => (f32::from(delta.x), f32::from(delta.y)),
                    ScrollDelta::Lines(delta) => (
                        delta.x * shell::BROWSER_SCROLL_LINE_PIXELS,
                        delta.y * shell::BROWSER_SCROLL_LINE_PIXELS,
                    ),
                };
                this.send(BrowserCommand::Scroll { x: -x, y: -y }, cx);
                cx.stop_propagation();
            }))
            .child(
                canvas(
                    move |rect, _, _| {
                        bounds.set(rect);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            );
        if let Some(image) = &self.image {
            stage = stage.child(
                img(image.clone())
                    .size_full()
                    .object_fit(ObjectFit::Contain),
            );
        } else if self.running && self.error.is_none() {
            stage = stage.child(
                div()
                    .p(space::REM_MD)
                    .text_size(text::WIDGET_SM_SIZE)
                    .text_color(p.muted)
                    .child("Connecting to agent browser…"),
            );
        }
        root.child(stage)
            .when_some(self.metadata.as_ref(), |root, metadata| {
                root.child(
                    div()
                        .px(space::REM_SM)
                        .py(space::REM_XS)
                        .text_size(text::WIDGET_XS_SIZE)
                        .text_color(p.muted)
                        .overflow_hidden()
                        .child(metadata.url.clone()),
                )
            })
    }
}

fn remote_point(
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    css_width: f32,
    css_height: f32,
) -> Option<(f32, f32)> {
    if width <= 0. || height <= 0. || css_width <= 0. || css_height <= 0. {
        return None;
    }
    let scale = (width / css_width).min(height / css_height);
    let left = (width - css_width * scale) / 2.;
    let top = (height - css_height * scale) / 2.;
    let point = ((x - left) / scale, (y - top) / scale);
    (point.0 >= 0. && point.1 >= 0. && point.0 <= css_width && point.1 <= css_height)
        .then_some(point)
}

#[cfg(test)]
mod tests {
    use super::remote_point;

    #[test]
    fn remote_click_mapping_excludes_letterbox_and_uses_css_pixels() {
        assert_eq!(
            remote_point(250., 250., 500., 500., 1000., 500.),
            Some((500., 250.))
        );
        assert_eq!(remote_point(250., 50., 500., 500., 1000., 500.), None);
        assert_eq!(remote_point(0., 0., 0., 500., 1000., 500.), None);
    }
}
