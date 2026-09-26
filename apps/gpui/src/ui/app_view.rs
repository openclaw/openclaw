mod render;

use super::theme::tokens::{icon, radius, shell, space, text};
#[path = "connection_state.rs"]
mod connection_state;

use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Root, Sizable, StyledExt, TitleBar,
        button::{Button, ButtonVariants},
        input::{InputEvent, InputState, TextareaState},
    },
    prelude::FluentBuilder,
    *,
};
use openclaw_gateway_client::GatewaySession;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{runtime::Handle, sync::oneshot};

use super::{
    attention_state::AttentionUi,
    composer_state::ComposerUi,
    model_controls_state::ModelControlsUi,
    sidebar_state::SidebarState,
    theme::{self, Palette},
    transcript_state::TranscriptUi,
};
use crate::gateway::router::Router;
use crate::{
    gateway::{config::ConnectionConfig, connection::Connection},
    model::{
        chat::{ChatNote, ChatState},
        sessions::{SessionRow, friendly_session_title},
    },
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ConnectionStage {
    Idle,
    Checking,
    AccessRequired,
    WaitingForBrowser,
    Connecting,
    Connected,
    SigningOut,
    Error,
}

pub struct AppView {
    pub(super) profile: Option<crate::gateway::profiles::GatewayProfile>,
    pub(super) focus_handle: FocusHandle,
    pub(super) web: super::web_state::WebUi,
    pub(super) web_access: Option<crate::gateway::access::Session>,
    pub(super) runtime: Handle,
    connection: Option<Connection>,
    connection_id: u64,
    #[cfg(target_os = "macos")]
    web_store_removal: Option<u64>,
    pub(crate) epoch: u64,
    pub(super) session: Option<GatewaySession>,
    pub(super) connecting: bool,
    pub(super) connection_stage: ConnectionStage,
    pub(super) access_protected: bool,
    pub(super) access_identity: Option<String>,
    pub(super) show_connect_form: bool,
    pub(super) connection_fixture: bool,
    browser_open_requested: bool,
    pub(super) connection_message: Option<String>,
    pub(super) url: Entity<InputState>,
    pub(super) token: Entity<InputState>,
    pub(super) password: Entity<InputState>,
    pub(super) composer: Entity<TextareaState>,
    pub(super) rows: Vec<SessionRow>,
    pub(super) roster_loading: bool,
    pub(super) roster_error: Option<String>,
    pub(super) chat: ChatState,
    pub(super) transcript_list: ListState,
    pub(super) sidebar_state: SidebarState,
    pub(super) composer_state: ComposerUi,
    pub(super) model_controls: ModelControlsUi,
    pub(super) new_session: super::new_session::NewSessionUi,
    pub(super) composer_capabilities: super::composer_capabilities::ComposerCapabilities,
    pub(super) transcript_state: TranscriptUi,
    pub(super) router: Router,
    pub(super) attention_state: AttentionUi,
    pub(super) viewer_presence: Option<(u64, String)>,
    pub(super) viewer_request: bool,
    ticker: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl AppView {
    pub fn new(
        runtime: Handle,
        config: Result<ConnectionConfig, String>,
        profile: Option<crate::gateway::profiles::GatewayProfile>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let (config, initial_error) = match config {
            Ok(config) => (config, None),
            Err(error) => (
                ConnectionConfig {
                    url: profile
                        .as_ref()
                        .map(|p| p.canonical_url())
                        .unwrap_or_default(),
                    token: None,
                    password: None,
                },
                Some(error),
            ),
        };
        let url = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("https://gateway.example.com")
                .default_value(config.url.clone())
        });
        let token = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Gateway token")
                .masked(true)
                .default_value(config.token.clone().unwrap_or_default())
        });
        let password = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Gateway password")
                .masked(true)
                .default_value(config.password.clone().unwrap_or_default())
        });
        let composer = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Message OpenClaw")
                .auto_grow(1, 6)
                .submit_on_enter(true)
        });
        let subscriptions = vec![
            cx.subscribe_in(&url, window, |this, _, event, window, cx| match event {
                InputEvent::Change => this.switch_gateway(window, cx),
                InputEvent::PressEnter { .. } => this.retry(window, cx),
                _ => {}
            }),
            cx.subscribe_in(&composer, window, |this, _, event, window, cx| {
                this.composer_event(event, window, cx);
                cx.notify();
            }),
            cx.observe_window_activation(window, |this, window, cx| {
                if window.is_window_active() {
                    crate::gateway_windows::focus(this.profile.as_ref().map(|p| p.id.as_str()), cx);
                }
            }),
            cx.observe_window_appearance(window, |this, window, cx| {
                theme::apply(window, cx);
                this.transcript_list.remeasure();
                cx.notify();
            }),
        ];
        let transcript_list = ListState::new(0, ListAlignment::Top, shell::TRANSCRIPT_OVERSCAN);
        transcript_list.set_follow_mode(FollowMode::Tail);
        let focus_handle = cx.focus_handle();
        focus_handle.focus(window, cx);
        let (web_wake, web_events) = async_channel::bounded(1);
        let mut web = super::web_state::WebUi::new(web_wake, window, cx);
        web.set_profile(profile.as_ref().map(|p| p.id.clone()), config.url.clone());
        let mut view = Self {
            profile,
            focus_handle,
            web,
            web_access: None,
            runtime,
            connection: None,
            connection_id: 0,
            #[cfg(target_os = "macos")]
            web_store_removal: None,
            epoch: 0,
            session: None,
            connecting: false,
            connection_stage: if initial_error.is_some() {
                ConnectionStage::Error
            } else {
                ConnectionStage::Idle
            },
            access_protected: false,
            access_identity: None,
            show_connect_form: true,
            connection_fixture: false,
            browser_open_requested: false,
            connection_message: initial_error,
            url,
            token,
            password,
            composer,
            rows: Vec::new(),
            roster_loading: false,
            roster_error: None,
            chat: ChatState::default(),
            transcript_list,
            sidebar_state: SidebarState::new(window, cx),
            composer_state: ComposerUi::default(),
            model_controls: ModelControlsUi::new(window, cx),
            new_session: super::new_session::NewSessionUi::new(window, cx),
            composer_capabilities: Default::default(),
            transcript_state: TranscriptUi::default(),
            router: Router::default(),
            attention_state: AttentionUi::default(),
            viewer_presence: None,
            viewer_request: false,
            ticker: None,
            _subscriptions: subscriptions,
        };
        cx.spawn_in(window, async move |this, cx| {
            while web_events.recv().await.is_ok() {
                if this
                    .update_in(cx, |this, window, cx| this.drain_web_events(window, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        #[cfg(debug_assertions)]
        view.apply_connection_fixture();
        if !view.connection_fixture && view.connection_message.is_none() && !config.url.is_empty() {
            view.connect(config, window, cx);
        }
        view.ticker = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                if this
                    .update(cx, |this, cx| {
                        let activity_changed = this
                            .sidebar_state
                            .activity
                            .tick(crate::model::chat::now_ms());
                        if activity_changed
                            || this
                                .rows
                                .iter()
                                .chain(this.sidebar_state.children.values().flatten())
                                .any(|row| row.running())
                            || this.connecting
                            || this.chat.active_run.is_some()
                            || this
                                .sidebar_state
                                .status_expiry
                                .is_some_and(|expiry| crate::model::chat::now_ms() >= expiry)
                        {
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        }));
        view
    }

    pub(crate) fn request(
        &self,
        method: &'static str,
        params: Value,
        cx: &mut Context<Self>,
        apply: impl FnOnce(&mut Self, Result<Value, String>, &mut Context<Self>) + 'static,
    ) {
        let Some(session) = self.session.clone() else {
            return;
        };
        let epoch = self.epoch;
        let (tx, rx) = oneshot::channel();
        self.runtime.spawn(async move {
            let result = session
                .request(method, params)
                .await
                .map_err(|error| error.to_string());
            let _ = tx.send(result);
        });
        cx.spawn(async move |this, cx| {
            if let Ok(result) = rx.await {
                let _ = this.update(cx, |this, cx| {
                    if this.epoch == epoch {
                        apply(this, result, cx);
                        cx.notify();
                    }
                });
            }
        })
        .detach();
    }

    pub(super) fn manual_refresh(&mut self, cx: &mut Context<Self>) {
        self.viewer_presence = None;
        self.router.retry_subscription();
        self.sync_subscription(cx);
        self.read_questions(cx);
        self.refresh_sessions(cx);
        if self.session.is_some() {
            self.load_history(cx);
        }
    }

    pub(super) fn select_session(
        &mut self,
        key: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.composer_save_draft(cx);
        self.new_session.active = false;
        self.new_session.picker = None;
        self.composer_capabilities.reset();
        self.web.settings_open = false;
        self.web.picker_open = false;
        self.web.address_dirty = true;
        self.web.pending_links.clear();
        if self.chat.selected_session.as_deref() == Some(&key)
            && self.chat.selected_agent == self.sidebar_state.selected_agent
        {
            return;
        }
        let destination_agent = self
            .rows
            .iter()
            .chain(self.sidebar_state.children.values().flatten())
            .chain(self.sidebar_state.search_rows.iter())
            .find(|row| row.key == key)
            .and_then(|row| row.agent().map(str::to_owned))
            .or_else(|| {
                key.strip_prefix("agent:")
                    .and_then(|tail| tail.split_once(':'))
                    .map(|(agent, _)| agent.to_owned())
            });
        if let Some(agent) = destination_agent
            && self.sidebar_state.selected_agent.as_ref() != Some(&agent)
        {
            self.sidebar_state.selected_agent = Some(agent);
            self.sidebar_state.agent_revision += 1;
            if !self.sidebar_state.preferences.all_agents {
                self.refresh_sessions(cx);
            }
        }
        self.remember_selected_descriptor(&key);
        self.chat
            .select_context(key, self.sidebar_state.selected_agent.clone());
        self.composer_restore_draft(window, cx);
        self.sync_subscription(cx);
        self.load_composer_catalogs(cx);
        self.transcript_list.reset(0);
        self.transcript_list.set_follow_mode(FollowMode::Tail);
        self.load_history(cx);
        cx.notify();
    }

    pub(super) fn stop(&mut self, cx: &mut Context<Self>) {
        let (Some(scope), Some(run_id)) = (self.chat.scope(), self.chat.active_run.clone()) else {
            return;
        };
        self.request(
            "chat.abort",
            json!({"sessionKey":scope.session_key,"agentId":scope.agent_id,"runId":run_id}),
            cx,
            move |this, result, cx| {
                if !this.chat.is_current(&scope) || this.chat.active_run.as_ref() != Some(&run_id) {
                    return;
                }
                match result {
                    Ok(_) => {
                        log::debug!("chat.abort acknowledged");
                        this.load_history(cx);
                    }
                    Err(error) => {
                        this.chat.note = Some(ChatNote {
                            text: format!("Could not stop: {error}"),
                            error: true,
                        })
                    }
                }
                this.sync_transcript();
            },
        );
    }

    pub(super) fn session_title(&self) -> String {
        if self.new_session.active {
            return "New chat".into();
        }
        self.selected_row()
            .map(SessionRow::title)
            .or_else(|| {
                self.chat
                    .selected_session
                    .as_deref()
                    .map(friendly_session_title)
            })
            .unwrap_or_else(|| "Chat".into())
    }
}

impl Drop for AppView {
    fn drop(&mut self) {
        self.connection.take();
        self.web.retire_all();
    }
}
