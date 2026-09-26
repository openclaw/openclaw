use super::{
    AppView,
    sidebar_batch::batch_menu,
    theme::tokens::{menu, space},
};
use crate::model::sessions::SessionRow;
use gpui_kit::{
    base::actions::Cancel,
    component::{
        Sizable, StyledExt, WindowExt,
        button::{Button, ButtonVariants},
        menu::{PopupMenu, PopupMenuItem},
    },
    *,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Action, Clone, PartialEq, Deserialize)]
#[action(namespace = openclaw, no_json)]
pub struct SessionMenuShortcut {
    pub key: String,
}

#[derive(Clone)]
pub(super) struct MenuTarget {
    view: WeakEntity<AppView>,
    epoch: u64,
    revision: u64,
}

impl MenuTarget {
    pub(super) fn new(view: WeakEntity<AppView>, cx: &App) -> Option<Self> {
        let entity = view.upgrade()?;
        let app = entity.read(cx);
        Some(Self {
            view,
            epoch: app.epoch,
            revision: app.sidebar_state.agent_revision,
        })
    }

    pub(super) fn update(
        &self,
        cx: &mut App,
        apply: impl FnOnce(&mut AppView, &mut Context<AppView>),
    ) -> Option<()> {
        self.view
            .update(cx, |this, cx| {
                if this.epoch != self.epoch || this.sidebar_state.agent_revision != self.revision {
                    this.mutation_error(
                        "Connection or agent changed. Open the conversation menu again.".into(),
                    );
                    cx.notify();
                    return;
                }
                apply(this, cx);
            })
            .ok()
    }
}

pub(crate) fn init_session_menu_shortcuts(cx: &mut App) {
    cx.bind_keys(["p", "r", "u", "a", "f", "d", "c", "i", "g"].map(|key| {
        KeyBinding::new(
            key,
            SessionMenuShortcut { key: key.into() },
            Some("SidebarSessionMenu && PopupMenu"),
        )
    }));
}

#[derive(Clone, Copy)]
enum SessionAction {
    Rename,
    Pin,
    Read,
    Fork,
    CopyKey,
    CopyId,
    CopyLink,
    CopyPreview,
    CopyMenu,
    OpenPr,
    Archive,
    Delete,
    Icon,
    Owner,
    Advanced,
    Involvement,
}

