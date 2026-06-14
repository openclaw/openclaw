use std::sync::Arc;

use gtk4::glib;
use gtk4::subclass::prelude::*;

use openclaw_gateway_client::GatewayClient;

// Thread-safe client holder (set from tokio, read from GLib)
pub type SharedClient = Arc<std::sync::Mutex<Option<Arc<GatewayClient>>>>;

mod imp {
    use std::cell::{Cell, RefCell};
    use super::*;

    #[derive(Default)]
    pub struct AppStateInner {
        pub connected: Cell<bool>,
        pub server_version: RefCell<String>,
        pub active_session: RefCell<Option<String>>,
        pub stream_text: RefCell<String>,
        pub stream_run_id: RefCell<Option<String>>,
        /// Session key of the currently streaming run, so finalization
        /// routes to the correct session even if the user switches tabs.
        pub stream_session_key: RefCell<String>,
        pub agents: RefCell<Vec<serde_json::Value>>,
        pub sessions: RefCell<Vec<serde_json::Value>>,
        pub channels: RefCell<Vec<serde_json::Value>>,
        pub models: RefCell<Vec<serde_json::Value>>,
        /// (session_key, run_id, text) — session-scoped so replies render
        /// in the correct chat even if the user switches tabs mid-flight.
        pub pending_assistant: RefCell<Vec<(String, String, String)>>,
        pub show_thinking: Cell<bool>,
        pub show_tools: Cell<bool>,
        pub current_view: RefCell<String>,
        pub selected_agent: RefCell<Option<String>>,
        pub selected_session: RefCell<Option<String>>,
        pub service_active: Cell<bool>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for AppStateInner {
        const NAME: &'static str = "OpenClawAppState";
        type Type = super::AppState;
        type ParentType = glib::Object;
    }

    impl ObjectImpl for AppStateInner {}
}

glib::wrapper! {
    pub struct AppState(ObjectSubclass<imp::AppStateInner>);
}

impl AppState {
    pub fn new() -> Self {
        glib::Object::builder().build()
    }

    pub fn is_connected(&self) -> bool {
        self.imp().connected.get()
    }

    pub fn set_connected(&self, val: bool) {
        self.imp().connected.set(val);
    }

    pub fn server_version(&self) -> String {
        self.imp().server_version.borrow().clone()
    }

    pub fn set_server_version(&self, v: String) {
        *self.imp().server_version.borrow_mut() = v;
    }

    pub fn active_session(&self) -> Option<String> {
        self.imp().active_session.borrow().clone()
    }

    pub fn set_active_session(&self, key: Option<String>) {
        *self.imp().active_session.borrow_mut() = key;
    }

    pub fn stream_text(&self) -> String {
        self.imp().stream_text.borrow().clone()
    }

    pub fn set_stream_text(&self, text: String) {
        *self.imp().stream_text.borrow_mut() = text;
    }

    pub fn stream_run_id(&self) -> Option<String> {
        self.imp().stream_run_id.borrow().clone()
    }

    pub fn set_stream_run_id(&self, id: Option<String>) {
        *self.imp().stream_run_id.borrow_mut() = id;
    }

    pub fn stream_session_key(&self) -> String {
        self.imp().stream_session_key.borrow().clone()
    }

    pub fn set_stream_session_key(&self, key: String) {
        *self.imp().stream_session_key.borrow_mut() = key;
    }

    pub fn agents(&self) -> Vec<serde_json::Value> {
        self.imp().agents.borrow().clone()
    }

    pub fn set_agents(&self, agents: Vec<serde_json::Value>) {
        *self.imp().agents.borrow_mut() = agents;
    }

    pub fn sessions(&self) -> Vec<serde_json::Value> {
        self.imp().sessions.borrow().clone()
    }

    pub fn set_sessions(&self, sessions: Vec<serde_json::Value>) {
        *self.imp().sessions.borrow_mut() = sessions;
    }

    pub fn channels(&self) -> Vec<serde_json::Value> {
        self.imp().channels.borrow().clone()
    }

    pub fn set_channels(&self, channels: Vec<serde_json::Value>) {
        *self.imp().channels.borrow_mut() = channels;
    }

    pub fn show_thinking(&self) -> bool {
        self.imp().show_thinking.get()
    }

    pub fn set_show_thinking(&self, v: bool) {
        self.imp().show_thinking.set(v);
    }

    pub fn show_tools(&self) -> bool {
        self.imp().show_tools.get()
    }

    pub fn set_show_tools(&self, v: bool) {
        self.imp().show_tools.set(v);
    }

    pub fn models(&self) -> Vec<serde_json::Value> {
        self.imp().models.borrow().clone()
    }

    pub fn set_models(&self, models: Vec<serde_json::Value>) {
        *self.imp().models.borrow_mut() = models;
    }

    /// Append a finalized assistant message scoped to a session key.
    pub fn push_assistant_message(&self, session_key: String, run_id: String, text: String) {
        self.imp().pending_assistant.borrow_mut().push((session_key, run_id, text));
    }

    /// Drain pending assistant messages for a specific session only.
    /// Messages for other sessions stay in the queue.
    pub fn drain_assistant_messages(&self, for_session: &str) -> Vec<(String, String, String)> {
        let mut pending = self.imp().pending_assistant.borrow_mut();
        let (matching, remaining): (Vec<_>, Vec<_>) = pending
            .drain(..)
            .partition(|(sk, _, _)| sk == for_session);
        *pending = remaining;
        matching
    }

    pub fn current_view(&self) -> String {
        let v = self.imp().current_view.borrow().clone();
        if v.is_empty() { "chat".to_string() } else { v }
    }

    pub fn set_current_view(&self, view: String) {
        *self.imp().current_view.borrow_mut() = view;
    }

    pub fn selected_agent(&self) -> Option<String> {
        self.imp().selected_agent.borrow().clone()
    }

    pub fn set_selected_agent(&self, id: Option<String>) {
        *self.imp().selected_agent.borrow_mut() = id;
    }

    pub fn selected_session(&self) -> Option<String> {
        self.imp().selected_session.borrow().clone()
    }

    pub fn set_selected_session(&self, key: Option<String>) {
        *self.imp().selected_session.borrow_mut() = key;
    }

    pub fn service_active(&self) -> bool {
        self.imp().service_active.get()
    }

    pub fn set_service_active(&self, val: bool) {
        self.imp().service_active.set(val);
    }
}
