use super::{
    AppView,
    components::icons::icon as ui_icon,
    theme::{
        Palette,
        tokens::{
            InsetsExt, TypographyExt, avatar, colors, header, icon, menu, opacity, radius, space,
            text,
        },
    },
};
use crate::gateway::sessions_rpc::Agent;
use gpui_kit::{
    assets::IconName,
    base::{Align, Placement, Positioner},
    component::{StyledExt, Theme},
    prelude::FluentBuilder,
    *,
};

mod state;
use state::{Choice, Entry, OpenMode, PickerState, activate, help_entries, picker_key};

struct MenuContext {
    state: Entity<PickerState>,
    view: WeakEntity<AppView>,
    epoch: u64,
}

impl AppView {
    pub(super) fn sidebar_agent_picker(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::sidebar(cx);
        let roster = self.sidebar_state.preferences.all_agents;
        let selected = self.sidebar_state.selected_agent.as_deref();
        let selected_agent = self
            .sidebar_state
            .agents
            .iter()
            .find(|agent| Some(agent.id.as_str()) == selected);
        let name = if roster {
            self.profile
                .as_ref()
                .map(|profile| profile.name.clone())
                .unwrap_or_else(|| "OpenClaw".into())
        } else {
            self.selected_agent_name()
        };
        let show_tiles = !roster && self.sidebar_state.agents.len() > 1;
        let mut entries: Vec<Entry> = if show_tiles {
            self.sidebar_state
                .agents
                .iter()
                .map(|agent| Entry {
                    label: agent.name().to_owned(),
                    icon: None,
                    choice: Choice::Agent(agent.id.clone()),
                    enabled: true,
                })
                .collect()
        } else {
            Vec::new()
        };
        let tile_count = entries.len();
        entries.push(Entry {
            label: if roster {
                "Show one agent"
            } else {
                "Show all agents"
            }
            .into(),
            icon: None,
            choice: Choice::Roster,
            enabled: true,
        });
        if !roster {
            entries.extend([
                Entry {
                    label: "All agents".into(),
                    icon: Some(IconName::Bot),
                    choice: Choice::Agents,
                    enabled: true,
                },
                Entry {
                    label: "New agent".into(),
                    icon: Some(IconName::Users),
                    choice: Choice::New,
                    enabled: true,
                },
                Entry {
                    label: format!("What can {name} do?"),
                    icon: Some(IconName::Bot),
                    choice: Choice::Capabilities(selected.unwrap_or("main").to_owned()),
                    enabled: self.session.is_some(),
                },
            ]);
        }
        entries.push(Entry {
            label: "Agent settings".into(),
            icon: Some(IconName::Settings),
            choice: Choice::Settings(selected.unwrap_or("main").to_owned()),
            enabled: true,
        });
        if roster {
            entries.push(Entry {
                label: "Help".into(),
                icon: Some(IconName::CircleQuestionMark),
                choice: Choice::Help,
                enabled: true,
            });
        }
        let active = entries
            .iter()
            .position(
                |entry| matches!(&entry.choice,Choice::Agent(id) if Some(id.as_str()) == selected),
            )
            .unwrap_or(0);
        let state = window.use_keyed_state("sidebar-agent-picker-state", cx, |_, cx| {
            PickerState::new(self.epoch, cx)
        });
        state.update(cx, |state, cx| {
            if state.epoch != self.epoch {
                state.close(false, window, cx);
                state.epoch = self.epoch;
            }
        });
        let opened = state.read(cx).mode.is_some();
        let trigger_focus = state.read(cx).trigger_focus.clone();
        let bounds = state.read(cx).bounds.clone();
        let capture = bounds.clone();
        let view = cx.entity().downgrade();
        let other_unread = self
            .sidebar_state
            .agent_activity
            .iter()
            .chain(self.rows.iter())
            .any(|row| row.unread && !row.archived && row.agent() != selected);
        let avatar = if roster {
            div()
                .size(avatar::AGENT_HEADER.diameter)
                .flex()
                .items_center()
                .justify_center()
                .text_size(avatar::WORKSPACE_GLYPH)
                .child("🦞")
                .into_any_element()
        } else {
            selected_agent
                .map(|agent| self.render_agent_avatar(agent, avatar::AGENT_HEADER, cx))
                .unwrap_or_else(|| {
                    div()
                        .size(avatar::AGENT_HEADER.diameter)
                        .child("◈")
                        .into_any_element()
                })
        };
        let trigger = div()
            .id("agent-picker")
            .role(Role::Button)
            .aria_expanded(opened)
            .track_focus(&trigger_focus)
            .tab_index(0)
            .h_flex()
            .relative()
            .h(header::AGENT_TRIGGER_HEIGHT)
            .max_w(px(self.sidebar_state.width) - space::WIDE)
            .px(space::SM)
            .gap(space::SM)
            .rounded(radius::PERSON)
            .cursor_pointer()
            .text_color(p.strong)
            .hover(|style| style.bg(colors::navigation_hover(p)))
            .when(opened, |el| el.bg(colors::navigation_hover(p)))
            .focus_visible(|style| style.shadow(colors::focus_ring(p)))
            .aria_label(format!(
                "{name} · {}",
                if roster {
                    "Workspace menu"
                } else {
                    "Switch agent"
                }
            ))
            .child(
                div()
                    .relative()
                    .size(avatar::AGENT_HEADER.diameter)
                    .flex_shrink_0()
                    .rounded_full()
                    .bg(p.card)
                    .child(avatar)
                    .when(other_unread && !opened, |el| {
                        el.child(
                            div()
                                .absolute()
                                .right(-space::HAIRLINE)
                                .top(-space::HAIRLINE)
                                .size(icon::DOT)
                                .rounded_full()
                                .bg(p.accent),
                        )
                    }),
            )
            .child(
                div()
                    .h_flex()
                    .min_w_0()
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .pr(header::AGENT_NAME_GAP)
                            .typography(text::AGENT_TITLE)
                            .child(name),
                    )
                    .child(ui_icon(IconName::ChevronsUpDown, icon::SMALL).text_color(p.muted)),
            )
            .child(
                canvas(move |bounds, _, _| capture.set(bounds), |_, _, _, _| {})
                    .absolute()
                    .inset_0()
                    .size_full(),
            )
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(window.listener_for(&state, move |state, _, window, cx| {
                state.toggle(active, window, cx)
            }))
            .on_mouse_down(
                MouseButton::Right,
                window.listener_for(&state, move |state, _, window, cx| {
                    state.open(OpenMode::Click, active, window, cx);
                    cx.stop_propagation();
                }),
            )
            .on_key_down(window.listener_for(
                &state,
                move |state, event: &KeyDownEvent, window, cx| {
                    if matches!(event.keystroke.key.as_str(), "enter" | "space" | "down") {
                        state.open(OpenMode::Click, active, window, cx);
                        cx.stop_propagation();
                    }
                },
            ))
            .when(roster || show_tiles, |el| {
                el.on_hover(
                    window.listener_for(&state, move |state, hovered, window, cx| {
                        state.hover(true, *hovered, active, window, cx)
                    }),
                )
            });
        let mut root = div()
            .h_flex()
            .items_start()
            .h(header::AGENT_HEIGHT)
            .pb(space::LG)
            .child(trigger);
        if !opened {
            return root.into_any_element();
        }
        let menu_focus = state.read(cx).menu_focus.clone();
        let keyboard_index = state.read(cx).keyboard_index;
        let context = MenuContext {
            state: state.clone(),
            view: view.clone(),
            epoch: self.epoch,
        };
        let mut content = div().v_flex().w_full();
        if show_tiles {
            content = content.child(
                div()
                    .h(menu::TITLE_HEIGHT)
                    .insets(menu::TITLE_PADDING)
                    .typography(text::SECTION)
                    .text_color(p.muted)
                    .child("AGENTS"),
            );
            let mut grid = div()
                .id("agent-tile-grid")
                .v_flex()
                .gap(space::XS)
                .max_h(header::AGENT_GRID_MAX_HEIGHT)
                .overflow_y_scroll();
            for (line, agents) in self.sidebar_state.agents.chunks(3).enumerate() {
                let mut row = div().h_flex().items_start().gap(space::XS);
                for (column, agent) in agents.iter().enumerate() {
                    let index = line * 3 + column;
                    row = row.child(self.agent_picker_tile(
                        agent,
                        keyboard_index == Some(index),
                        &state,
                        &view,
                        window,
                        cx,
                    ));
                }
                grid = grid.child(row);
            }
            content = content.child(grid).child(
                div()
                    .h(menu::SEPARATOR_HEIGHT)
                    .pt(space::SM)
                    .pb(space::SM)
                    .child(div().h(space::HAIRLINE).bg(p.border)),
            );
        }
        for (index, entry) in entries.iter().enumerate().skip(tile_count) {
            content = content.child(menu_entry(
                entry,
                index,
                keyboard_index == Some(index),
                &context,
                window,
                cx,
            ));
        }
        let keys = entries.clone();
        let key_view = view.clone();
        let epoch = self.epoch;
        let mut menu = div()
            .id("sidebar-agent-menu")
            .role(Role::Menu)
            .track_focus(&menu_focus)
            .occlude()
            .relative()
            .w(menu::AGENT.width)
            .p(menu::AGENT.padding)
            .border(space::HAIRLINE)
            .border_color(colors::overlay_border(p))
            .rounded(radius::ROW)
            .bg(p.elevated)
            .shadow(colors::menu_shadow(Theme::global(cx).is_dark()))
            .on_hover(
                window.listener_for(&state, move |state, hovered, window, cx| {
                    state.hover(false, *hovered, active, window, cx)
                }),
            )
            .on_mouse_down_out(window.listener_for(
                &state,
                |state, event: &MouseDownEvent, window, cx| {
                    if !state.bounds.get().contains(&event.position) {
                        state.close(false, window, cx);
                    }
                },
            ))
            .on_key_down(window.listener_for(
                &state,
                move |state, event: &KeyDownEvent, window, cx| {
                    picker_key(state, event, &keys, &key_view, epoch, window, cx)
                },
            ))
            .child(content);
        if state.read(cx).help {
            let mut links = div()
                .id("sidebar-agent-help-menu")
                .role(Role::Menu)
                .aria_label("Help")
                .v_flex()
                .w(menu::HELP.width)
                .p(menu::AGENT.padding)
                .border(space::HAIRLINE)
                .border_color(colors::overlay_border(p))
                .rounded(radius::ROW)
                .bg(p.elevated);
            for (index, entry) in help_entries().iter().enumerate() {
                links = links.child(menu_entry(entry, index, false, &context, window, cx));
            }
            menu = menu.child(
                div()
                    .absolute()
                    .left(menu::HELP_LEFT)
                    .top(menu::HELP_TOP)
                    .child(links),
            );
        }
        root = root.child(
            deferred(
                Positioner::side(bounds.get())
                    .placement(Placement::Bottom)
                    .align(Align::Start)
                    .offset(menu::ANCHOR_GAP)
                    .margin(menu::VIEWPORT_MARGIN)
                    .occlude()
                    .child(menu),
            )
            .with_priority(100),
        );
        root.into_any_element()
    }

    fn agent_picker_tile(
        &self,
        agent: &Agent,
        focused: bool,
        state: &Entity<PickerState>,
        view: &WeakEntity<Self>,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let p = Palette::sidebar(cx);
        let selected = self.sidebar_state.selected_agent.as_deref() == Some(agent.id.as_str());
        let unread = !selected
            && self
                .sidebar_state
                .agent_activity
                .iter()
                .chain(self.rows.iter())
                .any(|row| row.agent() == Some(agent.id.as_str()) && row.unread && !row.archived);
        let choice = Choice::Agent(agent.id.clone());
        let view = view.clone();
        let epoch = self.epoch;
        div()
            .id(SharedString::from(format!("agent-tile:{}", agent.id)))
            .role(Role::RadioButton)
            .aria_selected(selected)
            .aria_label(agent.name().to_owned())
            .w(header::AGENT_TILE_WIDTH)
            .h(header::AGENT_TILE_HEIGHT)
            .py(space::MD)
            .px(space::SM)
            .v_flex()
            .items_center()
            .gap(space::LG)
            .relative()
            .cursor_pointer()
            .group("agent-tile")
            .text_color(if selected { p.strong } else { p.muted })
            .hover(|style| style.text_color(p.text))
            .child(
                div()
                    .size(avatar::AGENT_TILE.diameter)
                    .rounded_full()
                    .bg(colors::agent_tile(p))
                    .when(selected || focused, |el| {
                        el.shadow(colors::agent_ring_shadow(p, selected))
                    })
                    .opacity(if selected {
                        opacity::VISIBLE
                    } else {
                        opacity::AGENT_INACTIVE
                    })
                    .group_hover("agent-tile", |style| {
                        style.opacity(if selected {
                            opacity::VISIBLE
                        } else {
                            opacity::AGENT_HOVER
                        })
                    })
                    .child(self.render_agent_avatar(agent, avatar::AGENT_TILE, cx)),
            )
            .child(
                div()
                    .w_full()
                    .h(header::AGENT_TILE_LABEL_HEIGHT)
                    .overflow_hidden()
                    .text_center()
                    .typography(text::AGENT_TILE)
                    .child(agent.name().to_owned()),
            )
            .when(unread, |el| {
                el.child(
                    div()
                        .absolute()
                        .right(space::XXS)
                        .top(-space::XXS)
                        .size(icon::DOT)
                        .rounded_full()
                        .bg(p.accent),
                )
            })
            .on_click(window.listener_for(state, move |state, _, window, cx| {
                activate(state, &choice, &view, epoch, window, cx)
            }))
            .on_mouse_move(window.listener_for(state, move |state, _, _, cx| {
                if state.keyboard_index.is_some() {
                    state.keyboard_index = None;
                    cx.notify();
                }
            }))
            .into_any_element()
    }
}