pub(super) fn session_menu(
    mut menu: PopupMenu,
    row: SessionRow,
    view: WeakEntity<AppView>,
    main_key: &str,
    window: &mut Window,
    cx: &mut Context<PopupMenu>,
) -> PopupMenu {
    let Some(entity) = view.upgrade() else {
        return menu;
    };
    let app = entity.read(cx);
    let selected = app.selected_sidebar_rows();
    if selected.len() > 1 && selected.iter().any(|candidate| candidate.key == row.key) {
        return batch_menu(menu, selected, view, cx);
    }
    let groups = app.sidebar_state.preferences.known_groups.clone();
    let has_pull_request = app
        .sidebar_state
        .pull_requests
        .menu_url(&crate::model::sidebar_pr::scoped_key(&row.key, row.agent()))
        .is_some();
    let involvement = app.session.as_ref().is_some_and(|session| {
        session
            .hello()
            .pointer("/policy/hasMultipleSessionSharingIdentities")
            .and_then(Value::as_bool)
            == Some(true)
    });
    let Some(view) = MenuTarget::new(view, cx) else {
        return menu;
    };
    menu = menu
        .min_w(menu::SESSION_MIN_WIDTH)
        .max_w(menu::SESSION_MAX_WIDTH)
        .scrollable(true);
    if row.can_pin(main_key) {
        menu = item(
            menu,
            if row.pinned {
                "Unpin session  P"
            } else {
                "Pin session  P"
            },
            SessionAction::Pin,
            &row,
            &view,
            row.archived,
        );
    }
    menu = item(
        menu,
        "Rename…  R",
        SessionAction::Rename,
        &row,
        &view,
        false,
    );
    menu = item(
        menu,
        if row.unread {
            "Mark as read  U"
        } else {
            "Mark as unread  U"
        },
        SessionAction::Read,
        &row,
        &view,
        false,
    );
    if involvement && let Some(hidden) = row.hidden_from_involving_me {
        menu = item(
            menu,
            if hidden {
                "Show in Involving me"
            } else {
                "Hide from Involving me"
            },
            SessionAction::Involvement,
            &row,
            &view,
            row.session_id.is_none(),
        );
    }
    menu = item(
        menu,
        if row.archived {
            "Restore session  A"
        } else {
            "Archive session  A"
        },
        SessionAction::Archive,
        &row,
        &view,
        !row.archived && !can_archive(&row, main_key),
    );
    menu = menu.separator();
    let icon_row = row.clone();
    let icon_view = view.clone();
    menu = menu.submenu("Icon & color  I", window, cx, move |menu, _, _| {
        appearance_menu(menu, &icon_row, &icon_view)
    });
    if row.can_pin(main_key) {
        let group_row = row.clone();
        let group_view = view.clone();
        menu = menu.submenu("Move to group", window, cx, move |mut menu, _, _| {
            for name in &groups {
                let name = name.clone();
                let row = group_row.clone();
                let view = group_view.clone();
                menu = menu.item(
                    PopupMenuItem::new(name.clone())
                        .checked(row.category.as_ref() == Some(&name))
                        .on_click(move |_, _, cx| {
                            let _ = view.update(cx, |this, cx| {
                                this.move_session_rows(vec![row.clone()], Some(name.clone()), cx)
                            });
                        }),
                );
            }
            if group_row.category.is_some() {
                menu = patch_item(
                    menu,
                    "Remove from group",
                    &group_row,
                    &group_view,
                    json!({"category":null}),
                );
            }
            let row = group_row.clone();
            let view = group_view.clone();
            menu.item(
                PopupMenuItem::new("New group…").on_click(move |_, window, cx| {
                    let _ = view.update(cx, |this, cx| {
                        this.show_session_group_dialog(vec![row.clone()], window, cx)
                    });
                }),
            )
        });
    }
    menu = item(menu, "Assign to…", SessionAction::Owner, &row, &view, false);
    menu = menu.separator();
    menu = item(
        menu,
        "Fork conversation  F",
        SessionAction::Fork,
        &row,
        &view,
        false,
    );
    let copy_row = row.clone();
    let copy_view = view.clone();
    menu = menu.submenu("Copy  C", window, cx, move |menu, _, _| {
        let menu = item(
            menu,
            "Session link",
            SessionAction::CopyLink,
            &copy_row,
            &copy_view,
            false,
        );
        let menu = item(
            menu,
            "Preview link",
            SessionAction::CopyPreview,
            &copy_row,
            &copy_view,
            false,
        );
        let menu = item(
            menu,
            "Session ID",
            SessionAction::CopyId,
            &copy_row,
            &copy_view,
            copy_row.session_id.is_none(),
        );
        item(
            menu,
            "Session key",
            SessionAction::CopyKey,
            &copy_row,
            &copy_view,
            false,
        )
    });
    if has_pull_request {
        menu = item(
            menu,
            "Open PR  G",
            SessionAction::OpenPr,
            &row,
            &view,
            false,
        );
    }
    menu = item(
        menu,
        "More in Sessions…",
        SessionAction::Advanced,
        &row,
        &view,
        false,
    );
    menu = menu.separator();
    item(
        menu,
        "Delete…  D",
        SessionAction::Delete,
        &row,
        &view,
        !row.archived && (!can_archive(&row, main_key) || row.running()),
    )
}

pub(super) fn can_archive(row: &SessionRow, main_key: &str) -> bool {
    row.session_id.as_ref().is_some_and(|id| !id.is_empty())
        && !matches!(row.key.as_str(), "main" | "global" | "unknown")
        && !matches!(row.kind.as_deref(), Some("global" | "unknown"))
        && row.key != main_key
        && !row.agent().is_some_and(|agent| {
            row.key
                == format!(
                    "agent:{agent}:{}",
                    main_key.rsplit(':').next().unwrap_or("main")
                )
        })
}

