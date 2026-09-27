use crate::{
    gateway::access,
    model::{
        chat::RequestScope,
        web_urls::{WebAuth, control_base_url},
    },
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use openclaw_gateway_client::GatewaySession;
use serde_json::{Value, json};
use std::time::Duration;

const MAX_SOURCE_BYTES: usize = 12 * 1024 * 1024;
#[cfg(target_os = "macos")]
const MAX_THUMBNAIL_EDGE: i32 = 2048;

pub(super) fn media_navigation_url(auth: &WebAuth, value: &str) -> Option<String> {
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

pub(super) fn save_artifact_bytes(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err("Attachment exceeds the 12 MiB download limit".into());
    }
    std::fs::write(path, bytes).map_err(|error| format!("Could not save attachment: {error}"))
}

pub(super) fn artifact_file_name(value: &str) -> String {
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

#[derive(Clone)]
pub(in crate::ui) struct InlineImage {
    pub key: String,
    bytes: std::sync::Arc<[u8]>,
}

impl InlineImage {
    pub fn from_data_url(url: &str) -> Result<Option<Self>, String> {
        use sha2::{Digest, Sha256};
        let Some(data) = url.strip_prefix("data:") else {
            return Ok(None);
        };
        let (metadata, data) = data.split_once(',').ok_or("Invalid inline image data")?;
        let mime = metadata
            .strip_suffix(";base64")
            .ok_or("Unsupported inline image encoding")?;
        if !matches!(
            mime,
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) {
            return Err("Unsupported inline image format".into());
        }
        // Markdown inline admission retains the Control UI's 5 MiB source limit.
        const MAX_INLINE_BYTES: usize = 5 * 1024 * 1024;
        if data.len() > MAX_INLINE_BYTES.div_ceil(3) * 4 {
            return Err("Inline image exceeds the 5 MiB preview limit".into());
        }
        let bytes = STANDARD
            .decode(data)
            .map_err(|_| "Invalid inline image data")?;
        if bytes.len() > MAX_INLINE_BYTES {
            return Err("Inline image exceeds the 5 MiB preview limit".into());
        }
        Ok(Some(Self {
            key: format!("inline:{:x}", Sha256::digest(&bytes)),
            bytes: bytes.into(),
        }))
    }

    pub fn thumbnail(&self) -> Result<Vec<u8>, String> {
        image_thumbnail(&self.bytes)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ArtifactPresentation {
    Image,
    File,
}

pub(super) async fn download_artifact_bytes(
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
pub(super) fn image_thumbnail(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("Image previews are not available on this platform yet".into())
}

#[cfg(target_os = "macos")]
pub(super) fn image_thumbnail(bytes: &[u8]) -> Result<Vec<u8>, String> {
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
