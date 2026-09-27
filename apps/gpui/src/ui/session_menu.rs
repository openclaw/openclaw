use super::components::action_menu::{ActionMenu as PopupMenu, ActionMenuItem as PopupMenuItem};
use super::components::{icons::icon as ui_icon, menu::action_item};
use super::{AppView, sidebar_batch::batch_menu, theme::tokens::menu};
use crate::model::{
    session_menu::{MenuAction, can_archive, disabled_reason},
    sessions::SessionRow,
};
use gpui_kit::assets::IconName;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::{Value, json};

#[derive(Clone)]
pub(super) struct MenuTarget {
    pub(super) view: WeakEntity<AppView>,
    epoch: u64,
    revision: u64,
    hello: Option<Value>,
    main_key: String,
}

impl MenuTarget {
    pub(super) fn new(view: WeakEntity<AppView>, cx: &App) -> Option<Self> {
        let entity = view.upgrade()?;
        let app = entity.read(cx);
        Some(Self {
            view,
            epoch: app.epoch,
            revision: app.sidebar_state.agent_revision,
            hello: app.session.as_ref().map(|session| session.hello().clone()),
            main_key: app.agent_home(),
        })
    }

    fn reason(&self, action: MenuAction, row: &SessionRow) -> Option<String> {
        disabled_reason(action, row, self.hello.as_ref(), &self.main_key)
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

#[derive(Clone, Copy)]
enum SessionAction {
    Rename,
    Pin,
    Read,
    Fork,
    CopyId,
    CopyLink,
    CopyPreview,
    CopyMarkdown,
    OpenPr,
    NewWindow,
    Archive,
    Delete,
    Involvement,
}

impl SessionAction {
    fn policy(self) -> MenuAction {
        match self {
            Self::Rename => MenuAction::Rename,
            Self::Pin => MenuAction::Pin,
            Self::Read => MenuAction::Read,
            Self::Fork => MenuAction::Fork,
            Self::CopyId => MenuAction::CopyId,
            Self::CopyLink | Self::CopyPreview => MenuAction::CopyLink,
            Self::CopyMarkdown => MenuAction::CopyMarkdown,
            Self::OpenPr | Self::NewWindow => MenuAction::Open,
            Self::Archive => MenuAction::Archive,
            Self::Delete => MenuAction::Delete,
            Self::Involvement => MenuAction::Involvement,
        }
    }
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
        return batch_menu(menu, selected, view, window, cx);
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
        .max_w(menu::SESSION_MIN_WIDTH)
        .scrollable(true);
    if let Some(timestamp) = row
        .updated_at
        .and_then(crate::model::chat::sidebar_timestamp)
    {
        menu = menu.label(format!("Last active {timestamp}"));
    }
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
    menu = menu
        .submenu_with_icon(
            Some(ui_icon(IconName::Palette, super::theme::tokens::icon::MENU)),
            "Icon & color",
            window,
            cx,
            move |menu, window, cx| {
                super::session_appearance::appearance_menu(
                    menu,
                    icon_row.clone(),
                    icon_view.clone(),
                    window,
                    cx,
                )
            },
        )
        .last_hint("I")
        .last_disabled(
            view.reason(MenuAction::Icon, &row).is_some(),
            view.reason(MenuAction::Icon, &row).map(Into::into),
        );
    if row.can_pin(main_key) {
        let group_row = row.clone();
        let group_view = view.clone();
        menu = menu
            .submenu_with_icon(
                Some(ui_icon(IconName::Folder, super::theme::tokens::icon::MENU)),
                "Move to group",
                window,
                cx,
                move |mut menu, _, _| {
                    for (index, name) in groups.iter().enumerate() {
                        let hint = (index < 9).then(|| (index + 1).to_string());
                        let name = name.clone();
                        let row = group_row.clone();
                        let view = group_view.clone();
                        menu = menu.item(
                            PopupMenuItem::new(name.clone())
                                .when_some(hint, |item, hint| item.hint(hint))
                                .checked(row.category.as_ref() == Some(&name))
                                .on_click(move |_, _, cx| {
                                    let _ = view.update(cx, |this, cx| {
                                        this.move_session_rows(
                                            vec![row.clone()],
                                            Some(name.clone()),
                                            cx,
                                        )
                                    });
                                }),
                        );
                    }
                    if group_row.category.is_some() {
                        let row = group_row.clone();
                        let view = group_view.clone();
                        let digit = groups.len() + 1;
                        menu = menu.item(
                            PopupMenuItem::new("Remove from group")
                                .when(digit <= 9, |item| item.hint(digit.to_string()))
                                .on_click(move |_, _, cx| {
                                    let _ = view.update(cx, |this, cx| {
                                        this.move_session_rows(vec![row.clone()], None, cx)
                                    });
                                }),
                        );
                    }
                    let row = group_row.clone();
                    let view = group_view.clone();
                    let reason = view.reason(MenuAction::NewGroup, &row);
                    let digit = groups.len() + usize::from(row.category.is_some()) + 1;
                    menu.item(
                        PopupMenuItem::new("New group")
                            .disabled(reason.is_some())
                            .when_some(reason, |item, reason| item.title(reason))
                            .when(digit <= 9, |item| item.hint(digit.to_string()))
                            .on_click(move |_, window, cx| {
                                let _ = view.update(cx, |this, cx| {
                                    this.show_session_group_dialog(vec![row.clone()], window, cx)
                                });
                            }),
                    )
                },
            )
            .last_disabled(
                view.reason(MenuAction::Group, &row).is_some(),
                view.reason(MenuAction::Group, &row).map(Into::into),
            );
    }
    let owner_row = row.clone();
    let owner_view = view.clone();
    menu = menu
        .submenu_with_icon(
            Some(ui_icon(IconName::Users, super::theme::tokens::icon::MENU)),
            "Assign to…",
            window,
            cx,
            move |menu, window, cx| {
                super::session_organization::session_owner_menu(
                    menu,
                    owner_row.clone(),
                    owner_view.clone(),
                    window,
                    cx,
                )
            },
        )
        .last_disabled(
            view.reason(MenuAction::Owner, &row).is_some(),
            view.reason(MenuAction::Owner, &row).map(Into::into),
        );
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
    menu = menu
        .submenu_with_icon(
            Some(ui_icon(IconName::Copy, super::theme::tokens::icon::MENU)),
            "Copy",
            window,
            cx,
            move |menu, _, _| {
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
                    "Conversation as Markdown",
                    SessionAction::CopyMarkdown,
                    &copy_row,
                    &copy_view,
                    false,
                );
                item(
                    menu,
                    "Session ID",
                    SessionAction::CopyId,
                    &copy_row,
                    &copy_view,
                    copy_row.session_id.is_none(),
                )
            },
        )
        .last_hint("C");
    let open_row = row.clone();
    let open_view = view.clone();
    menu = menu.submenu_with_icon(
        Some(ui_icon(
            IconName::ExternalLink,
            super::theme::tokens::icon::MENU,
        )),
        "Open in",
        window,
        cx,
        move |menu, _, _| {
            let menu = menu.item(
                action_item("New tab", IconName::ExternalLink, None, false)
                    .disabled(true)
                    .title("Conversation tabs are not available in this native window."),
            );
            let menu = item(
                menu,
                "New window",
                SessionAction::NewWindow,
                &open_row,
                &open_view,
                false,
            );
            menu.item(
                action_item("Split right", IconName::Columns2, None, false)
                    .disabled(true)
                    .title("Split conversations are not available in this native window."),
            )
            .item(
                action_item("Split below", IconName::PanelBottomOpen, None, false)
                    .disabled(true)
                    .title("Split conversations are not available in this native window."),
            )
        },
    );
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
    menu = menu.separator();
    item(
        menu,
        "Delete…  D",
        SessionAction::Delete,
        &row,
        &view,
        false,
    )
}

fn item(
    mut menu: PopupMenu,
    label: &str,
    action: SessionAction,
    row: &SessionRow,
    view: &MenuTarget,
    disabled: bool,
) -> PopupMenu {
    let (label, hint) = label
        .rsplit_once("  ")
        .map_or((label, None), |(label, hint)| (label, Some(hint)));
    let icon = match action {
        SessionAction::Pin => {
            if row.pinned {
                IconName::PinOff
            } else {
                IconName::Pin
            }
        }
        SessionAction::Rename => IconName::SquarePen,
        SessionAction::Read => {
            if row.unread {
                IconName::Eye
            } else {
                IconName::Circle
            }
        }
        SessionAction::Archive => {
            if row.archived {
                IconName::ArchiveRestore
            } else {
                IconName::Archive
            }
        }
        SessionAction::Fork | SessionAction::CopyId => IconName::Copy,
        SessionAction::CopyLink | SessionAction::CopyPreview => IconName::Link,
        SessionAction::CopyMarkdown => IconName::FileText,
        SessionAction::OpenPr => IconName::GitPullRequest,
        SessionAction::NewWindow => IconName::Monitor,
        SessionAction::Delete => IconName::Trash,
        SessionAction::Involvement => {
            if row.hidden_from_involving_me == Some(true) {
                IconName::Eye
            } else {
                IconName::EyeOff
            }
        }
    };
    let reason = view.reason(action.policy(), row);
    let disabled = disabled || reason.is_some();
    let row = row.clone();
    let view = view.clone();
    menu = menu.item(
        action_item(
            label.to_owned(),
            icon,
            hint,
            matches!(action, SessionAction::Delete),
        )
        .disabled(disabled)
        .when_some(reason, |item, reason| item.title(reason))
        .on_click(move |_, window, cx| {
            let _ = view.update(cx, |this, cx| {
                this.run_session_action(row.clone(), action, window, cx)
            });
        }),
    );
    menu
}

impl AppView {
    fn run_session_action(
        &mut self,
        row: SessionRow,
        action: SessionAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let current = self
            .rows
            .iter()
            .chain(self.sidebar_state.children.values().flatten())
            .find(|current| current.key == row.key);
        if current.is_some_and(|current| current.session_id != row.session_id) {
            self.mutation_error("This conversation was replaced. Open its menu again.".into());
            return;
        }
        let row = current.cloned().unwrap_or(row);
        if let Some(reason) = disabled_reason(
            action.policy(),
            &row,
            self.session.as_ref().map(|session| session.hello()),
            &self.agent_home(),
        ) {
            self.mutation_error(reason);
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
            SessionAction::CopyId => {
                if let Some(id) = row.session_id {
                    cx.write_to_clipboard(ClipboardItem::new_string(id));
                } else {
                    self.mutation_error("Refresh before copying this session's ID.".into());
                }
            }
            SessionAction::CopyMarkdown => self.copy_session_markdown(row, cx),
            SessionAction::NewWindow => {
                let config = self
                    .profile
                    .as_ref()
                    .map(crate::gateway::config::for_profile)
                    .unwrap_or_else(|| {
                        let optional =
                            |value: SharedString| (!value.is_empty()).then(|| value.to_string());
                        Ok(crate::gateway::config::ConnectionConfig {
                            url: self.url.read(cx).value().to_string(),
                            token: optional(self.token.read(cx).value()),
                            password: optional(self.password.read(cx).value()),
                        })
                    });
                crate::gateway_windows::open_session(self.profile.clone(), config, row.key, cx);
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