fn item(
    mut menu: PopupMenu,
    label: &str,
    action: SessionAction,
    row: &SessionRow,
    view: &MenuTarget,
    disabled: bool,
) -> PopupMenu {
    let row = row.clone();
    let view = view.clone();
    menu = menu.item(
        PopupMenuItem::new(label.to_owned())
            .disabled(disabled)
            .on_click(move |_, window, cx| {
                let _ = view.update(cx, |this, cx| {
                    this.run_session_action(row.clone(), action, window, cx)
                });
            }),
    );
    menu
}

fn patch_item(
    menu: PopupMenu,
    label: &str,
    row: &SessionRow,
    view: &MenuTarget,
    fields: Value,
) -> PopupMenu {
    let row = row.clone();
    let view = view.clone();
    menu.item(
        PopupMenuItem::new(label.to_owned()).on_click(move |_, _, cx| {
            let _ = view.update(cx, |this, cx| {
                this.patch_session(row.clone(), fields.clone(), cx)
            });
        }),
    )
}

fn appearance_menu(mut menu: PopupMenu, row: &SessionRow, view: &MenuTarget) -> PopupMenu {
    menu = menu.label("Color");
    for color in [
        "red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan",
    ] {
        menu = patch_item(menu, color, row, view, json!({"color":color}));
    }
    menu = menu.separator().label("Icon");
    for icon in [
        "🦞", "🚀", "🐛", "✅", "🔥", "📦", "🧪", "📝", "🔍", "⚡", "🎯", "braces", "book",
        "monitor", "bot", "kanban", "coins",
    ] {
        menu = patch_item(menu, icon, row, view, json!({"icon":icon}));
    }
    menu = item(menu, "Custom icon…", SessionAction::Icon, row, view, false);
    patch_item(
        menu.separator(),
        "Reset to default",
        row,
        view,
        json!({"icon":null,"color":null}),
    )
    .scrollable(true)
}

impl AppView {
    pub(super) fn session_menu_shortcut(
        &mut self,
        row: SessionRow,
        action: &SessionMenuShortcut,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let batch = self.selected_sidebar_rows();
        if batch.len() > 1 && batch.iter().any(|candidate| candidate.key == row.key) {
            let patch = match action.key.as_str() {
                "u" => Some(json!({"unread":!batch.iter().all(|row| row.unread)})),
                "a" => Some(json!({"archived":!batch.iter().all(|row| row.archived)})),
                _ => None,
            };
            if patch.is_some() || action.key == "d" {
                window.dispatch_action(Box::new(Cancel), cx);
                let delete = action.key == "d";
                cx.defer_in(window, move |this, window, cx| {
                    if let Some(patch) = patch {
                        this.patch_session_rows(batch, patch, cx);
                    } else if delete {
                        this.confirm_delete_rows(batch, window, cx);
                    }
                });
            }
            return;
        }
        let action = match action.key.as_str() {
            "p" if row.can_pin(&self.agent_home()) && !row.archived => SessionAction::Pin,
            "r" => SessionAction::Rename,
            "u" => SessionAction::Read,
            "a" if row.archived || can_archive(&row, &self.agent_home()) => SessionAction::Archive,
            "f" => SessionAction::Fork,
            "d" if row.archived || (!row.running() && can_archive(&row, &self.agent_home())) => {
                SessionAction::Delete
            }
            "c" => SessionAction::CopyMenu,
            "i" => SessionAction::Icon,
            "g" if self
                .sidebar_state
                .pull_requests
                .menu_url(&crate::model::sidebar_pr::scoped_key(&row.key, row.agent()))
                .is_some() =>
            {
                SessionAction::OpenPr
            }
            _ => return,
        };
        window.dispatch_action(Box::new(Cancel), cx);
        cx.defer_in(window, move |this, window, cx| {
            this.run_session_action(row, action, window, cx)
        });
    }

