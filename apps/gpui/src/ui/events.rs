use gpui_kit::*;
use serde_json::{Value, json};

use super::AppView;
use crate::gateway::attention_rpc::QuestionList;

impl AppView {
    pub(super) fn sync_subscription(&mut self, cx: &mut Context<Self>) {
        self.router.select(
            self.chat.selected_agent.clone(),
            self.chat.selected_session.clone(),
        );
        self.sync_sidebar_activity(cx);
    }

    pub(super) fn pump_subscription(&mut self, cx: &mut Context<Self>) {
        if self.session.is_none() {
            return;
        }
        let Some(request) = self.router.next_subscription() else {
            return;
        };
        self.request(
            request.method,
            request.params.clone(),
            cx,
            move |this, result, cx| {
                if this.router.finish_subscription(&request, &result) {
                    this.update_attention_badges();
                    this.pump_subscription(cx);
                }
            },
        );
    }

    pub(super) fn read_questions(&mut self, cx: &mut Context<Self>) {
        let revision = self.router.questions.revision();
        self.request(
            "question.list",
            json!({}),
            cx,
            move |this, result, _| match result.and_then(|value| {
                serde_json::from_value::<QuestionList>(value).map_err(|error| error.to_string())
            }) {
                Ok(snapshot) => {
                    this.router
                        .questions
                        .replace_snapshot(revision, snapshot.questions);
                    this.update_attention_badges();
                }
                Err(error) => {
                    this.router.error = Some(format!("Could not load questions: {error}"))
                }
            },
        );
    }

    pub(super) fn escape(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.new_session.picker.is_some() {
            self.new_session.picker = None;
        } else if self.composer_capabilities.plus_open || self.composer_capabilities.permission_open
        {
            self.composer_capabilities.plus_open = false;
            self.composer_capabilities.permission_open = false;
        } else if self.web.picker_open {
            self.web.picker_open = false;
        } else if self.sidebar_state.palette_open {
            self.close_palette(window, cx);
        } else if self.sidebar_state.rename_row.is_some() {
            self.sidebar_state.rename_row = None;
        } else if self.model_controls.model_open
            || self.model_controls.effort_open
            || self.composer_state.usage_open
            || !self.composer_state.slash_dismissed
                && self.composer.read(cx).value().starts_with('/')
        {
            self.composer_state.close_popups();
            self.model_controls.close_popups();
        } else if self.web.settings_open {
            self.close_settings(window, cx);
        } else {
            self.stop(cx);
        }
        cx.notify();
    }
}

impl AppView {
    pub(super) fn sync_viewer_presence(&mut self, cx: &mut Context<Self>) {
        let Some(session) = &self.session else {
            self.viewer_presence = None;
            self.viewer_request = false;
            return;
        };
        if self.viewer_request {
            return;
        }
        if !session
            .hello()
            .pointer("/features/methods")
            .and_then(Value::as_array)
            .is_some_and(|methods| {
                methods
                    .iter()
                    .any(|method| method.as_str() == Some("sessions.viewers.set"))
            })
        {
            return;
        }
        let keys: Vec<_> =
            if self.web.settings_open || self.show_connect_form || self.new_session.active {
                Vec::new()
            } else {
                self.chat.selected_session.iter().cloned().collect()
            };
        let mut params = json!({"sessionKeys": keys});
        if keys.iter().any(|key| !key.starts_with("agent:"))
            && let Some(agent) = &self.chat.selected_agent
        {
            params["agentId"] = json!(agent);
        }
        let signature = params.to_string();
        if self.viewer_presence.as_ref() == Some(&(self.epoch, signature.clone())) {
            return;
        }
        self.viewer_request = true;
        let epoch = self.epoch;
        self.request(
            "sessions.viewers.set",
            params,
            cx,
            move |this, result, _| {
                this.viewer_request = false;
                this.viewer_presence = Some((epoch, signature));
                if let Err(error) = result {
                    this.mutation_error(format!(
                        "Could not update viewing presence: {error}. Refresh to retry."
                    ));
                }
            },
        );
    }
}
