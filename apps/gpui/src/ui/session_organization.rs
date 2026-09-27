use super::components::action_menu::{ActionMenu as PopupMenu, ActionMenuItem as PopupMenuItem};
use super::{
    AppView,
    session_menu::MenuTarget,
    theme::{
        Palette,
        tokens::{TypographyExt, menu as tokens, text},
    },
};
use crate::model::{
    avatars::{self, AvatarSpec},
    people::{Person, PersonIdentity},
    session_menu::{MenuAction, disabled_reason},
    sessions::SessionRow,
};
use gpui_kit::{
    component::{
        Disableable, Sizable, StyledExt, WindowExt,
        button::{Button, ButtonVariants},
        dialog::DialogButtonProps,
        input::{Input, InputEvent, InputState},
    },
    *,
};
use serde_json::{Value, json};
use std::{cell::RefCell, rc::Rc};

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
        for row in &rows {
            if let Some(reason) = crate::model::session_menu::disabled_reason(
                crate::model::session_menu::MenuAction::Group,
                row,
                self.session.as_ref().map(|session| session.hello()),
                &self.agent_home(),
            ) {
                self.mutation_error(reason);
                return;
            }
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
                for row in &rows {
                    if let Some(reason) = crate::model::session_menu::disabled_reason(
                        crate::model::session_menu::MenuAction::NewGroup,
                        row,
                        this.session.as_ref().map(|session| session.hello()),
                        &this.agent_home(),
                    ) {
                        this.mutation_error(reason);
                        return;
                    }
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

    fn assign_session_owner(
        &mut self,
        row: SessionRow,
        owner: OwnerChoice,
        cx: &mut Context<Self>,
    ) {
        if let Some(reason) = disabled_reason(
            MenuAction::Owner,
            &row,
            self.session.as_ref().map(|session| session.hello()),
            &self.agent_home(),
        ) {
            self.mutation_error(reason);
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
    avatar: AvatarSpec,
    is_self: bool,
}

struct OwnerMenu {
    row: SessionRow,
    target: MenuTarget,
    owners: Vec<OwnerChoice>,
    input: Entity<InputState>,
    page: usize,
    generation: u64,
    loading: bool,
    error: Option<String>,
    _search: Option<Subscription>,
    _avatars: Option<Subscription>,
    avatar_lease: Option<Rc<Vec<AvatarSpec>>>,
}

type OwnerMenuState = Rc<RefCell<OwnerMenu>>;
const PEOPLE_PAGE_SIZE: usize = 20;

pub(super) fn session_owner_menu(
    menu: PopupMenu,
    row: SessionRow,
    target: MenuTarget,
    window: &mut Window,
    cx: &mut Context<PopupMenu>,
) -> PopupMenu {
    let Some(entity) = target.view.upgrade() else {
        return menu;
    };
    let app = entity.read(cx);
    if let Some(reason) = crate::model::session_menu::disabled_reason(
        crate::model::session_menu::MenuAction::Owner,
        &row,
        app.session.as_ref().map(|session| session.hello()),
        &app.agent_home(),
    ) {
        return menu.item(PopupMenuItem::new(reason).disabled(true));
    }
    let gateway = app
        .web
        .auth
        .as_ref()
        .map(|auth| auth.gateway_url.as_str())
        .unwrap_or("");
    let mut owners: Vec<_> = app
        .sidebar_state
        .agents
        .iter()
        .map(|agent| OwnerChoice {
            kind: "agent",
            id: agent.id.clone(),
            label: agent.name().to_owned(),
            avatar: avatars::agent_avatar(
                &agent.id,
                agent.identity.avatar.as_deref(),
                agent.identity.avatar_url.as_deref(),
                agent.identity.emoji.as_deref(),
                gateway,
            ),
            is_self: false,
        })
        .collect();
    if let Some(person) = app.sidebar_state.people.self_user.clone() {
        owners.push(person_choice(person, true, gateway));
    }
    if let Some(actor) = row.owner.as_ref().and_then(|owner| owner.get("actor"))
        && actor.get("type").and_then(Value::as_str) == Some("human")
        && let Some(person) = Person::from_actor(actor)
        && !owners
            .iter()
            .any(|owner| owner.kind == "human" && owner.id == person.id)
    {
        owners.push(person_choice(person, false, gateway));
    }
    sort_owners(&mut owners);
    let input = cx.new(|cx| InputState::new(window, cx).placeholder("Search people and agents…"));
    let state = Rc::new(RefCell::new(OwnerMenu {
        row,
        target,
        owners,
        input: input.clone(),
        page: 0,
        generation: 0,
        loading: true,
        error: None,
        _search: None,
        _avatars: Some(cx.observe(&entity, |_, _, cx| cx.notify())),
        avatar_lease: None,
    }));
    let weak_state = Rc::downgrade(&state);
    let subscription = cx.subscribe_in(&input, window, move |menu, _, event, window, cx| {
        if matches!(event, InputEvent::Change)
            && let Some(state) = weak_state.upgrade()
        {
            state.borrow_mut().page = 0;
            menu.rebuild(window, cx, move |menu, _, cx| owner_items(menu, state, cx));
        }
    });
    state.borrow_mut()._search = Some(subscription);
    load_owners(
        state.clone(),
        window.window_handle(),
        cx.entity().downgrade(),
        cx,
    );
    owner_items(menu, state, cx)
}

fn person_choice(mut person: Person, is_self: bool, gateway: &str) -> OwnerChoice {
    person.identity = Some(PersonIdentity {
        kind: "profile".into(),
        id: person.id.clone(),
    });
    OwnerChoice {
        kind: "human",
        id: person.id.clone(),
        label: person.label().to_owned(),
        avatar: avatars::person_avatar(&person, gateway),
        is_self,
    }
}

fn sort_owners(owners: &mut [OwnerChoice]) {
    owners.sort_by(|a, b| {
        b.is_self
            .cmp(&a.is_self)
            .then_with(|| a.kind.cmp(b.kind))
            .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
}

fn load_owners(
    state: OwnerMenuState,
    window: AnyWindowHandle,
    menu: WeakEntity<PopupMenu>,
    cx: &mut App,
) {
    let target = state.borrow().target.clone();
    let generation = {
        let mut state = state.borrow_mut();
        state.generation += 1;
        state.loading = true;
        state.error = None;
        state.generation
    };
    // The submenu owns this request; closing it or changing connection/agent retires the reply.
    cx.defer(move |cx| {
        let _ = target.update(cx, |app, cx| {
            let revision = app.sidebar_state.agent_revision;
            app.request("users.list", json!({}), cx, move |app, result, cx| {
                if app.sidebar_state.agent_revision != revision
                    || menu.upgrade().is_none()
                    || state.borrow().generation != generation
                {
                    return;
                }
                {
                    let mut state = state.borrow_mut();
                    state.loading = false;
                    let gateway = app
                        .web
                        .auth
                        .as_ref()
                        .map(|auth| auth.gateway_url.as_str())
                        .unwrap_or("");
                    match result {
                        Ok(value) => {
                            if let Some(profiles) = value.get("profiles").and_then(Value::as_array)
                            {
                                state
                                    .owners
                                    .retain(|owner| owner.kind == "agent" || owner.is_self);
                                let self_id = state
                                    .owners
                                    .iter()
                                    .find(|owner| owner.is_self)
                                    .map(|owner| owner.id.clone());
                                state.owners.extend(
                                    profiles
                                        .iter()
                                        .filter(|profile| {
                                            profile.get("mergedInto").is_none_or(Value::is_null)
                                        })
                                        .filter_map(|profile| {
                                            let id = profile.get("id")?.as_str()?;
                                            if self_id.as_deref() == Some(id) {
                                                return None;
                                            }
                                            let label = profile
                                                .get("displayName")
                                                .and_then(Value::as_str)
                                                .map(str::trim)
                                                .filter(|name| !name.is_empty())
                                                .or_else(|| {
                                                    profile
                                                        .pointer("/githubIdentity/login")
                                                        .and_then(Value::as_str)
                                                })
                                                .or_else(|| {
                                                    profile
                                                        .pointer("/emails/0")
                                                        .and_then(Value::as_str)
                                                })
                                                .unwrap_or(id);
                                            Some(person_choice(
                                                Person {
                                                    id: id.into(),
                                                    name: Some(label.into()),
                                                    avatar_url: Some(format!(
                                                        "/api/users/{}/avatar?v={}",
                                                        percent_encoding::utf8_percent_encode(
                                                            id,
                                                            percent_encoding::NON_ALPHANUMERIC
                                                        ),
                                                        profile
                                                            .get("updatedAt")
                                                            .and_then(Value::as_u64)
                                                            .unwrap_or_default()
                                                    )),
                                                    ..Default::default()
                                                },
                                                false,
                                                gateway,
                                            ))
                                        }),
                                );
                                sort_owners(&mut state.owners);
                            } else {
                                state.error =
                                    Some("Gateway did not return the user directory.".into());
                            }
                        }
                        Err(error) => state.error = Some(error),
                    }
                }
                let _ = window.update(cx, |_, window, cx| rebuild_owners(state, menu, window, cx));
            });
        });
    });
}

fn rebuild_owners(
    state: OwnerMenuState,
    menu: WeakEntity<PopupMenu>,
    window: &mut Window,
    cx: &mut App,
) {
    let _ = menu.update(cx, |menu, cx| {
        menu.rebuild(window, cx, move |menu, _, cx| owner_items(menu, state, cx));
    });
}

fn owner_items(
    mut menu: PopupMenu,
    state: OwnerMenuState,
    cx: &mut Context<PopupMenu>,
) -> PopupMenu {
    let current = state.borrow();
    let input = current.input.clone();
    let query = input.read(cx).value().to_lowercase();
    let terms: Vec<_> = query.split_whitespace().collect();
    let matches: Vec<_> = current
        .owners
        .iter()
        .filter(|owner| {
            let text = format!(
                "{} {} {} {}",
                owner.label,
                owner.id,
                owner.kind,
                if owner.is_self { "Me" } else { "" }
            )
            .to_lowercase();
            terms.iter().all(|term| text.contains(term))
        })
        .cloned()
        .collect();
    let page = current
        .page
        .min(matches.len().saturating_sub(1) / PEOPLE_PAGE_SIZE);
    let start = page * PEOPLE_PAGE_SIZE;
    let end = (start + PEOPLE_PAGE_SIZE).min(matches.len());
    let menu_entity = cx.entity().downgrade();
    let focus_menu = menu_entity.clone();
    let search_state = state.clone();
    menu = menu
        .min_w(tokens::OWNER_WIDTH)
        .max_w(tokens::OWNER_WIDTH)
        .max_h(tokens::OWNER_MAX_HEIGHT)
        .scrollable(true)
        .check_side(gpui_kit::component::Side::Right)
        .item(
            PopupMenuItem::element(move |_, cx| {
                let focus_menu = focus_menu.clone();
                let input = search_state.borrow().input.clone();
                div()
                    .id("owner-search")
                    .w_full()
                    .py(tokens::OWNER_EDITOR_PADDING_Y)
                    .text_color(Palette::get(cx).text)
                    .capture_key_down(move |event, window, cx| {
                        if matches!(event.keystroke.key.as_str(), "down" | "enter") {
                            cx.stop_propagation();
                            if let Some(menu) = focus_menu.upgrade() {
                                menu.update(cx, |menu, cx| menu.focus_first(window, cx));
                            }
                        }
                    })
                    .child(
                        Input::new(&input)
                            .small()
                            .aria_label("Search people and agents…"),
                    )
            })
            .disabled(true),
        );
    let current_owner = current
        .row
        .owner
        .as_ref()
        .and_then(|owner| owner.get("actor"));
    let current_kind = current_owner
        .and_then(|owner| owner.get("type"))
        .and_then(Value::as_str);
    let current_id = current_owner
        .and_then(|owner| owner.pointer("/identity/id").or_else(|| owner.get("id")))
        .and_then(Value::as_str);
    for owner in &matches[start..end] {
        let checked = current_kind == Some(owner.kind) && current_id == Some(owner.id.as_str());
        let choice = owner.clone();
        let avatar = owner.avatar.clone();
        let target = current.target.clone();
        let view = target.view.clone();
        let row = current.row.clone();
        let label = if owner.is_self {
            "Me".to_owned()
        } else {
            owner.label.clone()
        };
        menu = menu.item(
            PopupMenuItem::element(move |_, cx| {
                let avatar = view
                    .upgrade()
                    .map(|entity| {
                        let app = entity.read(cx);
                        super::components::avatar::Avatar::new(
                            &avatar,
                            &app.sidebar_state.avatars,
                            tokens::OWNER_AVATAR,
                        )
                        .into_any_element()
                    })
                    .unwrap_or_else(|| {
                        div().size(tokens::OWNER_AVATAR.diameter).into_any_element()
                    });
                div()
                    .h_flex()
                    .w_full()
                    .min_h(tokens::ROW_HEIGHT)
                    .gap(tokens::ICON_GAP)
                    .typography(text::MENU)
                    .text_color(Palette::get(cx).text)
                    .child(avatar)
                    .child(div().flex_1().truncate().child(label.clone()))
            })
            .checked(checked)
            .disabled(checked)
            .on_click(move |_, _, cx| {
                let _ = target.update(cx, |app, cx| {
                    app.assign_session_owner(row.clone(), choice.clone(), cx)
                });
            }),
        );
    }
    if matches.is_empty() || current.owners.len() > PEOPLE_PAGE_SIZE || !query.is_empty() {
        let label = if matches.is_empty() {
            "No matching people or agents".to_owned()
        } else {
            format!("{}–{} of {}", start + 1, end, matches.len())
        };
        let pages = matches.len() > PEOPLE_PAGE_SIZE;
        let count = matches.len();
        let pagination = state.clone();
        menu = menu.item(
            PopupMenuItem::element(move |_, cx| {
                let mut controls = div()
                    .h_flex()
                    .w_full()
                    .py(tokens::OWNER_EDITOR_PADDING_Y)
                    .gap(tokens::OWNER_EDITOR_PADDING_Y)
                    .text_size(tokens::OWNER_RANGE_TEXT_SIZE)
                    .text_color(Palette::get(cx).muted)
                    .child(div().flex_1().child(label.clone()));
                if pages {
                    for (label, next, disabled) in [
                        ("Previous", page.saturating_sub(1), page == 0),
                        ("Next", page + 1, end >= count),
                    ] {
                        let state = pagination.clone();
                        let menu = menu_entity.clone();
                        controls = controls.child(
                            Button::new(label)
                                .ghost()
                                .small()
                                .label(label)
                                .disabled(disabled)
                                .on_click(move |_, window, cx| {
                                    cx.stop_propagation();
                                    state.borrow_mut().page = next;
                                    rebuild_owners(state.clone(), menu.clone(), window, cx);
                                }),
                        );
                    }
                }
                controls
            })
            .disabled(true),
        );
    }
    if current.loading {
        menu = menu.item(PopupMenuItem::new("Loading…").disabled(true));
    }
    if let Some(error) = current.error.clone() {
        let retry_state = state.clone();
        let retry_menu = cx.entity().downgrade();
        menu = menu
            .item(
                PopupMenuItem::element(move |_, cx| {
                    div()
                        .py(tokens::OWNER_EDITOR_PADDING_Y)
                        .text_color(Palette::get(cx).danger)
                        .whitespace_normal()
                        .child(error.clone())
                })
                .disabled(true),
            )
            .item(
                PopupMenuItem::element(move |_, _| {
                    let state = retry_state.clone();
                    let menu = retry_menu.clone();
                    Button::new("retry-owners")
                        .ghost()
                        .small()
                        .label("Retry")
                        .on_click(move |_, window, cx| {
                            cx.stop_propagation();
                            load_owners(state.clone(), window.window_handle(), menu.clone(), cx);
                            rebuild_owners(state.clone(), menu.clone(), window, cx);
                        })
                })
                .disabled(true),
            );
    }
    let lease: Rc<Vec<AvatarSpec>> = Rc::new(
        matches[start..end]
            .iter()
            .map(|owner| owner.avatar.clone())
            .collect(),
    );
    let target = current.target.clone();
    drop(current);
    state.borrow_mut().avatar_lease = Some(lease.clone());
    cx.defer(move |cx| {
        let _ = target.update(cx, |app, cx| {
            app.sidebar_state.avatars.retain_specs(&lease);
            app.refresh_sidebar_avatars(cx);
        });
    });
    menu
}
