use super::theme::tokens::{conversation, icon, radius, shell, space, text, weight};
use super::{AppView, theme::Palette};
use crate::{
    gateway::attention_rpc::{QuestionResolution, QuestionResolutionResult, resolve_approval},
    model::{
        approvals::{Approval, ApprovalDecision},
        chat::now_ms,
        questions::{QuestionAnswers, QuestionRecord},
    },
};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        input::{Input, InputEvent, InputState},
    },
    prelude::FluentBuilder,
    *,
};
use std::time::Duration;

impl AppView {
    pub(super) fn update_attention_badges(&mut self) {
        let now = now_ms();
        self.attention_state.drafts.retain(|id, _| {
            self.router
                .questions
                .records
                .get(id)
                .is_some_and(|record| record.expires_at_ms > now)
        });
        self.attention_state.busy.retain(|id, _| {
            self.router
                .questions
                .records
                .get(id)
                .is_some_and(|record| record.expires_at_ms > now)
                || self
                    .router
                    .approvals
                    .pending
                    .get(id)
                    .is_some_and(|approval| approval.expires_at_ms > now)
        });
        self.attention_state.errors.retain(|id, _| {
            self.router
                .questions
                .records
                .get(id)
                .is_some_and(|record| record.expires_at_ms > now)
                || self
                    .router
                    .approvals
                    .pending
                    .get(id)
                    .is_some_and(|approval| approval.expires_at_ms > now)
        });
        self.sidebar_state.attention = self
            .router
            .questions
            .records
            .values()
            .filter(|question| {
                question.expires_at_ms > now
                    && question
                        .agent_id
                        .as_deref()
                        .zip(self.sidebar_state.selected_agent.as_deref())
                        .is_none_or(|(a, b)| a == b)
            })
            .filter_map(|question| question.session_key.clone())
            .collect();
        if self
            .router
            .approvals
            .pending
            .values()
            .any(|approval| approval.expires_at_ms > now)
            && let Some(scope) = self.router.scope()
        {
            self.sidebar_state.attention.insert(scope.session_key);
        }
    }

    pub(super) fn attention_dock(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(scope) = self.router.scope() else {
            return div().into_any_element();
        };
        let now = now_ms();
        let question = self
            .router
            .questions
            .selected(&scope.session_key, scope.agent_id.as_deref(), now)
            .cloned();
        let approval = self
            .router
            .approvals
            .pending
            .values()
            .filter(|a| a.expires_at_ms > now)
            .min_by_key(|a| a.created_at_ms)
            .cloned();
        if question.is_none() && approval.is_none() {
            return div().into_any_element();
        }
        self.start_attention_ticker(cx);
        let mut dock = div()
            .id("attention-dock-scroll")
            .max_h(
                (window.viewport_size().height * shell::ATTENTION_HEIGHT_RATIO)
                    .clamp(shell::ATTENTION_MIN_HEIGHT, shell::ATTENTION_MAX_HEIGHT),
            )
            .overflow_y_scroll()
            .v_flex()
            .w_full()
            .max_w(conversation::MAX_WIDTH)
            .gap(space::REM_SM)
            .px(space::REM_LG)
            .pb(space::REM_SM);
        if let Some(approval) = approval {
            dock = dock.child(self.approval_card(approval, cx));
        }
        if let Some(question) = question {
            dock = dock.child(self.question_card(question, window, cx));
        }
        div()
            .w_full()
            .flex()
            .justify_center()
            .child(dock)
            .into_any_element()
    }

