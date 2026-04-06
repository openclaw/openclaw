use gtk4::prelude::*;
use gtk4::{self, glib, Orientation};
use tracing::{debug, info, warn};

use crate::markdown;
use crate::state::{AppState, SharedClient};
use crate::widgets::chat_bubble::ChatBubble;

pub struct ChatView {
    container: gtk4::Box,
}

impl ChatView {
    pub fn new(state: AppState, client: SharedClient) -> Self {
        let container = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .vexpand(true)
            .hexpand(true)
            .build();

        // --- Header: model picker + session label -----------------------
        let header = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(8)
            .margin_start(24)
            .margin_end(24)
            .margin_top(12)
            .margin_bottom(8)
            .build();

        let model_label = gtk4::Label::builder()
            .label("Model:")
            .css_classes(vec!["dim-label".to_string()])
            .build();

        // Placeholder list; real model ids filled in by the poll loop below.
        let model_store = gtk4::StringList::new(&["loading…"]);
        let model_dropdown = gtk4::DropDown::builder()
            .model(&model_store)
            .tooltip_text("Override the model for this session")
            .build();

        let session_label = gtk4::Label::builder()
            .label("")
            .css_classes(vec!["dim-label".to_string(), "caption".to_string()])
            .halign(gtk4::Align::End)
            .hexpand(true)
            .ellipsize(gtk4::pango::EllipsizeMode::End)
            .build();

        // Thinking + Tools toggle buttons — let the user opt into
        // seeing reasoning traces and tool-use blocks in rendered history.
        let thinking_btn = gtk4::ToggleButton::builder()
            .icon_name("view-reveal-symbolic")
            .tooltip_text("Show reasoning / thinking blocks")
            .css_classes(vec!["flat".to_string()])
            .active(state.show_thinking())
            .build();
        let tools_btn = gtk4::ToggleButton::builder()
            .icon_name("applications-utilities-symbolic")
            .tooltip_text("Show tool calls and results")
            .css_classes(vec!["flat".to_string()])
            .active(state.show_tools())
            .build();

        header.append(&model_label);
        header.append(&model_dropdown);
        header.append(&thinking_btn);
        header.append(&tools_btn);
        header.append(&session_label);

        // Track which session has been rendered so toggles + history
        // loads can both trigger a reload by clearing this.
        let loaded_session: std::rc::Rc<std::cell::RefCell<Option<String>>> =
            std::rc::Rc::new(std::cell::RefCell::new(None));

        // Wire toggle state → AppState. Clearing `loaded_session` forces
        // the poller to re-render the current session's history with the
        // new visibility flags on the next tick.
        let state_tt = state.clone();
        let ls_t = loaded_session.clone();
        thinking_btn.connect_toggled(move |btn| {
            state_tt.set_show_thinking(btn.is_active());
            *ls_t.borrow_mut() = None;
        });
        let state_tt2 = state.clone();
        let ls_t2 = loaded_session.clone();
        tools_btn.connect_toggled(move |btn| {
            state_tt2.set_show_tools(btn.is_active());
            *ls_t2.borrow_mut() = None;
        });

        // --- Messages area ------------------------------------------------
        let messages_box = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .spacing(8)
            .margin_start(24)
            .margin_end(24)
            .margin_top(12)
            .margin_bottom(12)
            .valign(gtk4::Align::End)
            .build();

        let welcome_box = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .valign(gtk4::Align::Center)
            .halign(gtk4::Align::Center)
            .spacing(8)
            .vexpand(true)
            .css_classes(vec!["chat-welcome".to_string()])
            .build();

        let logo_label = gtk4::Label::builder()
            .label("OpenClaw")
            .css_classes(vec!["title-1".to_string()])
            .build();

        let subtitle = gtk4::Label::builder()
            .label("Send a message to get started")
            .css_classes(vec!["dim-label".to_string()])
            .build();

        welcome_box.append(&logo_label);
        welcome_box.append(&subtitle);
        messages_box.append(&welcome_box);

        let scroll = gtk4::ScrolledWindow::builder()
            .child(&messages_box)
            .vexpand(true)
            .hexpand(true)
            .hscrollbar_policy(gtk4::PolicyType::Never)
            .vscrollbar_policy(gtk4::PolicyType::Automatic)
            .kinetic_scrolling(true)
            .build();

        // Streaming / typing indicator — pinned under the messages area,
        // shows a spinner + live streaming text preview while the agent
        // is composing a reply.
        let typing_row = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(8)
            .margin_start(24)
            .margin_end(24)
            .margin_bottom(4)
            .visible(false)
            .build();
        let typing_spinner = gtk4::Spinner::builder()
            .spinning(false)
            .valign(gtk4::Align::Center)
            .build();
        let stream_label = gtk4::Label::builder()
            .label("Agent is typing…")
            .wrap(true)
            .xalign(0.0)
            .hexpand(true)
            .ellipsize(gtk4::pango::EllipsizeMode::End)
            .css_classes(vec!["stream-text".to_string()])
            .build();
        typing_row.append(&typing_spinner);
        typing_row.append(&stream_label);

        // Compose area — pinned at bottom
        let compose_box = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(8)
            .margin_start(24)
            .margin_end(24)
            .margin_top(8)
            .margin_bottom(16)
            .build();

        let compose_scroll = gtk4::ScrolledWindow::builder()
            .max_content_height(150)
            .min_content_height(44)
            .propagate_natural_height(true)
            .hscrollbar_policy(gtk4::PolicyType::Never)
            .hexpand(true)
            .css_classes(vec!["card".to_string()])
            .build();

        let compose_view = gtk4::TextView::builder()
            .wrap_mode(gtk4::WrapMode::WordChar)
            .left_margin(12)
            .right_margin(12)
            .top_margin(10)
            .bottom_margin(10)
            .build();

        compose_scroll.set_child(Some(&compose_view));

        let send_button = gtk4::Button::builder()
            .icon_name("go-up-symbolic")
            .css_classes(vec!["suggested-action".to_string(), "circular".to_string()])
            .tooltip_text("Send (Enter)")
            .valign(gtk4::Align::End)
            .margin_bottom(4)
            .build();

        compose_box.append(&compose_scroll);
        compose_box.append(&send_button);

        container.append(&header);
        container.append(&gtk4::Separator::new(Orientation::Horizontal));
        container.append(&scroll);
        container.append(&typing_row);
        container.append(&gtk4::Separator::new(Orientation::Horizontal));
        container.append(&compose_box);

        // --- Send wiring --------------------------------------------------
        let state2 = state.clone();
        let client2 = client.clone();
        let tv = compose_view.clone();
        let mb = messages_box.clone();
        let sc = scroll.clone();
        send_button.connect_clicked(move |_| {
            Self::send_message(&state2, &client2, &tv, &mb, &sc);
        });

        let state3 = state.clone();
        let client3 = client.clone();
        let tv2 = compose_view.clone();
        let mb2 = messages_box.clone();
        let sc2 = scroll.clone();
        let key_ctrl = gtk4::EventControllerKey::new();
        key_ctrl.connect_key_pressed(move |_, key, _, modifier| {
            if key == gtk4::gdk::Key::Return
                && !modifier.contains(gtk4::gdk::ModifierType::SHIFT_MASK)
            {
                Self::send_message(&state3, &client3, &tv2, &mb2, &sc2);
                glib::Propagation::Stop
            } else {
                glib::Propagation::Proceed
            }
        });
        compose_view.add_controller(key_ctrl);

        // --- Model dropdown: patch session on change ----------------------
        let state_md = state.clone();
        let client_md = client.clone();
        // Holds the currently-known list of model ids aligned with the dropdown.
        let model_ids: std::rc::Rc<std::cell::RefCell<Vec<String>>> =
            std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let model_ids_sel = model_ids.clone();
        model_dropdown.connect_selected_notify(move |dd| {
            let idx = dd.selected() as usize;
            let ids = model_ids_sel.borrow();
            let Some(model_id) = ids.get(idx).cloned() else {
                return;
            };
            // Skip the synthetic "current" marker at position 0.
            if model_id == "__current__" {
                return;
            }
            let gateway = client_md.lock().unwrap().clone();
            let Some(gateway) = gateway else { return };
            let session_key = state_md
                .selected_session()
                .or_else(|| state_md.active_session())
                .unwrap_or_else(|| "default".to_string());
            glib::spawn_future_local(async move {
                let params = serde_json::json!({
                    "key": session_key,
                    "model": model_id,
                });
                match gateway.request("sessions.patch", params).await {
                    Ok(_) => info!("sessions.patch ok (model change)"),
                    Err(e) => warn!("sessions.patch (model): {e}"),
                }
            });
        });

        // --- History load + streaming + finalized-assistant drain ---------
        let state4 = state;
        let client4 = client;
        let sl = stream_label;
        let tr = typing_row;
        let ts = typing_spinner;
        let mb3 = messages_box.clone();
        let sc3 = scroll.clone();
        let welcome = welcome_box;
        let model_store_clone = model_store.clone();
        let model_ids_poll = model_ids.clone();
        let session_label_clone = session_label.clone();
        // `loaded_session` was declared earlier (shared with toggle handlers).
        let models_populated: std::rc::Rc<std::cell::Cell<bool>> =
            std::rc::Rc::new(std::cell::Cell::new(false));

        glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
            // Typing indicator: visible whenever a stream is in progress.
            let text = state4.stream_text();
            let has_run = state4.stream_run_id().is_some();
            if text.is_empty() && !has_run {
                tr.set_visible(false);
                ts.set_spinning(false);
            } else {
                let preview = if text.is_empty() {
                    "Agent is typing…".to_string()
                } else {
                    // Compact preview: last ~120 chars of streaming text.
                    let trimmed = text.trim();
                    if trimmed.len() > 120 {
                        let start = trimmed.len().saturating_sub(120);
                        let mut s = start;
                        while s < trimmed.len() && !trimmed.is_char_boundary(s) {
                            s += 1;
                        }
                        format!("…{}", &trimmed[s..])
                    } else {
                        trimmed.to_string()
                    }
                };
                sl.set_label(&preview);
                tr.set_visible(true);
                ts.set_spinning(true);
            }

            // Populate model dropdown once, when the snapshot arrives.
            if !models_populated.get() {
                let models = state4.models();
                if !models.is_empty() {
                    let mut ids: Vec<String> = Vec::with_capacity(models.len());
                    let mut names: Vec<String> = Vec::with_capacity(models.len());
                    for m in &models {
                        let id = m
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("?")
                            .to_string();
                        let name = m
                            .get("name")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| id.clone());
                        let provider = m
                            .get("provider")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        ids.push(id);
                        names.push(if provider.is_empty() {
                            name
                        } else {
                            format!("{name} ({provider})")
                        });
                    }
                    // Clear placeholder and load real entries.
                    while model_store_clone.n_items() > 0 {
                        model_store_clone.remove(0);
                    }
                    for n in &names {
                        model_store_clone.append(n);
                    }
                    *model_ids_poll.borrow_mut() = ids;
                    models_populated.set(true);
                }
            }

