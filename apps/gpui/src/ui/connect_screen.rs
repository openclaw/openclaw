use super::{AppView, app_view::ConnectionStage, theme::Palette};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, StyledExt,
        button::{Button, ButtonVariants},
        input::Input,
        spinner::Spinner,
    },
    prelude::FluentBuilder,
    *,
};

impl AppView {
    pub(super) fn connect_screen(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Palette::get(cx);
        let busy = matches!(
            self.connection_stage,
            ConnectionStage::Checking
                | ConnectionStage::WaitingForBrowser
                | ConnectionStage::Connecting
                | ConnectionStage::SigningOut
        );
        let sign_in = self.connection_stage == ConnectionStage::AccessRequired;
        let waiting = self.connection_stage == ConnectionStage::WaitingForBrowser;
        let label = match self.connection_stage {
            ConnectionStage::Checking => "Checking…",
            ConnectionStage::AccessRequired if self.connection_message.is_some() => "Sign in again",
            ConnectionStage::AccessRequired => "Sign in with browser",
            ConnectionStage::WaitingForBrowser => "Waiting for browser sign-in…",
            ConnectionStage::Connecting => "Connecting…",
            ConnectionStage::SigningOut => "Signing out…",
            ConnectionStage::Error => "Retry",
            _ => "Connect",
        };
        div()
            .id("connect-screen")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_y_scroll()
            .flex()
            .items_center()
            .justify_center()
            .p_8()
            .child(
                div()
                    .v_flex()
                    .w_full()
                    .max_w(px(440.))
                    .gap(px(20.))
                    .child(
                        div()
                            .size(px(48.))
                            .rounded(px(14.))
                            .bg(p.accent_subtle)
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px(30.))
                            .text_color(p.accent)
                            .child("◈"),
                    )
                    .child(
                        div()
                            .v_flex()
                            .gap(px(8.))
                            .child(
                                div()
                                    .text_size(px(26.))
                                    .text_color(p.strong)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Connect to a Gateway"),
                            )
                            .child(
                                div()
                                    .text_color(p.muted)
                                    .line_height(px(22.))
                                    .child("Your agents and conversations, together on your desktop."),
                            ),
                    )
                    .child(
                        div()
                            .v_flex()
                            .gap_2()
                            .child(div().font_weight(FontWeight::MEDIUM).child("Gateway URL"))
                            .child(Input::new(&self.url).aria_label("Gateway URL").disabled(self.profile.is_some() || self.connection_stage == ConnectionStage::SigningOut))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(p.muted)
                                    .child("Enter an HTTPS or WebSocket address, or a hostname."),
                            ),
                    )
                    .when(!self.access_protected, |form| {
                        form.child(
                            div()
                                .v_flex()
                                .gap(px(14.))
                                .child(
                                    div()
                                        .v_flex()
                                        .gap_2()
                                        .child("Token")
                                        .child(
                                            Input::new(&self.token)
                                                .aria_label("Gateway token")
                                                .mask_toggle(),
                                        ),
                                )
                                .child(
                                    div()
                                        .v_flex()
                                        .gap_2()
                                        .child("Password")
                                        .child(
                                            Input::new(&self.password)
                                                .aria_label("Gateway password")
                                                .mask_toggle(),
                                        ),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .line_height(px(18.))
                                        .text_color(p.muted)
                                        .child("Use the token or password configured on your Gateway. For Cloudflare Access, continue to sign in with your browser."),
                                ),
                        )
                    })
                    .when(self.access_protected, |form| {
                        form.child(
                            div()
                                .v_flex()
                                .gap(px(8.))
                                .p_4()
                                .rounded(px(10.))
                                .bg(p.card)
                                .border_1()
                                .border_color(p.border)
                                .child(
                                    div()
                                        .h_flex()
                                        .gap_2()
                                        .text_color(p.strong)
                                        .font_weight(FontWeight::MEDIUM)
                                        .child(Icon::new(IconName::Lock).size(px(16.)))
                                        .child("This Gateway uses Cloudflare Access"),
                                )
                                .child(
                                    div()
                                        .text_sm()
                                        .line_height(px(20.))
                                        .text_color(p.muted)
                                        .child(if waiting {
                                            "Finish signing in in your browser. This window will connect automatically when you’re done."
                                        } else if self.access_identity.is_some() {
                                            "Your sign-in is saved for this Gateway. Sign out to connect with a different account."
                                        } else {
                                            "Sign in securely with your organization in your default browser. No Gateway token or password is needed."
                                        }),
                                )
                                .when_some(self.access_identity.clone(), |card, identity| {
                                    card.child(
                                        div().v_flex().gap_2()
                                            .child(div().text_sm().text_color(p.ok).child(format!("Signed in as {identity}")))
                                            .child(Button::new("connect-sign-out").ghost().label("Sign out").on_click(cx.listener(|this, _, window, cx| this.sign_out(window, cx))))
                                    )
                                }),
                        )
                    })
                    .when_some(self.connection_message.clone(), |form, message| {
                        form.child(
                            div()
                                .id("connection-error")
                                .v_flex()
                                .gap_2()
                                .p_4()
                                .rounded(px(10.))
                                .bg(p.card)
                                .border_1()
                                .border_color(p.border)
                                .text_sm()
                                .line_height(px(20.))
                                .text_color(p.danger)
                                .child(message),
                        )
                    })
                    .child(
                        div()
                            .h_flex()
                            .gap_3()
                            .child(
                                Button::new("connect")
                                    .primary()
                                    .h(px(40.))
                                    .flex_1()
                                    .label(label)
                                    .disabled(busy)
                                    .when(busy, |button| button.child(Spinner::new().color(p.accent_fg)))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        if sign_in {
                                            this.sign_in(cx);
                                        } else {
                                            this.retry(window, cx);
                                        }
                                    })),
                            )
                            .when(busy && self.connection_stage != ConnectionStage::SigningOut, |actions| {
                                actions.child(
                                    Button::new("cancel-connection")
                                        .ghost()
                                        .h(px(40.))
                                        .label("Cancel")
                                        .on_click(cx.listener(|this, _, _, cx| this.cancel_connection(cx))),
                                )
                            }),
                    )
                    .child(Button::new("manage-gateways-connect").ghost().label("Manage Gateways…").on_click(|_,_,cx| crate::gateway_windows::manage(cx)))
                    .child(
                        div()
                            .text_xs()
                            .line_height(px(18.))
                            .text_color(p.muted)
                            .child("Your device keeps its own identity. A Gateway administrator may need to approve it before you can chat."),
                    ),
            )
    }
}