fn menu_entry(
    entry: &Entry,
    index: usize,
    focused: bool,
    context: &MenuContext,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let p = Palette::sidebar(cx);
    let choice = entry.choice.clone();
    let enabled = entry.enabled;
    let state = context.state.clone();
    let view = context.view.clone();
    let epoch = context.epoch;
    let help = matches!(entry.choice, Choice::Help);
    let link = matches!(entry.choice, Choice::Link(_));
    div()
        .id(("agent-command", index))
        .role(Role::MenuItem)
        .aria_label(entry.label.clone())
        .h_flex()
        .h(menu::ROW_HEIGHT)
        .insets(menu::ITEM_PADDING)
        .rounded(radius::MENU_ITEM)
        .cursor_pointer()
        .typography(text::MENU)
        .text_color(p.text)
        .when(focused, |el| el.bg(p.hover))
        .when(!enabled, |el| el.opacity(opacity::DISABLED))
        .when(enabled, |el| el.hover(|style| style.bg(p.hover)))
        .when_some(entry.icon, |el, icon| {
            el.child(
                div()
                    .w(menu::ICON_COLUMN)
                    .mr(menu::ICON_GAP)
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        ui_icon(icon, crate::ui::theme::tokens::icon::NORMAL).text_color(p.muted),
                    ),
            )
        })
        .child(entry.label.clone())
        .when(matches!(entry.choice, Choice::Help), |el| {
            el.child(div().flex_1())
                .child(ui_icon(IconName::ChevronRight, icon::SMALL))
        })
        .on_hover(
            window.listener_for(&state, move |state, hovered, window, cx| {
                if *hovered && !link && state.help != help {
                    state.help = help;
                    state.keyboard_index = None;
                    window.refresh();
                    cx.notify();
                }
            }),
        )
        .on_click(window.listener_for(&state, move |state, _, window, cx| {
            if enabled {
                activate(state, &choice, &view, epoch, window, cx);
            }
        }))
        .into_any_element()
}
