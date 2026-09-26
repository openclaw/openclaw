use crate::ui::theme::tokens::space;
use crate::ui::theme::{Palette, controls as t, draft_tokens, menu_tokens as tokens};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        input::{Input, InputState},
        popover::Popover,
    },
    prelude::FluentBuilder as _,
    *,
};
use std::rc::Rc;

pub fn popover(
    id: impl Into<ElementId>,
    anchor: Anchor,
    open: bool,
    trigger: Button,
    content: AnyElement,
    on_change: impl Fn(bool, &mut Window, &mut App) + 'static,
) -> Popover {
    let on_change = Rc::new(on_change);
    let on_activate = on_change.clone();
    Popover::new(id)
        .anchor(anchor)
        .appearance(false)
        .open(open)
        .on_open_change(move |open, window, cx| on_change(*open, window, cx))
        .trigger(trigger.on_click(move |event, window, cx| {
            // AXPress arrives as a keyboard click. Pointer activation stays with BasePopover.
            if event.is_keyboard() {
                cx.stop_propagation();
                on_activate(!open, window, cx);
            }
        }))
        .child(content)
}

pub enum MenuStyle {
    Selection,
    Capability,
    Permission,
}

pub fn panel(id: impl Into<SharedString>, width: f32, style: MenuStyle, cx: &App) -> Stateful<Div> {
    let p = Palette::get(cx);
    let panel = div()
        .id(id.into())
        .v_flex()
        .w(px(width))
        .rounded(px(tokens::PANEL_RADIUS))
        .bg(p.elevated)
        .border(space::HAIRLINE)
        .border_color(p.border_strong)
        .shadow_lg();
    match style {
        MenuStyle::Selection => panel
            .max_h(px(tokens::SELECTION_PANEL_MAX_HEIGHT))
            .overflow_y_scroll()
            .p(px(tokens::SELECTION_PANEL_PADDING))
            .gap(px(tokens::SELECTION_PANEL_GAP)),
        MenuStyle::Capability => panel
            .max_h(px(tokens::CAPABILITY_PANEL_MAX_HEIGHT))
            .overflow_y_scroll()
            .p(px(tokens::CAPABILITY_PANEL_PADDING)),
        MenuStyle::Permission => panel.p(px(tokens::PERMISSION_PANEL_PADDING)),
    }
}

pub fn selection_row(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    selected: bool,
    cx: &App,
) -> Button {
    let p = Palette::get(cx);
    let label = label.into();
    Button::new(id.into())
        .ghost()
        .small()
        .w_full()
        .min_h(px(tokens::ROW_HEIGHT))
        .justify_start()
        .px(px(tokens::ROW_PADDING_X))
        .text_size(px(tokens::ROW_TEXT_SIZE))
        .text_color(p.text)
        .accessibility_label(label.clone())
        .child(div().flex_1().text_left().child(label))
        .child(div().w(px(tokens::ROW_CHECK_WIDTH)).when(selected, |el| {
            el.child(
                Icon::new(IconName::Check)
                    .size(px(tokens::ICON_SIZE))
                    .text_color(p.accent),
            )
        }))
}

pub fn capability_row(
    id: impl Into<SharedString>,
    label: &str,
    icon: Option<IconName>,
    note: Option<&str>,
    checked: Option<bool>,
    disabled: bool,
    cx: &App,
) -> Button {
    let p = Palette::get(cx);
    Button::new(id.into())
        .ghost()
        .small()
        .accessibility_label(label.to_owned())
        .w_full()
        .h_auto()
        .min_h(px(tokens::CAPABILITY_ROW_HEIGHT))
        .px(px(tokens::CAPABILITY_ROW_PADDING_X))
        .py(px(tokens::CAPABILITY_ROW_PADDING_Y))
        .rounded(px(tokens::CAPABILITY_ROW_RADIUS))
        .disabled(disabled)
        .child(
            div()
                .h_flex()
                .w_full()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap(px(tokens::ROW_GAP))
                .children(icon.map(|icon| {
                    Icon::new(icon)
                        .size(px(tokens::CAPABILITY_ICON_SIZE))
                        .flex_shrink_0()
                        .text_color(if icon == IconName::ShieldAlert {
                            p.accent
                        } else {
                            p.muted
                        })
                }))
                .child(
                    div()
                        .v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(tokens::CAPABILITY_COPY_GAP))
                        .items_start()
                        .child(
                            div()
                                .text_size(px(tokens::CAPABILITY_TITLE_SIZE))
                                .line_height(px(tokens::CAPABILITY_TITLE_LINE_HEIGHT))
                                .font_weight(tokens::CAPABILITY_TITLE_WEIGHT)
                                .text_color(p.strong)
                                .child(label.to_owned()),
                        )
                        .children(note.map(|note| {
                            div()
                                .whitespace_normal()
                                .text_size(px(tokens::CAPABILITY_NOTE_SIZE))
                                .line_height(px(tokens::CAPABILITY_NOTE_LINE_HEIGHT))
                                .text_color(p.muted)
                                .child(note.to_owned())
                        })),
                )
                .children(checked.map(|checked| {
                    // The row owns activation; this mirrors the web's pointer-inert switch.
                    div()
                        .w(px(tokens::TOGGLE_WIDTH))
                        .h(px(tokens::TOGGLE_HEIGHT))
                        .flex_shrink_0()
                        .rounded_full()
                        .bg(if checked { p.accent } else { p.border_strong })
                        .p(px(tokens::TOGGLE_INSET))
                        .h_flex()
                        .when(checked, |el| el.justify_end())
                        .child(
                            div()
                                .size(px(tokens::TOGGLE_THUMB_SIZE))
                                .rounded_full()
                                .bg(p.accent_fg),
                        )
                })),
        )
}

