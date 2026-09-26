//! Transcript-owned artifact loading. Tickets and bytes never leave this connection scope.
use super::{
    AppView,
    theme::{Palette, TranscriptTokens as T},
};
use crate::{
    gateway::access,
    model::{
        attachments::Attachment,
        chat::{MediaRef, RequestScope},
        web_urls::{WebAuth, control_base_url},
    },
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use gpui_kit::{
    component::{
        Disableable, Sizable, StyledExt,
        button::{Button, ButtonVariants},
    },
    prelude::FluentBuilder,
    *,
};
use openclaw_gateway_client::GatewaySession;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const MAX_SOURCE_BYTES: usize = 12 * 1024 * 1024;
#[cfg(target_os = "macos")]
const MAX_THUMBNAIL_EDGE: i32 = 2048;

#[derive(Default)]
pub(super) struct TranscriptMedia {
    owner: Option<(u64, RequestScope)>,
    entries: HashMap<String, MediaLoad>,
}
enum MediaLoad {
    ChoosingDestination,
    Loading(MediaTask),
    Ready,
    Failed(String),
}
#[derive(Clone)]
enum DownloadSource {
    Managed(String),
    Inline(Attachment),
}
impl DownloadSource {
    fn key(&self) -> String {
        match self {
            Self::Managed(id) => format!("download:{id}"),
            Self::Inline(attachment) => format!("download:inline:{}", attachment.id),
        }
    }
}
struct MediaTask {
    handle: tokio::task::AbortHandle,
    write_admission: Option<Arc<AtomicBool>>,
}
impl MediaTask {
    fn new(handle: tokio::task::AbortHandle) -> Self {
        Self {
            handle,
            write_admission: None,
        }
    }
}
impl Drop for MediaTask {
    fn drop(&mut self) {
        if let Some(admission) = &self.write_admission {
            admission.store(false, Ordering::Release);
        }
        self.handle.abort();
    }
}

impl AppView {
    pub(super) fn reset_transcript_media(&mut self) {
        for key in self.transcript_state.media.entries.keys() {
            self.transcript_state.images.remove(key);
        }
        self.transcript_state.media = TranscriptMedia::default();
    }

    pub(super) fn render_message_media(
        &mut self,
        key: &str,
        media: &MediaRef,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let owner = self.chat.scope().map(|scope| (self.epoch, scope));
        if self.transcript_state.media.owner != owner {
            self.reset_transcript_media();
            self.transcript_state.media.owner = owner;
        }
        let title = media
            .file_name
            .as_deref()
            .or(media.alt.as_deref())
            .unwrap_or("Attachment")
            .to_owned();
        if let Some(artifact) = media.artifact_id.as_deref().filter(|id| {
            !id.is_empty()
                && media
                    .content_type
                    .as_deref()
                    .map_or(media.kind.as_deref() != Some("file"), |mime| {
                        mime.starts_with("image/")
                    })
        }) {
            let image_key = format!("managed:{artifact}");
            if !self.transcript_state.media.entries.contains_key(&image_key) {
                self.load_transcript_media(image_key.clone(), artifact.to_owned(), cx);
            }
            if let Some(image) = self.transcript_state.images.get(&image_key) {
                return div()
                    .id(SharedString::from(format!("{key}:managed-image")))
                    .role(Role::Image)
                    .aria_label(media.alt.clone().unwrap_or(title))
                    .child(
                        img(image.clone())
                            .max_w(px(T::MEDIA_IMAGE_MAX))
                            .max_h(px(T::MEDIA_IMAGE_MAX))
                            .object_fit(ObjectFit::Contain)
                            .rounded(px(T::BUBBLE_RADIUS)),
                    )
                    .into_any_element();
            }
            let error = match self.transcript_state.media.entries.get(&image_key) {
                Some(MediaLoad::Failed(error)) => Some(error.clone()),
                _ => None,
            };
            return div()
                .v_flex()
                .gap_2()
                .px_3()
                .py_2()
                .rounded_md()
                .border_1()
                .border_color(p.border)
                .bg(p.card)
                .text_sm()
                .child(title)
                .child(
                    div()
                        .text_xs()
                        .text_color(if error.is_some() { p.danger } else { p.muted })
                        .child(error.clone().unwrap_or_else(|| "Loading image…".into())),
                )
                .when(error.is_some(), |this| {
                    let artifact = artifact.to_owned();
                    this.child(
                        Button::new(SharedString::from(format!("{key}:retry-media")))
                            .ghost()
                            .small()
                            .label("Retry image")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.load_transcript_media(image_key.clone(), artifact.clone(), cx)
                            })),
                    )
                })
                .into_any_element();
        }
        if let Some(artifact) = media.artifact_id.as_deref().filter(|id| !id.is_empty()) {
            let action = self.render_file_download_action(
                key,
                DownloadSource::Managed(artifact.to_owned()),
                &title,
                cx,
            );
            return div()
                .h_flex()
                .gap_2()
                .px_3()
                .py_2()
                .rounded_md()
                .border_1()
                .border_color(p.border)
                .bg(p.card)
                .text_sm()
                .child(title)
                .child(action)
                .into_any_element();
        }
        // Legacy URL blocks have no transcript-backed download grant. Offer a browser
        // destination without fetching them with the Gateway's shared credential.
        let url = media.url.as_deref().and_then(|value| {
            self.web
                .auth
                .as_ref()
                .and_then(|auth| media_navigation_url(auth, value))
        });
        div()
            .h_flex()
            .gap_2()
            .px_3()
            .py_2()
            .rounded_md()
            .border_1()
            .border_color(p.border)
            .bg(p.card)
            .text_sm()
            .child(
                div().v_flex().child(title).child(
                    div()
                        .text_xs()
                        .text_color(p.muted)
                        .child("Preview unavailable for this older attachment"),
                ),
            )
            .when_some(url, |this, url| {
                this.child(
                    Button::new(SharedString::from(format!("{key}:open-media")))
                        .ghost()
                        .xsmall()
                        .label("Open")
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.open_transcript_link(&url, cx)),
                        ),
                )
            })
            .into_any_element()
    }

    pub(super) fn render_attachment_download(
        &mut self,
        attachment: &Attachment,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.render_file_download_action(
            &attachment.id,
            DownloadSource::Inline(attachment.clone()),
            &attachment.file_name,
            cx,
        )
    }

    fn render_file_download_action(
        &mut self,
        key: &str,
        source: DownloadSource,
        title: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let owner = self.chat.scope().map(|scope| (self.epoch, scope));
        if self.transcript_state.media.owner != owner {
            self.reset_transcript_media();
            self.transcript_state.media.owner = owner;
        }
        let p = Palette::get(cx);
        let state = self.transcript_state.media.entries.get(&source.key());
        let busy = matches!(
            state,
            Some(MediaLoad::ChoosingDestination | MediaLoad::Loading(_))
        );
        let status = match state {
            Some(MediaLoad::ChoosingDestination) => {
                Some(("Choose a save destination".to_owned(), false))
            }
            Some(MediaLoad::Loading(task)) => Some((
                if task.write_admission.is_some() {
                    "Saving…"
                } else {
                    "Downloading…"
                }
                .to_owned(),
                false,
            )),
            Some(MediaLoad::Ready) => Some(("Saved".to_owned(), false)),
            Some(MediaLoad::Failed(error)) => Some((error.clone(), true)),
            None => None,
        };
        let suggested_name = artifact_file_name(title);
        div()
            .v_flex()
            .gap_1()
            .child(
                Button::new(SharedString::from(format!("{key}:download-media")))
                    .ghost()
                    .small()
                    .label("Download")
                    .disabled(busy)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.save_transcript_artifact(source.clone(), suggested_name.clone(), cx)
                    })),
            )
            .when_some(status, |this, (status, error)| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(if error { p.danger } else { p.muted })
                        .child(status),
                )
            })
            .into_any_element()
    }

    fn save_transcript_artifact(
        &mut self,
        source: DownloadSource,
        suggested_name: String,
        cx: &mut Context<Self>,
    ) {
        let Some(scope) = self.chat.scope() else {
            return;
        };
        let epoch = self.epoch;
        let key = source.key();
        let directory = dirs::download_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."));
        let prompt = cx.prompt_for_new_path(&directory, Some(&suggested_name));
        self.transcript_state
            .media
            .entries
            .insert(key.clone(), MediaLoad::ChoosingDestination);
        cx.spawn(async move |this, cx| {
            let result = prompt.await;
            let _ = this.update(cx, |this, cx| {
                if this.epoch != epoch || !this.chat.is_current(&scope) {
                    return;
                }
                match result {
                    Ok(Ok(Some(path))) => match source {
                        DownloadSource::Managed(artifact) => {
                            this.download_transcript_artifact(key, artifact, path, cx)
                        }
                        DownloadSource::Inline(attachment) => {
                            this.write_transcript_artifact(key, path, attachment.bytes, cx);
                        }
                    },
                    Ok(Err(_)) | Err(_) => {
                        this.transcript_state.media.entries.insert(
                            key,
                            MediaLoad::Failed("Could not open the save dialog. Try again.".into()),
                        );
                    }
                    Ok(Ok(None)) => {
                        this.transcript_state.media.entries.remove(&key);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn download_transcript_artifact(
        &mut self,
        key: String,
        artifact: String,
        path: PathBuf,
        cx: &mut Context<Self>,
    ) {
        let (Some(scope), Some(session), Some(auth)) = (
            self.chat.scope(),
            self.session.clone(),
            self.web.auth.clone(),
        ) else {
            self.transcript_state.media.entries.insert(
                key,
                MediaLoad::Failed("Reconnect to download this attachment".into()),
            );
            return;
        };
        let epoch = self.epoch;
        let request_scope = scope.clone();
        let request_session = session.clone();
        let task = self.runtime.spawn(async move {
            download_artifact_bytes(
                &request_session,
                &auth,
                &request_scope,
                &artifact,
                ArtifactPresentation::File,
            )
            .await
        });
        let task_id = task.id();
        self.transcript_state.media.entries.insert(
            key.clone(),
            MediaLoad::Loading(MediaTask::new(task.abort_handle())),
        );
        cx.spawn(async move |this, cx| {
            let result = task.await.unwrap_or_else(|_| Err("Download was interrupted. Try again.".into()));
            let _ = this.update(cx, |this, cx| {
                if this.epoch != epoch || !this.chat.is_current(&scope) || session.is_retired()
                    || !matches!(this.transcript_state.media.entries.get(&key), Some(MediaLoad::Loading(task)) if task.handle.id() == task_id) { return; }
                match result {
                    Ok(bytes) => this.write_transcript_artifact(key, path, bytes, cx),
                    Err(error) => { this.transcript_state.media.entries.insert(key, MediaLoad::Failed(error)); }
                }
                cx.notify();
            });
        }).detach();
    }

    fn write_transcript_artifact(
        &mut self,
        key: String,
        path: PathBuf,
        bytes: impl AsRef<[u8]> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        let Some(scope) = self.chat.scope() else {
            return;
        };
        let epoch = self.epoch;
        let admission = Arc::new(AtomicBool::new(true));
        let worker_admission = admission.clone();
        let task = self.runtime.spawn_blocking(move || {
            // Reset/drop/retry revokes queued writes. Once claimed, the bounded save
            // is allowed to finish even if its old transcript is no longer visible.
            if !worker_admission.swap(false, Ordering::AcqRel) {
                return Err("Save canceled".into());
            }
            save_artifact_bytes(&path, bytes.as_ref())
        });
        let task_id = task.id();
        self.transcript_state.media.entries.insert(
            key.clone(),
            MediaLoad::Loading(MediaTask {
                handle: task.abort_handle(),
                write_admission: Some(admission),
            }),
        );
        cx.spawn(async move |this, cx| {
            let result = task.await.unwrap_or_else(|_| Err("Save was interrupted. Try again.".into()));
            let _ = this.update(cx, |this, cx| {
                if this.epoch != epoch || !this.chat.is_current(&scope)
                    || !matches!(this.transcript_state.media.entries.get(&key), Some(MediaLoad::Loading(task)) if task.handle.id() == task_id) { return; }
                this.transcript_state.media.entries.insert(key, match result { Ok(()) => MediaLoad::Ready, Err(error) => MediaLoad::Failed(error) });
                cx.notify();
            });
        }).detach();
        cx.notify();
    }

    fn load_transcript_media(&mut self, key: String, artifact: String, cx: &mut Context<Self>) {
        let (Some(scope), Some(session), Some(auth)) = (
            self.chat.scope(),
            self.session.clone(),
            self.web.auth.clone(),
        ) else {
            self.transcript_state.media.entries.insert(
                key,
                MediaLoad::Failed("Reconnect to load this image".into()),
            );
            return;
        };
        self.transcript_state.media.entries.remove(&key);
        let epoch = self.epoch;
        let request_scope = scope.clone();
        let task = self.runtime.spawn(async move {
            let bytes = download_artifact_bytes(
                &session,
                &auth,
                &request_scope,
                &artifact,
                ArtifactPresentation::Image,
            )
            .await?;
            tokio::task::spawn_blocking(move || image_thumbnail(&bytes))
                .await
                .map_err(|_| "Image decoding was interrupted".to_owned())?
        });
        let task_id = task.id();
        self.transcript_state.media.entries.insert(
            key.clone(),
            MediaLoad::Loading(MediaTask::new(task.abort_handle())),
        );
        cx.spawn(async move |this, cx| {
            let result = task.await.unwrap_or_else(|_| Err("Image loading was interrupted. Try again.".into()));
            let _ = this.update(cx, |this, cx| {
                if this.epoch != epoch || !this.chat.is_current(&scope)
                    || !matches!(this.transcript_state.media.entries.get(&key), Some(MediaLoad::Loading(task)) if task.handle.id() == task_id) { return; }
                match result {
                    Ok(bytes) => {
                        this.transcript_state.images.insert(key.clone(), Arc::new(Image::from_bytes(ImageFormat::Png, bytes)));
                        this.transcript_state.media.entries.insert(key, MediaLoad::Ready);
                    }
                    Err(error) => { this.transcript_state.media.entries.insert(key, MediaLoad::Failed(error)); }
                }
                this.transcript_list.remeasure();
                cx.notify();
            });
        }).detach();
        cx.notify();
    }
}

fn media_navigation_url(auth: &WebAuth, value: &str) -> Option<String> {
    if value.starts_with("//") || value.contains('\\') || value.chars().any(char::is_control) {
        return None;
    }
    let base = control_base_url(&auth.gateway_url).ok()?;
    let mount = base.path().trim_end_matches('/');
    let mounted;
    let value = if value.starts_with('/')
        && !mount.is_empty()
        && value != mount
        && !value.starts_with(&format!("{mount}/"))
    {
        mounted = format!("{mount}{value}");
        mounted.as_str()
    } else {
        value
    };
    let url = base.join(value).ok()?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.into())
}

fn save_artifact_bytes(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err("Attachment exceeds the 12 MiB download limit".into());
    }
    std::fs::write(path, bytes).map_err(|error| format!("Could not save attachment: {error}"))
}

fn artifact_file_name(value: &str) -> String {
    let name = value.rsplit(['/', '\\']).next().unwrap_or_default();
    let name: String = name
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    let name = name.trim();
    if name.is_empty() || matches!(name, "." | "..") {
        "Attachment".into()
    } else {
        name.to_owned()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ArtifactPresentation {
    Image,
    File,
}

async fn download_artifact_bytes(
    session: &GatewaySession,
    auth: &WebAuth,
    scope: &RequestScope,
    artifact: &str,
    presentation: ArtifactPresentation,
) -> Result<Vec<u8>, String> {
    let mut params = json!({"sessionKey":scope.session_key,"artifactId":artifact});
    if let Some(agent) = &scope.agent_id {
        params["agentId"] = json!(agent);
    }
    for attempt in 0..2 {
        if session.is_retired() {
            return Err("Reconnect to download this attachment".into());
        }
        let response = session
            .request("artifacts.download", params.clone())
            .await
            .map_err(|_| "Could not authorize this attachment. Try again.")?;
        if session.is_retired() {
            return Err("Reconnect to download this attachment".into());
        }
        if response.pointer("/artifact/id").and_then(Value::as_str) != Some(artifact) {
            return Err("The Gateway returned a different artifact".into());
        }
        let mime = response
            .pointer("/artifact/mimeType")
            .and_then(Value::as_str)
            .unwrap_or("");
        if presentation == ArtifactPresentation::Image && !mime.starts_with("image/") {
            return Err("This attachment is not an image preview".into());
        }
        if response
            .pointer("/artifact/sizeBytes")
            .and_then(Value::as_u64)
            .is_some_and(|size| size > MAX_SOURCE_BYTES as u64)
        {
            return Err("Attachment exceeds the 12 MiB download limit".into());
        }
        let bytes = if response.get("encoding").and_then(Value::as_str) == Some("base64") {
            let data = response
                .get("data")
                .and_then(Value::as_str)
                .ok_or("The Gateway returned no attachment data")?;
            if data.len() > MAX_SOURCE_BYTES.div_ceil(3) * 4 {
                return Err("Attachment exceeds the 12 MiB download limit".into());
            }
            STANDARD
                .decode(data)
                .map_err(|_| "The Gateway returned invalid attachment data")?
        } else {
            let value = response
                .get("url")
                .and_then(Value::as_str)
                .ok_or("This attachment has no supported download")?;
            let url = media_navigation_url(auth, value)
                .filter(|url| auth.trusts(url))
                .ok_or("Attachment download must remain on the connected Gateway")?;
            let http = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Could not prepare attachment download")?;
            let mut request = http.get(&url).header(
                "Accept",
                if presentation == ArtifactPresentation::Image {
                    "image/*"
                } else {
                    "*/*"
                },
            );
            if let Some(access) = &auth.access_session {
                let token = access
                    .authorization_header(&url, access::now())
                    .ok_or("Sign in again to download this attachment")?;
                request = request.header("Cf-Access-Token", token);
            }
            if session.is_retired() {
                return Err("Reconnect to download this attachment".into());
            }
            let mut fetched = request
                .send()
                .await
                .map_err(|_| "Attachment download failed. Try again.")?;
            if matches!(fetched.status().as_u16(), 401 | 403 | 404 | 410) && attempt == 0 {
                continue;
            }
            if !fetched.status().is_success() {
                return Err("Attachment download failed. Try again.".into());
            }
            if presentation == ArtifactPresentation::Image
                && !fetched
                    .headers()
                    .get("content-type")
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|mime| mime.starts_with("image/"))
            {
                return Err("The download did not contain an image".into());
            }
            if fetched
                .content_length()
                .is_some_and(|size| size > MAX_SOURCE_BYTES as u64)
            {
                return Err("Attachment exceeds the 12 MiB download limit".into());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = fetched
                .chunk()
                .await
                .map_err(|_| "Attachment download was interrupted")?
            {
                if session.is_retired() {
                    return Err("Reconnect to download this attachment".into());
                }
                if bytes.len() + chunk.len() > MAX_SOURCE_BYTES {
                    return Err("Attachment exceeds the 12 MiB download limit".into());
                }
                bytes.extend(chunk);
            }
            bytes
        };
        if (presentation == ArtifactPresentation::Image && bytes.is_empty())
            || bytes.len() > MAX_SOURCE_BYTES
        {
            return Err("Attachment is empty or exceeds the 12 MiB download limit".into());
        }
        if session.is_retired() {
            return Err("Reconnect to download this attachment".into());
        }
        return Ok(bytes);
    }
    Err("The attachment download expired. Try again.".into())
}

#[cfg(not(target_os = "macos"))]
fn image_thumbnail(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("Image previews are not available on this platform yet".into())
}

#[cfg(target_os = "macos")]
fn image_thumbnail(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use objc2_foundation::NSString;
    use std::{ffi::c_void, ptr};
    type Ref = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: Ref);
        fn CFDataCreate(allocator: Ref, bytes: *const u8, length: isize) -> Ref;
        fn CFDataCreateMutable(allocator: Ref, capacity: isize) -> Ref;
        fn CFDataGetBytePtr(data: Ref) -> *const u8;
        fn CFDataGetLength(data: Ref) -> isize;
        fn CFNumberCreate(allocator: Ref, kind: isize, value: Ref) -> Ref;
        fn CFNumberGetValue(number: Ref, kind: isize, value: *mut c_void) -> bool;
        fn CFDictionaryCreate(
            allocator: Ref,
            keys: *const Ref,
            values: *const Ref,
            count: isize,
            key_callbacks: Ref,
            value_callbacks: Ref,
        ) -> Ref;
        fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
        static kCFBooleanTrue: Ref;
        static kCFBooleanFalse: Ref;
    }
    #[link(name = "ImageIO", kind = "framework")]
    unsafe extern "C" {
        fn CGImageSourceCreateWithData(data: Ref, options: Ref) -> Ref;
        fn CGImageSourceCopyPropertiesAtIndex(source: Ref, index: usize, options: Ref) -> Ref;
        fn CGImageSourceCreateThumbnailAtIndex(source: Ref, index: usize, options: Ref) -> Ref;
        fn CGImageDestinationCreateWithData(
            data: Ref,
            kind: Ref,
            count: usize,
            options: Ref,
        ) -> Ref;
        fn CGImageDestinationAddImage(destination: Ref, image: Ref, properties: Ref);
        fn CGImageDestinationFinalize(destination: Ref) -> bool;
        static kCGImagePropertyPixelWidth: Ref;
        static kCGImagePropertyPixelHeight: Ref;
        static kCGImageSourceCreateThumbnailFromImageAlways: Ref;
        static kCGImageSourceCreateThumbnailWithTransform: Ref;
        static kCGImageSourceThumbnailMaxPixelSize: Ref;
        static kCGImageSourceShouldCache: Ref;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGImageGetWidth(image: Ref) -> usize;
        fn CGImageGetHeight(image: Ref) -> usize;
    }
    struct Owned(Ref);
    impl Owned {
        fn new(value: Ref) -> Result<Self, String> {
            if value.is_null() {
                Err("This image could not be decoded".into())
            } else {
                Ok(Self(value))
            }
        }
    }
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe {
                CFRelease(self.0);
            }
        }
    }
    // ImageIO checks dimensions without allocating full pixels, then decodes a bounded
    // thumbnail. GPUI receives only that PNG, never the unbounded source image.
    unsafe {
        let data = Owned::new(CFDataCreate(
            ptr::null(),
            bytes.as_ptr(),
            bytes.len() as isize,
        ))?;
        let source_options = Owned::new(CFDictionaryCreate(
            ptr::null(),
            [kCGImageSourceShouldCache].as_ptr(),
            [kCFBooleanFalse].as_ptr(),
            1,
            ptr::null(),
            ptr::null(),
        ))?;
        let source = Owned::new(CGImageSourceCreateWithData(data.0, source_options.0))?;
        let properties = Owned::new(CGImageSourceCopyPropertiesAtIndex(source.0, 0, ptr::null()))?;
        let mut dimensions = [0_i64; 2];
        for (dimension, property) in dimensions
            .iter_mut()
            .zip([kCGImagePropertyPixelWidth, kCGImagePropertyPixelHeight])
        {
            let number = CFDictionaryGetValue(properties.0, property);
            if number.is_null()
                || !CFNumberGetValue(number, 4, (dimension as *mut i64).cast())
                || *dimension <= 0
            {
                return Err("Image dimensions are invalid".into());
            }
        }
        if dimensions.iter().any(|dimension| *dimension > 65_536)
            || dimensions[0].saturating_mul(dimensions[1]) > 100_000_000
        {
            return Err("Image dimensions exceed the preview limit".into());
        }
        let edge = Owned::new(CFNumberCreate(
            ptr::null(),
            3,
            (&MAX_THUMBNAIL_EDGE as *const i32).cast(),
        ))?;
        let keys = [
            kCGImageSourceCreateThumbnailFromImageAlways,
            kCGImageSourceCreateThumbnailWithTransform,
            kCGImageSourceThumbnailMaxPixelSize,
        ];
        let values = [kCFBooleanTrue, kCFBooleanTrue, edge.0];
        let options = Owned::new(CFDictionaryCreate(
            ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            keys.len() as isize,
            ptr::null(),
            ptr::null(),
        ))?;
        let image = Owned::new(CGImageSourceCreateThumbnailAtIndex(source.0, 0, options.0))?;
        if CGImageGetWidth(image.0) > MAX_THUMBNAIL_EDGE as usize
            || CGImageGetHeight(image.0) > MAX_THUMBNAIL_EDGE as usize
        {
            return Err("Decoded image exceeds the preview limit".into());
        }
        let output = Owned::new(CFDataCreateMutable(ptr::null(), 0))?;
        let png = NSString::from_str("public.png");
        let destination = Owned::new(CGImageDestinationCreateWithData(
            output.0,
            (&*png as *const NSString).cast(),
            1,
            ptr::null(),
        ))?;
        CGImageDestinationAddImage(destination.0, image.0, ptr::null());
        if !CGImageDestinationFinalize(destination.0) {
            return Err("Could not prepare image preview".into());
        }
        let length = CFDataGetLength(output.0);
        if length <= 0 || length as usize > MAX_SOURCE_BYTES {
            return Err("Decoded image exceeds the preview limit".into());
        }
        Ok(std::slice::from_raw_parts(CFDataGetBytePtr(output.0), length as usize).to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::{artifact_file_name, image_thumbnail, media_navigation_url};
    use crate::model::web_urls::WebAuth;
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    #[test]
    fn relative_media_links_resolve_on_the_active_gateway_without_credentials() {
        let auth = WebAuth {
            gateway_url: "wss://gateway.example.test/control".into(),
            token: None,
            password: None,
            access_session: None,
        };
        assert_eq!(
            media_navigation_url(&auth, "/control/api/artifacts/download/ticket").as_deref(),
            Some("https://gateway.example.test/control/api/artifacts/download/ticket")
        );
        for invalid in [
            "//other.test/private",
            "https://user:secret@gateway.example.test/image",
            "javascript:alert(1)",
            "https://gateway.example.test\\@other.test/image",
        ] {
            assert!(media_navigation_url(&auth, invalid).is_none());
        }
        assert_eq!(
            media_navigation_url(
                &auth,
                "/api/chat/media/outgoing/session/image/full?mediaTicket=synthetic"
            )
            .as_deref(),
            Some(
                "https://gateway.example.test/control/api/chat/media/outgoing/session/image/full?mediaTicket=synthetic"
            )
        );
        let outside_mount =
            media_navigation_url(&auth, "https://gateway.example.test/elsewhere/image").unwrap();
        assert!(!auth.trusts(&outside_mount));
    }

    #[test]
    fn save_dialog_suggests_only_a_filename_from_artifact_metadata() {
        for (source, expected) in [
            ("../../report.pdf", "report.pdf"),
            ("C:\\Downloads\\report.pdf", "report.pdf"),
            ("report\n.pdf", "report.pdf"),
            ("..", "Attachment"),
            ("/", "Attachment"),
        ] {
            assert_eq!(artifact_file_name(source), expected);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn preview_decoder_emits_a_png_and_rejects_non_images() {
        let source = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV2kAAAAASUVORK5CYII=").unwrap();
        let thumbnail = image_thumbnail(&source).unwrap();
        assert!(thumbnail.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(image_thumbnail(b"not an image").is_err());
    }
}