            // Load chat history when the user's selected session first
            // becomes known, or changes. The window's session dropdown owns
            // this value, so we defer to it and don't guess with fallbacks
            // (that causes a flash-reload when the dropdown sets its initial
            // value a beat after we connect).
            let current_session = state4.selected_session();
            if let Some(session_key) = current_session
                && loaded_session.borrow().as_ref() != Some(&session_key)
                && state4.is_connected()
            {
                debug!(
                    "session switch: {:?} -> {session_key} (selected={:?} active={:?})",
                    loaded_session.borrow(),
                    state4.selected_session(),
                    state4.active_session()
                );
                *loaded_session.borrow_mut() = Some(session_key.clone());
                session_label_clone.set_label(&format!("Session: {session_key}"));

                // Clear message bubbles (keep only the welcome or add it back).
                while let Some(child) = mb3.first_child() {
                    mb3.remove(&child);
                }

                let gateway = client4.lock().unwrap().clone();
                if let Some(gateway) = gateway {
                    let mb_fetch = mb3.clone();
                    let sc_fetch = sc3.clone();
                    let welcome_fetch = welcome.clone();
                    let sk = session_key.clone();
                    let show_thinking = state4.show_thinking();
                    let show_tools = state4.show_tools();
                    glib::spawn_future_local(async move {
                        let params = serde_json::json!({
                            "sessionKey": sk,
                            "limit": 100,
                        });
                        match gateway.request("chat.history", params).await {
                            Ok(payload) => {
                                let messages = payload
                                    .get("messages")
                                    .and_then(|m| m.as_array())
                                    .cloned()
                                    .unwrap_or_default();
                                debug!(
                                    "chat.history for {sk} returned {} messages",
                                    messages.len()
                                );
                                if messages.is_empty() {
                                    mb_fetch.append(&welcome_fetch);
                                } else {
                                    for msg in &messages {
                                        let role = msg
                                            .get("role")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("user");
                                        let blocks = extract_blocks(msg.get("content"));
                                        render_message_blocks(
                                            &mb_fetch,
                                            role,
                                            &blocks,
                                            show_thinking,
                                            show_tools,
                                        );
                                    }
                                    let adj = sc_fetch.vadjustment();
                                    glib::idle_add_local_once(move || {
                                        adj.set_value(adj.upper());
                                    });
                                }
                            }
                            Err(e) => {
                                warn!("chat.history: {e}");
                                mb_fetch.append(&welcome_fetch);
                            }
                        }
                    });
                }
            }

