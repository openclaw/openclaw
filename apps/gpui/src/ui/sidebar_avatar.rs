use super::{
    AppView,
    components::{avatar::Avatar, avatar_cache::AvatarCache},
    theme::{
        Palette,
        tokens::{AvatarMetrics, avatar, facepile, opacity, space},
    },
};
use crate::{
    gateway::sessions_rpc::Agent,
    model::{
        avatars::{self, AvatarFallback, AvatarSpec, SessionAvatarKind},
        people::Person,
        sessions::SessionRow,
    },
};
use gpui_kit::{assets::IconName, component::Icon, prelude::FluentBuilder, *};
use std::collections::HashSet;

impl AppView {
    pub(super) fn render_session_viewers(
        &self,
        row: &SessionRow,
        suppress_owner: bool,
        cx: &App,
    ) -> AnyElement {
        let mut excluded = HashSet::new();
        if !suppress_owner
            && !self.suppress_session_owner(row)
            && avatars::session_avatar_kind(row, false) == SessionAvatarKind::Owner
        {
            if let Some(owner) = self.session_avatar_owner(row)
                && let Some(profile) = owner.profile_id()
            {
                excluded.insert(profile.to_owned());
            }
            if row.participant_count.unwrap_or(row.participants.len()) == 1
                && let Some(person) = row.participants.first().and_then(Person::from_actor)
                && let Some(profile) = person.profile_id()
            {
                excluded.insert(profile.to_owned());
            }
        }
        let mut viewers: Vec<_> = self
            .sidebar_state
            .people
            .online_people()
            .into_iter()
            .filter(|person| {
                person.watched_sessions.contains(&row.key)
                    && person
                        .person
                        .profile_id()
                        .is_none_or(|profile| !excluded.contains(profile))
            })
            .collect();
        viewers.sort_by_key(|person| person.person.key());
        self.online_facepile(&viewers, 3, cx)
    }

    pub(super) fn render_person_avatar(
        &self,
        person: &Person,
        metrics: AvatarMetrics,
        cx: &App,
    ) -> AnyElement {
        self.render_person_avatar_on(person, metrics, Palette::sidebar(cx).sidebar)
    }

    pub(super) fn render_person_avatar_on(
        &self,
        person: &Person,
        metrics: AvatarMetrics,
        surface: Hsla,
    ) -> AnyElement {
        let gateway = self
            .web
            .auth
            .as_ref()
            .map(|auth| auth.gateway_url.as_str())
            .unwrap_or("");
        let spec = avatars::person_avatar(person, gateway);
        Avatar::new(&spec, &self.sidebar_state.avatars, metrics)
            .border_color(surface)
            .into_any_element()
    }

    pub(super) fn render_agent_avatar(
        &self,
        agent: &Agent,
        metrics: AvatarMetrics,
        _cx: &App,
    ) -> AnyElement {
        let gateway = self
            .web
            .auth
            .as_ref()
            .map(|auth| auth.gateway_url.as_str())
            .unwrap_or("");
        let spec = avatars::agent_avatar(
            &agent.id,
            agent.identity.avatar.as_deref(),
            agent.identity.avatar_url.as_deref(),
            agent.identity.emoji.as_deref(),
            gateway,
        );
        Avatar::new(&spec, &self.sidebar_state.avatars, metrics).into_any_element()
    }

    pub(super) fn render_session_avatar(
        &self,
        row: &SessionRow,
        size: f32,
        suppress_owner: bool,
        cx: &App,
    ) -> AnyElement {
        let gateway = self
            .web
            .auth
            .as_ref()
            .map(|auth| auth.gateway_url.as_str())
            .unwrap_or("");
        let suppress_owner = suppress_owner || self.suppress_session_owner(row);
        match avatars::session_avatar_kind(row, false) {
            SessionAvatarKind::Icon => {
                self.render_session_icon(row.icon.as_deref().unwrap_or_default(), size)
            }
            SessionAvatarKind::Channel => {
                let url = row
                    .channel_avatar_url
                    .as_deref()
                    .and_then(|url| avatars::trusted_avatar_url(url, gateway, Some("channel")));
                let image = url
                    .as_deref()
                    .and_then(|url| self.sidebar_state.avatars.image_url(url));
                let fallback = if suppress_owner {
                    div().size(px(size)).into_any_element()
                } else {
                    self.render_session_owner(row, size, cx)
                };
                div()
                    .relative()
                    .size(px(size))
                    .child(fallback)
                    .when_some(image, |this, image| {
                        this.child(
                            div()
                                .absolute()
                                .inset_0()
                                .rounded_full()
                                .overflow_hidden()
                                .child(
                                    img(image)
                                        .size_full()
                                        .rounded_full()
                                        .object_fit(ObjectFit::Cover)
                                        .with_fallback(|| div().into_any_element()),
                                ),
                        )
                    })
                    .into_any_element()
            }
            SessionAvatarKind::Owner if !suppress_owner => self.render_session_owner(row, size, cx),
            SessionAvatarKind::Empty
                if !suppress_owner && self.session_avatar_owner(row).is_some() =>
            {
                self.render_session_owner(row, size, cx)
            }
            _ => div().size(px(size)).into_any_element(),
        }
    }

