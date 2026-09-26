use super::{AppView, Palette, SessionRow, SidebarAttention};
use crate::ui::components::icons::icon as ui_icon;
use crate::{
    model::{chat::now_ms, sidebar_pr::scoped_key},
    ui::theme::tokens::{avatar, colors, icon, space, text},
};
use gpui_kit::{
    assets::IconName,
    component::{Sizable, StyledExt, spinner::Spinner, tooltip::Tooltip},
    prelude::FluentBuilder,
    *,
};
use serde_json::Value;

pub(super) struct LeadingState {
    pub depth: usize,
    pub attention: SidebarAttention,
    pub running: bool,
    pub queued: bool,
    pub unread: bool,
}

impl AppView {
    pub(super) fn sidebar_leading(
        &self,
        row: &SessionRow,
        attention_row: &SessionRow,
        state: LeadingState,
        cx: &App,
    ) -> AnyElement {
        let LeadingState {
            depth,
            attention,
            running,
            queued,
            unread,
        } = state;
        let p = Palette::sidebar(cx);
        let has_avatar = row.icon.is_some()
            || row.channel_avatar_url.is_some()
            || (depth == 0 && (row.owner.is_some() || row.created_actor.is_some()));
        let content = if attention != SidebarAttention::None {
            attention_badge(attention_row, attention, p)
        } else if depth > 0 && !running && !has_avatar {
            match row.status.as_deref() {
                Some("done") => row_badge(
                    &row.key,
                    "done",
                    IconName::Check,
                    "Completed".into(),
                    p.muted,
                ),
                Some("killed") => row_badge(
                    &row.key,
                    "stopped",
                    IconName::Square,
                    "Stopped".into(),
                    p.muted,
                ),
                Some("failed" | "timeout") => row_badge(
                    &row.key,
                    "failed",
                    IconName::TriangleAlert,
                    "Failed".into(),
                    p.danger,
                ),
                _ => div().size(avatar::SESSION.diameter).into_any_element(),
            }
        } else {
            self.render_session_avatar(row, avatar::SESSION.diameter.into(), depth > 0, cx)
        };
        div()
            .relative()
            .size(icon::RUN_RING)
            .flex()
            .items_center()
            .justify_center()
            .child(content)
            .when(running && attention != SidebarAttention::Question, |el| {
                el.child(
                    div()
                        .absolute()
                        .inset_0()
                        .child(run_ring(icon::RUN_RING, queued, p)),
                )
            })
            .when(unread && !running, |el| {
                el.child(
                    div()
                        .absolute()
                        .right(-space::HAIRLINE)
                        .bottom(-space::HAIRLINE)
                        .child(unread_dot(p)),
                )
            })
            .into_any_element()
    }