            // Drain finalized assistant messages for the CURRENT session only.
            // Messages for other sessions stay queued until that session is active.
            let active_session = state4.selected_session().unwrap_or_default();
            let finalized = state4.drain_assistant_messages(&active_session);
            if !finalized.is_empty() {
                if let Some(first) = mb3.first_child()
                    && first.css_classes().iter().any(|c| c == "chat-welcome")
                {
                    mb3.remove(&first);
                }
                for (_sk, _run_id, body) in finalized {
                    let markup = markdown::to_pango(&body);
                    let bubble = ChatBubble::new_assistant(&markup, None);
                    mb3.append(&bubble);
                }
                let adj = sc3.vadjustment();
                glib::idle_add_local_once(move || {
                    adj.set_value(adj.upper());
                });
            }

            glib::ControlFlow::Continue
        });

        Self { container }
    }

    fn send_message(
        state: &AppState,
        client: &SharedClient,
        compose: &gtk4::TextView,
        messages_box: &gtk4::Box,
        scroll: &gtk4::ScrolledWindow,
    ) {
        let buffer = compose.buffer();
        let text = buffer
            .text(&buffer.start_iter(), &buffer.end_iter(), false)
            .to_string();
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }

        buffer.set_text("");

        if let Some(first) = messages_box.first_child()
            && first.css_classes().iter().any(|c| c == "chat-welcome")
        {
            messages_box.remove(&first);
        }

        let bubble = ChatBubble::new_user(&text);
        messages_box.append(&bubble);

        // Show the typing indicator immediately; the real run_id takes
        // over as soon as the first delta event arrives.
        state.set_stream_run_id(Some("pending".to_string()));

        let adj = scroll.vadjustment();
        glib::idle_add_local_once(move || {
            adj.set_value(adj.upper());
        });

        let gateway = client.lock().unwrap().clone();
        if let Some(gateway) = gateway {
            let session_key = state
                .selected_session()
                .or_else(|| state.active_session())
                .unwrap_or_else(|| "default".to_string());
            let state_for_send = state.clone();
            glib::spawn_future_local(async move {
                let params = serde_json::json!({
                    "sessionKey": session_key,
                    "message": text,
                    "idempotencyKey": uuid::Uuid::new_v4().to_string(),
                });
                match gateway.request("chat.send", params).await {
                    Ok(_) => info!("chat.send ok"),
                    Err(e) => {
                        tracing::error!("chat.send: {e}");
                        // Clear the pending indicator on send failure.
                        state_for_send.set_stream_run_id(None);
                    }
                }
            });
        }
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}