    fn render_session_icon(&self, icon: &str, size: f32) -> AnyElement {
        let named = match icon {
            "braces" => Some(IconName::Braces),
            "book" => Some(IconName::Book),
            "monitor" => Some(IconName::Monitor),
            "bot" => Some(IconName::Bot),
            "kanban" => Some(IconName::Kanban),
            "coins" => Some(IconName::Coins),
            _ => None,
        };
        if let Some(named) = named {
            return Icon::new(named)
                .size(px(size * avatar::SESSION_ICON_RATIO))
                .into_any_element();
        }
        if let Some(image) = self.sidebar_state.avatars.image_url(icon) {
            return img(image.clone())
                .size(px(size))
                .object_fit(ObjectFit::Contain)
                .into_any_element();
        }
        div()
            .size(px(size))
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(size * avatar::SESSION_ICON_RATIO))
            .child(if icon.starts_with("data:") {
                String::new()
            } else {
                icon.to_owned()
            })
            .into_any_element()
    }

    fn render_session_owner(&self, row: &SessionRow, size: f32, cx: &App) -> AnyElement {
        let Some(owner) = self.session_avatar_owner(row) else {
            return div().size(px(size)).into_any_element();
        };
        let gateway = self
            .web
            .auth
            .as_ref()
            .map(|auth| auth.gateway_url.as_str())
            .unwrap_or("");
        let count = row.participant_count.unwrap_or(row.participants.len());
        let mut result = div()
            .relative()
            .w(px(if count > 0 {
                size + f32::from(facepile::PARTICIPANT_OFFSET_X)
            } else {
                size
            }))
            .h(px(size))
            .flex_shrink_0()
            .when(
                owner.profile_id().is_some() && !self.session_owner_viewing(&owner, row),
                |this| this.opacity(opacity::IDLE),
            );
        if count > 0 {
            let participant = if count == 1 {
                row.participants.first().and_then(Person::from_actor)
            } else {
                None
            };
            let rear = participant
                .as_ref()
                .map(|person| {
                    self.render_person_avatar(
                        person,
                        AvatarMetrics {
                            diameter: px(size),
                            text_size: px(size * avatar::FALLBACK_TEXT_RATIO),
                            border: space::HAIRLINE,
                        },
                        cx,
                    )
                })
                .unwrap_or_else(|| {
                    div()
                        .size(px(size))
                        .rounded_full()
                        .bg(Palette::sidebar(cx).elevated)
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(facepile::OVERFLOW_TEXT)
                        .child(format!("+{count}"))
                        .into_any_element()
                });
            result = result.child(
                div()
                    .absolute()
                    .left(facepile::PARTICIPANT_OFFSET_X)
                    .top(facepile::PARTICIPANT_OFFSET_Y)
                    .child(rear),
            );
        }
        result
            .child(div().relative().child(self.render_avatar_spec(
                &avatars::owner_avatar(&owner, gateway),
                size,
                cx,
            )))
            .into_any_element()
    }

    fn session_avatar_owner(&self, row: &SessionRow) -> Option<Person> {
        if self.sidebar_state.preferences.archive == crate::model::sidebar::ArchiveFilter::Archived
        {
            row.archived_by.as_ref().and_then(Person::from_actor)
        } else {
            avatars::session_owner(row)
        }
    }

    fn session_owner_viewing(&self, owner: &Person, row: &SessionRow) -> bool {
        owner.profile_id().is_some_and(|profile| {
            self.sidebar_state.people.entries.iter().any(|entry| {
                entry.reason.as_deref() != Some("disconnect")
                    && entry.user.as_ref().and_then(Person::profile_id) == Some(profile)
                    && entry.watched_sessions.contains(&row.key)
            })
        })
    }

    fn suppress_session_owner(&self, row: &SessionRow) -> bool {
        if !avatars::has_multiple_human_identities(
            &self.sidebar_state.owners,
            &self.rows,
            self.sidebar_state.people.self_user.as_ref(),
        ) {
            return true;
        }
        let preferences = &self.sidebar_state.preferences;
        if preferences.archive == crate::model::sidebar::ArchiveFilter::Archived {
            return false;
        }
        let Some(owner) = self.session_avatar_owner(row) else {
            return true;
        };
        let repeated_section = preferences.grouping == crate::model::sidebar::Grouping::Person
            && !row.pinned
            && !preferences.all_agents
            && !self.session_owner_viewing(&owner, row);
        let self_id = self
            .sidebar_state
            .people
            .self_user
            .as_ref()
            .and_then(|person| person.profile_id().or(Some(person.id.as_str())));
        let repeated_filter = owner.profile_id().is_some()
            && owner.profile_id() == self_id
            && (preferences.involving_me
                || preferences.owner_id.as_deref() == Some(owner.id.as_str()))
            && row.participant_count.unwrap_or(row.participants.len()) == 0;
        repeated_section || repeated_filter
    }

    pub(super) fn render_avatar_spec(&self, spec: &AvatarSpec, size: f32, _cx: &App) -> AnyElement {
        Avatar::new(
            spec,
            &self.sidebar_state.avatars,
            AvatarMetrics {
                diameter: px(size),
                text_size: px(size * avatar::FALLBACK_TEXT_RATIO),
                border: space::NONE,
            },
        )
        .into_any_element()
    }

    /// Fetch only currently referenced routes. Each Gateway window owns its cache and tasks.
    pub(super) fn refresh_sidebar_avatars(&mut self, cx: &mut Context<Self>) {
        let Some(auth) = self.web.auth.clone() else {
            return;
        };
        let mut specs = Vec::new();
        if let Some(person) = &self.sidebar_state.people.self_user {
            specs.push(avatars::person_avatar(person, &auth.gateway_url));
        }
        for person in self
            .chat
            .messages
            .iter()
            .filter_map(|message| message.sender_person.as_ref())
        {
            specs.push(avatars::person_avatar(person, &auth.gateway_url));
        }
        for person in self.sidebar_state.people.online_people() {
            specs.push(avatars::person_avatar(&person.person, &auth.gateway_url));
        }
        for agent in &self.sidebar_state.agents {
            specs.push(avatars::agent_avatar(
                &agent.id,
                agent.identity.avatar.as_deref(),
                agent.identity.avatar_url.as_deref(),
                agent.identity.emoji.as_deref(),
                &auth.gateway_url,
            ));
        }
        let visible: HashSet<_> = self.sidebar_visible_keys().into_iter().collect();
        let mut rows: Vec<_> = self
            .rows
            .iter()
            .chain(self.sidebar_state.children.values().flatten())
            .chain(self.sidebar_state.search_rows.iter())
            .collect();
        rows.sort_by_key(|row| !visible.contains(&row.key));
        for row in rows {
            if let Some(icon) = row
                .icon
                .as_ref()
                .filter(|icon| avatars::decode_data_image(icon).is_some())
            {
                specs.push(AvatarSpec {
                    url: Some(icon.clone()),
                    fallback: AvatarFallback::Text(String::new()),
                });
            }
            if let Some(person) = avatars::session_owner(row) {
                specs.push(avatars::owner_avatar(&person, &auth.gateway_url));
            }
            if let Some(person) = row.archived_by.as_ref().and_then(Person::from_actor) {
                specs.push(avatars::owner_avatar(&person, &auth.gateway_url));
            }
            for person in row.participants.iter().filter_map(Person::from_actor) {
                specs.push(avatars::person_avatar(&person, &auth.gateway_url));
            }
            if let Some(url) = row.channel_avatar_url.as_deref().and_then(|url| {
                avatars::trusted_avatar_url(url, &auth.gateway_url, Some("channel"))
            }) {
                specs.push(AvatarSpec {
                    url: Some(url),
                    fallback: AvatarFallback::Text("#".into()),
                });
            }
        }
        let downloads = self.sidebar_state.avatars.prepare(&specs);
        let device_token = self
            .session
            .as_ref()
            .and_then(|session| {
                session
                    .hello()
                    .pointer("/auth/deviceToken")
                    .and_then(serde_json::Value::as_str)
            })
            .map(str::to_owned);
        for url in downloads {
            let request_url = url.clone();
            let request_auth = auth.clone();
            let request_device_token = device_token.clone();
            let task = self.runtime.spawn(async move {
                AvatarCache::download(&request_url, &request_auth, request_device_token.as_deref())
                    .await
            });
            let request_id = task.id();
            self.sidebar_state
                .avatars
                .request_started(url.clone(), task.abort_handle());
            let epoch = self.epoch;
            cx.spawn(async move |this, cx| {
                let result = task.await.ok().flatten();
                let _ = this.update(cx, |this, cx| {
                    if this.epoch != epoch {
                        return;
                    }
                    if !this
                        .sidebar_state
                        .avatars
                        .complete(&url, request_id, result)
                    {
                        return;
                    }
                    cx.notify();
                });
            })
            .detach();
        }
    }
}
