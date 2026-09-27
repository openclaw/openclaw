use super::theme::tokens::{icon, radius, shell, space, text, weight};
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
            .p(space::REM_XXL)
            .child(
                div()
                    .v_flex()
                    .w_full()
                    .max_w(shell::CONNECT_MAX_WIDTH)
                    .gap(shell::CONNECT_FORM_GAP)
                    .child(
                        div()
                            .size(shell::CONNECT_LOGO_SIZE)
                            .rounded(radius::CARD)
                            .bg(p.accent_subtle)
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(shell::CONNECT_LOGO_TEXT_SIZE)
                            .text_color(p.accent)
                            .child("◈"),
                    )
                    .child(
                        div()
                            .v_flex()
                            .gap(space::MD)
                            .child(
                                div()
                                    .text_size(shell::CONNECT_TITLE_SIZE)
                                    .text_color(p.strong)
                                    .font_weight(weight::SEMIBOLD)
                                    .child("Connect to a Gateway"),
                            )
                            .child(
                                div()
                                    .text_color(p.muted)
                                    .line_height(shell::CONNECT_TAGLINE_HEIGHT)
                                    .child("Your agents and conversations, together on your desktop."),
                            ),
                    )
                    .child(
                        div()
                            .v_flex()
                            .gap(space::REM_SM)
                            .child(div().font_weight(weight::MEDIUM).child("Gateway URL"))
                            .child(Input::new(&self.url).aria_label("Gateway URL").disabled(self.profile.is_some() || self.connection_stage == ConnectionStage::SigningOut))
                            .child(
                                div()
                                    .text_size(text::WIDGET_XS_SIZE)
                                    .text_color(p.muted)
                                    .child("Enter an HTTPS or WebSocket address, or a hostname."),
                            ),
                    )
                    .when(!self.access_protected, |form| {
                        form.child(
                            div()
                                .v_flex()
                                .gap(shell::CONNECT_CREDENTIAL_GAP)
                                .child(
                                    div()
                                        .v_flex()
                                        .gap(space::REM_SM)
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
                                        .gap(space::REM_SM)
                                        .child("Password")
                                        .child(
                                            Input::new(&self.password)
                                                .aria_label("Gateway password")
                                                .mask_toggle(),
                                        ),
                                )
                                .child(
                                    div()
                                        .text_size(text::WIDGET_XS_SIZE)
                                        .line_height(shell::CONNECT_NOTE_LINE_HEIGHT)
                                        .text_color(p.muted)
                                        .child("Use the token or password configured on your Gateway. For Cloudflare Access, continue to sign in with your browser."),
                                ),
                        )
                    })
                    .when(self.access_protected, |form| {
                        form.child(
                            div()
                                .v_flex()
                                .gap(space::MD)
                                .p(space::REM_LG)
                                .rounded(radius::PERSON)
                                .bg(p.card)
                                .border(space::HAIRLINE)
                                .border_color(p.border)
                                .child(
                                    div()
                                        .h_flex()
                                        .gap(space::REM_SM)
                                        .text_color(p.strong)
                                        .font_weight(weight::MEDIUM)
                                        .child(Icon::new(IconName::Lock).size(icon::NORMAL))
                                        .child("This Gateway uses Cloudflare Access"),
                                )
                                .child(
                                    div()
                                        .text_size(text::WIDGET_SM_SIZE)
                                        .line_height(shell::CONNECT_BODY_LINE_HEIGHT)
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
                                        div().v_flex().gap(space::REM_SM)
                                            .child(div().text_size(text::WIDGET_SM_SIZE).text_color(p.ok).child(format!("Signed in as {identity}")))
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
                                .gap(space::REM_SM)
                                .p(space::REM_LG)
                                .rounded(radius::PERSON)
                                .bg(p.card)
                                .border(space::HAIRLINE)
                                .border_color(p.border)
                                .text_size(text::WIDGET_SM_SIZE)
                                .line_height(shell::CONNECT_BODY_LINE_HEIGHT)
                                .text_color(p.danger)
                                .child(message),
                        )
                    })
                    .child(
                        div()
                            .h_flex()
                            .gap(space::REM_MD)
                            .child(
                                Button::new("connect")
                                    .primary()
                                    .h(shell::CONNECT_BUTTON_HEIGHT)
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
                                        .h(shell::CONNECT_BUTTON_HEIGHT)
                                        .label("Cancel")
                                        .on_click(cx.listener(|this, _, _, cx| this.cancel_connection(cx))),
                                )
                            }),
                    )
                    .child(Button::new("manage-gateways-connect").ghost().label("Manage Gateways…").on_click(|_,_,cx| crate::gateway_windows::manage(cx)))
                    .child(
                        div()
                            .text_size(text::WIDGET_XS_SIZE)
                            .line_height(shell::CONNECT_NOTE_LINE_HEIGHT)
                            .text_color(p.muted)
                            .child("Your device keeps its own identity. A Gateway administrator may need to approve it before you can chat."),
                    ),
            )
    }
}
