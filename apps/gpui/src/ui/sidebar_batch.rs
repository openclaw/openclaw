use super::{
    AppView,
    session_menu::MenuTarget,
    theme::{Palette, tokens::space},
};
use crate::{
    gateway::sessions_rpc::{self as rpc, SessionIdentity},
    model::{
        sessions::SessionRow,
        sidebar_batch::{MAX_TARGETS, PatchMany, PatchManyResult, selected_visible_rows},
    },
};
use gpui_kit::{
    component::{
        Sizable, StyledExt, WindowExt,
        button::{Button, ButtonVariants},
        dialog::DialogButtonProps,
        menu::{DropdownMenu, PopupMenu, PopupMenuItem},
        notification::Notification,
    },
    *,
};
use serde_json::{Value, json};
use std::collections::VecDeque;

struct BatchWrite {
    remaining: VecDeque<Vec<(SessionRow, u64)>>,
    patch: Value,
    agent: Option<String>,
    revision: u64,
    successful: Vec<SessionRow>,
    errors: Vec<String>,
}

pub(super) fn batch_menu(
    mut menu: PopupMenu,
    rows: Vec<SessionRow>,
    view: WeakEntity<AppView>,
    cx: &App,
) -> PopupMenu {
    let Some(view) = MenuTarget::new(view, cx) else {
        return menu;
    };
    let count = rows.len();
    let unread = !rows.iter().all(|row| row.unread);
    let archived = !rows.iter().all(|row| row.archived);
    menu = menu.label(format!("{count} conversations selected"));
    for (label, fields) in [
        (
            format!("Mark {count} as {}", if unread { "unread" } else { "read" }),
            json!({"unread":unread}),
        ),
        (
            format!("{} {count}", if archived { "Archive" } else { "Restore" }),
            json!({"archived":archived}),
        ),
    ] {
        let view = view.clone();
        let rows = rows.clone();
        menu = menu.item(PopupMenuItem::new(label).on_click(move |_, _, cx| {
            let _ = view.update(cx, |this, cx| {
                let rows = this.captured_visible_selection(&rows);
                this.patch_session_rows(rows, fields.clone(), cx)
            });
        }));
    }
    let group_view = view.clone();
    let group_rows = rows.clone();
    menu = menu.item(
        PopupMenuItem::new(format!("Move {count} to group…")).on_click(move |_, window, cx| {
            let _ = group_view.update(cx, |this, cx| {
                let rows = this.captured_visible_selection(&group_rows);
                if !rows.is_empty() {
                    this.show_session_group_dialog(rows, window, cx);
                }
            });
        }),
    );
    menu.separator()
        .item(
            PopupMenuItem::new(format!("Delete {count}…")).on_click(move |_, window, cx| {
                let _ = view.update(cx, |this, cx| {
                    let rows = this.captured_visible_selection(&rows);
                    if !rows.is_empty() {
                        this.confirm_delete_rows(rows, window, cx);
                    }
                });
            }),
        )
}

impl AppView {
    pub(super) fn selected_sidebar_rows(&self) -> Vec<SessionRow> {
        selected_visible_rows(
            self.rows
                .iter()
                .chain(self.sidebar_state.children.values().flatten()),
            &self.sidebar_state.selection.keys,
            &self.sidebar_visible_keys(),
        )
    }

    fn captured_visible_selection(&mut self, rows: &[SessionRow]) -> Vec<SessionRow> {
        let rows = selected_visible_rows(
            rows.iter(),
            &self.sidebar_state.selection.keys,
            &self.sidebar_visible_keys(),
        );
        if rows.is_empty() {
            self.mutation_error(
                "The selected conversations are no longer visible. Select them again.".into(),
            );
        }
        rows
    }

