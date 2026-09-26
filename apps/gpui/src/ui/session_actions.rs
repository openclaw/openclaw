use super::AppView;
use crate::{
    gateway::sessions_rpc::{
        self as rpc, CreateParams, Created, DeleteParams, PatchParams, SessionIdentity,
    },
    model::sessions::{SessionRow, order_rows},
};
use gpui_kit::{
    component::{
        WindowExt,
        button::{Button, ButtonVariants},
        dialog::DialogButtonProps,
        notification::{Notification, NotificationType},
    },
    *,
};
use serde_json::{Value, json};

pub(super) use super::session_menu::{SessionMenuShortcut, session_menu};

impl AppView {
    pub(super) fn mutation_error(&mut self, error: String) {
        self.sidebar_state.notifications.push(
            Notification::new()
                .with_type(NotificationType::Error)
                .message(error),
        );
    }
    pub(super) fn begin_rename(
        &mut self,
        row: SessionRow,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.sidebar_state.rename_input.update(cx, |input, cx| {
            input.set_value(row.label.clone().unwrap_or_else(|| row.title()), window, cx);
            input.focus(window, cx);
        });
        self.sidebar_state.rename_in_header = false;
        self.sidebar_state.rename_row = Some(row);
        cx.notify();
    }
    pub(super) fn commit_rename(&mut self, cx: &mut Context<Self>) {
        let Some(row) = self.sidebar_state.rename_row.take() else {
            return;
        };
        let label = self
            .sidebar_state
            .rename_input
            .read(cx)
            .value()
            .trim()
            .to_owned();
        self.patch_session(
            row,
            json!({"label":if label.is_empty() {None} else {Some(label)}}),
            cx,
        );
    }
    pub(super) fn patch_session(&mut self, row: SessionRow, fields: Value, cx: &mut Context<Self>) {
        self.patch_session_then(row, fields, cx, |_, _, _| {});
    }
    fn patch_session_then(
        &mut self,
        row: SessionRow,
        fields: Value,
        cx: &mut Context<Self>,
        done: impl FnOnce(&mut Self, SessionRow, &mut Context<Self>) + 'static,
    ) {
        self.patch_session_receipt(row, fields, cx, move |this, result, cx| {
            if let Ok(row) = result {
                done(this, row, cx);
            }
        });
    }

    pub(super) fn patch_composer_settings(
        &mut self,
        fields: Value,
        cx: &mut Context<Self>,
        done: impl FnOnce(&mut Self, Result<(), String>, &mut Context<Self>) + 'static,
    ) {
        if self.new_session.active {
            self.patch_draft_settings(&fields, cx);
            done(self, Ok(()), cx);
        } else if let Some(row) = self.selected_row().cloned() {
            self.patch_session_receipt(row, fields, cx, move |this, result, cx| {
                done(this, result.map(|_| ()), cx);
            });
        } else {
            done(self, Err("The session is still loading.".into()), cx);
        }
    }

