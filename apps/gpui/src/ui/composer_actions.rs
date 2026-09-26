mod attachments;

use super::{AppView, composer_state::PendingSend};
use crate::{
    gateway::composer_rpc::{
        CatalogScope, ChatSend, CommandsList, CommandsResult, commands_session_missing,
    },
    model::{
        attachments::{Attachment, AttachmentLimits, AttachmentOrigin, large_paste},
        commands::matching,
        composer::Draft,
        model_controls::ModelControlsTarget,
    },
};
use gpui_kit::{
    component::input::{InputEvent, RopeExt},
    *,
};
use std::path::PathBuf;

impl AppView {
    fn composer_attachment_target(
        &self,
        scope: &Option<crate::model::chat::RequestScope>,
        draft: Option<u64>,
    ) -> bool {
        match draft {
            Some(generation) => {
                self.new_session.active
                    && self.new_session.generation == generation
                    && !self.new_session.locked()
            }
            None => {
                !self.new_session.active
                    && scope
                        .as_ref()
                        .is_some_and(|scope| self.chat.is_current(scope))
            }
        }
    }
    pub(super) fn composer_save_draft(&mut self, cx: &App) {
        if self.new_session.active {
            self.new_session.message = self.composer.read(cx).value().to_string();
            self.new_session.attachments = self.composer_state.attachments.clone();
            return;
        }
        self.composer_state.drafts.save(Draft {
            text: self.composer.read(cx).value().to_string(),
            attachments: self.composer_state.attachments.clone(),
            reply: self.composer_state.reply.clone(),
        });
    }

    pub(super) fn composer_begin_connection(
        &mut self,
        gateway: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.composer_save_draft(cx);
        self.new_session.bind_gateway(gateway);
        self.new_session.active = false;
        self.new_session.submitting = false;
        self.new_session.generation += 1;
        self.new_session.picker = None;
        self.composer_capabilities.reset();
        self.composer_state.drafts.bind_gateway(gateway);
        self.composer_state.restore_pending = true;
        self.composer_state.attachment_generation += 1;
        self.composer_state.catalog_generation += 1;
        self.composer_state.reading = 0;
        self.composer_state.error = None;
        self.composer_state.set_attachments(Vec::new());
        self.composer_state.reply = None;
        self.composer_state.commands.clear();
        self.model_controls.reset_connection();
        self.composer_state.catalog_cache.clear();
        self.composer_state.close_popups();
        self.model_controls.close_popups();
        self.composer_state.recall.reset();
        for pending in self.composer_state.pending.values_mut() {
            pending.in_flight = false;
        }
        self.composer
            .update(cx, |state, cx| state.set_value("", window, cx));
    }

    pub(super) fn composer_restore_if_pending(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.composer_state.restore_pending
            && self.session.is_some()
            && self.chat.selected_session.is_some()
        {
            self.composer_restore_draft(window, cx);
        }
    }