/// A single content block pulled from a chat history message.
#[derive(Debug)]
pub(crate) enum Block {
    Text(String),
    Thinking(String),
    ToolUse { name: String, input: String },
    ToolResult(String),
}

/// Split a message `content` field into typed blocks. Accepts both the
/// legacy string form and the standard `[{type, ...}]` array form.
fn extract_blocks(content: Option<&serde_json::Value>) -> Vec<Block> {
    let Some(v) = content else {
        return Vec::new();
    };
    if let Some(s) = v.as_str() {
        return if s.is_empty() {
            Vec::new()
        } else {
            vec![Block::Text(s.to_string())]
        };
    }
    let Some(arr) = v.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(arr.len());
    for part in arr {
        let kind = part.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match kind {
            "text" => {
                if let Some(text) = part.get("text").and_then(|t| t.as_str())
                    && !text.is_empty()
                {
                    out.push(Block::Text(text.to_string()));
                }
            }
            "thinking" => {
                if let Some(text) = part.get("thinking").and_then(|t| t.as_str())
                    && !text.is_empty()
                {
                    out.push(Block::Thinking(text.to_string()));
                }
            }
            "tool_use" => {
                let name = part
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let input = part
                    .get("input")
                    .map(|v| {
                        serde_json::to_string(v).unwrap_or_else(|_| String::from("{}"))
                    })
                    .unwrap_or_default();
                out.push(Block::ToolUse { name, input });
            }
            "tool_result" => {
                // tool_result.content can be a string, or an array of parts.
                let text = extract_plain_text(part.get("content"));
                if !text.is_empty() {
                    out.push(Block::ToolResult(text));
                }
            }
            _ => {}
        }
    }
    out
}

