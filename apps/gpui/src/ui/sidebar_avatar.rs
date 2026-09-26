use super::{AppView, theme::Palette};
use crate::{
    gateway::{access, sessions_rpc::Agent},
    model::{
        avatars::{self, AvatarFallback, AvatarSpec, MAX_AVATAR_BYTES, SessionAvatarKind},
        people::Person,
        sessions::SessionRow,
        web_urls::WebAuth,
    },
};
use gpui_kit::{assets::IconName, component::Icon, prelude::FluentBuilder, *};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

const MAX_CACHED_AVATARS: usize = 128;
const FAILED_AVATAR_RETRY_AFTER: Duration = Duration::from_secs(60);

#[derive(Default)]
pub(super) struct AvatarCache {
    images: HashMap<String, Option<Arc<Image>>>,
    failed_at: HashMap<String, Instant>,
    faces: HashMap<String, Arc<Image>>,
    pending: HashMap<String, tokio::task::AbortHandle>,
}

impl Drop for AvatarCache {
    fn drop(&mut self) {
        for task in self.pending.values() {
            task.abort();
        }
    }
}

impl AvatarCache {
    pub(super) fn image(&self, spec: &AvatarSpec) -> Option<Arc<Image>> {
        spec.url
            .as_ref()
            .and_then(|url| self.images.get(url))
            .cloned()
            .flatten()
    }

    fn face(&self, id: &str) -> Arc<Image> {
        self.faces.get(id).cloned().unwrap_or_else(|| {
            Arc::new(Image::from_bytes(
                ImageFormat::Svg,
                avatars::agent_face_svg(id).into_bytes(),
            ))
        })
    }
}

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

    pub(super) fn render_person_avatar(&self, person: &Person, size: f32, cx: &App) -> AnyElement {
        let gateway = self
            .web
            .auth
            .as_ref()
            .map(|auth| auth.gateway_url.as_str())
            .unwrap_or("");
        self.render_avatar_spec(&avatars::person_avatar(person, gateway), size, cx)
    }

    pub(super) fn render_agent_avatar(&self, agent: &Agent, size: f32, cx: &App) -> AnyElement {
        let gateway = self
            .web
            .auth
            .as_ref()
            .map(|auth| auth.gateway_url.as_str())
            .unwrap_or("");
        self.render_avatar_spec(
            &avatars::agent_avatar(
                &agent.id,
                agent.identity.avatar.as_deref(),
                agent.identity.avatar_url.as_deref(),
                agent.identity.emoji.as_deref(),
                gateway,
            ),
            size,
            cx,
        )
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
                    .as_ref()
                    .and_then(|url| self.sidebar_state.avatars.images.get(url))
                    .cloned()
                    .flatten();
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
            return Icon::new(named).size(px(size * 0.8)).into_any_element();
        }
        if let Some(Some(image)) = self.sidebar_state.avatars.images.get(icon) {
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
            .text_size(px(size * 0.8))
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
            .w(px(if count > 0 { size + 6. } else { size }))
            .h(px(size))
            .flex_shrink_0()
            .when(
                owner.profile_id().is_some() && !self.session_owner_viewing(&owner, row),
                |this| this.opacity(0.45),
            );
        if count > 0 {
            let participant = if count == 1 {
                row.participants.first().and_then(Person::from_actor)
            } else {
                None
            };
            let rear = participant
                .as_ref()
                .map(|person| self.render_person_avatar(person, size, cx))
                .unwrap_or_else(|| {
                    div()
                        .size(px(size))
                        .rounded_full()
                        .bg(Palette::get(cx).elevated)
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(8.))
                        .child(format!("+{count}"))
                        .into_any_element()
                });
            result = result.child(div().absolute().left(px(6.)).top(px(-2.)).child(rear));
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

    pub(super) fn render_avatar_spec(&self, spec: &AvatarSpec, size: f32, cx: &App) -> AnyElement {
        avatar_element(
            spec,
            self.sidebar_state.avatars.image(spec),
            match &spec.fallback {
                AvatarFallback::AgentFace(id) => Some(self.sidebar_state.avatars.face(id)),
                _ => None,
            },
            size,
            Palette::get(cx),
        )
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
        // Preserve priority rather than letting hash iteration decide which images fit.
        let mut wanted = HashSet::new();
        let urls: Vec<_> = specs
            .iter()
            .filter_map(|spec| spec.url.clone())
            .filter(|url| wanted.insert(url.clone()))
            .take(MAX_CACHED_AVATARS)
            .collect();
        self.sidebar_state
            .avatars
            .images
            .retain(|url, _| wanted.contains(url));
        self.sidebar_state
            .avatars
            .failed_at
            .retain(|url, _| wanted.contains(url));
        self.sidebar_state.avatars.pending.retain(|url, task| {
            let retained = wanted.contains(url);
            if !retained {
                task.abort();
            }
            retained
        });
        let wanted_faces: HashSet<_> = specs
            .iter()
            .filter_map(|spec| match &spec.fallback {
                AvatarFallback::AgentFace(id) => Some(id.clone()),
                _ => None,
            })
            .take(MAX_CACHED_AVATARS)
            .collect();
        self.sidebar_state
            .avatars
            .faces
            .retain(|id, _| wanted_faces.contains(id));
        for id in wanted_faces {
            self.sidebar_state
                .avatars
                .faces
                .entry(id.clone())
                .or_insert_with(|| {
                    Arc::new(Image::from_bytes(
                        ImageFormat::Svg,
                        avatars::agent_face_svg(&id).into_bytes(),
                    ))
                });
        }
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
        for url in urls {
            let retry = self
                .sidebar_state
                .avatars
                .failed_at
                .get(&url)
                .is_some_and(|failed| failed.elapsed() >= FAILED_AVATAR_RETRY_AFTER);
            if self.sidebar_state.avatars.images.contains_key(&url) && !retry {
                continue;
            }
            self.sidebar_state.avatars.failed_at.remove(&url);
            self.sidebar_state.avatars.images.insert(url.clone(), None);
            if let Some((mime, bytes)) = avatars::decode_data_image(&url) {
                if let Some(format) = ImageFormat::from_mime_type(&mime) {
                    self.sidebar_state
                        .avatars
                        .images
                        .insert(url, Some(Arc::new(Image::from_bytes(format, bytes))));
                } else {
                    self.sidebar_state
                        .avatars
                        .failed_at
                        .insert(url, Instant::now());
                }
                continue;
            }
            let request_url = url.clone();
            let request_auth = auth.clone();
            let request_device_token = device_token.clone();
            let task = self.runtime.spawn(async move {
                download_avatar(&request_url, &request_auth, request_device_token.as_deref()).await
            });
            let request_id = task.id();
            self.sidebar_state
                .avatars
                .pending
                .insert(url.clone(), task.abort_handle());
            let epoch = self.epoch;
            cx.spawn(async move |this, cx| {
                let result = task.await.ok().flatten();
                let _ = this.update(cx, |this, cx| {
                    if this.epoch != epoch {
                        return;
                    }
                    if this
                        .sidebar_state
                        .avatars
                        .pending
                        .get(&url)
                        .map(tokio::task::AbortHandle::id)
                        != Some(request_id)
                    {
                        return;
                    }
                    this.sidebar_state.avatars.pending.remove(&url);
                    if result.is_none() {
                        this.sidebar_state
                            .avatars
                            .failed_at
                            .insert(url.clone(), Instant::now());
                    }
                    if let Some(entry) = this.sidebar_state.avatars.images.get_mut(&url) {
                        *entry = result
                            .map(|(format, bytes)| Arc::new(Image::from_bytes(format, bytes)));
                    }
                    cx.notify();
                });
            })
            .detach();
        }
    }
}

