use super::{
    AppView,
    theme::{
        Palette,
        tokens::{dialog, space},
    },
};
use crate::model::sessions::SessionRow;
use gpui_kit::{
    component::{
        Sizable, StyledExt, WindowExt,
        button::{Button, ButtonVariants},
        dialog::DialogButtonProps,
        input::{Input, InputState},
    },
    *,
};
use serde_json::{Value, json};

impl AppView {
    pub(super) fn show_session_group_dialog(
        &mut self,
        rows: Vec<SessionRow>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let initial = rows
            .first()
            .and_then(|row| row.category.clone())
            .unwrap_or_default();
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .default_value(initial)
                .placeholder("Group name")
        });
        let view = cx.entity().downgrade();
        let epoch = self.epoch;
        let revision = self.sidebar_state.agent_revision;
        window.open_dialog(cx, move |dialog, _, _| {
            let view = view.clone();
            let rows = rows.clone();
            let input_ok = input.clone();
            dialog
                .title("Move to group")
                .child("Enter an existing or new group name. Leave blank to remove from the group.")
                .child(Input::new(&input).aria_label("Group name"))
                .button_props(
                    DialogButtonProps::default()
                        .ok_text("Move")
                        .show_cancel(true),
                )
                .on_ok(move |_, _, cx| {
                    let name = input_ok.read(cx).value().trim().to_owned();
                    let _ = view.update(cx, |this, cx| {
                        if this.epoch != epoch || this.sidebar_state.agent_revision != revision {
                            this.mutation_error(
                                "Connection or agent changed. Open the group action again.".into(),
                            );
                            return;
                        }
                        this.move_session_rows(
                            rows.clone(),
                            (!name.is_empty()).then_some(name),
                            cx,
                        );
                    });
                    true
                })
        });
    }

    pub(super) fn move_session_rows(
        &mut self,
        rows: Vec<SessionRow>,
        category: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.session.is_none() {
            self.mutation_error("Reconnect before moving conversations.".into());
            return;
        }
        let Some(name) = category else {
            self.patch_organization_rows(rows, json!({"category":null}), cx);
            return;
        };
        let revision = self.sidebar_state.agent_revision;
        self.request(
            "sessions.groups.list",
            json!({}),
            cx,
            move |this, result, cx| {
                if this.sidebar_state.agent_revision != revision {
                    return;
                }
                let mut names = match result.and_then(group_names) {
                    Ok(names) => names,
                    Err(error) => {
                        this.mutation_error(format!("Could not load groups: {error}"));
                        return;
                    }
                };
                if names.contains(&name) {
                    this.patch_organization_rows(rows, json!({"category":name}), cx);
                    return;
                }
                names.push(name.clone());
                this.request(
                    "sessions.groups.put",
                    json!({"names":names}),
                    cx,
                    move |this, result, cx| {
                        if this.sidebar_state.agent_revision != revision {
                            return;
                        }
                        match result.and_then(group_names) {
                            Ok(names) => {
                                this.sidebar_state.preferences.known_groups = names;
                                this.patch_organization_rows(rows, json!({"category":name}), cx);
                            }
                            Err(error) => {
                                this.mutation_error(format!("Could not create group: {error}"))
                            }
                        }
                    },
                );
            },
        );
    }

    fn patch_organization_rows(
        &mut self,
        rows: Vec<SessionRow>,
        fields: Value,
        cx: &mut Context<Self>,
    ) {
        if rows.len() == 1 {
            self.patch_session(rows.into_iter().next().expect("one row"), fields, cx);
        } else {
            self.patch_session_rows(rows, fields, cx);
        }
    }

    pub(super) fn show_session_icon_dialog(
        &mut self,
        row: SessionRow,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .default_value(row.icon.clone().unwrap_or_default())
                .placeholder("Emoji, named icon, or SVG data URL")
        });
        let view = cx.entity().downgrade();
        let epoch = self.epoch;
        window.open_dialog(cx, move |dialog, _, _| {
            let mut colors = div().h_flex().flex_wrap().gap(space::WIDGET_GAP);
            for color in ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"] {
                let view = view.clone();
                let row = row.clone();
                colors = colors.child(Button::new(color).ghost().small().label(color).on_click(move |_, _, cx| {
                    let _ = view.update(cx, |this, cx| {
                        if this.epoch == epoch {
                            this.patch_session(row.clone(), json!({"color":color}), cx);
                        } else { this.mutation_error("Connection changed. Open appearance again.".into()); }
                    });
                }));
            }
            let input_ok = input.clone();
            let row = row.clone();
            let view = view.clone();
            dialog.title("Icon & color")
                .child(colors)
                .child("Choose an emoji, a named icon, or an SVG data URL. Leave blank for the default.")
                .child(Input::new(&input).aria_label("Custom session icon"))
                .button_props(DialogButtonProps::default().ok_text("Set icon").show_cancel(true))
                .on_ok(move |_, _, cx| {
                    let icon = input_ok.read(cx).value().trim().to_owned();
                    let _ = view.update(cx, |this, cx| {
                        if this.epoch != epoch { this.mutation_error("Connection changed. Open the icon action again.".into()); return; }
                        this.patch_session(row.clone(), json!({"icon":(!icon.is_empty()).then_some(icon)}), cx);
                    });
                    true
                })
        });
    }

    pub(super) fn show_session_owner_dialog(
        &mut self,
        row: SessionRow,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.session.is_none() {
            self.mutation_error("Reconnect before assigning a conversation.".into());
            return;
        }
        let mut owners: Vec<OwnerChoice> = self
            .sidebar_state
            .agents
            .iter()
            .map(|agent| OwnerChoice {
                kind: "agent",
                id: agent.id.clone(),
                label: agent.name().to_owned(),
            })
            .collect();
        if let Some(owner) = row.owner.as_ref().and_then(|value| value.get("actor"))
            && owner.get("type").and_then(Value::as_str) == Some("human")
            && let Some(id) = owner
                .pointer("/identity/id")
                .or_else(|| owner.get("id"))
                .and_then(Value::as_str)
        {
            owners.push(OwnerChoice {
                kind: "human",
                id: id.into(),
                label: owner
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .into(),
            });
        }
        let view = cx.entity().downgrade();
        let picker = cx.new(|_| OwnerPicker {
            view,
            row: row.clone(),
            epoch: self.epoch,
            revision: self.sidebar_state.agent_revision,
            owners: owners.clone(),
            loading: true,
            error: None,
        });
        let shown = picker.clone();
        window.open_dialog(cx, move |dialog, _, _| {
            dialog.title("Assign conversation to…").child(shown.clone())
        });
        self.request("users.list", json!({}), cx, move |_, result, cx| {
            picker.update(cx, |picker, cx| {
                picker.loading = false;
                match result {
                    Ok(value) => {
                        if let Some(profiles) = value.get("profiles").and_then(Value::as_array) {
                            picker.owners.retain(|owner| owner.kind == "agent");
                            picker.owners.extend(
                                profiles
                                    .iter()
                                    .filter(|profile| {
                                        profile.get("mergedInto").is_none_or(Value::is_null)
                                    })
                                    .filter_map(|profile| {
                                        let id = profile.get("id")?.as_str()?;
                                        let label = profile
                                            .get("displayName")
                                            .and_then(Value::as_str)
                                            .filter(|name| !name.trim().is_empty())
                                            .or_else(|| {
                                                profile
                                                    .pointer("/githubIdentity/login")
                                                    .and_then(Value::as_str)
                                            })
                                            .or_else(|| {
                                                profile.pointer("/emails/0").and_then(Value::as_str)
                                            })
                                            .unwrap_or(id);
                                        Some(OwnerChoice {
                                            kind: "human",
                                            id: id.into(),
                                            label: label.into(),
                                        })
                                    }),
                            );
                            picker.owners.sort_by(|a, b| {
                                a.kind.cmp(b.kind).then_with(|| {
                                    a.label.to_lowercase().cmp(&b.label.to_lowercase())
                                })
                            });
                        } else {
                            picker.error =
                                Some("Gateway did not return the user directory.".into());
                        }
                    }
                    Err(error) => {
                        picker.error = Some(format!(
                            "Could not load users: {error}. Close and reopen to retry."
                        ))
                    }
                }
                cx.notify();
            });
        });
    }

    fn assign_session_owner(
        &mut self,
        row: SessionRow,
        owner: OwnerChoice,
        cx: &mut Context<Self>,
    ) {
        if self.session.is_none() {
            self.mutation_error("Reconnect before assigning a conversation.".into());
            return;
        }
        if self
            .rows
            .iter()
            .chain(self.sidebar_state.children.values().flatten())
            .any(|current| current.key == row.key && current.session_id != row.session_id)
        {
            self.mutation_error("This conversation was replaced. Open assignment again.".into());
            return;
        }
        let revision = self.sidebar_state.agent_revision;
        let generation = self.sidebar_state.mutation_receipts.begin(&row.key);
        let mut params = json!({"key":row.key,"owner":{"type":owner.kind,"id":owner.id}});
        if let Some(agent) = row.agent().or(self.sidebar_state.selected_agent.as_deref()) {
            params["agentId"] = json!(agent);
        }
        self.request(
            "sessions.assignOwner",
            params,
            cx,
            move |this, result, cx| {
                if this.sidebar_state.agent_revision != revision
                    || !this
                        .sidebar_state
                        .mutation_receipts
                        .current(&row.key, generation)
                {
                    return;
                }
                match result {
                    Ok(value) if value.get("owner").is_some() => {
                        this.patch_roster_fields(&row, &json!({"owner":value["owner"]}));
                        this.refresh_sessions(cx);
                    }
                    Ok(_) => {
                        this.mutation_error("Gateway did not return the updated owner.".into())
                    }
                    Err(error) => this.mutation_error(format!("Could not assign owner: {error}")),
                }
            },
        );
    }
}

