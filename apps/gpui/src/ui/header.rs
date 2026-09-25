use super::{AppView, session_actions::session_menu, theme::Palette};
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
        let selected = self.selected_row().cloned();
        let view = cx.entity().downgrade();
        let main_key = self.agent_home();
        let title = if self.web.settings_open {
            div()
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(p.text)
                .child(self.web.page_title().to_owned())
                .into_any_element()
        } else if self.sidebar_state.rename_in_header
            && selected.as_ref().is_some_and(|row| {
                self.sidebar_state
                    .rename_row
                    .as_ref()
                    .is_some_and(|editing| editing.key == row.key)
            })
        {
            Input::new(&self.sidebar_state.rename_input)
                .id("header-session-rename")
                .w_full()
                .h(px(28.))
                .small()
                .aria_label("Rename conversation")
                .into_any_element()
        } else {
            div()
                .id("chat-title")
                .truncate()
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
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
            .h(px(44.))
            .bg(p.bg)
            .flex_1()
            .min_w_0()
            .px(px(16.))
            .gap(px(8.))
            .child(
                div()
                    .text_size(px(13.))
                    .text_color(p.muted)
                    .child(self.selected_agent_name()),
            )
            .child(
                Icon::new(IconName::ChevronRight)
                    .size(px(14.))
                    .text_color(p.muted),
            )
            .child(div().flex_1().min_w_0().child(title))
            .when(self.web.settings_open, |el| {
                el.child(
                    Button::new("settings-done")
                        .ghost()
                        .small()
                        .label("Done")
                        .accessibility_label("Return to chat")
                        .on_click(
                            cx.listener(|this, _, window, cx| this.close_settings(window, cx)),
                        ),
                )
            })
            .when(!self.web.settings_open && !self.new_session.active, |el| {
                el.child(
                    Button::new("header-panels")
                        .ghost()
                        .small()
                        .size(px(28.))
                        .icon(Icon::new(IconName::PanelRight).size(px(16.)))
                        .accessibility_label("Open panels")
                        .on_click(cx.listener(|this, _, _, cx| this.toggle_dock(cx))),
                )
            })
            .when(
                !self.web.settings_open && self.chat.active_run.is_some(),
                |el| el.child(Spinner::new().small().color(p.muted)),
            )
            .when_some(
                selected.filter(|_| !self.web.settings_open && !self.new_session.active),
                |el, row| {
                    el.child(
                        Button::new("chat-header-menu")
                            .ghost()
                            .small()
                            .size(px(28.))
                            .icon(Icon::new(IconName::Ellipsis).size(px(16.)))
                            .accessibility_label("Conversation actions")
                            .dropdown_menu(move |menu, window, cx| {
                                session_menu(menu, row.clone(), view.clone(), &main_key, window, cx)
                            }),
                    )
                },
            )
            .into_any_element()
    }
}