/// Pull plain text from a value that may be a string or
/// `[{type: "text", text: "..."}]` array. Used for tool_result.content.
fn extract_plain_text(v: Option<&serde_json::Value>) -> String {
    let Some(v) = v else {
        return String::new();
    };
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    if let Some(arr) = v.as_array() {
        let mut out = String::new();
        for part in arr {
            if part.get("type").and_then(|t| t.as_str()) == Some("text")
                && let Some(text) = part.get("text").and_then(|t| t.as_str())
            {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text);
            }
        }
        return out;
    }
    String::new()
}

/// Render a single message's blocks into the messages box, respecting the
/// user's show_thinking / show_tools toggles.
fn render_message_blocks(
    messages_box: &gtk4::Box,
    role: &str,
    blocks: &[Block],
    show_thinking: bool,
    show_tools: bool,
) {
    for block in blocks {
        match block {
            Block::Text(text) => {
                let bubble = if role == "assistant" {
                    let markup = markdown::to_pango(text);
                    ChatBubble::new_assistant(&markup, None)
                } else {
                    ChatBubble::new_user(text)
                };
                messages_box.append(&bubble);
            }
            Block::Thinking(text) => {
                if !show_thinking {
                    continue;
                }
                let bubble = build_aux_bubble("🧠 thinking", text, "thinking-bubble");
                messages_box.append(&bubble);
            }
            Block::ToolUse { name, input } => {
                if !show_tools {
                    continue;
                }
                let title = format!("🔧 {name}");
                let bubble = build_aux_bubble(&title, input, "tool-bubble");
                messages_box.append(&bubble);
            }
            Block::ToolResult(text) => {
                if !show_tools {
                    continue;
                }
                let bubble =
                    build_aux_bubble("← tool result", text, "tool-result-bubble");
                messages_box.append(&bubble);
            }
        }
    }
}

