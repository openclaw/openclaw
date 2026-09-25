use super::{
    AppView,
    session_actions::{SessionMenuShortcut, session_menu},
    theme::Palette,
};
use crate::model::{
    sessions::{SessionRow, visible_child_keys},
    sidebar::ArchiveFilter,
    sidebar_activity::{SidebarAttention, strongest_attention},
};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Sizable, StyledExt, Theme,
        button::{Button, ButtonVariants},
        input::Input,
        menu::{ContextMenuExt, DropdownMenu},
    },
    prelude::FluentBuilder,
    *,
};
use serde_json::json;

#[path = "sidebar_row_indicators.rs"]
mod indicators;
use indicators::{LeadingState, attention_badge, row_badge, run_ring, session_color, unread_dot};

impl AppView {
    pub(super) fn sidebar_row(
        &self,
        row: &SessionRow,
        depth: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let selected =
            !self.web.settings_open && self.chat.selected_session.as_ref() == Some(&row.key);
        let multi_selected = self.sidebar_state.selection.keys.contains(&row.key);
        let key = row.key.clone();
        let view = cx.entity().downgrade();
        let menu_row = row.clone();
        let button_view = view.clone();
        let button_row = row.clone();
        let shortcut_row = row.clone();
        let shortcut_epoch = self.epoch;
        let shortcut_revision = self.sidebar_state.agent_revision;
        let pin_row = row.clone();
        let archive_row = row.clone();
        let expanded = self.sidebar_state.expanded.contains(&key);
        let main_key = self.agent_home();
        let menu_main_key = main_key.clone();
        let button_main_key = main_key.clone();
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
        let count = children.len();
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
        let color = row
            .color
            .as_deref()
            .and_then(|color| session_color(color, Theme::global(cx).is_dark()));
        let row_key = key.clone();
        let mut line = div()
            .id(SharedString::from(format!("session:{key}")))
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
            .h_flex()
            .relative()
            .min_h(px(30.))
            .px_2()
            .py(px(4.))
            .gap(px(8.))
            .rounded_md()
            .when_some(color, |el, color| {
                el.bg(color.opacity(0.08)).border_l_2().border_color(color)
            })
            .when(selected, |el| el.bg(p.hover))
            .when(multi_selected, |el| {
                el.bg(p.accent_subtle)
                    .border_1()
                    .border_color(p.accent.opacity(0.5))
            })
            .hover(|el| el.bg(p.hover))
            .on_click(cx.listener(move |this, event, window, cx| {
                this.sidebar_row_click(row_key.clone(), event, window, cx);
            }))
            .child(
                div()
                    .w(px(22.))
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
                    .h(px(28.))
                    .aria_label("Rename conversation")
                    .small()
                    .w_full(),
            );
        } else {
            line = line.child(
                div()
                    .v_flex()
                    .gap(px(2.))
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .h_flex()
                            .gap(px(4.))
                            .min_w_0()
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(if selected || unread { p.strong } else { p.text })
                                    .truncate()
                                    .child(row.title()),
                            )
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
                    .when_some(subtitle, |el, preview| {
                        el.child(
                            div()
                                .text_size(px(11.))
                                .text_color(p.muted)
                                .truncate()
                                .child(preview),
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
                .when(unread, |el| el.child(unread_dot(p)))
                .when(attention != SidebarAttention::None, |el| {
                    el.child(attention_badge(attention_row, attention, p))
                })
                .when(attention == SidebarAttention::None && running, |el| {
                    el.child(run_ring(16., queued, p))
                });
        }
        if count > 0 || !row.child_sessions.is_empty() {
            let toggle_key = key.clone();
            line = line.child(
                Button::new(SharedString::from(format!("children:{key}")))
                    .ghost()
                    .small()
                    .h(px(22.))
                    .px(px(4.))
                    .icon(
                        Icon::new(if expanded {
                            IconName::ChevronDown
                        } else {
                            IconName::ChevronRight
                        })
                        .size(px(14.)),
                    )
                    .label(count.max(row.child_sessions.len()).to_string())
                    .text_size(px(11.))
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
                .right(px(if count > 0 { 44. } else { 4. }))
                .top(px(1.))
                .h_flex()
                .bg(if selected { p.hover } else { p.sidebar })
                .rounded_md()
                .invisible()
                .group_hover("session-row", |el| el.visible().bg(p.hover))
                .when(!row.archived && row.can_pin(&main_key), |el| {
                    el.child(
                        Button::new(SharedString::from(format!("pin:{key}")))
                            .ghost()
                            .small()
                            .size(px(28.))
                            .icon(
                                Icon::new(if row.pinned {
                                    IconName::PinOff
                                } else {
                                    IconName::Pin
                                })
                                .size(px(16.)),
                            )
                            .accessibility_label(if row.pinned { "Unpin" } else { "Pin" })
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
                    Button::new(SharedString::from(format!("archive:{key}")))
                        .ghost()
                        .small()
                        .size(px(28.))
                        .icon(
                            Icon::new(if row.archived {
                                IconName::ArchiveRestore
                            } else {
                                IconName::Archive
                            })
                            .size(px(16.)),
                        )
                        .accessibility_label(if row.archived {
                            "Restore session"
                        } else {
                            "Archive session"
                        })
                        .tooltip(if row.archived {
                            "Restore session"
                        } else {
                            "Archive session"
                        })
                        .disabled(
                            !row.archived && !super::session_menu::can_archive(row, &main_key),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.archive_session(archive_row.clone(), cx);
                        })),
                )
                .child(
                    Button::new(SharedString::from(format!("menu:{key}")))
                        .ghost()
                        .small()
                        .size(px(28.))
                        .icon(Icon::new(IconName::Ellipsis).size(px(16.)))
                        .accessibility_label("Conversation menu")
                        .dropdown_menu(move |menu, window, cx| {
                            session_menu(
                                menu,
                                button_row.clone(),
                                button_view.clone(),
                                &button_main_key,
                                window,
                                cx,
                            )
                        }),
                ),
        );
        let mut branch = div()
            .v_flex()
            .gap(px(2.))
            .ml(px(if depth > 0 { 20. } else { 0. }))
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
                        .pl_8()
                        .text_xs()
                        .text_color(p.muted)
                        .child("Loading children…"),
                );
            }
            if let Some(error) = self.sidebar_state.child_errors.get(&key) {
                branch = branch.child(
                    div()
                        .pl_8()
                        .text_xs()
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
                        .ml(px(24.))
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