    fn patch_session_receipt(
        &mut self,
        row: SessionRow,
        fields: Value,
        cx: &mut Context<Self>,
        done: impl FnOnce(&mut Self, Result<SessionRow, String>, &mut Context<Self>) + 'static,
    ) {
        if self.session.is_none() {
            self.mutation_error("Reconnect before changing this session.".into());
            done(
                self,
                Err("Reconnect before changing this session.".into()),
                cx,
            );
            return;
        }
        if fields.get("archived").is_some() && row.session_id.as_deref().is_none_or(str::is_empty) {
            self.mutation_error(
                "Refresh before changing a session without a durable identity.".into(),
            );
            return;
        }
        if fields.get("pinned").and_then(Value::as_bool) == Some(true)
            && (row.archived || !row.can_pin(&self.agent_home()))
        {
            self.mutation_error("Only active root conversations can be pinned.".into());
            return;
        }
        let agent = self.sidebar_state.selected_agent.clone();
        let revision = self.sidebar_state.agent_revision;
        self.invalidate_roster_reads();
        let generation = self.sidebar_state.mutation_receipts.begin(&row.key);
        let previous = serde_json::to_value(&row).expect("session rows serialize");
        let rollback: Value = fields
            .as_object()
            .into_iter()
            .flat_map(|fields| fields.keys())
            .map(|key| (key.clone(), previous[key].clone()))
            .collect();
        self.patch_roster_fields(&row, &fields);
        let identity = SessionIdentity::from_row(&row, agent.as_deref());
        self.request(
            "sessions.patch",
            rpc::params(PatchParams { identity, fields }),
            cx,
            move |this, result, cx| {
                if this.sidebar_state.agent_revision != revision
                    || !this
                        .sidebar_state
                        .mutation_receipts
                        .current(&row.key, generation)
                {
                    done(
                        this,
                        Err("Session settings changed; refresh and retry.".into()),
                        cx,
                    );
                    return;
                }
                match result {
                    Ok(_) => {
                        done(this, Ok(row), cx);
                        if this.sidebar_state.selected_agent == agent {
                            this.refresh_sessions(cx);
                        }
                    }
                    Err(error) => {
                        if this.sidebar_state.selected_agent == agent {
                            for current in this
                                .rows
                                .iter_mut()
                                .chain(this.sidebar_state.children.values_mut().flatten())
                                .chain(this.sidebar_state.selected_descriptor.iter_mut())
                            {
                                if current.key == row.key && current.session_id == row.session_id {
                                    current.apply_patch(&rollback);
                                }
                            }
                            order_rows(&mut this.rows);
                        }
                        this.mutation_error(format!("Could not update session: {error}"));
                        done(this, Err(error), cx);
                        this.refresh_sessions(cx);
                    }
                }
            },
        );
        cx.notify();
    }
    pub(super) fn archive_session(&mut self, row: SessionRow, cx: &mut Context<Self>) {
        if row.archived {
            self.patch_session(row, json!({"archived":false}), cx);
            return;
        }
        let view = cx.entity().downgrade();
        let epoch = self.epoch;
        self.patch_session_then(row, json!({"archived":true,"pinned":false}), cx, move |this, row, _| {
            let note = Notification::new().message("Conversation archived").action(move |_, _, cx| {
                let row = row.clone();
                let view = view.clone();
                Button::new("undo-archive").ghost().label("Undo").on_click(cx.listener(move |note, _, window, cx| {
                    let _ = view.update(cx, |this, cx| {
                        if this.epoch != epoch {
                            this.mutation_error("Reconnect changed the session scope. Refresh before restoring.".into());
                            return;
                        }
                        this.patch_session(row.clone(), json!({"archived":false,"pinned":row.pinned}), cx);
                    });
                    note.dismiss(window, cx);
                }))
            });
            this.sidebar_state.notifications.push(note);
        });
    }
    pub(super) fn new_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_new_session(window, cx);
    }
    pub(super) fn fork_session(&mut self, row: SessionRow, cx: &mut Context<Self>) {
        self.create_session(
            CreateParams {
                agent_id: row
                    .agent()
                    .map(str::to_owned)
                    .or_else(|| self.sidebar_state.selected_agent.clone()),
                parent_session_key: Some(row.key.clone()),
                fork: Some(true),
                fork_from: if row.running() {
                    Some("last-completed")
                } else {
                    None
                },
            },
            cx,
        );
    }
    fn create_session(&mut self, params: CreateParams, cx: &mut Context<Self>) {
        if self.session.is_none() {
            self.mutation_error("Reconnect before creating a conversation.".into());
            return;
        }
        self.sidebar_state.create_generation += 1;
        let generation = self.sidebar_state.create_generation;
        let agent = self.sidebar_state.selected_agent.clone();
        let source = self.chat.scope();
        let revision = self.sidebar_state.agent_revision;
        self.request(
            "sessions.create",
            rpc::params(params),
            cx,
            move |this, result, cx| {
                if this.sidebar_state.create_generation != generation
                    || this.sidebar_state.agent_revision != revision
                    || this.sidebar_state.selected_agent != agent
                {
                    return;
                }
                match result.and_then(|value| {
                    serde_json::from_value::<Created>(value).map_err(|error| error.to_string())
                }) {
                    Ok(created) if !created.key.is_empty() => {
                        if this.chat.scope() == source {
                            this.queue_session_selection(created.key);
                        }
                        this.refresh_sessions(cx);
                    }
                    Ok(_) => this
                        .mutation_error("Gateway did not return the created session key.".into()),
                    Err(error) => {
                        this.mutation_error(format!("Could not create conversation: {error}"))
                    }
                }
            },
        );
    }
    pub(super) fn confirm_delete(
        &mut self,
        row: SessionRow,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let view = cx.entity().downgrade();
        let epoch = self.epoch;
        let title = format!("Delete “{}”?", row.title());
        window.open_alert_dialog(cx,move|dialog,_,_| {
            let view=view.clone();
            let row=row.clone();
            dialog.confirm().title(title.clone()).description("This permanently deletes this conversation and its transcript. This cannot be undone.")
                .button_props(DialogButtonProps::default().ok_text("Delete conversation").cancel_text("Cancel").show_cancel(true))
                .on_ok(move|_,_,cx| {
                    let _=view.update(cx,|this,cx| {if this.epoch==epoch {this.delete_session(row.clone(),cx);}});
                    true
                })
        });
    }
    pub(super) fn delete_session(&mut self, row: SessionRow, cx: &mut Context<Self>) {
        let source = self.chat.scope();
        // operator.write may delete only an archived row; the Gateway rechecks identity at both writes.
        self.patch_session_then(
            row,
            json!({"archived":true,"pinned":false}),
            cx,
            move |this, row, cx| {
                let agent = this.sidebar_state.selected_agent.clone();
                let identity = SessionIdentity::from_row(&row, agent.as_deref());
                this.request(
                    "sessions.delete",
                    rpc::params(DeleteParams {
                        identity,
                        delete_transcript: true,
                        archived_only: true,
                    }),
                    cx,
                    move |this, result, cx| match result {
                        Ok(_) => {
                            this.rows.retain(|candidate| candidate.key != row.key);
                            for children in this.sidebar_state.children.values_mut() {
                                children.retain(|candidate| candidate.key != row.key);
                            }
                            if this.chat.scope() == source
                                && source
                                    .as_ref()
                                    .is_some_and(|scope| scope.session_key == row.key)
                                && this.sidebar_state.selected_agent == agent
                            {
                                this.queue_session_selection(this.agent_home());
                            }
                            this.sidebar_state
                                .notifications
                                .push(Notification::new().message("Conversation deleted"));
                            this.refresh_sessions(cx);
                        }
                        Err(error) => this.mutation_error(format!(
                            "Conversation was archived, but deletion failed: {error}"
                        )),
                    },
                );
            },
        );
    }
}
