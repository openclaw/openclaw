mod face;
mod http;

use crate::model::{
    avatars::{self, AvatarFallback, AvatarSpec},
    web_urls::WebAuth,
};
use gpui_kit::{Image, ImageFormat};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

const MAX_CACHED_AVATARS: usize = 128;
const FAILED_AVATAR_RETRY_AFTER: Duration = Duration::from_secs(60);

pub(in crate::ui) type DownloadedAvatar = (ImageFormat, Vec<u8>);

#[derive(Clone, Default)]
pub(in crate::ui) struct AvatarAssets {
    pub image: Option<Arc<Image>>,
    pub fallback_image: Option<Arc<Image>>,
}

/// One Gateway window owns its image assets, pending requests, and retry budget.
#[derive(Default)]
pub(in crate::ui) struct AvatarCache {
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
    pub fn image_url(&self, url: &str) -> Option<Arc<Image>> {
        self.images.get(url).cloned().flatten()
    }

    pub fn assets(&self, spec: &AvatarSpec) -> AvatarAssets {
        AvatarAssets {
            image: spec.url.as_deref().and_then(|url| self.image_url(url)),
            fallback_image: match &spec.fallback {
                AvatarFallback::AgentFace(id) => Some(self.face(id)),
                _ => None,
            },
        }
    }

    fn face(&self, id: &str) -> Arc<Image> {
        self.faces
            .get(id)
            .cloned()
            .unwrap_or_else(|| face::image(id))
    }

    /// Retains sources in caller priority order and returns only required downloads.
    pub fn prepare(&mut self, specs: &[AvatarSpec]) -> Vec<String> {
        let mut wanted = HashSet::new();
        let urls: Vec<_> = specs
            .iter()
            .filter_map(|spec| spec.url.clone())
            .filter(|url| wanted.insert(url.clone()))
            .take(MAX_CACHED_AVATARS)
            .collect();
        self.images.retain(|url, _| wanted.contains(url));
        self.failed_at.retain(|url, _| wanted.contains(url));
        self.pending.retain(|url, task| {
            let retained = wanted.contains(url);
            if !retained {
                task.abort();
            }
            retained
        });
        let mut wanted_faces = HashSet::new();
        let faces: Vec<_> = specs
            .iter()
            .filter_map(|spec| match &spec.fallback {
                AvatarFallback::AgentFace(id) => Some(id.clone()),
                _ => None,
            })
            .filter(|id| wanted_faces.insert(id.clone()))
            .take(MAX_CACHED_AVATARS)
            .collect();
        self.faces.retain(|id, _| wanted_faces.contains(id));
        for id in faces {
            self.faces
                .entry(id.clone())
                .or_insert_with(|| face::image(&id));
        }
        let mut downloads = Vec::new();
        for url in urls {
            let retry = self
                .failed_at
                .get(&url)
                .is_some_and(|failed| failed.elapsed() >= FAILED_AVATAR_RETRY_AFTER);
            if self.images.contains_key(&url) && !retry {
                continue;
            }
            self.failed_at.remove(&url);
            self.images.insert(url.clone(), None);
            if let Some((mime, bytes)) = avatars::decode_data_image(&url) {
                if let Some(format) = ImageFormat::from_mime_type(&mime) {
                    self.images
                        .insert(url, Some(Arc::new(Image::from_bytes(format, bytes))));
                } else {
                    self.failed_at.insert(url, Instant::now());
                }
            } else {
                downloads.push(url);
            }
        }
        downloads
    }

    pub fn request_started(&mut self, url: String, task: tokio::task::AbortHandle) {
        if let Some(previous) = self.pending.insert(url, task) {
            previous.abort();
        }
    }

    pub fn complete(
        &mut self,
        url: &str,
        request: tokio::task::Id,
        result: Option<DownloadedAvatar>,
    ) -> bool {
        if self.pending.get(url).map(tokio::task::AbortHandle::id) != Some(request) {
            return false;
        }
        self.pending.remove(url);
        if result.is_none() {
            self.failed_at.insert(url.to_owned(), Instant::now());
        }
        if let Some(entry) = self.images.get_mut(url) {
            *entry = result.map(|(format, bytes)| Arc::new(Image::from_bytes(format, bytes)));
        }
        true
    }

    pub async fn download(
        url: &str,
        auth: &WebAuth,
        device_token: Option<&str>,
    ) -> Option<DownloadedAvatar> {
        http::download_avatar(url, auth, device_token).await
    }
}
