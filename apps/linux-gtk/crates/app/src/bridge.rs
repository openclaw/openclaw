use gtk4::glib;
use openclaw_gateway_client::{ChatEvent, GatewayEvent};
use tracing::{debug, info, warn};

use crate::state::{AppState, SharedClient};

/// Bridges async-channel events from tokio into the GLib main loop.
pub struct EventBridge {
    rx: async_channel::Receiver<GatewayEvent>,
    state: AppState,
    client: SharedClient,
}

impl EventBridge {
    pub fn new(
        rx: async_channel::Receiver<GatewayEvent>,
        state: AppState,
        client: SharedClient,
    ) -> Self {
        Self { rx, state, client }
    }

    pub fn start(&self) {
        let rx = self.rx.clone();
        let state = self.state.clone();
        let client = self.client.clone();

        glib::spawn_future_local(async move {
            while let Ok(event) = rx.recv().await {
                Self::handle_event(&state, &client, event);
            }
        });
    }

    fn handle_event(state: &AppState, client: &SharedClient, event: GatewayEvent) {
        match event {
            GatewayEvent::Connected(hello) => {
                info!("connected: server v{}", hello.server.version);
                state.set_connected(true);
                state.set_server_version(hello.server.version.clone());

                // Desktop notification for connection status
                if let Some(app) = gtk4::gio::Application::default() {
                    crate::notifications::send_notification(
                        &app,
                        "Gateway Connected",
                        &format!("OpenClaw gateway v{}", hello.server.version),
                        "network-transmit-symbolic",
                    );
                }

                // The connect snapshot only carries presence/health/version —
                // agents, sessions, and channels must be fetched via RPC.
                // Kick off async fetches; state update happens when each
                // RPC returns.
                Self::refresh_snapshot(state.clone(), client.clone());
            }
            GatewayEvent::Disconnected(reason) => {
                info!("disconnected: {reason}");
                state.set_connected(false);

                // Desktop notification for disconnection
                if let Some(app) = gtk4::gio::Application::default() {
                    crate::notifications::send_notification(
                        &app,
                        "Gateway Disconnected",
                        &format!("Reason: {reason}"),
                        "network-offline-symbolic",
                    );
                }
            }
            GatewayEvent::Event(frame) => {
                match frame.event.as_str() {
                    "chat" => {
                        if let Ok(chat) = serde_json::from_value::<ChatEvent>(frame.payload) {
                            Self::handle_chat(state, chat);
                        }
                    }
                    "tick" => {
                        debug!("tick");
                    }
                    "presence" | "health" => {
                        debug!("event: {}", frame.event);
                    }
                    "agent" => {
                        // The modern gateway pipes assistant output through
                        // the unified `agent` event stream — chat deltas,
                        // lifecycle markers, tool activity — all share one
                        // event name, discriminated by the `stream` field.
                        Self::handle_agent_event(state, &frame.payload);
                    }
                    other => {
                        debug!("unhandled event {other}: {}", serde_json::to_string(&frame.payload).unwrap_or_default().chars().take(300).collect::<String>());
                    }
                }
            }
        }
    }