    fn start_attention_ticker(&mut self, cx: &mut Context<Self>) {
        if self.attention_state.ticker.is_some() {
            return;
        }
        self.attention_state.ticker = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let keep = this
                    .update(cx, |this, cx| {
                        let now = now_ms();
                        let keep = this
                            .router
                            .approvals
                            .pending
                            .values()
                            .any(|a| a.expires_at_ms > now)
                            || this
                                .router
                                .questions
                                .records
                                .values()
                                .any(|q| q.expires_at_ms > now);
                        if !keep {
                            this.attention_state.ticker = None;
                        }
                        cx.notify();
                        keep
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
        }));
    }

    fn question_card(
        &mut self,
        record: QuestionRecord,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let draft = self
            .attention_state
            .drafts
            .entry(record.id.clone())
            .or_default();
        draft.page = draft.page.min(record.questions.len().saturating_sub(1));
        let page = draft.page;
        let Some(question) = record.questions.get(page).cloned() else {
            return div().into_any_element();
        };
        let input = if question.is_other || question.is_secret || question.options.is_empty() {
            if !draft.inputs.contains_key(&question.question_id) {
                let input = cx.new(|cx| {
                    InputState::new(window, cx)
                        .placeholder(if question.is_secret {
                            "Enter secret…"
                        } else {
                            "Other answer…"
                        })
                        .masked(question.is_secret)
                });
                let id = record.id.clone();
                let question_id = question.question_id.clone();
                let multi = question.multi_select;
                draft
                    .subscriptions
                    .push(cx.subscribe(&input, move |this, input, event, cx| {
                        if matches!(event, InputEvent::Change) {
                            if !multi
                                && !input.read(cx).value().is_empty()
                                && let Some(draft) = this.attention_state.drafts.get_mut(&id)
                            {
                                draft
                                    .answers
                                    .entry(question_id.clone())
                                    .or_default()
                                    .selected
                                    .clear();
                            }
                            cx.notify();
                        }
                    }));
                draft.inputs.insert(question.question_id.clone(), input);
            }
            draft.inputs.get(&question.question_id).cloned()
        } else {
            None
        };
        let selected = draft
            .answers
            .entry(question.question_id.clone())
            .or_default()
            .selected
            .clone();
        let busy = self.attention_state.busy.contains_key(&record.id);
        let mut card = div()
            .v_flex()
            .gap(space::REM_MD)
            .p(space::REM_LG)
            .bg(p.card)
            .border(space::HAIRLINE)
            .border_color(p.accent_subtle)
            .rounded(radius::WIDGET_LG)
            .child(
                div()
                    .h_flex()
                    .justify_between()
                    .gap(space::REM_SM)
                    .child(
                        div()
                            .font_weight(weight::SEMIBOLD)
                            .text_color(p.strong)
                            .child(format!(
                                "◇  {}",
                                if question.header.is_empty() {
                                    "Question"
                                } else {
                                    &question.header
                                }
                            )),
                    )
                    .child(
                        div()
                            .text_size(text::WIDGET_XS_SIZE)
                            .text_color(p.muted)
                            .child(format!("{} of {}", page + 1, record.questions.len())),
                    ),
            )
            .child(
                div()
                    .text_size(text::WIDGET_SM_SIZE)
                    .text_color(p.text)
                    .child(question.question.clone()),
            );
        if let Some(url) = question.url.clone() {
            card = card.child(
                Button::new("question-link")
                    .ghost()
                    .small()
                    .label("Open link ↗")
                    .on_click(move |_, _, cx| cx.open_url(&url)),
            );
        }
        for (index, option) in question.options.iter().enumerate() {
            let id = record.id.clone();
            let q = question.clone();
            let label = option.label.clone();
            let chosen = selected.contains(&label);
            card = card.child(div().v_flex().gap(space::REM_XS).child(
                question_option_button(index, option, q.multi_select, chosen, busy, p).on_click(
                    cx.listener(move |this, _, window, cx| {
                        let draft = this.attention_state.drafts.entry(id.clone()).or_default();
                        let answer = draft.answers.entry(q.question_id.clone()).or_default();
                        answer.toggle(&q, &label);
                        if !q.multi_select {
                            answer.other.clear();
                            if let Some(input) = draft.inputs.get(&q.question_id) {
                                input.update(cx, |input, cx| input.set_value("", window, cx));
                            }
                        }
                        cx.notify();
                    }),
                ),
            ));
        }
        if let Some(input) = input {
            card = card.child(
                Input::new(&input)
                    .aria_label(if question.is_secret {
                        "Secret answer"
                    } else {
                        "Other answer"
                    })
                    .disabled(busy),
            );
        }
        if let Some(error) = self.attention_state.errors.get(&record.id) {
            card = card.child(
                div()
                    .text_size(text::WIDGET_XS_SIZE)
                    .text_color(p.danger)
                    .child(error.clone()),
            );
        }
        let previous_id = record.id.clone();
        let next_id = record.id.clone();
        let skip_id = record.id.clone();
        let submit_id = record.id.clone();
        card.child(
            div()
                .h_flex()
                .justify_between()
                .gap(space::REM_SM)
                .child(
                    div()
                        .h_flex()
                        .gap(space::REM_SM)
                        .child(
                            Button::new("question-back")
                                .ghost()
                                .small()
                                .label("Back")
                                .disabled(busy || page == 0)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if let Some(draft) =
                                        this.attention_state.drafts.get_mut(&previous_id)
                                    {
                                        draft.page = draft.page.saturating_sub(1);
                                    }
                                    cx.notify();
                                })),
                        )
                        .child(
                            Button::new("question-skip")
                                .ghost()
                                .small()
                                .label("Skip")
                                .disabled(busy)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.submit_question(&skip_id, true, cx)
                                })),
                        ),
                )
                .child(if page + 1 < record.questions.len() {
                    Button::new("question-next")
                        .primary()
                        .small()
                        .label("Next →")
                        .disabled(busy)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(draft) = this.attention_state.drafts.get_mut(&next_id) {
                                draft.page += 1;
                            }
                            cx.notify();
                        }))
                } else {
                    Button::new("question-submit")
                        .primary()
                        .small()
                        .label(if busy { "Submitting…" } else { "Submit" })
                        .disabled(busy)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.submit_question(&submit_id, false, cx)
                        }))
                }),
        )
        .into_any_element()
    }

    fn submit_question(&mut self, id: &str, cancel: bool, cx: &mut Context<Self>) {
        let Some(scope) = self.router.scope() else {
            return;
        };
        let Some(record) = self.router.questions.records.get(id) else {
            return;
        };
        if !record.targets(&scope.session_key, scope.agent_id.as_deref())
            || record.expires_at_ms <= now_ms()
            || self.attention_state.busy.contains_key(id)
        {
            return;
        }
        let resolution = if cancel {
            QuestionResolution::Cancel { id, cancel: true }
        } else {
            let draft = self.attention_state.drafts.entry(id.into()).or_default();
            let mut answers = QuestionAnswers::default();
            for (index, question) in record.questions.iter().enumerate() {
                let answer = draft
                    .answers
                    .entry(question.question_id.clone())
                    .or_default();
                if let Some(input) = draft.inputs.get(&question.question_id) {
                    answer.other = input.read(cx).value().to_string();
                }
                let values = answer.values(question);
                if values.is_empty() {
                    draft.page = index;
                    self.attention_state.errors.insert(
                        id.into(),
                        "Choose or enter an answer, or Skip this request.".into(),
                    );
                    cx.notify();
                    return;
                }
                answers.answers.insert(question.question_id.clone(), values);
            }
            QuestionResolution::Answers { id, answers }
        };
        let params = serde_json::to_value(resolution).expect("question resolution serializes");
        let expected_status = if cancel { "cancelled" } else { "answered" };
        let id = id.to_owned();
        self.attention_state.request += 1;
        let request = self.attention_state.request;
        self.attention_state.busy.insert(id.clone(), request);
        self.attention_state.errors.remove(&id);
        self.request("question.resolve", params, cx, move |this, result, cx| {
            if this.attention_state.busy.get(&id) != Some(&request) {
                return;
            }
            this.attention_state.busy.remove(&id);
            if !this.router.is_current(&scope) {
                return;
            }
            let result = result.and_then(|payload| {
                let result: QuestionResolutionResult = serde_json::from_value(payload)
                    .map_err(|error| format!("Invalid question response: {error}"))?;
                if result.status != expected_status {
                    return Err("Gateway did not confirm this answer".into());
                }
                Ok(())
            });
            match result {
                Ok(_) => {
                    this.router.questions.remove(&id);
                    this.attention_state.drafts.remove(&id);
                }
                Err(error) => {
                    this.attention_state.errors.insert(id, error);
                }
            }
            cx.notify();
        });
        cx.notify();
    }

    fn approval_card(&self, approval: Approval, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        let busy = self.attention_state.busy.contains_key(&approval.id);
        let mut card = div()
            .v_flex()
            .gap(space::REM_MD)
            .p(space::REM_LG)
            .rounded(radius::WIDGET_LG)
            .bg(p.card)
            .border(space::HAIRLINE)
            .border_color(p.accent)
            .child(
                div()
                    .h_flex()
                    .justify_between()
                    .gap(space::REM_SM)
                    .child(
                        div()
                            .text_color(p.strong)
                            .font_weight(weight::SEMIBOLD)
                            .child(format!("◇  {}", approval.title())),
                    )
                    .child(
                        div()
                            .text_size(text::WIDGET_XS_SIZE)
                            .text_color(p.muted)
                            .child(format!(
                                "Expires in {}s",
                                approval
                                    .expires_at_ms
                                    .saturating_sub(now_ms())
                                    .div_ceil(1000)
                            )),
                    ),
            )
            .when(!approval.presentation.description.is_empty(), |card| {
                card.child(
                    div()
                        .text_size(text::WIDGET_SM_SIZE)
                        .child(approval.presentation.description.clone()),
                )
            })
            .when(!approval.preview().is_empty(), |card| {
                card.child(
                    div()
                        .id("approval-preview")
                        .max_h(shell::APPROVAL_DETAIL_MAX_HEIGHT)
                        .overflow_y_scroll()
                        .p(space::REM_SM)
                        .rounded(radius::WIDGET_MD)
                        .bg(p.elevated)
                        .font_family(conversation::CODE_FONT_FAMILY)
                        .text_size(text::WIDGET_XS_SIZE)
                        .child(approval.preview().to_owned()),
                )
            });
        if let Some(error) = self.attention_state.errors.get(&approval.id) {
            card = card.child(
                div()
                    .text_size(text::WIDGET_XS_SIZE)
                    .text_color(p.danger)
                    .child(error.clone()),
            );
        }
        let buttons = approval
            .presentation
            .allowed_decisions
            .iter()
            .copied()
            .enumerate()
            .map(|(index, decision)| {
                let id = approval.id.clone();
                Button::new(("approval-decision", index))
                    .small()
                    .label(decision.label())
                    .when(decision == ApprovalDecision::AllowOnce, |button| {
                        button.primary()
                    })
                    .disabled(busy || approval.method().is_none())
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.submit_approval(&id, decision, cx)),
                    )
            })
            .collect::<Vec<_>>();
        card.child(
            div()
                .h_flex()
                .justify_end()
                .gap(space::REM_SM)
                .children(buttons),
        )
        .into_any_element()
    }

    fn submit_approval(&mut self, id: &str, decision: ApprovalDecision, cx: &mut Context<Self>) {
        let Some(scope) = self.router.scope() else {
            return;
        };
        let Some(approval) = self.router.approvals.pending.get(id) else {
            return;
        };
        if approval.expires_at_ms <= now_ms() || self.attention_state.busy.contains_key(id) {
            return;
        }
        let Some((method, params)) = resolve_approval(approval, decision) else {
            return;
        };
        let id = id.to_owned();
        self.attention_state.request += 1;
        let request = self.attention_state.request;
        self.attention_state.busy.insert(id.clone(), request);
        self.attention_state.errors.remove(&id);
        self.request(method, params, cx, move |this, result, cx| {
            if this.attention_state.busy.get(&id) != Some(&request) {
                return;
            }
            this.attention_state.busy.remove(&id);
            if !this.router.is_current(&scope) {
                return;
            }
            match result {
                Ok(_) => this.router.approvals.resolve(&id, now_ms()),
                Err(error) => {
                    this.attention_state.errors.insert(id, error);
                }
            }
            cx.notify();
        });
        cx.notify();
    }
}