fn group_names(value: Value) -> Result<Vec<String>, String> {
    value
        .get("groups")
        .and_then(Value::as_array)
        .ok_or_else(|| "Gateway did not return the group catalog.".to_owned())?
        .iter()
        .map(|group| {
            group
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| "Gateway returned an invalid group name.".to_owned())
        })
        .collect()
}

#[derive(Clone)]
struct OwnerChoice {
    kind: &'static str,
    id: String,
    label: String,
}

struct OwnerPicker {
    view: WeakEntity<AppView>,
    row: SessionRow,
    epoch: u64,
    revision: u64,
    owners: Vec<OwnerChoice>,
    loading: bool,
    error: Option<String>,
}

impl Render for OwnerPicker {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Palette::get(cx);
        let mut body = div()
            .id("session-owner-options")
            .v_flex()
            .gap(space::WIDGET_GAP)
            .max_h(dialog::OWNER_OPTIONS_MAX_HEIGHT)
            .overflow_y_scroll();
        if self.loading {
            body = body.child("Loading people…");
        }
        if let Some(error) = &self.error {
            body = body.child(div().text_color(p.danger).child(error.clone()));
        }
        for owner in &self.owners {
            let view = self.view.clone();
            let row = self.row.clone();
            let owner = owner.clone();
            let epoch = self.epoch;
            let revision = self.revision;
            body = body.child(
                Button::new(SharedString::from(format!(
                    "owner:{}:{}",
                    owner.kind, owner.id
                )))
                .ghost()
                .small()
                .label(format!(
                    "{}{}",
                    owner.label,
                    if owner.kind == "agent" {
                        " · Agent"
                    } else {
                        ""
                    }
                ))
                .on_click(move |_, window, cx| {
                    let _ = view.update(cx, |this, cx| {
                        if this.epoch != epoch || this.sidebar_state.agent_revision != revision {
                            this.mutation_error(
                                "Connection or agent changed. Open assignment again.".into(),
                            );
                            return;
                        }
                        this.assign_session_owner(row.clone(), owner.clone(), cx);
                    });
                    window.close_dialog(cx);
                }),
            );
        }
        body
    }
}