pub fn section_header(label: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .px(px(tokens::ROW_PADDING_X))
        .pt(px(tokens::HEADER_PADDING_TOP))
        .pb(px(tokens::HEADER_PADDING_BOTTOM))
        .text_size(px(tokens::HEADER_TEXT_SIZE))
        .font_weight(tokens::HEADER_WEIGHT)
        .text_color(Palette::get(cx).muted)
        .child(label.into())
}

pub fn note(label: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .px(px(tokens::ROW_PADDING_X))
        .pt(px(tokens::NOTE_PADDING_TOP))
        .pb(px(tokens::NOTE_PADDING_BOTTOM))
        .text_size(px(tokens::NOTE_TEXT_SIZE))
        .line_height(px(tokens::NOTE_LINE_HEIGHT))
        .text_color(Palette::get(cx).muted)
        .child(label.into())
}

pub fn capability_note(label: &str, cx: &App) -> Div {
    div()
        .px(px(tokens::CAPABILITY_STATE_PADDING_X))
        .py(px(tokens::CAPABILITY_STATE_PADDING_Y))
        .text_size(px(tokens::ROW_TEXT_SIZE))
        .line_height(px(tokens::CAPABILITY_STATE_LINE_HEIGHT))
        .text_color(Palette::get(cx).muted)
        .child(label.to_owned())
}

pub fn divider(cx: &App) -> Div {
    div()
        .h(px(tokens::DIVIDER_HEIGHT))
        .mx(px(tokens::DIVIDER_MARGIN_X))
        .my(px(tokens::DIVIDER_MARGIN_Y))
        .bg(Palette::get(cx).border)
}

pub fn inline_detail_row(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    icon: IconName,
    detail: impl Into<SharedString>,
    selected: bool,
    cx: &App,
) -> Button {
    let p = Palette::get(cx);
    let label = label.into();
    Button::new(id.into())
        .ghost()
        .small()
        .w_full()
        .h(px(tokens::ROW_HEIGHT))
        .px(px(tokens::ROW_PADDING_X))
        .accessibility_label(label.clone())
        .when(selected, |el| el.bg(p.hover))
        .child(
            div()
                .h_flex()
                .w_full()
                .items_center()
                .gap(px(tokens::ROW_GAP))
                .child(Icon::new(icon).size(px(tokens::ICON_SIZE)))
                .child(div().text_size(px(tokens::ROW_TEXT_SIZE)).child(label))
                .child(
                    div()
                        .flex_1()
                        .text_size(px(tokens::DETAIL_TEXT_SIZE))
                        .text_color(p.muted)
                        .truncate()
                        .child(detail.into()),
                )
                .child(
                    div()
                        .w(px(tokens::INLINE_CHECK_WIDTH))
                        .when(selected, |el| {
                            el.child(
                                Icon::new(IconName::Check)
                                    .size(px(tokens::ICON_SIZE))
                                    .text_color(p.accent),
                            )
                        }),
                ),
        )
}

pub fn input_field(
    label: impl Into<SharedString>,
    accessible: impl Into<SharedString>,
    input: &Entity<InputState>,
    cx: &App,
) -> Div {
    div()
        .h_flex()
        .items_center()
        .gap(px(tokens::ROW_GAP))
        .px(px(tokens::ROW_PADDING_X))
        .py(px(tokens::FIELD_PADDING_Y))
        .child(
            div()
                .w(px(tokens::FIELD_LABEL_WIDTH))
                .flex_shrink_0()
                .whitespace_nowrap()
                .text_size(px(tokens::ROW_TEXT_SIZE))
                .text_color(Palette::get(cx).muted)
                .child(label.into()),
        )
        .child(
            Input::new(input)
                .small()
                .h(px(tokens::ROW_HEIGHT))
                .flex_1()
                .text_size(px(tokens::ROW_TEXT_SIZE))
                .aria_label(accessible),
        )
}

pub(crate) fn menu_surface(p: Palette) -> Div {
    div()
        .v_flex()
        .bg(p.controls().menu)
        .border(space::HAIRLINE)
        .border_color(p.controls().menu_border)
        .rounded(px(t::MENU_RADIUS))
        .shadow_lg()
        .overflow_hidden()
}

pub fn identity_row(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    avatar: AnyElement,
    selected: bool,
    cx: &App,
) -> Button {
    let p = Palette::get(cx);
    let label = label.into();
    Button::new(id.into())
        .ghost()
        .small()
        .w_full()
        .h(px(draft_tokens::IDENTITY_ROW_HEIGHT))
        .px(px(tokens::ROW_PADDING_X))
        .accessibility_label(label.clone())
        .when(selected, |el| el.bg(p.hover))
        .child(
            div()
                .h_flex()
                .w_full()
                .items_center()
                .gap(px(draft_tokens::IDENTITY_ROW_GAP))
                .child(avatar)
                .child(
                    div()
                        .flex_1()
                        .text_left()
                        .text_size(px(draft_tokens::BODY_TEXT_SIZE))
                        .child(label),
                )
                .child(
                    div()
                        .w(px(draft_tokens::IDENTITY_CHECK_WIDTH))
                        .when(selected, |el| {
                            el.child(
                                Icon::new(IconName::Check)
                                    .size(px(tokens::ICON_SIZE))
                                    .text_color(p.accent),
                            )
                        }),
                ),
        )
}