fn question_option_button(
    index: usize,
    option: &crate::model::questions::QuestionOption,
    multi: bool,
    chosen: bool,
    busy: bool,
    p: Palette,
) -> Button {
    let icon = match (multi, chosen) {
        (_, true) => IconName::CircleCheck,
        (true, false) => IconName::Square,
        (false, false) => IconName::Circle,
    };
    Button::new(("question-option", index))
        .w_full()
        .h_auto()
        .min_h(shell::QUESTION_OPTION_MIN_HEIGHT)
        .px(space::REM_MD)
        .py(space::REM_SM)
        .justify_start()
        .bg(if chosen { p.accent_subtle } else { p.card })
        .border_color(if chosen {
            p.accent.opacity(shell::QUESTION_SELECTED_BORDER_OPACITY)
        } else {
            p.border
        })
        .accessibility_label(format!(
            "{}{}",
            option.label,
            option
                .description
                .as_ref()
                .map(|text| format!(". {text}"))
                .unwrap_or_default()
        ))
        .child(
            div()
                .h_flex()
                .w_full()
                .items_start()
                .gap(space::REM_SM)
                .child(
                    Icon::new(icon)
                        .size(icon::NORMAL)
                        .mt(space::XXS)
                        .text_color(if chosen { p.accent } else { p.muted }),
                )
                .child(
                    div()
                        .v_flex()
                        .flex_1()
                        .min_w_0()
                        .text_left()
                        .whitespace_normal()
                        .gap(space::REM_XS)
                        .child(
                            div()
                                .text_size(text::NAV.size)
                                .font_weight(weight::MEDIUM)
                                .text_color(p.strong)
                                .child(option.label.clone()),
                        )
                        .when_some(option.description.clone(), |copy, description| {
                            copy.child(
                                div()
                                    .text_size(text::SMALL.size)
                                    .line_height(shell::QUESTION_DESCRIPTION_LINE_HEIGHT)
                                    .text_color(p.muted)
                                    .child(description),
                            )
                        }),
                ),
        )
        .disabled(busy)
}

#[cfg(test)]
mod tests {
    use super::{Palette, question_option_button};
    use gpui_kit::{JustifyContent, Styled};
    #[test]
    fn question_choices_align_the_clickable_content_and_distinguish_selection() {
        let option = crate::model::questions::QuestionOption {
            label: "Review".into(),
            description: Some("Inspect the changes".into()),
        };
        let p = Palette::for_dark(true);
        let mut idle = question_option_button(0, &option, false, false, false, p);
        let mut selected = question_option_button(0, &option, false, true, false, p);
        assert_eq!(idle.style().justify_content, Some(JustifyContent::Start));
        assert_ne!(idle.style().background, selected.style().background);
        assert_eq!(selected.style().border_color, Some(p.accent.opacity(0.4)));
    }
}
