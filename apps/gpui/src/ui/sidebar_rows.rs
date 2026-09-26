use super::{
    AppView,
    components::{
        icon_button::icon_button as ui_icon_button, icons::icon as ui_icon, list::list_row,
    },
    session_actions::{SessionMenuShortcut, session_menu},
    theme::{
        Palette,
        tokens::{TypographyExt, colors, icon, icon_button, radius, row as row_style, space, text},
    },
};
use crate::model::{
    sessions::{SessionRow, visible_child_keys},
    sidebar::ArchiveFilter,
    sidebar_activity::{SidebarAttention, strongest_attention},
};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Sizable, StyledExt, Theme,
        button::{Button, ButtonVariants},
        input::Input,
        menu::ContextMenuExt,
    },
    prelude::FluentBuilder,
    *,
};
use serde_json::json;

#[path = "sidebar_row_indicators.rs"]
mod indicators;
use indicators::{LeadingState, attention_badge, row_badge, run_ring, unread_dot};

impl AppView {
    pub(super) fn sidebar_row(
        &self,
        row: &SessionRow,
        depth: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::sidebar(cx);
        let selected =
            !self.web.settings_open && self.chat.selected_session.as_ref() == Some(&row.key);
        let pinned_navigation = row.pinned && !self.sidebar_state.preferences.all_agents;
        let multi_selected = self.sidebar_state.selection.keys.contains(&row.key);
        let key = row.key.clone();
        let view = cx.entity().downgrade();
        let menu_row = row.clone();
        let shortcut_row = row.clone();
        let shortcut_epoch = self.epoch;
        let shortcut_revision = self.sidebar_state.agent_revision;
        let pin_row = row.clone();
        let archive_row = row.clone();
        let expanded = self.sidebar_state.expanded.contains(&key);
        let main_key = self.agent_home();
        let menu_main_key = main_key.clone();
        let known: Vec<_> = self
            .rows
            .iter()
            .chain(self.sidebar_state.children.values().flatten())
            .chain(row.children.iter())
            .collect();
        let child_keys = visible_child_keys(row, &known, &main_key);
        let children: Vec<_> = child_keys
            .iter()
            .filter_map(|key| known.iter().copied().find(|child| &child.key == key))
            .filter(|child| match self.sidebar_state.preferences.archive {
                ArchiveFilter::Active => !child.archived,
                ArchiveFilter::Archived => child.archived,
                ArchiveFilter::All => true,
            })
            .collect();
        let count = child_keys.len();
        let team = self.sidebar_state.preferences.all_agents;
        let own_attention = if row.archived {
            SidebarAttention::None
        } else {
            self.sidebar_attention(row)
        };
        let (attention_row, attention) = strongest_attention(
            std::iter::once((row, own_attention)).chain(
                children
                    .iter()
                    .filter(|child| !row.archived && !child.archived)
                    .map(|child| (*child, self.sidebar_attention(child))),
            ),
        )
        .expect("parent attention is present");
        let child_running = !row.archived
            && children
                .iter()
                .any(|child| !child.archived && child.display_running());
        let running = !row.archived && (row.display_running() || child_running);
        let queued = row.status.as_deref() == Some("queued") && !child_running;
        let unread = !row.archived && row.unread;
        let leading = self.sidebar_leading(
            row,
            attention_row,
            LeadingState {
                depth,
                attention: if team {
                    SidebarAttention::None
                } else {
                    attention
                },
                running: running && !team,
                queued,
                unread: unread && !team,
            },
            cx,
        );
        let subtitle = if team || row.archived {
            None
        } else {
            self.sidebar_subtitle(row)
        };
        let channel = crate::model::session_channel::channel_label(row);
        let color = row
            .color
            .as_deref()
            .and_then(|color| colors::session_color(color, Theme::global(cx).is_dark()));
        let row_key = key.clone();
        let mut line = list_row(
            SharedString::from(format!("session:{key}")),
            if team {
                row_style::SESSION_TEAM
            } else {
                row_style::SESSION
            },
        )
        .role(Role::Button)
        .aria_label(row.title())
        .group("session-row")
        .key_context("SidebarSessionMenu")
        .on_action(
            cx.listener(move |this, action: &SessionMenuShortcut, window, cx| {
                if this.epoch == shortcut_epoch
                    && this.sidebar_state.agent_revision == shortcut_revision
                {
                    this.session_menu_shortcut(shortcut_row.clone(), action, window, cx);
                } else {
                    this.mutation_error(
                        "The conversation changed. Reopen its menu before changing it.".into(),
                    );
                    cx.notify();
                }
            }),
        )
        .when_some(color, |el, color| {
            el.bg(colors::category_tint(color))
                .border_l(space::XXS)
                .border_color(color)
        })
        .when(pinned_navigation, |el| {
            el.border(space::HAIRLINE).border_color(transparent_black())
        })
        .when(selected, |el| {
            if pinned_navigation {
                el.bg(colors::navigation_active(p, Theme::global(cx).is_dark()))
                    .border_color(colors::selected_border(p))
            } else {
                el.bg(colors::session_selected(p))
            }
        })
        .when(multi_selected, |el| el.bg(colors::multi_selected(p)))
        .hover(|el| {
            el.bg(if multi_selected {
                colors::multi_selected(p)
            } else if selected {
                colors::session_selected(p)
            } else {
                colors::session_hover(p)
            })
        })
        .on_click(cx.listener(move |this, event, window, cx| {
            this.sidebar_row_click(row_key.clone(), event, window, cx);
        }))
        .child(
            div()
                .w(row_style::NAV.leading_width)
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .child(leading),
        );
        if !self.sidebar_state.rename_in_header
            && self
                .sidebar_state
                .rename_row
                .as_ref()
                .is_some_and(|editing| editing.key == row.key)
        {
            line = line.child(
                Input::new(&self.sidebar_state.rename_input)
                    .id("sidebar-session-rename")
                    .h(row_style::RENAME_HEIGHT)
                    .aria_label("Rename conversation")
                    .small()
                    .w_full(),
            );
        } else {
            line = line.child(
                div()
                    .v_flex()
                    .gap(space::XXS)
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .h_flex()
                            .gap(space::XS)
                            .min_w_0()
                            .child(
                                div()
                                    .typography(if team {
                                        text::SESSION_TEAM
                                    } else {
                                        text::SESSION
                                    })
                                    .text_color(match attention {
                                        SidebarAttention::Agent | SidebarAttention::Approval => {
                                            colors::attention_text(p)
                                        }
                                        SidebarAttention::Error => colors::error_text(p),
                                        _ if selected => p.strong,
                                        _ => p.text,
                                    })
                                    .truncate()
                                    .child(row.title()),
                            )
                            .when_some(channel.clone().filter(|_| team), |el, label| {
                                el.child(channel_caption(label, p))
                            })
                            .when(row.visibility.as_deref() == Some("draft"), |el| {
                                el.child(row_badge(
                                    &key,
                                    "shared-draft",
                                    IconName::Ghost,
                                    "Draft session".into(),
                                    p.muted,
                                ))
                            })
                            .when(row.archived, |el| {
                                el.child(row_badge(
                                    &key,
                                    "archived",
                                    IconName::Archive,
                                    "Archived".into(),
                                    p.muted,
                                ))
                            })
                            .when(row.fork_source.is_some(), |el| {
                                el.child(row_badge(
                                    &key,
                                    "fork",
                                    IconName::GitFork,
                                    "Forked session".into(),
                                    p.muted,
                                ))
                            }),
                    )
                    .when(!team && (channel.is_some() || subtitle.is_some()), |el| {
                        el.child(
                            div()
                                .h_flex()
                                .gap(space::SM)
                                .min_w_0()
                                .when_some(channel, |el, label| el.child(channel_caption(label, p)))
                                .when_some(subtitle, |el, preview| {
                                    el.child(
                                        div()
                                            .typography(text::CAPTION)
                                            .text_color(match attention {
                                                SidebarAttention::Agent
                                                | SidebarAttention::Approval => {
                                                    colors::attention_text(p)
                                                }
                                                SidebarAttention::Error => colors::error_text(p),
                                                _ => p.muted,
                                            })
                                            .truncate()
                                            .child(preview),
                                    )
                                }),
                        )
                    }),
            );
        }
        line = line
            .child(self.render_session_viewers(
                row,
                depth > 0 || (!team && attention != SidebarAttention::None),
                cx,
            ))
            .child(self.sidebar_row_badges(row, depth, cx));
        if team {
            line = line
                .when(!expanded && count > 0, |el| {
                    el.child(
                        div()
                            .text_size(text::CAPTION.size)
                            .text_color(p.muted)
                            .child(count.to_string()),
                    )
                })
                .when(unread, |el| el.child(unread_dot(p)))
                .when(attention != SidebarAttention::None, |el| {
                    el.child(attention_badge(attention_row, attention, p))
                })
                .when(attention == SidebarAttention::None && running, |el| {
                    el.child(run_ring(icon::NORMAL, queued, p))
                });
        }
        if count > 0 || !row.child_sessions.is_empty() {
            let toggle_key = key.clone();
            line = line.child(
                Button::new(SharedString::from(format!("children:{key}")))
                    .ghost()
                    .small()
                    .h(row_style::CHILD_TOGGLE_HEIGHT)
                    .w(row_style::CHILD_TOGGLE)
                    .px_0()
                    .when(team, |button| {
                        button
                            .absolute()
                            .left_0()
                            .top_0()
                            .w(row_style::NAV.leading_width)
                            .h(row_style::SESSION_TEAM.min_height)
                            .py_0()
                    })
                    .icon(ui_icon(
                        if expanded {
                            IconName::ChevronDown
                        } else {
                            IconName::ChevronRight
                        },
                        if team { icon::SMALL } else { icon::ACTION },
                    ))
                    .when(!team, |button| {
                        button.label(count.max(row.child_sessions.len()).to_string())
                    })
                    .text_size(text::CAPTION.size)
                    .accessibility_label(if expanded {
                        "Collapse children"
                    } else {
                        "Expand children"
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.toggle_children(toggle_key.clone(), cx);
                    })),
            );
        }
        line = line.child(
            div()
                .absolute()
                .right(if !team && count > 0 {
                    row_style::HOVER_ACTIONS_WITH_CHILDREN_RIGHT
                } else {
                    space::XS
                })
                .top(if team { space::XS } else { space::HAIRLINE })
                .h_flex()
                .bg(if selected { p.hover } else { p.sidebar })
                .rounded(radius::ROW)
                .invisible()
                .group_hover("session-row", |el| el.visible().bg(p.hover))
                .when(!row.archived && row.can_pin(&main_key), |el| {
                    el.child(
                        ui_icon_button(
                            SharedString::from(format!("pin:{key}")),
                            IconName::Pin,
                            if row.pinned { "Unpin" } else { "Pin" },
                            icon_button::ROW,
                            cx,
                        )
                        .tooltip(if row.pinned {
                            "Unpin session"
                        } else {
                            "Pin session"
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.patch_session(
                                pin_row.clone(),
                                json!({"pinned":!pin_row.pinned}),
                                cx,
                            );
                        })),
                    )
                })
                .child(
                    ui_icon_button(
                        SharedString::from(format!("archive:{key}")),
                        if row.archived {
                            IconName::ArchiveRestore
                        } else {
                            IconName::Archive
                        },
                        if row.archived {
                            "Restore session"
                        } else {
                            "Archive session"
                        },
                        icon_button::ROW,
                        cx,
                    )
                    .tooltip(if row.archived {
                        "Restore session"
                    } else {
                        "Archive session"
                    })
                    .disabled(!row.archived && !super::session_menu::can_archive(row, &main_key))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.archive_session(archive_row.clone(), cx);
                    })),
                ),
        );
        let mut branch = div()
            .v_flex()
            .gap(if team { space::NONE } else { row_style::GAP })
            .mx(if team { space::NONE } else { space::XXS })
            .ml(if depth > 0 {
                if team {
                    row_style::TEAM_CHILD_INDENT
                } else {
                    row_style::CHILD_INDENT
                }
            } else if team {
                space::NONE
            } else {
                space::XXS
            })
            .child(line.context_menu(move |menu, window, cx| {
                session_menu(
                    menu,
                    menu_row.clone(),
                    view.clone(),
                    &menu_main_key,
                    window,
                    cx,
                )
            }));
        if expanded && depth < 12 {
            let limit = self
                .sidebar_state
                .child_limits
                .get(&key)
                .copied()
                .unwrap_or(4);
            let mut shown = 0;
            for (index, child) in children.iter().enumerate() {
                let visible = index < limit
                    || self.chat.selected_session.as_ref() == Some(&child.key)
                    || (!child.archived
                        && (child.unread
                            || child.display_running()
                            || self.sidebar_attention(child) != SidebarAttention::None));
                if visible {
                    branch = branch.child(self.sidebar_row(child, depth + 1, cx));
                    shown += 1;
                }
            }
            if self.sidebar_state.child_loading.contains(&key) {
                branch = branch.child(
                    div()
                        .pl(space::CONTENT)
                        .text_size(text::SMALL.size)
                        .text_color(p.muted)
                        .child("Loading children…"),
                );
            }
            if let Some(error) = self.sidebar_state.child_errors.get(&key) {
                branch = branch.child(
                    div()
                        .pl(space::CONTENT)
                        .text_size(text::SMALL.size)
                        .text_color(p.danger)
                        .child(error.clone()),
                );
            }
            if children.len() > shown {
                let more_key = key.clone();
                branch = branch.child(
                    Button::new(SharedString::from(format!("children-more:{key}")))
                        .ghost()
                        .small()
                        .ml(space::WIDE)
                        .label(format!("Show {} more", children.len() - shown))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.sidebar_state
                                .child_limits
                                .insert(more_key.clone(), usize::MAX);
                            cx.notify();
                        })),
                );
            }
        }
        branch.into_any_element()
    }
}

fn channel_caption(label: String, p: Palette) -> Div {
    div()
        .max_w(row_style::CHANNEL_MAX_WIDTH)
        .typography(text::CAPTION)
        .text_color(p.muted)
        .truncate()
        .child(label)
}
