use super::AppView;
use crate::model::{session_export::TranscriptExport, session_menu, sessions::SessionRow};
use gpui_kit::{component::notification::Notification, *};
use serde_json::json;

impl AppView {
    pub(super) fn copy_session_markdown(&mut self, row: SessionRow, cx: &mut Context<Self>) {
        if let Some(reason) = session_menu::disabled_reason(
            session_menu::MenuAction::CopyMarkdown,
            &row,
            self.session.as_ref().map(|session| session.hello()),
            &self.agent_home(),
        ) {
            self.mutation_error(reason);
            cx.notify();
            return;
        }
        let agent = row
            .agent()
            .map(str::to_owned)
            .or_else(|| self.sidebar_state.selected_agent.clone());
        let assistant = self
            .sidebar_state
            .agents
            .iter()
            .find(|entry| Some(&entry.id) == agent.as_ref())
            .and_then(|entry| entry.name.clone())
            .unwrap_or_else(|| "OpenClaw".into());
        self.copy_session_markdown_page(
            row,
            agent,
            assistant,
            TranscriptExport::default(),
            false,
            cx,
        );
    }

    fn copy_session_markdown_page(
        &mut self,
        row: SessionRow,
        agent: Option<String>,
        assistant: String,
        mut export: TranscriptExport,
        verify_tail: bool,
        cx: &mut Context<Self>,
    ) {
        let epoch = self.epoch;
        let revision = self.sidebar_state.agent_revision;
        self.request(
            "chat.history",
            json!({
                "sessionKey": row.key,
                "agentId": agent,
                "limit": if verify_tail { 1 } else { 1000 },
                "maxChars": 500_000,
                "offset": if verify_tail { 0 } else { export.offset() },
            }),
            cx,
            move |this, result, cx| {
                let current = this.epoch == epoch
                    && this.session.is_some()
                    && this.sidebar_state.agent_revision == revision
                    && this
                        .rows
                        .iter()
                        .chain(this.sidebar_state.children.values().flatten())
                        .chain(this.sidebar_state.selected_descriptor.iter())
                        .filter(|candidate| candidate.key == row.key)
                        .all(|candidate| candidate.session_id == row.session_id);
                let result = result.and_then(|page| {
                    if !current {
                        return Err(TranscriptExport::CHANGED.into());
                    }
                    if verify_tail {
                        export.verify_tail(&page)?;
                        Ok(false)
                    } else {
                        export.append(page, row.session_id.as_deref())
                    }
                });
                match result {
                    Err(error) => this.mutation_error(error),
                    Ok(true) => {
                        this.copy_session_markdown_page(row, agent, assistant, export, false, cx)
                    }
                    Ok(false) if !verify_tail && export.needs_tail_verification() => {
                        this.copy_session_markdown_page(row, agent, assistant, export, true, cx);
                    }
                    Ok(false) => match export.markdown(&assistant) {
                        Some(markdown) => {
                            cx.write_to_clipboard(ClipboardItem::new_string(markdown));
                            this.sidebar_state
                                .notifications
                                .push(Notification::new().message("Copied"));
                        }
                        None => this.mutation_error("No messages to export.".into()),
                    },
                }
            },
        );
    }
}