    pub(super) fn composer_restore_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.update(cx, |input, cx| {
            input.set_placeholder("Message OpenClaw", window, cx)
        });
        let draft = self
            .chat
            .selected_session
            .as_ref()
            .map(|key| {
                self.composer_state
                    .drafts
                    .select(key, self.chat.selected_agent.as_deref())
            })
            .unwrap_or_default();
        self.composer_state.restore_pending = false;
        self.composer_state.attachment_generation += 1;
        self.composer_state.reading = 0;
        self.composer_state.error = None;
        self.composer_state.close_popups();
        self.model_controls.close_popups();
        self.composer_state.recall.reset();
        self.composer_state.set_attachments(draft.attachments);
        self.composer_state.reply = draft.reply;
        self.composer
            .update(cx, |state, cx| state.set_value(draft.text, window, cx));
    }

    pub(super) fn composer_history_loaded(&mut self, _cx: &mut Context<Self>) {
        if let Some(scope) = self.chat.scope() {
            let pending = self
                .composer_state
                .pending
                .values()
                .filter(|pending| {
                    Some(pending.gateway.as_str()) == self.composer_state.drafts.gateway()
                        && pending.scope.session_key == scope.session_key
                        && pending.scope.agent_id == scope.agent_id
                })
                .map(|pending| {
                    let mut message = pending.optimistic.clone();
                    message.pending = pending.in_flight;
                    if !message.pending && message.send_error.is_none() {
                        message.send_error = Some(
                            "Delivery was not confirmed. Retry safely uses the original request."
                                .into(),
                        );
                    }
                    message
                })
                .collect();
            if self.chat.restore_pending_messages(pending) {
                self.sync_transcript();
            }
        }
        self.composer_state.recall.seed(
            self.chat
                .messages
                .iter()
                .filter(|message| message.role == "user")
                .map(|message| message.text.clone()),
        );
    }

    pub(super) fn load_composer_catalogs(&mut self, cx: &mut Context<Self>) {
        let Some(scope) = self.chat.scope() else {
            return;
        };
        let agent = scope.agent_id.clone();
        self.set_model_controls_target(
            ModelControlsTarget {
                agent_id: agent
                    .clone()
                    .or_else(|| self.sidebar_state.selected_agent.clone())
                    .unwrap_or_else(|| "main".into()),
                session_key: Some(scope.session_key.clone()),
                draft_id: None,
            },
            cx,
        );
        self.load_composer_commands(cx);
    }

    pub(super) fn composer_commands_scope(&self) -> Option<CatalogScope> {
        if self.new_session.active {
            return None;
        }
        let scope = self.chat.scope()?;
        Some(CatalogScope::for_session(
            scope.session_key,
            scope.agent_id,
            self.chat.session_info.session_id.as_deref().or_else(|| {
                self.selected_row()
                    .filter(|row| row.agent() == self.chat.selected_agent.as_deref())
                    .and_then(|row| row.session_id.as_deref())
            }),
        ))
    }

    pub(super) fn refresh_composer_commands(
        &mut self,
        previous: Option<CatalogScope>,
        cx: &mut Context<Self>,
    ) {
        if previous != self.composer_commands_scope() {
            self.load_composer_commands(cx);
        }
    }

    fn load_composer_commands(&mut self, cx: &mut Context<Self>) {
        let Some(context) = self.composer_commands_scope() else {
            return;
        };
        self.composer_state
            .catalog_cache
            .retain(|(epoch, _), _| *epoch == self.epoch);
        self.composer_state.catalog_generation += 1;
        let generation = self.composer_state.catalog_generation;
        let cache_key = (self.epoch, context.clone());
        if let Some(commands) = self.composer_state.catalog_cache.get(&cache_key) {
            self.composer_state.commands = commands.clone();
            return;
        }
        let agent_scope = CatalogScope {
            session_key: None,
            agent_id: context.agent_id.clone(),
        };
        self.composer_state.commands = self
            .composer_state
            .catalog_cache
            .get(&(self.epoch, agent_scope))
            .cloned()
            .unwrap_or_default();
        self.request_composer_commands(context, generation, cx);
    }

    fn request_composer_commands(
        &mut self,
        context: CatalogScope,
        generation: u64,
        cx: &mut Context<Self>,
    ) {
        let Some(command_scope) = self.chat.scope() else {
            return;
        };
        let params = CommandsList {
            context: context.clone(),
            scope: "text",
            include_args: true,
        };
        let command_cache_key = (self.epoch, context.clone());
        self.request(
            "commands.list",
            serde_json::to_value(params).expect("serialize command scope"),
            cx,
            move |this, result, cx| {
                if this.new_session.active
                    || !this.chat.is_current(&command_scope)
                    || this.sidebar_state.selected_agent != context.agent_id
                    || this.composer_state.catalog_generation != generation
                {
                    return;
                }
                match result.and_then(|value| {
                    serde_json::from_value::<CommandsResult>(value)
                        .map_err(|error| error.to_string())
                }) {
                    Ok(result) => {
                        this.composer_state.commands = result.commands.clone();
                        this.composer_state
                            .catalog_cache
                            .insert(command_cache_key, result.commands);
                    }
                    Err(error)
                        if context.session_key.is_some() && commands_session_missing(&error) =>
                    {
                        this.request_composer_commands(
                            CatalogScope {
                                session_key: None,
                                ..context
                            },
                            generation,
                            cx,
                        );
                    }
                    // Like the web composer, retain available commands when metadata fails.
                    Err(_) => {}
                }
            },
        );
    }

    pub(super) fn composer_event(
        &mut self,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            InputEvent::Change => {
                self.composer_state.slash_dismissed = false;
                self.composer_state.slash_index = 0;
                self.composer_state.recall.reset();
                self.composer_save_draft(cx);
            }
            InputEvent::PressEnter { shift: false, .. } => {
                if self.composer_state.suppress_enter {
                    self.composer_state.suppress_enter = false;
                } else if !self.composer_is_composing(window, cx) {
                    self.send(window, cx);
                }
            }
            _ => {}
        }
        cx.notify();
    }

    fn composer_is_composing(&self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.composer.update(cx, |state, cx| {
            state.marked_text_range(window, cx).is_some()
        })
    }

    pub(super) fn composer_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.composer.focus_handle(cx).is_focused(window) {
            return;
        }
        let key = event.keystroke.key.as_str();
        if self.composer_is_composing(window, cx) {
            if key == "enter" {
                self.composer_state.suppress_enter = true;
            }
            return;
        }
        if key == "enter" && event.is_held {
            window.prevent_default();
            cx.stop_propagation();
            return;
        }
        if key == "enter" {
            self.composer_state.suppress_enter = false;
        }
        let modifiers = event.keystroke.modifiers;
        if modifiers.platform || modifiers.control || modifiers.alt || modifiers.shift {
            return;
        }
        let text = self.composer.read(cx).value().to_string();
        let count = if self.composer_state.slash_dismissed {
            0
        } else {
            matching(&self.composer_state.commands, &text).len()
        };
        if count > 0
            && matches!(
                key,
                "up" | "down" | "home" | "end" | "tab" | "enter" | "escape"
            )
        {
            match key {
                "up" => {
                    self.composer_state.slash_index =
                        self.composer_state.slash_index.saturating_sub(1)
                }
                "down" => {
                    self.composer_state.slash_index =
                        (self.composer_state.slash_index + 1).min(count - 1)
                }
                "home" => self.composer_state.slash_index = 0,
                "end" => self.composer_state.slash_index = count - 1,
                "escape" => self.composer_state.slash_dismissed = true,
                "tab" | "enter" => {
                    self.choose_slash(self.composer_state.slash_index, key == "enter", window, cx)
                }
                _ => {}
            }
            window.prevent_default();
            cx.stop_propagation();
            cx.notify();
            return;
        }
        if key == "escape" {
            if self.model_controls.model_open
                || self.model_controls.effort_open
                || self.composer_state.usage_open
            {
                self.composer_state.close_popups();
                self.model_controls.close_popups();
            } else {
                self.stop(cx);
            }
            window.prevent_default();
            cx.stop_propagation();
            cx.notify();
            return;
        }
        if !self.chat.loading {
            let next = match key {
                "up" => self
                    .composer_state
                    .recall
                    .up(&text, self.composer.read(cx).selected_range() == (0..0)),
                "down" => self.composer_state.recall.down(),
                _ => None,
            };
            if let Some(next) = next {
                self.composer.update(cx, |state, cx| {
                    state.set_value(next, window, cx);
                    let end = state.text().offset_to_position(state.text().len());
                    state.set_cursor_position(end, window, cx);
                });
                window.prevent_default();
                cx.stop_propagation();
                cx.notify();
            }
        }
    }

    pub(super) fn choose_slash(
        &mut self,
        index: usize,
        execute: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = self.composer.read(cx).value();
        let Some(command) = matching(&self.composer_state.commands, &text)
            .get(index)
            .cloned()
            .cloned()
        else {
            return;
        };
        let value = format!(
            "/{}{}",
            command.name.trim_start_matches('/'),
            if command.accepts_args { " " } else { "" }
        );
        self.composer.update(cx, |state, cx| {
            state.set_value(value, window, cx);
            let end = state.text().offset_to_position(state.text().len());
            state.set_cursor_position(end, window, cx);
        });
        self.composer_state.slash_dismissed = true;
        if execute && !command.accepts_args {
            self.send(window, cx);
        }
    }

    pub(super) fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.new_session.active {
            if !self.composer_is_composing(window, cx) {
                self.submit_new_session(cx);
            }
            return;
        }
        if self.session.is_none()
            || self.chat.loading
            || self.model_controls.pending
            || self.composer_state.reading > 0
            || self.composer_is_composing(window, cx)
        {
            return;
        }
        let message = self.composer.read(cx).value().to_string();
        let attachments = self.composer_state.attachments.clone();
        if message.trim().is_empty() && attachments.is_empty() {
            return;
        }
        let reply = self.composer_state.reply.clone();
        let message = match &reply {
            Some(reply) if reply.id.is_none() => format!(
                "{}\n\n{message}",
                reply
                    .text
                    .lines()
                    .map(|line| format!("> {line}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
            _ => message,
        };
        let run_id = uuid::Uuid::new_v4().to_string();
        let Some(gateway) = self.composer_state.drafts.gateway().map(str::to_owned) else {
            return;
        };
        let row = self.selected_row();
        let session_id = self
            .chat
            .session_info
            .session_id
            .clone()
            .or_else(|| row.and_then(|row| row.session_id.clone()));
        let queue_mode = if self.chat.active_run.is_some()
            && self
                .chat
                .session_info
                .effective_queue_mode
                .as_deref()
                .or_else(|| row.and_then(|row| row.effective_queue_mode.as_deref()))
                == Some("steer")
        {
            Some("steer".to_owned())
        } else {
            None
        };
        let Some(scope) = self.chat.begin_send_with_attachments(
            run_id.clone(),
            message.clone(),
            attachments.clone(),
        ) else {
            return;
        };
        if let Some(message) = self.chat.messages.last_mut() {
            message.reply_to = reply.as_ref().and_then(|reply| reply.id.clone());
            message.reply_preview = reply.clone();
        }
        let optimistic = self
            .chat
            .messages
            .last()
            .expect("begin_send inserts an optimistic message")
            .clone();
        let request = ChatSend {
            session_key: scope.session_key.clone(),
            agent_id: scope.agent_id.clone(),
            session_id,
            message: message.clone(),
            deliver: false,
            idempotency_key: run_id.clone(),
            attachments: attachments.iter().map(Attachment::encoded).collect(),
            queue_mode,
            reply_to_id: reply.and_then(|reply| reply.id),
        };
        self.composer_state.recall.record(message);
        self.composer_state.recall.reset();
        self.composer_state.set_attachments(Vec::new());
        self.composer_state.reply = None;
        self.composer_state.error = None;
        self.composer_state.close_popups();
        self.model_controls.close_popups();
        self.composer
            .update(cx, |state, cx| state.set_value("", window, cx));
        self.composer_save_draft(cx);
        self.composer_state.pending.insert(
            run_id.clone(),
            PendingSend {
                gateway,
                scope,
                request,
                optimistic,
                in_flight: false,
            },
        );
        self.transcript_list.set_follow_mode(FollowMode::Tail);
        self.retry_send(&run_id, cx);
    }

    pub(super) fn retry_send(&mut self, id: impl AsRef<str>, cx: &mut Context<Self>) {
        let id = id.as_ref();
        let Some(current_scope) = self.chat.scope() else {
            return;
        };
        let Some(pending) = self.composer_state.pending.get_mut(id) else {
            return;
        };
        if pending.in_flight
            || self.session.is_none()
            || Some(pending.gateway.as_str()) != self.composer_state.drafts.gateway()
            || pending.scope.session_key != current_scope.session_key
            || pending.scope.agent_id != current_scope.agent_id
        {
            return;
        }
        pending.scope = current_scope;
        pending.in_flight = true;
        pending.optimistic.send_error = None;
        let scope = pending.scope.clone();
        let run_id = id.to_owned();
        let agent = pending.request.agent_id.clone();
        let params = serde_json::to_value(&pending.request).expect("serialize chat request");
        self.chat.retry_send(id);
        self.request("chat.send", params, cx, move |this, result, _| {
            if let Some(pending) = this.composer_state.pending.get_mut(&run_id) {
                pending.in_flight = false;
                if let Err(error) = &result {
                    pending.optimistic.send_error = Some(error.clone());
                }
            }
            if result.is_ok() {
                this.composer_state.pending.remove(&run_id);
            }
            if !this.chat.is_current(&scope) || this.sidebar_state.selected_agent != agent {
                return;
            }
            match result {
                Ok(payload) => {
                    this.chat.send_ack(&scope, &run_id, &payload);
                }
                Err(error) => {
                    this.chat.send_failed(&scope, &run_id, error);
                }
            }
            this.sync_transcript();
        });
        self.sync_transcript();
        cx.notify();
    }

    pub(super) fn discard_send(&mut self, id: impl AsRef<str>, cx: &mut Context<Self>) {
        let id = id.as_ref();
        if self
            .composer_state
            .pending
            .get(id)
            .is_some_and(|pending| pending.in_flight)
        {
            return;
        }
        self.composer_state.pending.remove(id);
        self.chat.discard_send(id);
        self.sync_transcript();
        cx.notify();
    }
}
