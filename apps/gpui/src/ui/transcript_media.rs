//! Transcript-owned artifact loading. Tickets and bytes never leave this connection scope.
use super::{
    AppView,
    theme::{Palette, tokens::transcript::TranscriptTokens as T},
};
mod download;
use crate::model::{
    attachments::Attachment,
    chat::{MediaRef, RequestScope},
};
pub(super) use download::InlineImage;
use download::{
    ArtifactPresentation, artifact_file_name, download_artifact_bytes, image_thumbnail,
    media_navigation_url, save_artifact_bytes,
};
use gpui_kit::{
    component::{
        Disableable, Sizable, StyledExt,
        button::{Button, ButtonVariants},
    },
    prelude::FluentBuilder,
    *,
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

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
                            .rounded(px(T::MEDIA_IMAGE_RADIUS)),
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
        self.install_transcript_image_task(key, scope, epoch, task, cx);
    }

    pub(super) fn inline_transcript_image(
        &mut self,
        image: &InlineImage,
        cx: &mut Context<Self>,
    ) -> Result<Option<Arc<Image>>, String> {
        let scope = self
            .chat
            .scope()
            .ok_or("Select a conversation to load this image")?;
        let owner = Some((self.epoch, scope.clone()));
        if self.transcript_state.media.owner != owner {
            self.reset_transcript_media();
            self.transcript_state.media.owner = owner;
        }
        if !self.transcript_state.media.entries.contains_key(&image.key) {
            let source = image.clone();
            let task = self.runtime.spawn_blocking(move || source.thumbnail());
            self.install_transcript_image_task(image.key.clone(), scope, self.epoch, task, cx);
        }
        if let Some(MediaLoad::Failed(error)) = self.transcript_state.media.entries.get(&image.key)
        {
            return Err(error.clone());
        }
        Ok(self.transcript_state.images.get(&image.key).cloned())
    }

    fn install_transcript_image_task(
        &mut self,
        key: String,
        scope: RequestScope,
        epoch: u64,
        task: tokio::task::JoinHandle<Result<Vec<u8>, String>>,
        cx: &mut Context<Self>,
    ) {
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