pub(super) fn avatar_element(
    spec: &AvatarSpec,
    image: Option<Arc<Image>>,
    face: Option<Arc<Image>>,
    size: f32,
    p: Palette,
) -> AnyElement {
    let fallback = match &spec.fallback {
        AvatarFallback::Initials { text, hue, owner } => div()
            .size_full()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(hsla(
                f32::from(*hue) / 360.,
                if *owner { 0.58 } else { 0.48 },
                if *owner { 0.26 } else { 0.42 },
                1.,
            ))
            .text_color(rgb(0xffffff))
            .text_size(px(size * 0.4))
            .font_weight(FontWeight::BOLD)
            .child(text.clone())
            .into_any_element(),
        AvatarFallback::Text(text) => div()
            .size_full()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(p.elevated)
            .text_size(px(size * 0.72))
            .child(text.clone())
            .into_any_element(),
        AvatarFallback::AgentFace(_) => face
            .map(|face| {
                img(face)
                    .size_full()
                    .rounded_full()
                    .object_fit(ObjectFit::Cover)
                    .into_any_element()
            })
            .unwrap_or_else(|| div().into_any_element()),
    };
    div()
        .relative()
        .size(px(size))
        .flex_shrink_0()
        .rounded_full()
        .overflow_hidden()
        .child(fallback)
        .when_some(image, |this, image| {
            this.child(
                img(image)
                    .absolute()
                    .inset_0()
                    .size_full()
                    .rounded_full()
                    .object_fit(ObjectFit::Cover)
                    .with_fallback(|| div().into_any_element()),
            )
        })
        .into_any_element()
}

async fn download_avatar(
    url: &str,
    auth: &WebAuth,
    device_token: Option<&str>,
) -> Option<(ImageFormat, Vec<u8>)> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let mut credentials: Vec<_> = [
        device_token,
        auth.token.as_deref(),
        auth.password.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter(|token| !token.is_empty())
    .collect();
    credentials.dedup();
    if credentials.is_empty() {
        credentials.push("");
    }
    for retry in 0..=3 {
        let mut retry_after = None;
        for credential in &credentials {
            let mut request = http.get(url).header("Accept", "image/*");
            if !credential.is_empty() {
                request = request.bearer_auth(credential);
            }
            if let Some(token) = auth
                .access_session
                .as_ref()
                .and_then(|session| session.authorization_header(url, access::now()))
            {
                request = request.header("Cf-Access-Token", token);
            }
            let mut response = request.send().await.ok()?;
            let status = response.status();
            if matches!(status.as_u16(), 401 | 403) {
                continue;
            }
            if status.as_u16() == 503 {
                retry_after = response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .filter(|seconds| (1..=30).contains(seconds));
                break;
            }
            if !status.is_success()
                || response
                    .content_length()
                    .is_some_and(|size| size > MAX_AVATAR_BYTES as u64)
            {
                return None;
            }
            let mime = response
                .headers()
                .get("content-type")?
                .to_str()
                .ok()?
                .split(';')
                .next()?
                .trim();
            let format = ImageFormat::from_mime_type(mime)?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.ok()? {
                if bytes.len() + chunk.len() > MAX_AVATAR_BYTES {
                    return None;
                }
                bytes.extend(chunk);
            }
            return Some((format, bytes));
        }
        if retry == 3 {
            return None;
        }
        tokio::time::sleep(Duration::from_secs(retry_after?)).await;
    }
    None
}
