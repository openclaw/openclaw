use super::{
    AppView,
    session_actions::session_menu,
    theme::{
        Palette,
        tokens::{TypographyExt, header, icon, row, space, text},
    },
};
use gpui_kit::{
    assets::IconName,
    component::{
        Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        input::Input,
        menu::DropdownMenu,
        spinner::Spinner,
    },
    prelude::FluentBuilder,
    *,
};

impl AppView {
    pub(super) fn chat_header(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        if self.web.settings_open {
            return div()
                .h_flex()
                .h(header::WINDOW_HEIGHT)
                .bg(p.bg)
                .flex_1()
                .min_w_0()
                .px(space::XXL)
                .gap(space::MD)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .typography(text::NAV)
                        .text_color(p.text)
                        .child(self.web.page_title().to_owned()),
                )
                .child(
                    Button::new("settings-done")
                        .ghost()
                        .small()
                        .label("Done")
                        .accessibility_label("Return to chat")
                        .on_click(
                            cx.listener(|this, _, window, cx| this.close_settings(window, cx)),
                        ),
                )
                .into_any_element();
        }
        let selected = self.selected_row().cloned();
        let view = cx.entity().downgrade();
        let main_key = self.agent_home();
        let title = if self.sidebar_state.rename_in_header
            && selected.as_ref().is_some_and(|row| {
                self.sidebar_state
                    .rename_row
                    .as_ref()
                    .is_some_and(|editing| editing.key == row.key)
            }) {
            Input::new(&self.sidebar_state.rename_input)
                .id("header-session-rename")
                .w_full()
                .h(row::RENAME_HEIGHT)
                .small()
                .aria_label("Rename conversation")
                .into_any_element()
        } else {
            div()
                .id("chat-title")
                .truncate()
                .text_size(text::NAV.size)
                .font_weight(text::NAV.weight)
                .text_color(p.text)
                .hover(|el| el.text_color(p.strong))
                .child(self.session_title())
                .on_click(cx.listener(|this, _, window, cx| {
                    if let Some(row) = this.selected_row().cloned() {
                        this.begin_rename(row, window, cx);
                        this.sidebar_state.rename_in_header = true;
                    }
                }))
                .into_any_element()
        };
        div()
            .h_flex()
            .h(header::WINDOW_HEIGHT)
            .bg(p.bg)
            .flex_1()
            .min_w_0()
            .px(space::XXL)
            .gap(space::MD)
            .child(
                div()
                    .text_size(text::NAV.size)
                    .text_color(p.muted)
                    .child(self.selected_agent_name()),
            )
            .child(
                Icon::new(IconName::ChevronRight)
                    .size(icon::ACTION)
                    .text_color(p.muted),
            )
            .child(div().flex_1().min_w_0().child(title))
            .when(!self.new_session.active, |el| {
                el.child(
                    Button::new("header-panels")
                        .ghost()
                        .small()
                        .size(row::RENAME_HEIGHT)
                        .icon(Icon::new(IconName::PanelRight).size(icon::NORMAL))
                        .accessibility_label("Open panels")
                        .on_click(cx.listener(|this, _, _, cx| this.toggle_dock(cx))),
                )
            })
            .when(self.chat.active_run.is_some(), |el| {
                el.child(Spinner::new().small().color(p.muted))
            })
            .when_some(selected.filter(|_| !self.new_session.active), |el, row| {
                el.child(
                    Button::new("chat-header-menu")
                        .ghost()
                        .small()
                        .size(row::RENAME_HEIGHT)
                        .icon(Icon::new(IconName::Ellipsis).size(icon::NORMAL))
                        .accessibility_label("Conversation actions")
                        .dropdown_menu(move |menu, window, cx| {
                            session_menu(menu, row.clone(), view.clone(), &main_key, window, cx)
                        }),
                )
            })
            .into_any_element()
    }
}
