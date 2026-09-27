use super::*;

impl AppView {
    pub(in crate::ui) fn permission_control(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Palette::get(cx);
        let current = self
            .selected_row()
            .and_then(|row| row.permission_mode.as_deref());
        let scope = self.capability_scope();
        let default = self
            .sidebar_state
            .agents
            .iter()
            .find(|agent| agent.id == scope.agent)
            .and_then(|agent| agent.default_permission_mode.as_deref());
        let label = permission_label(current, default);
        let blocked = self.permission_blocked();
        let admin = self.composer_has_scope("operator.admin");
        let target = cx.entity().downgrade();
        let mut menu = panel(
            "composer-permission-menu",
            tokens::PERMISSION_PANEL_WIDTH,
            MenuStyle::Permission,
            cx,
        )
        .capture_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
            if let Some(index) = event
                .keystroke
                .key
                .parse::<usize>()
                .ok()
                .filter(|index| (1..=5).contains(index))
            {
                this.choose_permission(
                    [
                        None,
                        Some("read-only"),
                        Some("guarded"),
                        Some("workspace"),
                        Some("full"),
                    ][index - 1],
                    cx,
                );
                cx.stop_propagation();
            }
        }))
        .child(
            Button::new("permission-help")
                .ghost()
                .small()
                .w_full()
                .justify_between()
                .px_0()
                .pb(px(tokens::PERMISSION_HEADING_PADDING_BOTTOM))
                .child(
                    div()
                        .flex_1()
                        .text_size(px(tokens::HEADER_TEXT_SIZE))
                        .font_weight(tokens::PERMISSION_HEADING_WEIGHT)
                        .text_color(p.muted)
                        .child("EXECUTION PERMISSIONS"),
                )
                .child(
                    div()
                        .text_size(px(tokens::HEADER_TEXT_SIZE))
                        .text_color(p.muted)
                        .child("Learn more"),
                )
                .on_click(|_, _, cx| {
                    cx.open_url("https://docs.openclaw.ai/gateway/permission-modes")
                }),
        );
        for (index, mode) in [
            None,
            Some("read-only"),
            Some("guarded"),
            Some("workspace"),
            Some("full"),
        ]
        .into_iter()
        .enumerate()
        {
            let locked = mode == Some("full") && !admin;
            let selected = current == mode;
            let mut row = menu_row(
                format!("permission-{index}"),
                &permission_label(mode, default),
                Some(permission_icon(mode)),
                Some(permission_description(mode)),
                None,
                blocked.is_some() || locked,
                cx,
            )
            .when(selected, |row| row.bg(p.hover))
            .when_some(
                if locked {
                    Some("Full access requires operator.admin access.")
                } else {
                    blocked
                },
                |row, reason| row.tooltip(reason),
            )
            .on_click(cx.listener(move |this, _, _, cx| this.choose_permission(mode, cx)));
            row = if locked {
                row.child(Icon::new(IconName::Lock).size(px(tokens::CAPABILITY_ICON_SIZE)))
            } else if selected {
                row.child(
                    Icon::new(IconName::Check)
                        .size(px(tokens::CAPABILITY_ICON_SIZE))
                        .text_color(p.accent),
                )
            } else {
                row.child(
                    div()
                        .w(px(tokens::CAPABILITY_ICON_SIZE))
                        .text_size(px(tokens::PERMISSION_SHORTCUT_SIZE))
                        .text_color(p.muted)
                        .child((index + 1).to_string()),
                )
            };
            menu = menu.child(row);
        }
        if let Some(error) = &self.composer_capabilities.error {
            menu = menu.child(menu_note(error, cx).text_color(p.danger));
        }
        popover(
            "permission-picker",
            Anchor::BottomLeft,
            self.composer_capabilities.permission_open,
            Button::new("permission-mode")
                .ghost()
                .small()
                .h(px(tokens::PERMISSION_CHIP_HEIGHT))
                .accessibility_label(format!("Execution permissions: {label}"))
                .child(
                    div()
                        .h_flex()
                        .items_center()
                        .gap(px(tokens::PERMISSION_CHIP_GAP))
                        .text_size(px(tokens::PERMISSION_CHIP_TEXT_SIZE))
                        .line_height(px(tokens::PERMISSION_CHIP_LINE_HEIGHT))
                        .child(
                            Icon::new(permission_icon(current))
                                .size(px(tokens::CAPABILITY_ICON_SIZE)),
                        )
                        .child(label),
                )
                .text_color(if current.or(default) == Some("full") {
                    p.accent
                } else {
                    p.muted
                })
                .disabled(blocked.is_some())
                .when(!self.composer_capabilities.permission_open, |button| {
                    button.tooltip(
                        blocked.unwrap_or("Choose what available tools may do in this session."),
                    )
                }),
            menu.into_any_element(),
            move |open, _, cx| {
                let _ = target.update(cx, |this, cx| {
                    this.composer_capabilities.permission_open = open;
                    cx.notify();
                });
            },
        )
    }
}

fn permission_icon(mode: Option<&str>) -> IconName {
    match mode {
        Some("read-only") => IconName::ShieldEllipsis,
        Some("guarded") => IconName::ShieldLock,
        Some("workspace") => IconName::ShieldCog,
        Some("full") => IconName::ShieldAlert,
        _ => IconName::ShieldCheck,
    }
}
