use super::components::action_menu::{ActionMenu as PopupMenu, ActionMenuItem as PopupMenuItem};
use super::{
    components::icons::icon,
    session_menu::MenuTarget,
    theme::{
        Palette,
        tokens::{TypographyExt, colors, menu as t, radius, space, text, weight},
    },
};
use crate::model::{
    session_menu::{self as access, MenuAction},
    sessions::SessionRow,
};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Sizable, StyledExt, Theme,
        button::{Button, ButtonVariants},
        input::{Input, InputEvent, InputState},
    },
    prelude::FluentBuilder,
    *,
};
use serde_json::{Value, json};

const COLORS: [Option<&str>; 9] = [
    None,
    Some("red"),
    Some("blue"),
    Some("green"),
    Some("yellow"),
    Some("purple"),
    Some("orange"),
    Some("pink"),
    Some("cyan"),
];
const EMOJI: [&str; 11] = [
    "🦞", "🚀", "🐛", "✅", "🔥", "📦", "🧪", "📝", "🔍", "⚡", "🎯",
];
const GLYPHS: [(&str, IconName); 6] = [
    ("braces", IconName::Braces),
    ("book", IconName::Book),
    ("monitor", IconName::Monitor),
    ("bot", IconName::Bot),
    ("kanban", IconName::Kanban),
    ("coins", IconName::Coins),
];
const COLUMNS: usize = 6;
const CUSTOM_INDEX: usize = EMOJI.len();
const CLEAR_INDEX: usize = CUSTOM_INDEX + 1;
const ICON_COUNT: usize = CLEAR_INDEX + 1 + GLYPHS.len();

pub(super) fn appearance_menu(
    menu: PopupMenu,
    row: SessionRow,
    target: MenuTarget,
    window: &mut Window,
    cx: &mut Context<PopupMenu>,
) -> PopupMenu {
    let picker = cx.new(|cx| AppearancePicker::new(row, target, window, cx));
    let focus = picker.read(cx).icon_focus[match picker.read(cx).row.icon.as_deref() {
        None => CLEAR_INDEX,
        Some(icon) => EMOJI
            .iter()
            .position(|value| *value == icon)
            .or_else(|| {
                GLYPHS
                    .iter()
                    .position(|(value, _)| *value == icon)
                    .map(|index| CLEAR_INDEX + 1 + index)
            })
            .unwrap_or(CUSTOM_INDEX),
    }]
    .clone();
    let width = t::APPEARANCE_WIDTH + (t::ACTION_SUBMENU_PADDING + space::HAIRLINE) * 2.;
    let opening_picker = picker.clone();
    menu.on_open(move |window, cx| {
        opening_picker.update(cx, |picker, cx| picker.reset_custom_icon(false, window, cx));
    })
    .initial_focus(focus)
    .min_w(width)
    .max_w(width)
    .item(PopupMenuItem::element(move |_, _| picker.clone()).disabled(true))
}

struct AppearancePicker {
    row: SessionRow,
    target: MenuTarget,
    input: Entity<InputState>,
    custom: bool,
    icon_focus: Vec<FocusHandle>,
    color_focus: Vec<FocusHandle>,
    _subscriptions: Vec<Subscription>,
}

