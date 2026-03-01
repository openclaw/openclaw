use serde::Serialize;
use std::os::windows::process::CommandExt;
use tauri::AppHandle;

const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Windows-specific capability names that map to Windows Settings pages.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub microphone: bool,
    pub camera: bool,
    pub screen_capture: bool,
    pub speech_recognition: bool,
    pub notifications: bool,
    pub accessibility: bool,
    pub location: bool,
    pub apple_script: bool,
}

/// Checks Windows privacy permissions using the Windows API.
#[tauri::command]
pub async fn get_permissions_status() -> crate::error::Result<PermissionStatus> {
    // On Windows, screen capture is always "permitted" at the OS level for desktop apps.
    // Microphone and Camera have per-app toggles in Windows Settings under Privacy.
    // Speech recognition is enabled system-wide via Windows Speech Recognition.

    Ok(PermissionStatus {
        microphone: check_microphone_allowed(),
        camera: check_camera_allowed(),
        screen_capture: true, // Always granted on Windows for desktop apps
        speech_recognition: check_speech_recognition_enabled(),
        notifications: check_notifications_allowed(),
        accessibility: true, // Desktop apps on Windows generally have accessibility access
        location: check_location_allowed(),
        apple_script: false, // macOS specific
    })
}

fn check_microphone_allowed() -> bool {
    use std::process::Command;
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone",
            "/v",
            "Value",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out.stdout);
            s.contains("Allow")
        }
        Err(_) => false,
    }
}

fn check_camera_allowed() -> bool {
    use std::process::Command;
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam",
            "/v",
            "Value",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out.stdout);
            s.contains("Allow")
        }
        Err(_) => false,
    }
}

fn check_speech_recognition_enabled() -> bool {
    use std::process::Command;
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\SOFTWARE\Microsoft\Speech_OneCore\Settings\OnlineSpeechPrivacy",
            "/v",
            "HasAccepted",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out.stdout);
            s.contains("0x1")
        }
        Err(_) => true,
    }
}

fn check_notifications_allowed() -> bool {
    use std::process::Command;
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\PushNotifications",
            "/v",
            "ToastEnabled",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out.stdout);
            s.contains("0x1")
        }
        Err(_) => true,
    }
}

fn check_location_allowed() -> bool {
    use std::process::Command;
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\location",
            "/v",
            "Value",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out.stdout);
            s.contains("Allow")
        }
        Err(_) => false,
    }
}

/// Opens the correct Windows Settings page for the given capability.
#[tauri::command]
pub async fn open_windows_permission(
    capability: String,
    _app: AppHandle,
) -> crate::error::Result<()> {
    let uri = match capability.as_str() {
        "microphone" => "ms-settings:privacy-microphone",
        "camera" => "ms-settings:privacy-webcam",
        "screen_capture" => "ms-settings:privacy-broadfilesystemaccess",
        "speech_recognition" => "ms-settings:privacy-speechtyping",
        "location" => "ms-settings:privacy-location",
        "notifications" => "ms-settings:notifications",
        _ => "ms-settings:privacy",
    };

    std::process::Command::new("explorer")
        .arg(uri)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| {
            crate::error::OpenClawError::Internal(format!("Failed to open Settings: {}", e))
        })?;

    Ok(())
}