    fn run_session_action(
        &mut self,
        row: SessionRow,
        action: SessionAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.session.is_none()
            && !matches!(
                action,
                SessionAction::CopyKey
                    | SessionAction::CopyId
                    | SessionAction::CopyLink
                    | SessionAction::CopyPreview
                    | SessionAction::CopyMenu
            )
        {
            self.mutation_error("Reconnect before changing this conversation.".into());
            return;
        }
        match action {
            SessionAction::Rename => self.begin_rename(row, window, cx),
            SessionAction::Pin => {
                let pinned = !row.pinned;
                self.patch_session(row, json!({"pinned":pinned}), cx);
            }
            SessionAction::Read => {
                let unread = !row.unread;
                self.patch_session(row, json!({"unread":unread}), cx);
            }
            SessionAction::Fork => self.fork_session(row, cx),
            SessionAction::CopyKey => cx.write_to_clipboard(ClipboardItem::new_string(row.key)),
            SessionAction::CopyId => {
                if let Some(id) = row.session_id {
                    cx.write_to_clipboard(ClipboardItem::new_string(id));
                } else {
                    self.mutation_error("Refresh before copying this session's ID.".into());
                }
            }
            SessionAction::CopyMenu => {
                let view = cx.entity().downgrade();
                window.open_dialog(cx, move |dialog, _, _| {
                    let mut choices = div().v_flex().gap(space::WIDGET_GAP);
                    for (label, action) in [
                        ("Session link", SessionAction::CopyLink),
                        ("Preview link", SessionAction::CopyPreview),
                        ("Session ID", SessionAction::CopyId),
                        ("Session key", SessionAction::CopyKey),
                    ] {
                        let row = row.clone();
                        let view = view.clone();
                        choices = choices.child(
                            Button::new(label).ghost().small().label(label).on_click(
                                move |_, window, cx| {
                                    let _ = view.update(cx, |this, cx| {
                                        this.run_session_action(row.clone(), action, window, cx)
                                    });
                                    window.close_dialog(cx);
                                },
                            ),
                        );
                    }
                    dialog.title("Copy conversation").child(choices)
                });
            }
            SessionAction::OpenPr => {
                let url = self
                    .sidebar_state
                    .pull_requests
                    .menu_url(&crate::model::sidebar_pr::scoped_key(&row.key, row.agent()))
                    .map(str::to_owned);
                match url.filter(|value| {
                    url::Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
                }) {
                    Some(url) => self.open_reading_url(&url, cx),
                    None => self.mutation_error(
                        "This conversation no longer has an available pull request link.".into(),
                    ),
                }
            }
            SessionAction::CopyLink | SessionAction::CopyPreview => {
                let base = self
                    .session
                    .as_ref()
                    .and_then(|session| session.hello().get("controlUiUrl").and_then(Value::as_str))
                    .or_else(|| self.web.auth.as_ref().map(|auth| auth.gateway_url.as_str()));
                let link = base
                    .ok_or_else(|| "Reconnect before copying a session link.".to_owned())
                    .and_then(|base| {
                        crate::model::session_links::session_link(
                            base,
                            &row.key,
                            row.agent().or(self.sidebar_state.selected_agent.as_deref()),
                            &self.sidebar_state.main_key,
                            matches!(action, SessionAction::CopyPreview),
                        )
                    });
                match link {
                    Ok(link) => cx.write_to_clipboard(ClipboardItem::new_string(link)),
                    Err(error) => self.mutation_error(error),
                }
            }
            SessionAction::Archive => self.archive_session(row, cx),
            SessionAction::Delete => self.confirm_delete(row, window, cx),
            SessionAction::Icon => self.show_session_icon_dialog(row, window, cx),
            SessionAction::Owner => self.show_session_owner_dialog(row, window, cx),
            SessionAction::Advanced => self.open_control_page("/sessions", "Sessions", window, cx),
            SessionAction::Involvement => {
                let hidden = !row.hidden_from_involving_me.unwrap_or_default();
                let mut params =
                    json!({"key":row.key,"expectedSessionId":row.session_id,"hidden":hidden});
                if let Some(agent) = row.agent().or(self.sidebar_state.selected_agent.as_deref()) {
                    params["agentId"] = json!(agent);
                }
                let revision = self.sidebar_state.agent_revision;
                let generation = self.sidebar_state.mutation_receipts.begin(&row.key);
                self.request(
                    "sessions.setInvolvement",
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
                            Ok(_) => {
                                this.patch_roster_fields(
                                    &row,
                                    &json!({"hiddenFromInvolvingMe":hidden}),
                                );
                                this.refresh_sessions(cx);
                            }
                            Err(error) => this
                                .mutation_error(format!("Could not change Involving me: {error}")),
                        }
                    },
                );
            }
        }
    }
}