impl AppearancePicker {
    fn new(
        row: SessionRow,
        target: MenuTarget,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx));
        let mut subscriptions =
            vec![
                cx.subscribe_in(&input, window, |this, _, event, _, cx| match event {
                    InputEvent::Change => cx.notify(),
                    InputEvent::PressEnter { .. } => this.apply_custom(cx),
                    _ => {}
                }),
            ];
        if let Some(view) = target.view.upgrade() {
            subscriptions.push(cx.observe(&view, |_, _, cx| cx.notify()));
        }
        Self {
            row,
            target,
            input,
            custom: false,
            icon_focus: (0..ICON_COUNT).map(|_| cx.focus_handle()).collect(),
            color_focus: (0..COLORS.len()).map(|_| cx.focus_handle()).collect(),
            _subscriptions: subscriptions,
        }
    }

    fn current_row(&self, cx: &App) -> SessionRow {
        self.target
            .view
            .upgrade()
            .and_then(|view| {
                let app = view.read(cx);
                app.rows
                    .iter()
                    .chain(app.sidebar_state.children.values().flatten())
                    .find(|row| row.key == self.row.key && row.session_id == self.row.session_id)
                    .cloned()
            })
            .unwrap_or_else(|| self.row.clone())
    }

    fn patch(&self, fields: Value, cx: &mut Context<Self>) {
        let row = self.current_row(cx);
        let _ = self.target.update(cx, |app, cx| {
            for (field, action) in [("icon", MenuAction::Icon), ("color", MenuAction::Color)] {
                if fields.get(field).is_some()
                    && let Some(reason) = access::disabled_reason(
                        action,
                        &row,
                        app.session.as_ref().map(|session| session.hello()),
                        &app.agent_home(),
                    )
                {
                    app.mutation_error(reason);
                    cx.notify();
                    return;
                }
            }
            app.patch_session(row, fields, cx);
        });
    }

    fn access_reason(&self, action: MenuAction, cx: &App) -> Option<String> {
        let row = self.current_row(cx);
        let Some(view) = self.target.view.upgrade() else {
            return Some("Connect to the Gateway to change sessions.".into());
        };
        let app = view.read(cx);
        access::disabled_reason(
            action,
            &row,
            app.session.as_ref().map(|session| session.hello()),
            &app.agent_home(),
        )
    }

    fn apply_custom(&self, cx: &mut Context<Self>) {
        let value = self.input.read(cx).value().trim().to_owned();
        if !value.is_empty() {
            // sessions.patch owns emoji/SVG validation and returns canonical icon bytes.
            self.patch(json!({"icon": value}), cx);
        }
    }

    fn select_icon(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.access_reason(MenuAction::Icon, cx).is_some() {
            return;
        }
        self.icon_focus[index].focus(window, cx);
        if index == CUSTOM_INDEX {
            self.reset_custom_icon(true, window, cx);
            self.input.focus_handle(cx).focus(window, cx);
            return;
        }
        let value = if index < EMOJI.len() {
            Some(EMOJI[index])
        } else if index == CLEAR_INDEX {
            None
        } else {
            Some(GLYPHS[index - CLEAR_INDEX - 1].0)
        };
        self.patch(json!({"icon": value}), cx);
    }

    fn grid_key(
        &mut self,
        event: &KeyDownEvent,
        colors: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .access_reason(
                if colors {
                    MenuAction::Color
                } else {
                    MenuAction::Icon
                },
                cx,
            )
            .is_some()
        {
            return;
        }
        let focus = if colors {
            &self.color_focus
        } else {
            &self.icon_focus
        };
        let Some(index) = focus
            .iter()
            .position(|handle| handle.contains_focused(window, cx))
        else {
            return;
        };
        let key = event.keystroke.key.as_str();
        let next = match key {
            "left" => Some((index + focus.len() - 1) % focus.len()),
            "right" => Some((index + 1) % focus.len()),
            "up" | "down" => {
                let rows = focus.len().div_ceil(COLUMNS);
                let next_row = (index / COLUMNS + if key == "down" { 1 } else { rows - 1 }) % rows;
                Some((next_row * COLUMNS + index % COLUMNS).min(focus.len() - 1))
            }
            "enter" | "space" => {
                cx.stop_propagation();
                if colors {
                    self.patch(json!({"color": COLORS[index]}), cx);
                } else {
                    self.select_icon(index, window, cx);
                }
                return;
            }
            _ => None,
        };
        if let Some(next) = next {
            cx.stop_propagation();
            focus[next].focus(window, cx);
        }
    }

    fn color_grid(&self, row: &SessionRow, cx: &mut Context<Self>) -> Div {
        let p = Palette::get(cx);
        let reason = self.access_reason(MenuAction::Color, cx);
        let mut grid = div()
            .h_flex()
            .flex_wrap()
            .w(t::APPEARANCE_GRID_WIDTH)
            .gap(t::APPEARANCE_GRID_GAP)
            .mt(space::XS)
            .mb(t::APPEARANCE_COLOR_MARGIN_BOTTOM)
            .capture_key_down(
                cx.listener(|this, event, window, cx| this.grid_key(event, true, window, cx)),
            );
        for (index, color) in COLORS.iter().copied().enumerate() {
            let selected = row.color.as_deref() == color;
            let label = color
                .map(|name| {
                    let mut chars = name.chars();
                    format!("{}{}", chars.next().unwrap().to_uppercase(), chars.as_str())
                })
                .unwrap_or_else(|| "No color".into());
            let swatch = div()
                .size(t::APPEARANCE_SWATCH)
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(color
                    .and_then(|name| colors::session_color(name, Theme::global(cx).is_dark()))
                    .unwrap_or(transparent_black()))
                .text_color(if color.is_some() { p.bg } else { p.muted })
                .when(color.is_none(), |el| {
                    el.child(icon(IconName::CircleX, t::APPEARANCE_SWATCH_ICON))
                })
                .when(color.is_some() && selected, |el| {
                    el.child(icon(IconName::Check, t::APPEARANCE_SWATCH_ICON))
                });
            grid = grid.child(
                div()
                    .id(("appearance-color-focus", index))
                    .track_focus(&self.color_focus[index])
                    .tab_index(if selected && reason.is_none() { 0 } else { -1 })
                    .focus_visible(|el| {
                        el.rounded_full()
                            .border(space::HAIRLINE)
                            .border_color(p.accent)
                    })
                    .child(
                        Button::new(("appearance-color", index))
                            .ghost()
                            .size(t::APPEARANCE_CELL)
                            .p_0()
                            .rounded_full()
                            .tab_stop(false)
                            .disabled(reason.is_some())
                            .when_some(reason.clone(), |button, reason| button.tooltip(reason))
                            .accessibility_label(label)
                            .toggled(selected)
                            .when(selected && color.is_none(), |button| {
                                button
                                    .bg(p.hover)
                                    .border(space::HAIRLINE)
                                    .border_color(p.border)
                            })
                            .child(swatch)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.color_focus[index].focus(window, cx);
                                this.patch(json!({"color":color}), cx);
                            })),
                    ),
            );
        }
        grid
    }

    fn icon_choice(
        &self,
        index: usize,
        current: Option<&str>,
        reason: Option<&str>,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let p = Palette::get(cx);
        let (label, value, graphic) = if index < EMOJI.len() {
            (
                EMOJI[index],
                Some(EMOJI[index]),
                div()
                    .text_size(t::APPEARANCE_EMOJI_SIZE)
                    .child(EMOJI[index])
                    .into_any_element(),
            )
        } else if index == CUSTOM_INDEX {
            (
                "Custom emoji or SVG…",
                Some("custom"),
                icon(IconName::Ellipsis, t::APPEARANCE_GLYPH_SIZE).into_any_element(),
            )
        } else if index == CLEAR_INDEX {
            (
                "No icon",
                None,
                icon(IconName::CircleX, t::APPEARANCE_GLYPH_SIZE).into_any_element(),
            )
        } else {
            let (label, name) = GLYPHS[index - CLEAR_INDEX - 1];
            (
                label,
                Some(label),
                icon(name, t::APPEARANCE_GLYPH_SIZE).into_any_element(),
            )
        };
        let selected = index != CUSTOM_INDEX && current == value;
        div()
            .id(("appearance-icon-focus", index))
            .track_focus(&self.icon_focus[index])
            .tab_index(
                if reason.is_none()
                    && (selected
                        || (index == 0
                            && current.is_some()
                            && !EMOJI.contains(&current.unwrap_or_default())
                            && !GLYPHS.iter().any(|(name, _)| Some(*name) == current)))
                {
                    0
                } else {
                    -1
                },
            )
            .focus_visible(|el| {
                el.rounded(radius::MENU_ITEM)
                    .border(space::HAIRLINE)
                    .border_color(p.accent)
            })
            .child(
                Button::new(("appearance-icon", index))
                    .ghost()
                    .size(t::APPEARANCE_CELL)
                    .p_0()
                    .rounded(radius::MENU_ITEM)
                    .tab_stop(false)
                    .disabled(reason.is_some())
                    .when_some(reason, |button, reason| button.tooltip(reason.to_owned()))
                    .toggled(selected)
                    .accessibility_label(label)
                    .text_color(if index == CUSTOM_INDEX {
                        p.muted
                    } else {
                        p.text
                    })
                    .when(selected, |button| {
                        button
                            .bg(p.accent.opacity(t::APPEARANCE_SELECTED_BG))
                            .border(space::HAIRLINE)
                            .border_color(p.accent.opacity(t::APPEARANCE_SELECTED_BORDER))
                    })
                    .when(index == CUSTOM_INDEX, |button| {
                        button
                            .border(space::HAIRLINE)
                            .border_dashed()
                            .border_color(p.border)
                    })
                    .child(graphic)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.select_icon(index, window, cx);
                    })),
            )
    }

    fn icon_grid(&self, row: &SessionRow, cx: &mut Context<Self>) -> Div {
        let reason = self.access_reason(MenuAction::Icon, cx);
        let mut emoji = div()
            .h_flex()
            .flex_wrap()
            .w(t::APPEARANCE_GRID_WIDTH)
            .gap(t::APPEARANCE_GRID_GAP);
        for index in 0..=CUSTOM_INDEX {
            emoji =
                emoji.child(self.icon_choice(index, row.icon.as_deref(), reason.as_deref(), cx));
        }
        let mut glyphs = div()
            .h_flex()
            .flex_wrap()
            .w(t::APPEARANCE_GRID_WIDTH)
            .gap(t::APPEARANCE_GRID_GAP);
        for index in CLEAR_INDEX..ICON_COUNT {
            glyphs =
                glyphs.child(self.icon_choice(index, row.icon.as_deref(), reason.as_deref(), cx));
        }
        div()
            .v_flex()
            .gap(t::APPEARANCE_GRID_GAP)
            .p(space::XXS)
            .capture_key_down(
                cx.listener(|this, event, window, cx| this.grid_key(event, false, window, cx)),
            )
            .child(section_label("EMOJI", cx))
            .child(emoji)
            .child(section_label("ICONS", cx).mt(space::XS))
            .child(glyphs)
    }

    fn reset_custom_icon(&mut self, custom: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.custom = custom;
        self.input
            .update(cx, |input, cx| input.set_value("", window, cx));
        cx.notify();
    }

    fn show_icon_grid(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.reset_custom_icon(false, window, cx);
        self.icon_focus[CUSTOM_INDEX].focus(window, cx);
    }

    fn custom_entry(&self, cx: &mut Context<Self>) -> Div {
        let p = Palette::get(cx);
        let reason = self.access_reason(MenuAction::Icon, cx);
        let disabled = reason.is_some() || self.input.read(cx).value().trim().is_empty();
        div()
            .v_flex()
            .p(space::XXS)
            .gap(t::APPEARANCE_CUSTOM_GAP)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    this.show_icon_grid(window, cx);
                    cx.stop_propagation();
                }
            }))
            .on_action(
                cx.listener(|this, _: &gpui_kit::component::input::Escape, window, cx| {
                    this.show_icon_grid(window, cx);
                    cx.stop_propagation();
                }),
            )
            .child(
                div()
                    .h_flex()
                    .gap(t::APPEARANCE_CUSTOM_GAP)
                    .min_h(t::APPEARANCE_CELL)
                    .child(
                        Button::new("appearance-back")
                            .ghost()
                            .size(t::APPEARANCE_BACK_SIZE)
                            .p_0()
                            .accessibility_label("Back")
                            .child(icon(IconName::ArrowLeft, t::APPEARANCE_BACK_ICON))
                            .on_click(cx.listener(|this, _, window, cx| {
                                cx.stop_propagation();
                                this.show_icon_grid(window, cx);
                            })),
                    )
                    .child(
                        div()
                            .typography(text::MENU)
                            .font_weight(weight::SEMIBOLD)
                            .child("Custom icon"),
                    ),
            )
            .child(
                div()
                    .h_flex()
                    .gap(t::APPEARANCE_CUSTOM_GAP)
                    .child(
                        Input::new(&self.input)
                            .disabled(reason.is_some())
                            .small()
                            .h(t::APPEARANCE_INPUT_HEIGHT)
                            .flex_1()
                            .text_size(t::APPEARANCE_EMOJI_SIZE)
                            .aria_label("Custom icon"),
                    )
                    .child(
                        Button::new("appearance-set")
                            .primary()
                            .small()
                            .h(t::APPEARANCE_INPUT_HEIGHT)
                            .min_w(t::APPEARANCE_SET_WIDTH)
                            .disabled(disabled)
                            .when_some(reason.clone(), |button, reason| button.tooltip(reason))
                            .label("Set")
                            .on_click(cx.listener(|this, _, _, cx| {
                                cx.stop_propagation();
                                this.apply_custom(cx);
                            })),
                    ),
            )
            .child(
                div()
                    .pt(t::APPEARANCE_PADDING)
                    .text_size(t::APPEARANCE_LABEL_SIZE)
                    .text_color(p.muted)
                    .whitespace_normal()
                    .child("Paste an emoji or SVG. Press ⌃⌘Space for the system emoji picker."),
            )
    }
}

