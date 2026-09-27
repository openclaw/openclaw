use super::*;

impl ChatState {
    pub fn begin_send_with_attachments(
        &mut self,
        id: String,
        text: String,
        attachments: Vec<Attachment>,
    ) -> Option<RequestScope> {
        let scope = self.scope()?;
        if text.trim().is_empty() && attachments.is_empty() {
            return None;
        }
        self.messages.push(Message {
            role: "user".into(),
            text,
            attachments,
            send_id: Some(id.clone()),
            run_id: Some(id.clone()),
            pending: true,
            timestamp: Some(now_ms()),
            ..Default::default()
        });
        if self.active_run.is_none() {
            self.turn_recap = None;
            self.clear_stream();
            self.active_run = Some(id);
            self.started_at = Some(now_ms());
            self.phase_label = "Working".into();
        }
        self.note = None;
        self.error_detail = None;
        self.revision += 1;
        Some(scope)
    }
    pub fn send_ack(&mut self, scope: &RequestScope, id: &str, payload: &Value) -> bool {
        if !self.is_current(scope) || self.completed_runs.iter().any(|run| run == id) {
            return false;
        }
        let Some((index, message)) = self
            .messages
            .iter_mut()
            .enumerate()
            .find(|(_, m)| m.send_id.as_deref() == Some(id))
        else {
            return false;
        };
        self.dirty_from = Some(self.dirty_from.map_or(index, |old| old.min(index)));
        message.pending = false;
        message.send_error = None;
        if self.active_run.as_deref() == Some(id)
            && let Some(run) = payload.get("runId").and_then(Value::as_str)
        {
            self.active_run = Some(run.to_owned());
        }
        true
    }
    pub fn send_failed(&mut self, scope: &RequestScope, id: &str, error: String) -> bool {
        if !self.is_current(scope) {
            return false;
        }
        let Some((index, message)) = self
            .messages
            .iter_mut()
            .enumerate()
            .find(|(_, m)| m.send_id.as_deref() == Some(id))
        else {
            return false;
        };
        self.dirty_from = Some(self.dirty_from.map_or(index, |old| old.min(index)));
        message.pending = false;
        message.send_error = Some(error.clone());
        self.note = Some(ChatNote {
            text: error,
            error: true,
        });
        if self.active_run.as_deref() == Some(id) && self.sequence.is_none() {
            self.active_run = None;
        }
        self.revision += 1;
        true
    }
    pub fn restore_pending_messages(&mut self, messages: Vec<Message>) -> bool {
        let first = self.messages.len();
        for message in messages {
            if message.role == "user"
                && message.send_id.is_some()
                && (message.pending || message.send_error.is_some())
                && !self.messages.iter().any(|held| held.same_message(&message))
            {
                self.messages.push(message);
            }
        }
        if self.messages.len() == first {
            return false;
        }
        self.dirty_from = Some(self.dirty_from.map_or(first, |old| old.min(first)));
        self.revision += 1;
        true
    }
    pub fn discard_send(&mut self, id: &str) {
        self.dirty_from = self
            .messages
            .iter()
            .position(|message| message.send_id.as_deref() == Some(id));
        self.messages.retain(|m| m.send_id.as_deref() != Some(id));
        self.revision += 1;
    }
    pub fn retry_send(&mut self, id: &str) {
        if let Some((index, message)) = self
            .messages
            .iter_mut()
            .enumerate()
            .find(|(_, m)| m.send_id.as_deref() == Some(id))
        {
            self.dirty_from = Some(self.dirty_from.map_or(index, |old| old.min(index)));
            message.pending = true;
            message.send_error = None;
        }
        self.note = None;
    }
}