/// Build a compact collapsible-looking bubble for auxiliary content
/// (thinking, tool calls). Uses Expander so long bodies don't dominate.
fn build_aux_bubble(title: &str, body: &str, css: &str) -> gtk4::Box {
    let outer = gtk4::Box::builder()
        .orientation(Orientation::Horizontal)
        .halign(gtk4::Align::Start)
        .margin_bottom(2)
        .build();
    let expander = gtk4::Expander::builder()
        .label(title)
        .css_classes(vec!["caption".to_string(), "dim-label".to_string(), css.to_string()])
        .margin_end(48)
        .build();
    let body_label = gtk4::Label::builder()
        .label(body)
        .wrap(true)
        .xalign(0.0)
        .selectable(true)
        .css_classes(vec!["caption".to_string(), "monospace".to_string()])
        .margin_start(8)
        .margin_top(4)
        .margin_bottom(4)
        .build();
    expander.set_child(Some(&body_label));
    outer.append(&expander);
    outer
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_blocks_empty_content() {
        assert!(extract_blocks(None).is_empty());
        assert!(extract_blocks(Some(&json!(null))).is_empty());
        assert!(extract_blocks(Some(&json!(""))).is_empty());
        assert!(extract_blocks(Some(&json!([]))).is_empty());
    }

    #[test]
    fn extract_blocks_legacy_string_content() {
        let blocks = extract_blocks(Some(&json!("hello world")));
        assert_eq!(blocks.len(), 1);
        match &blocks[0] {
            Block::Text(t) => assert_eq!(t, "hello world"),
            _ => panic!("expected Text"),
        }
    }

    #[test]
    fn extract_blocks_text_array() {
        let content = json!([
            {"type": "text", "text": "first"},
            {"type": "text", "text": "second"},
        ]);
        let blocks = extract_blocks(Some(&content));
        assert_eq!(blocks.len(), 2);
        match (&blocks[0], &blocks[1]) {
            (Block::Text(a), Block::Text(b)) => {
                assert_eq!(a, "first");
                assert_eq!(b, "second");
            }
            _ => panic!("expected Text, Text"),
        }
    }

    #[test]
    fn extract_blocks_skips_empty_text() {
        let content = json!([
            {"type": "text", "text": ""},
            {"type": "text", "text": "kept"},
        ]);
        let blocks = extract_blocks(Some(&content));
        assert_eq!(blocks.len(), 1);
    }

    #[test]
    fn extract_blocks_thinking() {
        let content = json!([
            {"type": "thinking", "thinking": "pondering"},
            {"type": "text", "text": "answer"},
        ]);
        let blocks = extract_blocks(Some(&content));
        assert_eq!(blocks.len(), 2);
        match &blocks[0] {
            Block::Thinking(t) => assert_eq!(t, "pondering"),
            _ => panic!("expected Thinking"),
        }
    }

    #[test]
    fn extract_blocks_tool_use_with_input() {
        let content = json!([
            {"type": "tool_use", "name": "read_file", "input": {"path": "/tmp/x"}},
        ]);
        let blocks = extract_blocks(Some(&content));
        assert_eq!(blocks.len(), 1);
        match &blocks[0] {
            Block::ToolUse { name, input } => {
                assert_eq!(name, "read_file");
                assert!(input.contains("\"path\""));
                assert!(input.contains("/tmp/x"));
            }
            _ => panic!("expected ToolUse"),
        }
    }

    #[test]
    fn extract_blocks_tool_use_missing_fields() {
        let content = json!([{"type": "tool_use"}]);
        let blocks = extract_blocks(Some(&content));
        assert_eq!(blocks.len(), 1);
        match &blocks[0] {
            Block::ToolUse { name, input } => {
                assert_eq!(name, "tool");
                assert_eq!(input, "");
            }
            _ => panic!("expected ToolUse"),
        }
    }

    #[test]
    fn extract_blocks_tool_result_string() {
        let content = json!([
            {"type": "tool_result", "content": "42"},
        ]);
        let blocks = extract_blocks(Some(&content));
        assert_eq!(blocks.len(), 1);
        match &blocks[0] {
            Block::ToolResult(t) => assert_eq!(t, "42"),
            _ => panic!("expected ToolResult"),
        }
    }

    #[test]
    fn extract_blocks_tool_result_array() {
        let content = json!([
            {"type": "tool_result", "content": [
                {"type": "text", "text": "line1"},
                {"type": "text", "text": "line2"},
            ]},
        ]);
        let blocks = extract_blocks(Some(&content));
        assert_eq!(blocks.len(), 1);
        match &blocks[0] {
            Block::ToolResult(t) => assert_eq!(t, "line1\nline2"),
            _ => panic!("expected ToolResult"),
        }
    }

    #[test]
    fn extract_blocks_unknown_type_ignored() {
        let content = json!([
            {"type": "text", "text": "keep"},
            {"type": "unknown_block", "data": "drop"},
            {"type": "text", "text": "also keep"},
        ]);
        let blocks = extract_blocks(Some(&content));
        assert_eq!(blocks.len(), 2);
    }

    #[test]
    fn extract_blocks_mixed_realistic() {
        // Roughly what an assistant message with reasoning + tool calls looks like.
        let content = json!([
            {"type": "thinking", "thinking": "Let me check the file"},
            {"type": "tool_use", "name": "read", "input": {"path": "x.md"}},
            {"type": "tool_result", "content": "file contents"},
            {"type": "text", "text": "The file says X"},
        ]);
        let blocks = extract_blocks(Some(&content));
        assert_eq!(blocks.len(), 4);
        assert!(matches!(blocks[0], Block::Thinking(_)));
        assert!(matches!(blocks[1], Block::ToolUse { .. }));
        assert!(matches!(blocks[2], Block::ToolResult(_)));
        assert!(matches!(blocks[3], Block::Text(_)));
    }

    #[test]
    fn extract_plain_text_handles_string_or_array() {
        assert_eq!(extract_plain_text(Some(&json!("direct"))), "direct");
        assert_eq!(
            extract_plain_text(Some(&json!([
                {"type": "text", "text": "a"},
                {"type": "text", "text": "b"},
            ]))),
            "a\nb"
        );
        assert_eq!(extract_plain_text(None), "");
        assert_eq!(extract_plain_text(Some(&json!(42))), "");
    }
}
