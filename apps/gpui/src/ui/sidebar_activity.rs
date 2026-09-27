use crate::model::sidebar_pr;
use gpui_kit::*;
use serde_json::json;

use super::AppView;
use crate::model::{
    chat::now_ms,
    sessions::SessionRow,
    sidebar_activity::{SidebarAttention, session_matches},
};

impl AppView {
    pub(super) fn sync_sidebar_activity(&mut self, cx: &mut Context<Self>) {
        let rows = self
            .rows
            .iter()
            .chain(self.sidebar_state.children.values().flatten())
            .collect::<Vec<_>>();
        let scopes = self.sidebar_state.activity.sync(
            &rows,
            self.chat.selected_session.as_deref(),
            self.sidebar_state.selected_agent.as_deref(),
            self.session.is_some(),
        );
        self.router.set_sidebar_subscriptions(scopes);
        self.pump_subscription(cx);
    }

    pub(super) fn sidebar_attention(&self, row: &SessionRow) -> SidebarAttention {
        let now = now_ms();
        let agent = row.agent().or(self.sidebar_state.selected_agent.as_deref());
        let question = self.router.questions.records.values().any(|question| {
            question.expires_at_ms > now
                && question
                    .agent_id
                    .as_deref()
                    .zip(agent)
                    .is_none_or(|(a, b)| a == b)
                && question
                    .session_key
                    .as_deref()
                    .is_some_and(|key| session_matches(&row.key, key, agent))
        });
        let selected = self
            .chat
            .selected_session
            .as_deref()
            .is_some_and(|key| session_matches(&row.key, key, agent));
        let approval = self.router.has_sidebar_approval(&row.key, agent, now)
            || (selected
                && self
                    .router
                    .approvals
                    .pending
                    .values()
                    .any(|approval| approval.expires_at_ms > now));
        let failed = matches!(row.status.as_deref(), Some("failed" | "timeout"))
            && row
                .last_read_at
                .is_none_or(|read| row.ended_at.or(row.updated_at).unwrap_or_default() > read);
        let agent_attention = row.agent_status.as_ref().is_some_and(|status| {
            status.expires_at > now && status.attention.is_some() && !status.note.trim().is_empty()
        });
        if question {
            SidebarAttention::Question
        } else if approval {
            SidebarAttention::Approval
        } else if agent_attention {
            SidebarAttention::Agent
        } else if failed {
            SidebarAttention::Error
        } else {
            SidebarAttention::None
        }
    }

    pub(super) fn sidebar_subtitle(&self, row: &SessionRow) -> Option<String> {
        self.sidebar_state.activity.subtitle(
            row,
            self.sidebar_attention(row),
            self.sidebar_state.preferences.show_preview,
            self.sidebar_state.preferences.live_activity,
            now_ms(),
        )
    }
}

impl AppView {
    pub(super) fn sync_sidebar_pull_requests(&mut self, cx: &mut Context<Self>) {
        let Some(session) = &self.session else {
            return;
        };
        let advertised = session
            .hello()
            .pointer("/features/methods")
            .and_then(|value| value.as_array())
            .is_some_and(|methods| {
                methods.iter().any(|method| {
                    method.as_str() == Some("controlUi.sessionPullRequests.subscribe")
                })
            });
        if !advertised {
            return;
        }
        let visible = self.sidebar_visible_keys();
        let keys = self
            .rows
            .iter()
            .filter(|row| {
                visible.contains(&row.key)
                    && row.worktree.as_ref().and_then(|v| v.get("id")).is_some()
            })
            .map(|row| sidebar_pr::scoped_key(&row.key, row.agent()))
            .collect();
        if self.sidebar_state.pull_requests.set_watched(keys) {
            let keys = self.sidebar_state.pull_requests.watched_keys();
            self.sidebar_state.pull_request_generation += 1;
            let generation = self.sidebar_state.pull_request_generation;
            self.request(
                "controlUi.sessionPullRequests.subscribe",
                json!({"sessionKeys":keys,"refreshSessionKeys":keys}),
                cx,
                move |this, result, _| {
                    if this.sidebar_state.pull_request_generation != generation {
                        return;
                    }
                    if let Err(error) = result {
                        if this.sidebar_state.pull_requests.watched_keys() == keys {
                            this.sidebar_state.pull_requests.clear();
                        }
                        this.mutation_error(format!(
                            "Could not subscribe to pull requests: {error}"
                        ));
                    }
                },
            );
        }
    }
}
