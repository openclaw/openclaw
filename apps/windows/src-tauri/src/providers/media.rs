use crate::error::OpenClawError;
use base64::{engine::general_purpose::STANDARD as b64, Engine};
use serde_json::{json, Value};
use std::io::Cursor;

pub trait MediaProvider: Send + Sync {
    fn list_cameras(&self) -> crate::error::Result<Value>;
    fn capture_camera_frame(&self, index: u32) -> crate::error::Result<Value>;
    fn capture_screen(&self, monitor_index: usize) -> crate::error::Result<Value>;
}

pub struct RealMediaProvider;

impl MediaProvider for RealMediaProvider {
    fn list_cameras(&self) -> crate::error::Result<Value> {
        let devices = nokhwa::query(nokhwa::utils::ApiBackend::Auto)
            .map_err(|e| OpenClawError::Internal(format!("Failed to query cameras: {}", e)))?;

        let infos: Vec<Value> = devices
            .iter()
            .map(|dev| {
                json!({
                    "id": dev.index().to_string(),
                    "name": dev.human_name(),
                })
            })
            .collect();

        Ok(json!({ "devices": infos }))
    }

    fn capture_camera_frame(&self, index: u32) -> crate::error::Result<Value> {
        let mut camera = nokhwa::Camera::new(
            nokhwa::utils::CameraIndex::Index(index),
            nokhwa::utils::RequestedFormat::new::<nokhwa::pixel_format::RgbFormat>(
                nokhwa::utils::RequestedFormatType::AbsoluteHighestFrameRate,
            ),
        )
        .map_err(|e| {
            OpenClawError::Internal(format!("Failed to initialize camera {}: {}", index, e))
        })?;

        camera
            .open_stream()
            .map_err(|e| OpenClawError::Internal(format!("Failed to open camera stream: {}", e)))?;

        let frame = camera
            .frame()
            .map_err(|e| OpenClawError::Internal(format!("Failed to capture frame: {}", e)))?;

        // Close the stream explicitly so the OS handle is released promptly
        let _ = camera.stop_stream();

        let decoded = frame
            .decode_image::<nokhwa::pixel_format::RgbFormat>()
            .map_err(|e| OpenClawError::Internal(format!("Failed to decode image: {}", e)))?;

        let width = decoded.width();
        let height = decoded.height();

        let mut buf = Cursor::new(Vec::new());
        decoded
            .write_to(&mut buf, image::ImageFormat::Jpeg)
            .map_err(|e| OpenClawError::Internal(format!("Failed to encode jpeg: {}", e)))?;

        let b64_str = b64.encode(buf.into_inner());

        Ok(json!({
            "format": "jpeg",
            "base64": b64_str,
            "width": width,
            "height": height,
        }))
    }

    fn capture_screen(&self, monitor_index: usize) -> crate::error::Result<Value> {
        let screens = xcap::Monitor::all()
            .map_err(|e| OpenClawError::Internal(format!("Failed to list monitors: {}", e)))?;

        let screen = screens
            .get(monitor_index)
            .or_else(|| screens.first())
            .ok_or_else(|| OpenClawError::Internal("No monitors found".to_string()))?;

        let image = screen
            .capture_image()
            .map_err(|e| OpenClawError::Internal(format!("Failed to capture screen: {}", e)))?;

        let mut buf = Cursor::new(Vec::new());
        image
            .write_to(&mut buf, xcap::image::ImageFormat::Jpeg)
            .map_err(|e| OpenClawError::Internal(format!("Failed to encode jpeg: {}", e)))?;

        let b64_str = b64.encode(buf.into_inner());

        Ok(json!({
            "format": "jpeg",
            "base64": b64_str,
            "screenIndex": monitor_index,
            "hasAudio": false
        }))
    }
}
