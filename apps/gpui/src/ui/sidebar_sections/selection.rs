use super::*;

impl AppView {
    pub(in crate::ui) fn toggle_sidebar_section(&mut self, key: &str, cx: &mut Context<Self>) {
        if !self
            .sidebar_state
            .preferences
            .collapsed_sections
            .remove(key)
        {
            self.sidebar_state
                .preferences
                .collapsed_sections
                .insert(key.to_owned());
        }
        self.sidebar_state.preference_revision += 1;
        self.persist_sidebar_preferences(cx);
        self.sync_sidebar_pull_requests(cx);
        self.refresh_sidebar_avatars(cx);
        cx.notify();
    }
    pub(in crate::ui) fn sidebar_visible_keys(&self) -> Vec<String> {
        let mut result = Vec::new();
        let groups: Vec<_> = if self.sidebar_state.preferences.all_agents {
            self.sidebar_state
                .agents
                .iter()
                .map(|agent| {
                    let rows = self
                        .rows
                        .iter()
                        .filter(|row| row.agent() == Some(&agent.id))
                        .cloned()
                        .collect::<Vec<_>>();
                    (
                        format!("agent:{}", agent.id),
                        format!("agent:{}:{}", agent.id, self.sidebar_state.main_key),
                        rows,
                    )
                })
                .collect()
        } else {
            vec![(String::new(), self.agent_home(), self.rows.clone())]
        };
        for (scope, main, rows) in groups {
            if !scope.is_empty()
                && self
                    .sidebar_state
                    .preferences
                    .collapsed_sections
                    .contains(&scope)
            {
                continue;
            }
            for section in self.projected_sections(&rows, &main) {
                let key = if scope.is_empty() {
                    section.id.clone()
                } else {
                    format!("{scope}/{}", section.id)
                };
                if section.render_header
                    && self
                        .sidebar_state
                        .preferences
                        .collapsed_sections
                        .contains(&key)
                {
                    continue;
                }
                let limit = self
                    .sidebar_state
                    .section_limits
                    .get(&key)
                    .copied()
                    .unwrap_or(SECTION_PAGE_SIZE);
                result.extend(
                    sidebar::page_rows(&section, limit, self.chat.selected_session.as_deref())
                        .iter()
                        .map(|row| row.key.clone()),
                );
            }
        }
        result
    }
    pub(in crate::ui) fn sidebar_row_click(
        &mut self,
        key: String,
        event: &ClickEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let modifiers = event.modifiers();
        let visible = self.sidebar_visible_keys();
        if modifiers.shift && visible.contains(&key) {
            self.sidebar_state.selection.extend(
                &visible,
                &key,
                self.chat.selected_session.as_deref(),
            );
        } else if modifiers.platform && visible.contains(&key) {
            self.sidebar_state.selection.toggle(&key);
        } else {
            self.sidebar_state.selection.clear();
            self.sidebar_state.selection.anchor = Some(key.clone());
            if self.sidebar_state.preferences.all_agents {
                self.sidebar_state.selected_agent = self
                    .rows
                    .iter()
                    .find(|row| row.key == key)
                    .and_then(|row| row.agent().map(str::to_owned));
            }
            self.select_session(key, window, cx);
        }
        self.sidebar_state.list_focus.focus(window, cx);
        cx.notify();
    }
}