    pub(super) fn sidebar_row_badges(
        &self,
        row: &SessionRow,
        depth: usize,
        cx: &App,
    ) -> AnyElement {
        let p = Palette::sidebar(cx);
        let agent = row.agent().or(self.sidebar_state.selected_agent.as_deref());
        let pr = self
            .sidebar_state
            .pull_requests
            .summary(&scoped_key(&row.key, agent));
        let selected = self.chat.selected_session.as_ref() == Some(&row.key);
        let draft = if selected {
            !self.composer.read(cx).value().trim().is_empty()
                || !self.composer_state.attachments.is_empty()
        } else {
            self.composer_state.drafts.has_draft(&row.key, agent)
        };
        let failed_sends = self
            .composer_state
            .pending
            .values()
            .filter(|pending| {
                !pending.in_flight
                    && pending.scope.session_key == row.key
                    && pending.scope.agent_id.as_deref() == agent
                    && self.composer_state.drafts.gateway() == Some(pending.gateway.as_str())
            })
            .count();
        let mut badges = div().h_flex().flex_shrink_0().gap(space::TIGHT);
        if row.incognito {
            badges = badges.child(row_badge(
                &row.key,
                "incognito",
                IconName::Lock,
                "Incognito session".into(),
                p.muted,
            ));
        }
        if let Some(pr) = pr {
            let title = format!(
                "{} · {}",
                pr.numbers
                    .iter()
                    .map(|number| format!("#{number}"))
                    .collect::<Vec<_>>()
                    .join(", "),
                pr.state
            );
            let color = match pr.state.as_str() {
                "open" => p.ok,
                "merged" => colors::merged_pull_request(),
                _ => p.muted,
            };
            badges = badges.child(row_badge(
                &row.key,
                "pr",
                if pr.state == "merged" {
                    IconName::GitMerge
                } else {
                    IconName::GitPullRequest
                },
                title,
                color,
            ));
        }
        if draft {
            badges = badges.child(row_badge(
                &row.key,
                "draft",
                IconName::Pencil,
                "Unsent draft".into(),
                p.muted,
            ));
        }
        if failed_sends > 0 {
            badges = badges.child(row_badge(
                &row.key,
                "send",
                IconName::TriangleAlert,
                format!("{failed_sends} unsent message(s) need attention"),
                p.danger,
            ));
        }
        if let Some(placement) = &row.placement {
            let state = placement
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("local");
            let conflicts = placement
                .pointer("/workspaceResultConflict/totalCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .max(
                    placement
                        .pointer("/workspaceResultConflict/paths")
                        .and_then(Value::as_array)
                        .map_or(0, |paths| paths.len() as u64),
                );
            if (depth == 0 && !matches!(state, "local" | "reclaimed")) || conflicts > 0 {
                let mut label = [
                    placement.get("providerId").and_then(Value::as_str),
                    placement.get("profileId").and_then(Value::as_str),
                    Some(state),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ");
                if conflicts > 0 {
                    label.push_str(&format!(" · {conflicts} workspace conflicts"));
                }
                let disk = placement
                    .pointer("/diskSpace/status")
                    .and_then(Value::as_str);
                if depth == 0 && state == "active" && matches!(disk, Some("warning" | "critical")) {
                    label.push_str(&format!(" · disk space {}", disk.unwrap_or_default()));
                }
                badges = badges.child(row_badge(
                    &row.key,
                    "placement",
                    IconName::Globe,
                    label,
                    if conflicts > 0 || state == "failed" || disk == Some("critical") {
                        p.danger
                    } else {
                        p.muted
                    },
                ));
            }
        }
        if self.sidebar_state.preferences.all_agents {
            if row.work_session() && row.worktree.is_none() && row.repository.is_none() {
                badges = badges.child(row_badge(
                    &row.key,
                    "coding",
                    IconName::Terminal,
                    "Coding".into(),
                    p.muted,
                ));
            }
            if row.has_automation {
                badges = badges.child(row_badge(
                    &row.key,
                    "automation",
                    IconName::Clock,
                    "Automation".into(),
                    p.muted,
                ));
            }
        }
        if depth > 0
            && let Some(runtime) = row.runtime_duration_ms(now_ms())
        {
            badges = badges.child(
                div()
                    .text_size(text::COUNT.size)
                    .text_color(p.muted)
                    .child(compact_duration(runtime)),
            );
        }
        badges.into_any_element()
    }
}

pub(super) fn row_badge(
    key: &str,
    id: &str,
    icon: IconName,
    label: String,
    color: Hsla,
) -> AnyElement {
    div()
        .id(SharedString::from(format!("badge:{key}:{id}")))
        .size(icon::BADGE_BOX)
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .child(ui_icon(icon, icon::COMPACT).text_color(color))
        .tooltip(move |window, cx| Tooltip::new(label.clone()).build(window, cx))
        .into_any_element()
}

pub(super) fn attention_badge(
    row: &SessionRow,
    attention: SidebarAttention,
    p: Palette,
) -> AnyElement {
    let (icon, label, color) = match attention {
        SidebarAttention::Question => {
            (IconName::Hand, "Waiting for your answer".to_owned(), p.warn)
        }
        SidebarAttention::Approval => (
            IconName::ShieldQuestionMark,
            "Waiting for approval".to_owned(),
            p.warn,
        ),
        SidebarAttention::Error => (
            IconName::TriangleAlert,
            row.last_run_error
                .clone()
                .unwrap_or_else(|| "Run failed".into()),
            p.danger,
        ),
        SidebarAttention::Agent => {
            let status = row.agent_status.as_ref();
            let icon = match status.and_then(|status| status.attention.as_deref()) {
                Some("key") => IconName::Key,
                Some("flag") => IconName::Flag,
                Some("lock") => IconName::Lock,
                Some("hourglass") => IconName::Circle,
                Some("alert") => IconName::TriangleAlert,
                _ => IconName::Hand,
            };
            (
                icon,
                status
                    .map(|status| status.note.clone())
                    .unwrap_or_else(|| "Needs attention".into()),
                p.warn,
            )
        }
        SidebarAttention::None => return div().into_any_element(),
    };
    row_badge(&row.key, "attention", icon, label, color)
}

pub(super) fn run_ring(size: Pixels, queued: bool, p: Palette) -> AnyElement {
    if queued {
        ui_icon(IconName::CircleDashed, size)
            .text_color(p.muted)
            .into_any_element()
    } else {
        Spinner::new()
            .icon(IconName::LoaderCircle)
            .with_size(size)
            .color(p.muted)
            .into_any_element()
    }
}

pub(super) fn unread_dot(p: Palette) -> AnyElement {
    div()
        .size(icon::DOT)
        .rounded_full()
        .bg(p.accent)
        .flex_shrink_0()
        .into_any_element()
}

fn compact_duration(ms: u64) -> String {
    let seconds = ms / 1000;
    if seconds >= 3600 {
        format!("{}h {}m", seconds / 3600, seconds % 3600 / 60)
    } else if seconds >= 60 {
        format!("{}m {}s", seconds / 60, seconds % 60)
    } else if ms >= 1000 {
        format!("{seconds}s")
    } else {
        format!("{ms}ms")
    }
}