fn section_label(label: &'static str, cx: &App) -> Div {
    div()
        .pt(space::XS)
        .px(space::XS)
        .pb(space::XXS)
        .text_size(t::APPEARANCE_LABEL_SIZE)
        .line_height(t::APPEARANCE_LABEL_SIZE)
        .font_weight(weight::SEMIBOLD)
        .text_color(Palette::get(cx).muted)
        .child(label)
}

impl Render for AppearancePicker {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Palette::get(cx);
        let row = self.current_row(cx);
        let reset_reason = self
            .access_reason(MenuAction::Icon, cx)
            .or_else(|| self.access_reason(MenuAction::Color, cx));
        let editor = if self.custom {
            self.custom_entry(cx)
        } else {
            self.icon_grid(&row, cx)
        };
        div()
            .id("session-appearance-picker")
            .v_flex()
            .w_full()
            .p(t::APPEARANCE_PADDING)
            .text_color(p.text)
            .child(section_label("COLOR", cx))
            .child(self.color_grid(&row, cx))
            .child(div().min_h(t::APPEARANCE_ICON_PANEL_HEIGHT).child(editor))
            .child(super::components::menu::divider(cx))
            .child(
                Button::new("appearance-reset")
                    .ghost()
                    .small()
                    .w_full()
                    .min_h(t::APPEARANCE_CELL)
                    .justify_start()
                    .px(t::APPEARANCE_RESET_PADDING)
                    .text_size(text::MENU.size)
                    .accessibility_label("Reset to default")
                    .child(div().w_full().text_left().child("Reset to default"))
                    .disabled(reset_reason.is_some())
                    .when_some(reset_reason, |button, reason| button.tooltip(reason))
                    .on_click(cx.listener(|this, _, _, cx| {
                        cx.stop_propagation();
                        this.patch(json!({"icon":null,"color":null}), cx);
                    })),
            )
    }
}
