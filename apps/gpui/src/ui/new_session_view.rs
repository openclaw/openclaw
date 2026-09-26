mod destination;
mod workspace;

use super::{
    AppView,
    components::{
        chip::{ChipStyle, chip},
        icons,
        menu::{
            self, MenuStyle, inline_detail_row as checkout_option, input_field as checkout_field,
            note, section_header as title, selection_row as row,
        },
    },
    new_session::DraftPicker,
    new_session_actions::clone_url,
    theme::{Palette, draft_tokens as t, menu_tokens as m},
};
use crate::model::new_session::{
    Destination, Visibility, is_worktree_name_valid, worktree_branch_name,
};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        input::{Input, Textarea},
    },
    prelude::FluentBuilder,
    *,
};

impl AppView {
    pub(super) fn new_session_view(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        let state = &self.new_session;
        let draft = &state.draft;
        let agent = self
            .sidebar_state
            .agents
            .iter()
            .find(|a| a.id == draft.agent_id);
        let incognito = draft.visibility == Visibility::Incognito;
        let paste_target = cx.entity().downgrade();
        let invalid_name = draft.worktree && !is_worktree_name_valid(&draft.worktree_name);
        let submit_block = self.draft_submit_block();
        let send_disabled = state.submitting
            || self.session.is_none()
            || self.composer_state.reading > 0
            || invalid_name
            || submit_block.is_some()
            || (self.composer.read(cx).value().trim().is_empty()
                && self.composer_state.attachments.is_empty());
        let composer = div()
            .id("new-session-composer")
            .v_flex()
            .w_full()
            .gap(px(t::STACK_GAP))
            .px(px(t::COMPOSER_INSET))
            .py(px(t::COMPOSER_PADDING_Y))
            .min_h(px(t::COMPOSER_HEIGHT))
            .justify_between()
            .bg(p.card)
            .border_1()
            .border_color(p.border_strong)
            .rounded(px(t::COMPOSER_RADIUS))
            .capture_key_down(cx.listener(Self::composer_key_down))
            .children(self.attachment_rail(cx))
            .child(
                Textarea::new(&self.composer)
                    .mx(px(t::EDITOR_MARGIN_X))
                    .aria_label("What should this session work on?")
                    .accessibility_id("new-session-message")
                    .appearance(false)
                    .bordered(false)
                    .disabled(state.locked())
                    .text_size(px(t::EDITOR_TEXT_SIZE))
                    .on_paste(move |item, _, cx| {
                        paste_target
                            .update(cx, |this, cx| this.composer_paste(item, cx))
                            .unwrap_or(false)
                    }),
            )
            .children(self.composer_state.error.as_ref().map(|error| {
                div()
                    .text_size(px(t::CAPTION_TEXT_SIZE))
                    .text_color(p.danger)
                    .child(error.clone())
            }))
            .when(self.composer_state.reading > 0, |el| {
                el.child(
                    div()
                        .text_color(p.muted)
                        .text_size(px(t::CAPTION_TEXT_SIZE))
                        .child("Reading attachment…"),
                )
            })
            .child(
                div()
                    .h_flex()
                    .group("new-session-footer")
                    .mx(px(t::FOOTER_MARGIN_X))
                    .items_center()
                    .gap(px(t::CONTROL_GAP))
                    .child(self.composer_plus_control(cx))
                    .child(self.permission_control(cx))
                    .when(self.composer_draft_available(), |el| {
                        el.child(
                            Button::new("draft-visibility")
                                .ghost()
                                .small()
                                .h(px(t::FOOTER_CONTROL_SIZE))
                                .icon(Icon::new(IconName::Pencil).size(px(m::ICON_SIZE)))
                                .label("Draft")
                                .text_color(if draft.visibility == Visibility::Draft {
                                    p.accent
                                } else {
                                    p.muted
                                })
                                .tooltip("Keep this session to yourself until you publish it")
                                .disabled(state.locked())
                                .when(draft.visibility != Visibility::Draft, |el| {
                                    el.opacity(t::HIDDEN_CONTROL_OPACITY)
                                        .group_hover("new-session-footer", |el| {
                                            el.opacity(t::VISIBLE_CONTROL_OPACITY)
                                        })
                                })
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.new_session.draft.visibility =
                                        if this.new_session.draft.visibility == Visibility::Draft {
                                            Visibility::Normal
                                        } else {
                                            Visibility::Draft
                                        };
                                    cx.notify();
                                })),
                        )
                    })
                    .child(div().flex_1())
                    .child(self.model_controls_view(&self.new_session.model_target(), window, cx))
                    .child(
                        Button::new("start-session")
                            .primary()
                            .small()
                            .size(px(t::FOOTER_CONTROL_SIZE))
                            .rounded_full()
                            .child(
                                Icon::new(if state.submitting {
                                    IconName::LoaderCircle
                                } else {
                                    IconName::ArrowUp
                                })
                                .size(px(t::FOOTER_ICON_SIZE)),
                            )
                            .accessibility_label(if state.submitting {
                                "Starting session"
                            } else {
                                "Start session"
                            })
                            .disabled(send_disabled)
                            .tooltip(
                                submit_block
                                    .clone()
                                    .unwrap_or_else(|| "Start session".into()),
                            )
                            .on_click(cx.listener(|this, _, window, cx| this.send(window, cx))),
                    ),
            );
        let target_row = div()
            .id("new-session-targets")
            .h_flex()
            .flex_wrap()
            .items_center()
            .gap(px(t::CHIP_GAP))
            .when(self.sidebar_state.agents.len() > 1, |el| {
                el.child(self.draft_picker(
                    DraftPicker::Agent,
                    "draft-agent",
                    agent.map(|a| a.name()).unwrap_or("Agent").to_owned(),
                    IconName::Bot,
                    self.draft_agent_menu(cx),
                    cx,
                ))
            })
            .child(self.draft_picker(
                DraftPicker::Destination,
                "draft-destination",
                self.draft_destination_label(),
                if draft.destination.is_remote() {
                    IconName::Monitor
                } else {
                    IconName::House
                },
                self.draft_destination_menu(cx),
                cx,
            ))
            .child(self.draft_picker(
                DraftPicker::Project,
                "draft-project",
                self.draft_project_label(),
                if draft.project_id.is_empty() {
                    IconName::Folder
                } else {
                    IconName::GitBranch
                },
                self.draft_project_menu(cx),
                cx,
            ))
            .when(
                !(draft.destination.is_remote() && draft.fresh_workspace)
                    && (state.branches.repository_status.as_deref() == Some("git")
                        || !draft.project_git_url.is_empty()
                        || draft.worktree),
                |el| {
                    el.child(self.draft_picker(
                        DraftPicker::Checkout,
                        "draft-checkout",
                        if draft.worktree {
                            "New worktree".into()
                        } else {
                            state
                                .branches
                                .head_branch
                                .clone()
                                .unwrap_or_else(|| "Current checkout".into())
                        },
                        IconName::GitBranch,
                        self.draft_checkout_menu(cx),
                        cx,
                    ))
                },
            );
        let mut recent = self
            .rows
            .iter()
            .filter(|row| {
                !row.archived
                    && row
                        .navigation_parent(
                            &format!("agent:{}:{}", draft.agent_id, self.sidebar_state.main_key),
                            None,
                        )
                        .is_none()
                    && !row.incognito
                    && row
                        .channel
                        .as_deref()
                        .is_none_or(|channel| channel == "webchat")
                    && row.agent() == Some(draft.agent_id.as_str())
                    && !row.key.ends_with(":main")
            })
            .collect::<Vec<_>>();
        recent.sort_by(|a, b| {
            b.updated_at
                .partial_cmp(&a.updated_at)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        div().id("new-session-page").relative().flex_1().min_w_0().h_full()
            .child(div().id("new-session-scroll").v_flex().items_center().size_full().overflow_y_scroll()
                .pt(px(t::SCROLL_TOP)).px(px(t::SCROLL_PADDING_X)).pb(px(t::SCROLL_BOTTOM))
                .on_drop(cx.listener(|this,paths:&ExternalPaths,_,cx| this.attach_paths(paths.paths().to_vec(),cx)))
                .child(div().v_flex().items_center().gap(px(t::HERO_GAP))
                    .children(agent.map(|agent| div().size(px(t::HERO_AVATAR_SIZE)).h_flex().items_center().justify_center().text_size(px(t::ICON_SIZE)).child(agent.avatar())))
                    .child(div().v_flex().items_center().gap(px(t::CONTROL_GAP))
                        .child(div().text_size(px(t::TITLE_TEXT_SIZE)).line_height(px(t::TITLE_LINE_HEIGHT)).font_weight(t::TITLE_WEIGHT)
                            .child(agent.map(|a|a.name()).unwrap_or("Assistant").to_owned()))
                        .child(div().text_size(px(t::BODY_TEXT_SIZE)).line_height(px(t::HINT_LINE_HEIGHT)).text_color(p.muted).child("Pick where this session works, then say what to do."))))
                .child(div().v_flex().w_full().max_w(px(t::COMPOSER_WIDTH)).mt(px(t::FORM_TOP)).gap(px(t::STACK_GAP))
                    .child(target_row)
                    .when(invalid_name,|el| el.child(div().text_size(px(t::CAPTION_TEXT_SIZE)).text_color(p.danger).px(px(t::NOTICE_INSET)).child("Use lowercase letters, digits, and dashes (up to 64).")))
                    .children(state.error.as_ref().map(|error| div().text_size(px(t::CAPTION_TEXT_SIZE)).text_color(p.danger).child(error.clone())))
                    .when(state.group_failed,|el|el.child(Button::new("retry-group-defaults").ghost().small().label("Retry group defaults")
                        .on_click(cx.listener(|this,_,_,cx|{this.new_session.group_failed=false;this.new_session.group_pending=true;this.load_draft_catalogs(cx);}))))
                    .when(state.error.is_some() && state.completed_key.is_some(), |el| {
                        let key=state.completed_key.clone().unwrap_or_default();
                        el.child(Button::new("open-created-session").ghost().small().label("Open created session")
                            .on_click(cx.listener(move|this,_,window,cx|this.select_session(key.clone(),window,cx))))
                    })
                    .child(composer)
                    .when(incognito, |el| el.child(div().text_size(px(t::CAPTION_TEXT_SIZE)).text_color(p.muted).px(px(t::COMPOSER_INSET)).child(
                        "Keep this session for 24 hours or until the Gateway restarts, whichever comes first"))))
                .when(!incognito && self.composer.read(cx).value().trim().is_empty(), |el| el.child(
                    div().v_flex().w_full().max_w(px(t::RECENT_WIDTH)).mt(px(t::RECENT_TOP)).gap(px(t::CHIP_GAP))
                        .when(!recent.is_empty(), |el| el.child(div().px(px(t::RECENT_ROW_PADDING_X)).text_size(px(t::CAPTION_TEXT_SIZE)).font_weight(t::TITLE_WEIGHT).text_color(p.muted).child("RECENT CHATS")))
                        .children(recent.into_iter().take(5).map(|row| {
                            let key = row.key.clone();
                            Button::new(SharedString::from(format!("draft-recent-{key}"))).ghost().small().h(px(t::RECENT_ROW_HEIGHT)).px(px(t::RECENT_ROW_PADDING_X)).justify_start()
                                .accessibility_label(row.title()).child(div().flex_1().text_left().child(row.title())).on_click(cx.listener(move |this,_,window,cx|this.select_session(key.clone(),window,cx)))
                        })))))
            .child(Button::new("new-session-incognito").ghost().small().absolute().top(px(t::INCOGNITO_INSET)).right(px(t::INCOGNITO_INSET)).size(px(t::INCOGNITO_BUTTON_SIZE))
                .border_1().border_color(p.border).rounded(px(t::INCOGNITO_RADIUS)).child(icons::incognito(if incognito {p.accent} else {p.muted}))
                .when(incognito,|el|el.border_color(p.accent.opacity(t::ACTIVE_BORDER_OPACITY)).bg(p.accent.opacity(t::ACTIVE_BACKGROUND_OPACITY)))
                .text_color(if incognito {p.accent} else {p.muted}).accessibility_label("Incognito")
                .tooltip(if self.draft_admin(){"Keep this session for 24 hours or until the Gateway restarts, whichever comes first"}else{"Incognito requires administrator access"}).disabled(state.locked() || !self.draft_admin())
                .on_click(cx.listener(|this,_,_,cx| {
                    this.new_session.draft.visibility = if this.new_session.draft.visibility == Visibility::Incognito {Visibility::Normal} else {Visibility::Incognito}; cx.notify();
                })))
            .into_any_element()
    }
}
