use super::{
    AppView,
    components::activity_mark::activity_mark,
    theme::{Palette, tokens::transcript::ToolTokens as T},
    transcript_state::transcript_text_style,
};
use gpui_kit::{
    component::{
        IconName, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        text::TextView,
    },
    prelude::FluentBuilder,
    *,
};

impl AppView {
    pub(super) fn render_reasoning(
        &mut self,
        message_key: &str,
        index: usize,
        thinking: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let key = format!("{message_key}:thinking-open");
        let expanded = self.transcript_state.expanded.contains(&key);
        let button = Button::new(SharedString::from(key.clone()))
            .ghost()
            .small()
            .self_start()
            .label("Reasoning")
            .icon(if expanded {
                IconName::ChevronDown
            } else {
                IconName::ChevronRight
            })
            .on_click(cx.listener(move |this, _, _, cx| {
                if !this.transcript_state.expanded.remove(&key) {
                    this.transcript_state.expanded.insert(key.clone());
                }
                this.transcript_list.remeasure_items(index..index + 1);
                cx.notify();
            }));
        if !expanded {
            return button.into_any_element();
        }
        let state = self.markdown_state(
            format!("{message_key}:thinking"),
            &format!("_Reasoning:_\n\n{thinking}"),
            cx,
        );
        let content = div()
            .w_full()
            .px(px(T::BODY_X))
            .py(px(T::BODY_Y))
            .rounded(px(T::RADIUS))
            .border_1()
            .border_dashed()
            .border_color(Hsla {
                a: T::REASONING_BORDER,
                ..p.strong
            })
            .bg(Hsla {
                a: T::REASONING_TINT,
                ..p.strong
            })
            .text_size(px(T::SMALL_FONT))
            .line_height(px(T::REASONING_LINE))
            .text_color(p.muted)
            .child(
                TextView::new(&state)
                    .style(transcript_text_style(p))
                    .selectable(true)
                    .scrollable(false),
            )
            .into_any_element();
        div()
            .v_flex()
            .gap(px(T::GAP))
            .child(button)
            .child(content)
            .into_any_element()
    }

    pub(super) fn render_working_indicator(
        &self,
        waiting_approval: bool,
        elapsed_ms: u64,
        output_tokens: Option<u64>,
        cx: &App,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let seconds = (elapsed_ms / 1000).max(1);
        let elapsed = if seconds >= 60 {
            format!("{}m {}s", seconds / 60, seconds % 60)
        } else {
            format!("{seconds}s")
        };
        div()
            .h_flex()
            .gap(px(T::BLOCK_GAP))
            .min_h(px(T::WORKING_HEIGHT))
            .text_size(px(T::SMALL_FONT))
            .text_color(p.muted)
            .child(activity_mark(!waiting_approval, p.accent, px(T::CLAW)))
            .child(if waiting_approval {
                "Waiting for approval".into()
            } else {
                elapsed
            })
            .when_some(output_tokens, |row, tokens| {
                row.child("·").child(tokens_label(tokens))
            })
            .when(
                !waiting_approval && output_tokens.is_none() && elapsed_ms >= 30_000,
                |row| {
                    let phrases = [
                        "Shelling…",
                        "Scuttling…",
                        "Clawing…",
                        "Pinching…",
                        "Molting…",
                        "Bubbling…",
                        "Tiding…",
                        "Reefing…",
                        "Cracking…",
                        "Sifting…",
                    ];
                    row.child(phrases[((elapsed_ms - 30_000) / 45_000) as usize % phrases.len()])
                },
            )
            .into_any_element()
    }

    pub(super) fn render_turn_recap(
        &self,
        runtime_ms: u64,
        output_tokens: Option<u64>,
        cx: &App,
    ) -> AnyElement {
        let p = Palette::get(cx);
        div()
            .h_flex()
            .flex_wrap()
            .gap(px(T::BLOCK_GAP))
            .text_size(px(T::OUTCOME_FONT))
            .text_color(p.muted)
            .child(activity_mark(false, p.accent, px(T::CLAW)))
            .child(format!("Done in {}", recap_duration(runtime_ms)))
            .when_some(output_tokens, |row, tokens| {
                row.child("·").child(tokens_label(tokens))
            })
            .into_any_element()
    }
}

fn tokens_label(tokens: u64) -> String {
    match tokens {
        1 => "1 token".into(),
        0..1000 => format!("{tokens} tokens"),
        1000..1_000_000 => format!("{:.1}k tokens", tokens as f64 / 1000.),
        _ => format!("{:.1}m tokens", tokens as f64 / 1_000_000.),
    }
}

fn recap_duration(ms: u64) -> String {
    let mut seconds = ((ms.saturating_add(500)) / 1000).max(1);
    let mut parts = Vec::new();
    for (unit, size) in [
        ("day", 86400),
        ("hour", 3600),
        ("minute", 60),
        ("second", 1),
    ] {
        let count = seconds / size;
        seconds %= size;
        if count > 0 {
            parts.push(format!(
                "{count} {unit}{}",
                if count == 1 { "" } else { "s" }
            ));
        }
        if parts.len() == 2 {
            break;
        }
    }
    parts.join(", ")
}
