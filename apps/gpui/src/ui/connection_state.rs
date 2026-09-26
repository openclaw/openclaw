use super::{AppView, ConnectionStage};
use crate::{
    gateway::{
        config::{ConnectionConfig, normalize_url},
        connection::{self, ConnectionEvent},
        router::{RoutedEvent, Router},
    },
    model::chat::ChatState,
    ui::{
        attention_state::AttentionUi, sidebar_state::SidebarState, transcript_state::TranscriptUi,
    },
};
use gpui_kit::*;
use serde_json::{Value, json};
use std::time::Instant;

impl AppView {
    fn publish_gateway_status(&self, cx: &mut Context<Self>) {
        use crate::gateway_windows::GatewayStatus;
        let status = match self.connection_stage {
            ConnectionStage::Connected => GatewayStatus::Connected,
            ConnectionStage::Checking | ConnectionStage::Connecting => GatewayStatus::Connecting,
            ConnectionStage::AccessRequired | ConnectionStage::WaitingForBrowser => {
                GatewayStatus::NeedsSignIn
            }
            _ => GatewayStatus::Offline,
        };
        crate::gateway_windows::status(self.profile.as_ref().map(|p| p.id.as_str()), status, cx);
    }

    pub(in crate::ui) fn retry(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.connection_fixture || self.connection_stage == ConnectionStage::SigningOut {
            return;
        }
        let configured = match self
            .profile
            .as_ref()
            .map(crate::gateway::config::for_profile)
            .transpose()
        {
            Ok(config) => config,
            Err(message) => {
                self.connection_stage = ConnectionStage::Error;
                self.connection_message = Some(message);
                self.publish_gateway_status(cx);
                cx.notify();
                return;
            }
        };
        let url = match normalize_url(
            configured
                .as_ref()
                .map(|config| config.url.as_str())
                .unwrap_or(self.url.read(cx).value().as_ref()),
        ) {
            Ok(url) => url,
            Err(message) => {
                self.connection_stage = ConnectionStage::Error;
                self.connection_message = Some(message);
                self.connecting = false;
                self.publish_gateway_status(cx);
                cx.notify();
                return;
            }
        };
        let optional = |value: SharedString| {
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        };
        self.connect(
            ConnectionConfig {
                url,
                token: optional(self.token.read(cx).value())
                    .or_else(|| configured.as_ref().and_then(|config| config.token.clone())),
                password: optional(self.password.read(cx).value()).or_else(|| {
                    configured
                        .as_ref()
                        .and_then(|config| config.password.clone())
                }),
            },
            window,
            cx,
        );
    }

