use gpui_kit::*;

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
