use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{fs::File, io::Read, path::Path, sync::Arc};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentOrigin {
    Paste,
    File,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attachment {
    pub id: String,
    pub file_name: String,
    pub mime_type: String,
    pub origin: AttachmentOrigin,
    pub bytes: Arc<[u8]>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentLimits {
    pub max_bytes: usize,
    pub max_image_bytes: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub mime_type: String,
    pub file_name: String,
    pub origin: AttachmentOrigin,
    pub content: String,
}

impl AttachmentLimits {
    pub fn validate(&self, mime: &str, size: usize) -> Result<(), String> {
        let limit = if mime.starts_with("image/") {
            self.max_image_bytes.min(self.max_bytes)
        } else {
            self.max_bytes
        };
        if size == 0 {
            Err("Empty files cannot be attached".into())
        } else if size > limit {
            Err(format!(
                "Attachment exceeds the Gateway limit of {}",
                size_label(limit)
            ))
        } else {
            Ok(())
        }
    }
}

impl Attachment {
    pub fn from_bytes(
        file_name: String,
        mime_type: String,
        origin: AttachmentOrigin,
        bytes: Vec<u8>,
        limits: AttachmentLimits,
    ) -> Result<Self, String> {
        limits.validate(&mime_type, bytes.len())?;
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            file_name,
            mime_type,
            origin,
            bytes: bytes.into(),
        })
    }

    pub fn read(path: &Path, limits: AttachmentLimits) -> Result<Self, String> {
        let file_name = path
            .file_name()
            .ok_or("Choose a file")?
            .to_string_lossy()
            .into_owned();
        let mime_type = mime_for_path(path).to_owned();
        let file = File::open(path).map_err(|error| format!("{file_name}: {error}"))?;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err(format!("{file_name} is not a regular file"));
        }
        limits.validate(
            &mime_type,
            usize::try_from(metadata.len()).unwrap_or(usize::MAX),
        )?;
        // A file can grow between metadata and read; cap the actual read as well.
        let mut bytes = Vec::new();
        file.take(limits.max_bytes as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        Self::from_bytes(file_name, mime_type, AttachmentOrigin::File, bytes, limits)
    }

    pub fn is_image(&self) -> bool {
        self.mime_type.starts_with("image/")
    }
    pub fn size_label(&self) -> String {
        size_label(self.bytes.len())
    }
    pub fn encoded(&self) -> AttachmentPayload {
        AttachmentPayload {
            kind: if self.is_image() { "image" } else { "file" },
            mime_type: self.mime_type.clone(),
            file_name: self.file_name.clone(),
            origin: self.origin,
            content: STANDARD.encode(&self.bytes),
        }
    }
}

pub fn large_paste(text: &str) -> bool {
    text.encode_utf16().count() > 1000
}

fn size_label(bytes: usize) -> String {
    if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.)
    } else {
        format!("{bytes} B")
    }
}

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "csv" => "text/csv",
        "md" => "text/markdown",
        "html" => "text/html",
        "txt" | "rs" | "ts" | "js" | "py" | "sh" | "go" | "swift" | "log" => "text/plain",
        "zip" => "application/zip",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_transport_preserves_bytes_origin_and_specific_image_limit() {
        let limits = AttachmentLimits {
            max_bytes: 12,
            max_image_bytes: 4,
        };
        assert!(limits.validate("text/plain", 8).is_ok());
        assert!(limits.validate("image/png", 5).is_err());
        assert!(limits.validate("text/plain", 0).is_err());
        let attachment = Attachment::from_bytes(
            "a.png".into(),
            "image/png".into(),
            AttachmentOrigin::Paste,
            vec![0, 1, 255],
            limits,
        )
        .unwrap();
        let wire = serde_json::to_value(attachment.encoded()).unwrap();
        assert_eq!(wire["content"], "AAH/");
        assert_eq!(wire["type"], "image");
        assert_eq!(wire["origin"], "paste");
        assert_eq!(wire["fileName"], "a.png");
    }

    #[test]
    fn paste_threshold_counts_utf16_units_like_the_web_composer() {
        assert!(!large_paste(&"🦞".repeat(500)));
        assert!(large_paste(&"🦞".repeat(501)));
    }
}