    pub(super) fn connect(
        &mut self,
        config: ConnectionConfig,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.connection_stage == ConnectionStage::SigningOut {
            return;
        }
        self.web.retire_control();
        let selection = (self.composer_state.drafts.gateway() == Some(config.url.as_str()))
            .then(|| self.chat.scope())
            .flatten();
        self.composer_begin_connection(&config.url, window, cx);
        self.connection.take();
        self.connection_id += 1;
        self.epoch += 1;
        self.reset_transcript_media();
        self.attention_state = AttentionUi::default();
        self.session = None;
        self.rows.clear();
        self.chat = ChatState::default();
        if let Some(scope) = selection {
            self.chat.select_context(scope.session_key, scope.agent_id);
        }
        self.transcript_list.reset(0);
        self.sidebar_state.selected_descriptor = None;
        self.sidebar_state.search_rows.clear();
        self.sidebar_state.search_hits.clear();
        self.sidebar_state.children.clear();
        self.sidebar_state.pending_selection = None;
        self.sidebar_state.agent_revision += 1;

        self.connecting = true;
        self.connection_stage = ConnectionStage::Checking;
        self.browser_open_requested = false;
        self.connection_message = None;
        let connection_id = self.connection_id;
        let (connection, events) = connection::connect(&self.runtime, config, self.profile.clone());
        self.connection = Some(connection);
        cx.spawn(async move |this, cx| {
            while let Ok(event) = events.recv().await {
                if this
                    .update(cx, |this, cx| {
                        if this.connection_id == connection_id {
                            this.on_connection_event(event, cx);
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        self.publish_gateway_status(cx);
        cx.notify();
    }

    fn on_connection_event(&mut self, event: ConnectionEvent, cx: &mut Context<Self>) {
        // Actor expiry/disconnect events cannot reopen connection controls while
        // local WebKit deletion still owns this connection generation.
        #[cfg(target_os = "macos")]
        if self.web_store_removal.is_some() {
            return;
        }
        if self.connection_stage == ConnectionStage::SigningOut
            && !matches!(
                event,
                ConnectionEvent::AccessRequired { .. }
                    | ConnectionEvent::Disconnected { paused: true, .. }
            )
        {
            return;
        }
        match event {
            ConnectionEvent::Checking => {
                self.connecting = true;
                self.connection_stage = ConnectionStage::Checking;
            }
            ConnectionEvent::AccessRequired { message } => {
                self.clear_connection_content(cx);
                self.clear_account_composer();
                self.connecting = false;
                self.connection_stage = ConnectionStage::AccessRequired;
                self.access_protected = true;
                self.access_identity = None;
                self.show_connect_form = true;
                self.browser_open_requested = false;
                self.connection_message = message;
            }
            ConnectionEvent::WaitingForBrowser { url } => {
                if self.browser_open_requested && !self.connection_fixture {
                    self.browser_open_requested = false;
                    self.connection_stage = ConnectionStage::WaitingForBrowser;
                    cx.open_url(&url);
                }
            }
            ConnectionEvent::AccessIdentity(identity) => {
                self.access_protected = true;
                self.access_identity = Some(
                    identity
                        .email
                        .clone()
                        .unwrap_or_else(|| identity.subject.clone()),
                );
                self.web_access = Some(identity.clone());
                if let Some(auth) = &mut self.web.auth {
                    auth.access_session = Some(identity);
                    auth.token = None;
                    auth.password = None;
                }
            }
            ConnectionEvent::Connecting => {
                self.connection_stage = ConnectionStage::Connecting;
                self.connecting = true;
                self.sidebar_state.reconnect_at = None;
            }
            ConnectionEvent::Disconnected {
                message,
                paused,
                retry_after,
            } => {
                self.epoch += 1;
                self.reset_transcript_media();
                self.session = None;
                self.sidebar_state.activity.clear();
                self.sidebar_state.people.entries.clear();
                self.sidebar_state.avatars = Default::default();
                self.sidebar_state.pull_requests.clear();
                self.connecting = !paused;
                self.connection_stage = if paused {
                    ConnectionStage::Error
                } else {
                    ConnectionStage::Connecting
                };
                self.browser_open_requested = false;
                self.connection_message = Some(message);
                self.router.disconnected(self.epoch);
                self.chat.manual_compaction = None;
                self.sync_transcript();
                self.sidebar_state.reconnect_at = retry_after.map(|delay| Instant::now() + delay);
                self.composer_state.attachment_generation += 1;
                self.composer_state.reading = 0;
                for pending in self.composer_state.pending.values_mut() {
                    if pending.in_flight {
                        pending.in_flight = false;
                        self.chat.send_failed(
                            &pending.scope,
                            &pending.request.idempotency_key,
                            "Connection lost before delivery was confirmed".into(),
                        );
                    }
                }
            }
            ConnectionEvent::Connected {
                session,
                mut config,
                transport_url,
                instance_id,
            } => {
                self.viewer_presence = None;
                self.viewer_request = false;
                self.connection_stage = ConnectionStage::Connected;
                self.show_connect_form = false;
                self.epoch += 1;
                self.attention_state = AttentionUi::default();
                self.connecting = false;
                self.sidebar_state.reconnect_at = None;
                self.connection_message = None;
                self.router.connected(self.epoch, session.hello());
                if self.chat.selected_session.is_none() {
                    let key = session
                        .hello()
                        .pointer("/snapshot/sessionDefaults/mainSessionKey")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    if let Some(key) = key {
                        let agent = key
                            .strip_prefix("agent:")
                            .and_then(|s| s.split(':').next())
                            .map(str::to_owned);
                        self.sidebar_state.selected_agent = agent.clone();
                        self.chat.select_context(key, agent);
                    }
                }
                config.url = transport_url;
                self.web.connect(&config, self.web_access.clone());
                for dock in self.web.sessions.values_mut() {
                    dock.agent_browser = None;
                }
                let hello = session.hello().clone();
                self.session = Some(session);
                self.sidebar_state.people.instance_id = Some(instance_id);
                self.sidebar_people_connected(&hello, cx);
                self.load_sidebar_preferences(cx);
                self.sidebar_state.pull_requests.clear();
                if hello
                    .pointer("/features/methods")
                    .and_then(Value::as_array)
                    .is_some_and(|methods| {
                        methods
                            .iter()
                            .any(|method| method.as_str() == Some("sessions.observer.visibility"))
                    })
                {
                    self.request(
                        "sessions.observer.visibility",
                        json!({"visible": true}),
                        cx,
                        |_, _, _| {},
                    );
                }
                self.request("sessions.subscribe", json!({}), cx, |this, result, _| {
                    if let Err(error) = result {
                        this.roster_error = Some(error);
                    }
                });
                self.read_questions(cx);
                self.sync_subscription(cx);
                self.load_history(cx);
                self.load_composer_catalogs(cx);
                self.sidebar_connected(cx);
            }
            ConnectionEvent::Event(event) => {
                self.sidebar_state.activity.handle_event(
                    &event.event,
                    &event.payload,
                    crate::model::chat::now_ms(),
                );
                match event.event.as_str() {
                    "session.operation" => {
                        let outcome = self.chat.apply_session_operation(&event.payload);
                        if outcome.changed {
                            self.sync_transcript();
                        }
                        if outcome.terminal {
                            self.load_history(cx);
                            self.schedule_refresh(cx);
                        }
                    }
                    "presence" => self.sidebar_presence(&event.payload, cx),
                    "controlUi.sessionPullRequests.changed" => {
                        self.sidebar_state
                            .pull_requests
                            .apply_changed(&event.payload);
                    }
                    "plugins.changed" | "plugins.controlUi.changed" => {
                        self.refresh_control_tabs(cx)
                    }
                    "sessions.groups.changed" => self.load_sidebar_groups(cx),
                    _ => {}
                }
                self.apply_sidebar_catalog_event(&event.event, &event.payload, cx);

                match self.router.route(
                    self.epoch,
                    &event.event,
                    &event.payload,
                    self.chat.active_run.as_deref(),
                ) {
                    Some(RoutedEvent::Roster(payload)) => self.apply_sessions_changed(&payload, cx),
                    Some(RoutedEvent::Chat(payload)) => {
                        let outcome = self.chat.apply_event(&payload);
                        if outcome.changed {
                            self.sync_transcript();
                        }
                        if outcome.terminal {
                            self.schedule_refresh(cx);
                        }
                    }
                    Some(RoutedEvent::Agent(payload) | RoutedEvent::Tool(payload)) => {
                        if self.chat.apply_agent_event(&payload) {
                            self.sync_transcript();
                        }
                    }
                    Some(RoutedEvent::Attention) => self.update_attention_badges(),
                    Some(RoutedEvent::Presence) => {}
                    Some(RoutedEvent::Shutdown) => {
                        self.connection_message = Some(
                            self.router
                                .shutdown
                                .as_ref()
                                .map(|s| match s.restart_expected_ms {
                                    Some(ms) => format!(
                                        "{} · restarting in {}s",
                                        s.reason,
                                        ms.div_ceil(1000)
                                    ),
                                    None => s.reason.clone(),
                                })
                                .unwrap_or_else(|| "Gateway is shutting down".into()),
                        );
                    }
                    None => {}
                }
            }
        }
        self.publish_gateway_status(cx);
        cx.notify();
    }

    fn clear_connection_content(&mut self, cx: &App) {
        self.web.reset();
        self.web_access = None;
        self.composer_save_draft(cx);
        self.composer_state.restore_pending = true;
        self.epoch += 1;
        self.session = None;
        self.rows.clear();
        self.roster_loading = false;
        self.roster_error = None;
        self.chat = ChatState::default();
        self.router = Router::default();
        self.router.disconnected(self.epoch);
        self.attention_state = AttentionUi::default();
        self.transcript_state = TranscriptUi::default();
        self.transcript_list.reset(0);
        self.sidebar_state.reconnect_at = None;
        self.sidebar_state.refresh_timer = None;
        self.sidebar_state.pending_selection = None;
        self.sidebar_state.selected_agent = None;
        self.sidebar_state.selected_descriptor = None;
        self.sidebar_state.agents.clear();
        self.sidebar_state.children.clear();
        self.sidebar_state.child_loading.clear();
        self.sidebar_state.child_errors.clear();
        self.sidebar_state.child_limits.clear();
        self.sidebar_state.expanded.clear();
        self.sidebar_state.attention.clear();
        self.sidebar_state.people = Default::default();
        self.sidebar_state.avatars = Default::default();
        self.sidebar_state.activity.clear();
        self.sidebar_state.pull_requests.clear();
        self.sidebar_state.catalogs = Default::default();
        self.sidebar_state.selection.clear();
        self.sidebar_state.status_expiry = None;
        self.sidebar_state.has_more = false;
        self.sidebar_state.next_offset = 0;
        self.sidebar_state.main_key = "main".into();
        self.sidebar_state.global_scope = false;
        self.sidebar_state.rename_row = None;
        self.sidebar_state.rename_in_header = false;
        self.sidebar_state.palette_open = false;
        self.sidebar_state.search_rows.clear();
        self.sidebar_state.search_hits.clear();
        self.sidebar_state.search_target = None;
        self.sidebar_state.search_loading = false;
        self.sidebar_state.search_error = None;
        self.sidebar_state.notifications.clear();
        self.sidebar_state.agent_revision += 1;
        self.sidebar_state.search_generation += 1;
        self.sidebar_state.agents_generation += 1;
        self.sidebar_state.create_generation += 1;
        self.composer_state.set_attachments(Vec::new());
        self.composer_state.commands.clear();
        self.model_controls.reset_connection();
        self.composer_state.catalog_cache.clear();
        self.composer_state.close_popups();
        self.composer_state.error = None;
        self.composer_state.attachment_generation += 1;
        self.composer_state.catalog_generation += 1;
        self.composer_state.reading = 0;
    }

    pub(in crate::ui) fn switch_gateway(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.connection_stage == ConnectionStage::SigningOut {
            return;
        }
        self.connection.take();
        self.connection_id += 1;
        self.clear_connection_content(cx);
        let mut sidebar = SidebarState::new(window, cx);
        sidebar.collapsed = self.sidebar_state.collapsed;
        sidebar.width = self.sidebar_state.width;
        sidebar.agent_revision = self.sidebar_state.agent_revision + 1;
        sidebar.search_generation = self.sidebar_state.search_generation + 1;
        sidebar.create_generation = self.sidebar_state.create_generation + 1;
        sidebar.agents_generation = self.sidebar_state.agents_generation + 1;
        self.sidebar_state = sidebar;
        self.connecting = false;
        self.connection_stage = ConnectionStage::Idle;
        self.access_protected = false;
        self.access_identity = None;
        self.connection_message = None;
        self.browser_open_requested = false;
        self.show_connect_form = true;
        self.token
            .update(cx, |state, cx| state.set_value("", window, cx));
        self.password
            .update(cx, |state, cx| state.set_value("", window, cx));
        self.publish_gateway_status(cx);
        cx.notify();
    }

    pub(in crate::ui) fn sign_in(&mut self, cx: &mut Context<Self>) {
        if self.connection_fixture || self.connection_stage != ConnectionStage::AccessRequired {
            return;
        }
        if let Some(connection) = &self.connection {
            self.browser_open_requested = true;
            self.connection_stage = ConnectionStage::WaitingForBrowser;
            self.connection_message = None;
            self.connecting = true;
            connection.sign_in();
            self.publish_gateway_status(cx);
            cx.notify();
        }
    }

    pub(in crate::ui) fn cancel_connection(&mut self, cx: &mut Context<Self>) {
        if self.connection_stage == ConnectionStage::SigningOut {
            return;
        }
        self.connection.take();
        self.connection_id += 1;
        self.browser_open_requested = false;
        self.connecting = false;
        self.connection_stage = ConnectionStage::Idle;
        self.connection_message = Some("Connection canceled. Choose Connect to try again.".into());
        self.publish_gateway_status(cx);
        cx.notify();
    }

    fn clear_account_composer(&mut self) {
        let gateway = self.composer_state.drafts.gateway().map(str::to_owned);
        self.composer_state.drafts = Default::default();
        if let Some(gateway) = gateway {
            self.composer_state.drafts.bind_gateway(&gateway);
        }
        self.composer_state.pending.clear();
        self.composer_state.recall = Default::default();
        self.composer_state.restore_pending = true;
    }

    pub(in crate::ui) fn sign_out(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.connection_fixture || self.connection_stage == ConnectionStage::SigningOut {
            return;
        }
        #[cfg(target_os = "macos")]
        {
            let gateway = self
                .web
                .auth
                .as_ref()
                .map(|auth| auth.gateway_url.clone())
                .unwrap_or_else(|| self.url.read(cx).value().to_string());
            let result = (|| {
                let scope = self.web.control_scope(&gateway)?;
                let mut identity = crate::gateway::identity::Identity::load()?;
                identity.begin_web_store_removal(&scope)?;
                let retired = self.web.retire_control();
                if let Some(stores) = &mut self.web.stores {
                    stores.retire_control();
                }
                Ok::<_, String>((identity, scope, retired))
            })();
            match result {
                Ok((mut identity, scope, retired)) => {
                    let connection_id = self.connection_id;
                    self.web_store_removal = Some(connection_id);
                    self.connection_stage = ConnectionStage::SigningOut;
                    self.connecting = true;
                    self.show_connect_form = true;
                    self.connection_message = Some("Removing this Gateway's web session…".into());
                    cx.spawn_in(window, async move |this, cx| {
                        // Native view release can finish asynchronously. Service
                        // workers are cleared by the store removal owner afterward.
                        let deadline = Instant::now() + std::time::Duration::from_secs(10);
                        while retired.iter().any(|view| !view.is_complete())
                            && Instant::now() < deadline
                        {
                            cx.background_executor()
                                .timer(std::time::Duration::from_millis(25))
                                .await;
                        }
                        let result = if retired.iter().any(|view| !view.is_complete()) {
                            Err(
                                "WebKit is still closing this Gateway's pages. Retry Sign out."
                                    .into(),
                            )
                        } else {
                            crate::web_data_store::remove(
                                &mut identity,
                                &scope,
                                cx.background_executor(),
                            )
                            .await
                        };
                        let _ = this.update_in(cx, |this, window, cx| {
                            if this.web_store_removal != Some(connection_id)
                                || this.connection_id != connection_id
                            {
                                return;
                            }
                            this.web_store_removal = None;
                            this.connection_stage = ConnectionStage::Idle;
                            this.connecting = false;
                            match result {
                                Ok(()) => this.finish_sign_out(window, cx),
                                Err(error) => {
                                    this.show_connect_form = false;
                                    this.web.error = Some(error.clone());
                                    this.connection_message = Some(error);
                                    this.publish_gateway_status(cx);
                                    cx.notify();
                                }
                            }
                        });
                    })
                    .detach();
                }
                Err(error) => self.connection_message = Some(error),
            }
            self.publish_gateway_status(cx);
            cx.notify();
        }
        #[cfg(not(target_os = "macos"))]
        self.finish_sign_out(window, cx);
    }

    fn finish_sign_out(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        #[cfg(not(target_os = "macos"))]
        if let Some(surface) = self.web.settings.as_ref().or_else(|| {
            self.web
                .sessions
                .values()
                .find_map(|dock| dock.catalog.as_ref())
        }) && let Err(error) = surface.clear_data()
        {
            self.connection_message = Some(error);
        }
        self.clear_account_composer();
        self.composer
            .update(cx, |state, cx| state.set_value("", window, cx));
        if !self.access_protected {
            self.switch_gateway(window, cx);
            return;
        }
        if let Some(connection) = &self.connection {
            connection.sign_out();
            self.clear_connection_content(cx);
            self.connection_stage = ConnectionStage::SigningOut;
            self.connecting = true;
            self.access_identity = None;
            self.connection_message = None;
            self.browser_open_requested = false;
            self.show_connect_form = true;
            self.token
                .update(cx, |state, cx| state.set_value("", window, cx));
            self.password
                .update(cx, |state, cx| state.set_value("", window, cx));
            self.publish_gateway_status(cx);
            cx.notify();
        } else {
            self.switch_gateway(window, cx);
        }
    }

    #[cfg(debug_assertions)]
    pub(super) fn apply_connection_fixture(&mut self) {
        let Ok(fixture) = std::env::var("OPENCLAW_GPUI_CONNECT_FIXTURE") else {
            return;
        };
        // Fixture mode is render-only, including unknown fixture names.
        self.connection_fixture = true;
        self.connection_message = None;
        match fixture.as_str() {
            "waiting" => {
                self.access_protected = true;
                self.connecting = true;
                self.connection_stage = ConnectionStage::WaitingForBrowser;
            }
            "error" => {
                self.access_protected = true;
                self.connection_stage = ConnectionStage::Error;
                self.connection_message = Some("Device pairing is awaiting approval. Ask a Gateway administrator to approve this device, then choose Retry.".into());
            }
            _ => {
                self.connection_stage = ConnectionStage::Idle;
                self.connection_message = None;
            }
        }
    }
}
