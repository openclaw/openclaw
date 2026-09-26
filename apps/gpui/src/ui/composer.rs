use super::{AppView, theme::Palette};
use crate::model::{commands::matching, composer::context_usage};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        input::Textarea,
        popover::Popover,
    },
    prelude::FluentBuilder as _,
    *,
};

impl AppView {
    pub(super) fn composer_view(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let p = Palette::get(cx);
        let running = self.chat.active_run.is_some();
        let disabled = self.chat.loading || self.chat.selected_session.is_none();
        let send_disabled = disabled
            || self.model_controls.pending
            || self.session.is_none()
            || self.composer_state.reading > 0
            || (self.composer.read(cx).value().trim().is_empty()
                && self.composer_state.attachments.is_empty());
        let steer = running
            && self
                .chat
                .session_info
                .effective_queue_mode
                .as_deref()
                .or_else(|| {
                    self.selected_row()
                        .and_then(|row| row.effective_queue_mode.as_deref())
                })
                == Some("steer");
        let paste_target = cx.entity().downgrade();
        div()
            .id("composer-shell")
            .v_flex()
            .flex_shrink_0()
            .items_center()
            .px_6()
            .pt_3()
            .pb_3()
            .capture_key_down(cx.listener(Self::composer_key_down))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| {
                this.attach_paths(paths.paths().to_vec(), cx)
            }))
            .child(
                div()
                    .relative()
                    .v_flex()
                    .w_full()
                    .max_w(px(768.))
                    .gap_2()
                    .children(self.slash_popup(cx))
                    .child(
                        div()
                            .v_flex()
                            .px(px(14.))
                            .py(px(10.))
                            .min_h(px(112.))
                            .justify_between()
                            .gap_2()
                            .bg(p.card)
                            .border_1()
                            .border_color(p.border_strong)
                            .rounded(px(20.))
                            .children(self.attachment_rail(cx))
                            .child(
                                Textarea::new(&self.composer)
                                    .aria_label("Message OpenClaw")
                                    .accessibility_id("chat-composer")
                                    .appearance(false)
                                    .bordered(false)
                                    .disabled(disabled)
                                    .text_size(px(16.))
                                    .on_paste(move |item, _, cx| {
                                        paste_target
                                            .update(cx, |this, cx| this.composer_paste(item, cx))
                                            .unwrap_or(false)
                                    }),
                            )
                            .children(self.composer_state.error.as_ref().map(|error| {
                                div().text_xs().text_color(p.danger).child(error.clone())
                            }))
                            .when(self.composer_state.reading > 0, |this| {
                                this.child(
                                    div()
                                        .text_xs()
                                        .text_color(p.muted)
                                        .child("Preparing attachments…"),
                                )
                            })
                            .child(
                                div()
                                    .h_flex()
                                    .flex_wrap()
                                    .justify_between()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        div()
                                            .h_flex()
                                            .items_center()
                                            .gap(px(6.))
                                            .child(self.composer_plus_control(cx))
                                            .child(self.permission_control(cx)),
                                    )
                                    .child(
                                        div()
                                            .h_flex()
                                            .flex_1()
                                            .min_w_0()
                                            .flex_wrap()
                                            .justify_end()
                                            .items_center()
                                            .gap_1()
                                            .children(self.usage_control(cx))
                                            .children(self.model_controls.target.as_ref().map(
                                                |target| {
                                                    self.model_controls_view(target, window, cx)
                                                },
                                            ))
                                            .when(running, |this| {
                                                this.child(
                                                    Button::new("stop-run")
                                                        .small()
                                                        .w(px(32.))
                                                        .h(px(32.))
                                                        .icon(
                                                            Icon::new(IconName::Square)
                                                                .size(px(14.)),
                                                        )
                                                        .tooltip("Stop · Escape")
                                                        .on_click(cx.listener(|this, _, _, cx| {
                                                            this.stop(cx)
                                                        })),
                                                )
                                            })
                                            .child(
                                                Button::new("send-message")
                                                    .primary()
                                                    .small()
                                                    .w(px(32.))
                                                    .rounded_full()
                                                    .h(px(32.))
                                                    .icon(
                                                        Icon::new(IconName::ArrowUp).size(px(16.)),
                                                    )
                                                    .tooltip(if steer {
                                                        "Steer current run"
                                                    } else {
                                                        "Send message · Enter"
                                                    })
                                                    .disabled(send_disabled)
                                                    .on_click(cx.listener(
                                                        |this, _, window, cx| this.send(window, cx),
                                                    )),
                                            ),
                                    ),
                            ),
                    ),
            )
    }

    pub(super) fn attachment_rail(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.composer_state.attachments.is_empty() {
            return None;
        }
        let p = Palette::get(cx);
        Some(
            div()
                .id("attachment-rail")
                .h_flex()
                .gap_2()
                .overflow_x_scroll()
                .pb_1()
                .children(self.composer_state.attachments.iter().map(|attachment| {
                    let id = attachment.id.clone();
                    let mut chip = div()
                        .h_flex()
                        .items_center()
                        .gap_2()
                        .h(px(56.))
                        .flex_shrink_0()
                        .pl_2()
                        .pr_1()
                        .rounded_md()
                        .border_1()
                        .border_color(p.border)
                        .bg(p.elevated);
                    if let Some(image) = self.composer_state.previews.get(&id) {
                        chip = chip.child(
                            img(image.clone())
                                .size(px(48.))
                                .object_fit(ObjectFit::Cover)
                                .rounded_sm(),
                        );
                    } else {
                        chip = chip.child(div().text_lg().text_color(p.muted).child("▤"));
                    }
                    chip.child(
                        div()
                            .v_flex()
                            .max_w(px(160.))
                            .gap_1()
                            .child(
                                div()
                                    .text_sm()
                                    .truncate()
                                    .child(attachment.file_name.clone()),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(p.muted)
                                    .child(attachment.size_label()),
                            ),
                    )
                    .child(
                        Button::new(SharedString::from(format!("remove-attachment-{id}")))
                            .ghost()
                            .xsmall()
                            .label("×")
                            .tooltip("Remove attachment")
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.remove_attachment(&id, cx)),
                            ),
                    )
                }))
                .into_any_element(),
        )
    }

    fn slash_popup(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.composer_state.slash_dismissed {
            return None;
        }
        let value = self.composer.read(cx).value();
        if !value.starts_with('/') || value.contains(char::is_whitespace) {
            return None;
        }
        let commands = matching(&self.composer_state.commands, &value);
        if commands.is_empty() {
            return None;
        }
        let p = Palette::get(cx);
        let selected = self.composer_state.slash_index.min(commands.len() - 1);
        let start = selected.saturating_sub(4);
        Some(
            div()
                .id("slash-commands")
                .absolute()
                .bottom_full()
                .mb_2()
                .w_full()
                .max_h(px(320.))
                .overflow_y_scroll()
                .v_flex()
                .p_2()
                .gap_1()
                .rounded_lg()
                .bg(p.elevated)
                .border_1()
                .border_color(p.border_strong)
                .shadow_lg()
                .occlude()
                .child(
                    div()
                        .px_2()
                        .pb_1()
                        .text_xs()
                        .text_color(p.muted)
                        .child("Commands · ↑↓ to choose · Tab to complete"),
                )
                .children(commands.iter().enumerate().skip(start).take(5).map(
                    |(index, command)| {
                        let aliases = command
                            .text_aliases
                            .iter()
                            .filter(|alias| {
                                !alias
                                    .trim_start_matches('/')
                                    .eq_ignore_ascii_case(command.name.trim_start_matches('/'))
                            })
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(" · ");
                        let hint = [command.arg_hint(), aliases]
                            .into_iter()
                            .filter(|part| !part.is_empty())
                            .collect::<Vec<_>>()
                            .join(" · ");
                        div()
                            .id(("slash-command", index))
                            .h_flex()
                            .items_start()
                            .gap_3()
                            .h(px(44.))
                            .line_height(px(16.))
                            .flex_shrink_0()
                            .px_2()
                            .py_1()
                            .rounded_md()
                            .when(index == selected, |row| row.bg(p.hover))
                            .hover(|row| row.bg(p.hover))
                            .child(
                                div()
                                    .v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .gap_1()
                                    .child(
                                        div()
                                            .h_flex()
                                            .items_center()
                                            .min_w_0()
                                            .gap_2()
                                            .child(
                                                div()
                                                    .text_sm()
                                                    .truncate()
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(p.strong)
                                                    .child(format!("/{}", command.name)),
                                            )
                                            .child(
                                                div()
                                                    .text_xs()
                                                    .min_w_0()
                                                    .truncate()
                                                    .text_color(p.muted)
                                                    .child(hint),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .text_xs()
                                            .truncate()
                                            .text_color(p.muted)
                                            .child(command.description.clone()),
                                    ),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .flex_shrink_0()
                                    .text_color(p.muted)
                                    .child(command.category.clone()),
                            )
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |this, _, window, cx| {
                                    this.choose_slash(index, false, window, cx);
                                    cx.stop_propagation();
                                    cx.notify();
                                }),
                            )
                    },
                ))
                .into_any_element(),
        )
    }

    fn usage_control(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let p = Palette::get(cx);
        let row = self.selected_row();
        let info = &self.chat.session_info;
        let (used, limit, ratio) = context_usage(
            row.and_then(|row| row.total_tokens)
                .or(info.total_tokens.map(|value| value as f64)),
            row.and_then(|row| row.context_tokens)
                .or(info.context_tokens.map(|value| value as f64)),
        )?;
        let warning = ratio >= 0.85 && row.and_then(|row| row.total_tokens_fresh) != Some(false);
        let detail = format!(
            "Input: {} · Output: {}\nContext: {} / {} tokens{}",
            row.and_then(|row| row.input_tokens)
                .or(info.input_tokens.map(|value| value as f64))
                .map(|v| format!("{v:.0}"))
                .unwrap_or_else(|| "—".into()),
            row.and_then(|row| row.output_tokens)
                .or(info.output_tokens.map(|value| value as f64))
                .map(|v| format!("{v:.0}"))
                .unwrap_or_else(|| "—".into()),
            used as u64,
            limit as u64,
            row.and_then(|row| row.estimated_cost_usd)
                .or(info.estimated_cost_usd)
                .map(|cost| format!("\nEstimated cost: ${cost:.4}"))
                .unwrap_or_default()
        );
        let target = cx.entity().downgrade();
        let tooltip_detail = detail.clone();
        Some(
            Popover::new("usage-details")
                .anchor(Anchor::BottomRight)
                .open(self.composer_state.usage_open)
                .on_open_change(move |open, _, cx| {
                    let _ = target.update(cx, |this, cx| {
                        this.composer_state.usage_open = *open;
                        cx.notify();
                    });
                })
                .trigger(
                    Button::new("context-usage")
                        .ghost()
                        .small()
                        .child(usage_ring(
                            ratio as f32,
                            p.border_strong,
                            if warning { p.danger } else { p.muted },
                        ))
                        .text_color(if warning { p.danger } else { p.muted })
                        .tooltip(tooltip_detail.clone()),
                )
                .child(div().text_sm().w(px(240.)).child(detail))
                .into_any_element(),
        )
    }
}

fn usage_ring(ratio: f32, track: Hsla, fill: Hsla) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let center = bounds.center();
            for (fraction, color) in [(1., track), (ratio, fill)] {
                if fraction <= 0. {
                    continue;
                }
                let mut path = PathBuilder::stroke(px(2.));
                let steps = (fraction * 64.).ceil() as usize;
                for index in 0..=steps {
                    let angle = -std::f32::consts::FRAC_PI_2
                        + std::f32::consts::TAU * fraction * index as f32 / steps as f32;
                    let point = point(
                        center.x + px(angle.cos() * 7.),
                        center.y + px(angle.sin() * 7.),
                    );
                    if index == 0 {
                        path.move_to(point);
                    } else {
                        path.line_to(point);
                    }
                }
                if let Ok(path) = path.build() {
                    window.paint_path(path, color);
                }
            }
        },
    )
    .size(px(18.))
}