    /// Fire off async RPC calls to populate the agents/sessions/channels
    /// caches in `AppState`. Each call is independent; a failure on one
    /// does not block the others.
    ///
    /// `pub(crate)` so the window's refresh button can trigger a reload
    /// without having to reconnect the gateway.
    pub(crate) fn refresh_snapshot(state: AppState, client: SharedClient) {
        // Snapshot the Arc<GatewayClient> out of the mutex so we can move
        // it into async tasks without holding the lock.
        let gw = match client.lock() {
            Ok(g) => g.clone(),
            Err(_) => {
                warn!("client mutex poisoned; skipping snapshot refresh");
                return;
            }
        };
        let Some(gw) = gw else {
            warn!("no gateway client available; cannot refresh snapshot");
            return;
        };

        // agents.list
        let state_a = state.clone();
        let gw_a = gw.clone();
        glib::spawn_future_local(async move {
            match gw_a
                .request("agents.list", serde_json::json!({}))
                .await
            {
                Ok(payload) => {
                    let agents = payload
                        .get("agents")
                        .and_then(|a| a.as_array())
                        .cloned()
                        .unwrap_or_default();
                    debug!("agents.list returned {} agents", agents.len());
                    state_a.set_agents(agents);
                }
                Err(e) => warn!("agents.list failed: {e}"),
            }
        });

        // sessions.list (no agentId → returns sessions for all agents)
        let state_s = state.clone();
        let gw_s = gw.clone();
        glib::spawn_future_local(async move {
            match gw_s
                .request("sessions.list", serde_json::json!({}))
                .await
            {
                Ok(payload) => {
                    let sessions = payload
                        .get("sessions")
                        .and_then(|s| s.as_array())
                        .cloned()
                        .unwrap_or_default();
                    debug!("sessions.list returned {} sessions", sessions.len());
                    state_s.set_sessions(sessions);
                }
                Err(e) => warn!("sessions.list failed: {e}"),
            }
        });

        // models.list → { models: [{id, name, provider, contextWindow}] }
        let state_m = state.clone();
        let gw_m = gw.clone();
        glib::spawn_future_local(async move {
            match gw_m.request("models.list", serde_json::json!({})).await {
                Ok(payload) => {
                    let models = payload
                        .get("models")
                        .and_then(|m| m.as_array())
                        .cloned()
                        .unwrap_or_default();
                    debug!("models.list returned {} models", models.len());
                    state_m.set_models(models);
                }
                Err(e) => warn!("models.list failed: {e}"),
            }
        });

        // channels.status returns:
        //   { channels: { telegram: {configured, ...}, whatsapp: {...} },
        //     channelOrder: ["telegram", ...],
        //     channelLabels: { telegram: "Telegram", ... } }
        // Reshape into rows the channels view expects: {name, status}.
        let state_c = state;
        glib::spawn_future_local(async move {
            match gw
                .request("channels.status", serde_json::json!({}))
                .await
            {
                Ok(payload) => {
                    let labels = payload
                        .get("channelLabels")
                        .and_then(|m| m.as_object())
                        .cloned()
                        .unwrap_or_default();
                    let order: Vec<String> = payload
                        .get("channelOrder")
                        .and_then(|a| a.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default();
                    let channels_map = payload
                        .get("channels")
                        .and_then(|m| m.as_object())
                        .cloned()
                        .unwrap_or_default();

                    let mut rows: Vec<serde_json::Value> = Vec::new();
                    for id in &order {
                        let summary = channels_map.get(id);
                        let configured = summary
                            .and_then(|s| s.get("configured"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        let status = if configured { "connected" } else { "not configured" };
                        let label = labels
                            .get(id)
                            .and_then(|v| v.as_str())
                            .unwrap_or(id);
                        rows.push(serde_json::json!({
                            "id": id,
                            "name": label,
                            "status": status,
                        }));
                    }
                    debug!("channels.status returned {} channels", rows.len());
                    state_c.set_channels(rows);
                }
                Err(e) => warn!("channels.status failed: {e}"),
            }
        });
    }

    /// Handle an `agent` event frame. Modern gateway (≥ 2026.4) emits
    /// everything — assistant text deltas, lifecycle markers, tool
    /// activity — through this single event, discriminated by `stream`.
    ///
    /// Expected shape:
    ///   { runId, seq, sessionKey, stream, data: {...}, ts }
    ///
    /// For assistant text: `stream: "assistant"`, `data.text` holds the
    /// running-accumulated reply, `data.delta` holds the incremental chunk.
    /// For end-of-turn: `stream: "lifecycle"`, `data.phase == "end"`.
    fn handle_agent_event(state: &AppState, payload: &serde_json::Value) {
        let stream = payload.get("stream").and_then(|v| v.as_str()).unwrap_or("");
        let run_id = payload
            .get("runId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let session_key = payload
            .get("sessionKey")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let data = payload.get("data");

        match stream {
            "assistant" => {
                // `data.text` is the running-accumulated text; overwrite
                // the stream buffer. Track session key so finalization
                // routes to the correct session even if user switches tabs.
                if let Some(text) = data
                    .and_then(|d| d.get("text"))
                    .and_then(|v| v.as_str())
                {
                    state.set_stream_text(text.to_string());
                    state.set_stream_session_key(session_key.clone());
                    if let Some(id) = run_id {
                        state.set_stream_run_id(Some(id));
                    }
                }
            }
            "lifecycle" => {
                let phase = data
                    .and_then(|d| d.get("phase"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match phase {
                    "start" => {
                        state.set_stream_session_key(session_key.clone());
                        if let Some(id) = run_id {
                            state.set_stream_run_id(Some(id));
                        }
                    }
                    "end" => {
                        // Use the STORED stream session key, not the
                        // lifecycle event's session key, to correctly
                        // attribute text even if events interleave.
                        let sk = state.stream_session_key();
                        let sk = if sk.is_empty() { session_key.clone() } else { sk };
                        let text = state.stream_text();
                        if !text.is_empty() {
                            let rid = run_id.unwrap_or_default();
                            state.push_assistant_message(sk, rid, text);
                        }
                        state.set_stream_text(String::new());
                        state.set_stream_run_id(None);
                        state.set_stream_session_key(String::new());
                    }
                    _ => {}
                }
            }
            "error" => {
                warn!(
                    "agent error: {}",
                    serde_json::to_string(&payload).unwrap_or_default()
                );
                state.set_stream_text(String::new());
                state.set_stream_run_id(None);
            }
            "tool" | _ => {
                // Tool events aren't rendered in the chat view yet (future
                // work wires them through show_tools toggle). Just keep the
                // pipe warm; don't clutter the log.
                debug!("agent stream {stream}");
            }
        }
    }

    fn handle_chat(state: &AppState, chat: ChatEvent) {
        match chat.state.as_str() {
            "delta" => {
                // Append delta text to streaming buffer
                if let Some(text) = chat.message.get("text").and_then(|v| v.as_str()) {
                    let mut current = state.stream_text();
                    current.push_str(text);
                    state.set_stream_text(current);
                    state.set_stream_run_id(Some(chat.run_id));
                }
            }
            "final" => {
                // Prefer the text explicitly carried on the `final` frame;
                // fall back to the accumulated stream buffer for servers that
                // only send deltas.
                let text = chat
                    .message
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| state.stream_text());
                if !text.is_empty() {
                    state.push_assistant_message(
                        chat.session_key.clone(),
                        chat.run_id,
                        text,
                    );
                }
                state.set_stream_text(String::new());
                state.set_stream_run_id(None);
            }
            "aborted" | "error" => {
                state.set_stream_text(String::new());
                state.set_stream_run_id(None);
            }
            _ => {}
        }
    }
}
