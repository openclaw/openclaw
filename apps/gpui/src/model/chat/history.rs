use super::*;

impl ChatState {
    pub fn history_claim(&self) -> Option<(RequestScope, u64)> {
        Some((self.scope()?, self.history_request))
    }

    pub fn begin_history(&mut self) -> Option<HistoryRequest> {
        self.begin_history_page(None)
    }
    pub fn begin_older(&mut self) -> Option<HistoryRequest> {
        if self.history_pending || !self.has_more {
            return None;
        }
        if self.history_offset_dirty {
            let mut request = self.begin_history_page(None)?;
            request.cursor = None;
            request.startup = false;
            request.rebase_offset = true;
            self.loading = false;
            self.loading_older = true;
            return Some(request);
        }
        self.begin_history_page(Some(self.next_offset?))
    }
    fn begin_history_page(&mut self, offset: Option<usize>) -> Option<HistoryRequest> {
        let scope = self.scope()?;
        self.history_request = self.history_request.wrapping_add(1);
        self.history_pending = true;
        self.loading = offset.is_none() && !self.loaded;
        self.loading_older = offset.is_some();
        self.history_error = None;
        Some(HistoryRequest {
            scope,
            offset,
            cursor: offset
                .is_none()
                .then(|| self.delta_cursor.clone())
                .flatten(),
            startup: offset.is_none() && !self.startup_loaded,
            rebase_offset: false,
            request: self.history_request,
            revision: self.revision,
            message_count: self.messages.len(),
        })
    }
    pub fn apply_history(&mut self, request: &HistoryRequest, payload: &Value) -> bool {
        if !self.is_current(&request.scope) || request.request != self.history_request {
            return false;
        }
        let Ok(payload) = serde_json::from_value::<HistoryPayload>(payload.clone()) else {
            return self.history_failed(request, "Gateway returned invalid chat history".into());
        };
        if payload.kind.as_deref() == Some("reset") {
            if request.cursor.is_none() {
                return self
                    .history_failed(request, "Gateway reset a non-cursor history request".into());
            }
            self.delta_cursor = None;
            self.replace_history = true;
            self.loading = false;
            self.loading_older = false;
            self.history_pending = false;
            return true;
        }
        let delta = payload.kind.as_deref() == Some("delta");
        let session_id = payload
            .session_info
            .as_ref()
            .and_then(|info| info.session_id.as_ref())
            .or(payload.session_id.as_ref());
        let identity_changed = self
            .session_info
            .session_id
            .as_ref()
            .zip(session_id)
            .is_some_and(|(old, new)| old != new);
        if request.rebase_offset {
            self.loading_older = false;
            self.history_pending = false;
            if !identity_changed
                && let Some((previous, total)) = self.history_total.zip(payload.total_messages)
                && total >= previous
            {
                self.next_offset = self.next_offset.map(|offset| offset + total - previous);
                self.history_total = Some(total);
                self.history_offset_dirty = false;
            } else {
                self.delta_cursor = None;
                self.replace_history = true;
            }
            return true;
        }
        if (delta || request.offset.is_some()) && identity_changed {
            self.delta_cursor = None;
            self.replace_history = true;
            self.loading = false;
            self.loading_older = false;
            self.history_pending = false;
            return true;
        }
        if delta && (request.cursor.is_none() || payload.delta_cursor.is_none()) {
            return self
                .history_failed(request, "Gateway returned an unscoped history delta".into());
        }
        let Some(values) = payload.messages else {
            return self.history_failed(request, "Gateway returned invalid chat history".into());
        };
        let replacement = self.replace_history || identity_changed;
        if replacement {
            self.clear_stream();
            self.active_run = None;
            self.completed_runs.clear();
            self.messages.clear();
            self.turn_recap = None;
            self.note = None;
        }
        let mut messages: Vec<_> = values
            .iter()
            .filter_map(|value| {
                if delta {
                    delta_message(value, &request.scope, session_id.map(String::as_str))
                } else {
                    Message::from_value(value)
                }
            })
            .filter(Message::visible)
            .collect();
        for tool in messages.iter_mut().flat_map(|message| &mut message.tools) {
            tool.receipt = request.revision;
        }
        let mut current_tools = self
            .messages
            .iter()
            .flat_map(|message| message.tools.iter().cloned())
            .collect();
        pair_history(&mut messages);
        if delta {
            let mut held = std::mem::take(&mut self.messages);
            for message in messages {
                if let Some(index) = held.iter().position(|old| old.same_message(&message)) {
                    if held[index] != message {
                        held[index] = message;
                        self.dirty_from = Some(self.dirty_from.map_or(index, |old| old.min(index)));
                    }
                } else {
                    held.push(message);
                }
            }
            // Delta cursors include hidden raw records that may have no message
            // envelope. Rebase offset against an authoritative raw count only
            // when the reader actually asks for an older page.
            self.history_offset_dirty |= self.has_more && payload.delta_cursor != request.cursor;
            messages = held;
        } else if request.offset.is_some() {
            messages.retain(|message| !self.messages.iter().any(|held| held.same_message(message)));
            messages.append(&mut self.messages);
        }
        if request.offset.is_none() && self.revision != request.revision && !replacement {
            reconcile_live_history(&mut messages, &mut current_tools);
            let live = &self.messages[request.message_count.min(self.messages.len())..];
            for message in live {
                if !messages.iter().any(|held| held.same_message(message)) {
                    messages.push(message.clone());
                }
            }
        } else if request.offset.is_none() {
            let run = payload
                .in_flight_run
                .as_ref()
                .filter(|run| !self.completed_runs.contains(&run.run_id));
            if self.active_run.as_deref() != run.map(|run| run.run_id.as_str()) || run.is_none() {
                self.clear_stream();
            }
            if run.is_some() && self.active_run.as_deref() != run.map(|run| run.run_id.as_str()) {
                self.turn_recap = None;
            }
            self.active_run = run.map(|run| run.run_id.clone());
            self.stream_text = run.map(|run| run.text.clone()).unwrap_or_default();
            self.started_at = run.and_then(|run| run.started_at);
            self.sequence = None;
        }
        // Unconfirmed input belongs to this client until an authoritative match arrives.
        for pending in &self.messages {
            if pending.send_id.is_some() && !messages.iter().any(|held| held.same_message(pending))
            {
                messages.push(pending.clone());
            }
        }
        pair_history(&mut messages);
        self.messages = messages;
        if !delta {
            self.has_more = payload.has_more;
            self.next_offset = payload.next_offset;
            self.history_total = payload.total_messages;
            self.history_offset_dirty = false;
            self.dirty_from = Some(0);
        }
        if request.offset.is_none() {
            self.delta_cursor = payload.delta_cursor;
        }
        if let Some(id) = payload.session_id {
            self.session_info.session_id = Some(id);
        }
        if let Some(info) = payload.session_info {
            self.session_info = info;
        }
        if let Some(run) = payload
            .in_flight_run
            .filter(|run| self.active_run.as_deref() == Some(&run.run_id))
        {
            for event in run.events {
                self.apply_agent_event(&event);
            }
        }
        reconcile_live_history(&mut self.messages, &mut self.live_tools);
        pair_history(&mut self.messages);
        settle_history_tools(&mut self.messages, self.active_run.as_deref());
        self.loading = false;
        self.loading_older = false;
        self.history_pending = false;
        self.history_error = None;
        self.loaded = true;
        self.startup_loaded |= request.startup;
        self.replace_history = false;
        if replacement {
            self.generation = self.generation.wrapping_add(1);
        }
        true
    }
    pub fn history_failed(&mut self, request: &HistoryRequest, error: String) -> bool {
        if !self.is_current(&request.scope) || request.request != self.history_request {
            return false;
        }
        self.loading = false;
        self.loading_older = false;
        self.history_pending = false;
        self.history_error = Some(error);
        true
    }

    pub fn needs_history_replacement(&self) -> bool {
        self.replace_history && !self.history_pending && self.history_error.is_none()
    }
}

fn delta_message(value: &Value, scope: &RequestScope, session_id: Option<&str>) -> Option<Message> {
    if value
        .get("sessionKey")
        .and_then(Value::as_str)
        .is_some_and(|key| key != scope.session_key)
        || value
            .get("agentId")
            .and_then(Value::as_str)
            .zip(scope.agent_id.as_deref())
            .is_some_and(|(a, b)| a != b)
        || value
            .get("sessionId")
            .and_then(Value::as_str)
            .zip(session_id)
            .is_some_and(|(a, b)| a != b)
    {
        return None;
    }
    let mut message = Message::from_value(value.get("message")?)?;
    if message.id.is_none() {
        message.id = value
            .get("messageId")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    if message.run_id.is_none() {
        message.run_id = value
            .get("runId")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    Some(message)
}