    pub(super) fn render_batch_actions(&self, cx: &mut Context<Self>) -> AnyElement {
        let rows = self.selected_sidebar_rows();
        if rows.len() < 2 {
            return div().into_any_element();
        }
        let p = Palette::sidebar(cx);
        let view = cx.entity().downgrade();
        div()
            .h_flex()
            .items_center()
            .gap(space::WIDGET_GAP)
            .px(space::WIDGET_INSET)
            .py(space::WIDGET_GAP)
            .bg(p.accent_subtle)
            .child(
                Button::new("sidebar-batch-actions")
                    .ghost()
                    .small()
                    .label(format!("{} selected ▾", rows.len()))
                    .accessibility_label("Selected conversations actions")
                    .dropdown_menu(move |menu, _, cx| {
                        batch_menu(menu, rows.clone(), view.clone(), cx)
                    }),
            )
            .child(
                Button::new("sidebar-clear-selection")
                    .ghost()
                    .small()
                    .label("Clear")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.sidebar_state.selection.keys.clear();
                        cx.notify();
                    })),
            )
            .into_any_element()
    }

    pub(super) fn patch_session_rows(
        &mut self,
        mut rows: Vec<SessionRow>,
        patch: Value,
        cx: &mut Context<Self>,
    ) {
        if self.session.is_none() {
            self.mutation_error("Reconnect before changing selected conversations.".into());
            return;
        }
        // Archive Undo owns only rows this action actually archived.
        if patch.get("archived").and_then(Value::as_bool) == Some(true) {
            rows.retain(|row| !row.archived);
        }
        if rows.is_empty() {
            return;
        }
        if patch.get("archived").is_some()
            && rows
                .iter()
                .any(|row| row.session_id.as_deref().is_none_or(str::is_empty))
        {
            self.mutation_error(
                "Refresh before changing conversations without durable identities.".into(),
            );
            return;
        }
        self.invalidate_roster_reads();
        let claimed: Vec<_> = rows
            .into_iter()
            .map(|row| {
                let receipt = self.sidebar_state.mutation_receipts.begin(&row.key);
                (row, receipt)
            })
            .collect();
        self.write_next_session_batch(
            BatchWrite {
                remaining: claimed.chunks(MAX_TARGETS).map(<[_]>::to_vec).collect(),
                patch,
                agent: self.sidebar_state.selected_agent.clone(),
                revision: self.sidebar_state.agent_revision,
                successful: Vec::new(),
                errors: Vec::new(),
            },
            cx,
        );
    }

    fn write_next_session_batch(&mut self, mut write: BatchWrite, cx: &mut Context<Self>) {
        if self.sidebar_state.agent_revision != write.revision || self.session.is_none() {
            return;
        }
        let Some(chunk) = write.remaining.pop_front() else {
            if !write.errors.is_empty() {
                self.mutation_error(format!(
                    "{} updated. {}",
                    write.successful.len(),
                    write.errors.join("; ")
                ));
            } else if !write.successful.is_empty() {
                self.sidebar_state.notifications.push(
                    Notification::new()
                        .message(format!("Updated {} conversations", write.successful.len())),
                );
            }
            if write.patch.get("archived").and_then(Value::as_bool) == Some(true)
                && !write.successful.is_empty()
            {
                self.batch_archive_undo(write.successful, cx);
            }
            self.refresh_sessions(cx);
            return;
        };
        let chunk: Vec<_> = chunk
            .into_iter()
            .filter(|(row, generation)| {
                self.sidebar_state
                    .mutation_receipts
                    .current(&row.key, *generation)
            })
            .collect();
        if chunk.is_empty() {
            self.write_next_session_batch(write, cx);
            return;
        }
        let rows: Vec<_> = chunk.iter().map(|(row, _)| row.clone()).collect();
        let params = PatchMany::new(&rows, write.agent.as_deref(), write.patch.clone());
        self.request(
            "sessions.patchMany",
            rpc::params(params),
            cx,
            move |this, result, cx| {
                if this.sidebar_state.agent_revision != write.revision {
                    return;
                }
                match result.and_then(|value| {
                    serde_json::from_value::<PatchManyResult>(value)
                        .map_err(|error| error.to_string())
                }) {
                    Ok(result) => {
                        for (row, generation) in chunk {
                            if !this
                                .sidebar_state
                                .mutation_receipts
                                .current(&row.key, generation)
                            {
                                continue;
                            }
                            let target = SessionIdentity::from_row(&row, write.agent.as_deref());
                            match result.outcome(&target) {
                                Ok(()) => {
                                    let mut fields = write.patch.clone();
                                    if fields.get("archived").and_then(Value::as_bool) == Some(true)
                                    {
                                        fields["pinned"] = json!(false);
                                    }
                                    this.patch_roster_fields(&row, &fields);
                                    this.sidebar_state.selection.keys.remove(&row.key);
                                    write.successful.push(row);
                                }
                                Err(error) => {
                                    write.errors.push(format!("{}: {error}", row.title()))
                                }
                            }
                        }
                    }
                    Err(error) => {
                        write.errors.push(format!(
                            "Batch outcome is uncertain: {error}. Refresh before retrying."
                        ));
                        write.remaining.clear();
                    }
                }
                this.write_next_session_batch(write, cx);
            },
        );
    }

    pub(super) fn patch_roster_fields(&mut self, row: &SessionRow, fields: &Value) {
        for current in self
            .rows
            .iter_mut()
            .chain(self.sidebar_state.children.values_mut().flatten())
            .chain(self.sidebar_state.selected_descriptor.iter_mut())
        {
            if current.key == row.key
                && current.session_id == row.session_id
                && current.agent() == row.agent()
            {
                current.apply_patch(fields);
            }
        }
    }

    fn batch_archive_undo(&mut self, rows: Vec<SessionRow>, cx: &mut Context<Self>) {
        let epoch = self.epoch;
        let view = cx.entity().downgrade();
        self.sidebar_state.notifications.push(
            Notification::new()
                .message(format!("Archived {} conversations", rows.len()))
                .action(move |_, _, cx| {
                    let rows = rows.clone();
                    let view = view.clone();
                    Button::new("undo-batch-archive")
                        .ghost()
                        .label("Undo")
                        .on_click(cx.listener(move |note, _, window, cx| {
                            let _ = view.update(cx, |this, cx| {
                                if this.epoch != epoch {
                                    this.mutation_error(
                                    "Connection changed. Refresh before restoring conversations."
                                        .into(),
                                );
                                    return;
                                }
                                for row in &rows {
                                    this.patch_session(
                                        row.clone(),
                                        json!({"archived":false,"pinned":row.pinned}),
                                        cx,
                                    );
                                }
                            });
                            note.dismiss(window, cx);
                        }))
                }),
        );
    }

    pub(super) fn confirm_delete_rows(
        &mut self,
        rows: Vec<SessionRow>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let view = cx.entity().downgrade();
        let epoch = self.epoch;
        let revision = self.sidebar_state.agent_revision;
        window.open_alert_dialog(cx, move |dialog, _, _| {
            let view = view.clone();
            let rows = rows.clone();
            dialog.confirm().title(format!("Delete {} conversations?", rows.len()))
                .description("This permanently deletes the selected conversations and their transcripts. This cannot be undone.")
                .button_props(DialogButtonProps::default().ok_text("Delete conversations").cancel_text("Cancel").show_cancel(true))
                .on_ok(move |_, _, cx| {
                    let _ = view.update(cx, |this, cx| {
                        if this.epoch != epoch || this.sidebar_state.agent_revision != revision {
                            this.mutation_error("Connection or agent changed. Select the conversations again.".into());
                            return;
                        }
                        for row in &rows { this.delete_session(row.clone(), cx); }
                    });
                    true
                })
        });
    }
}
