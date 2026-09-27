use std::time::{SystemTime, UNIX_EPOCH};

pub fn footer_label(now: SystemTime) -> String {
    let commit = option_env!("GPUI_BUILD_COMMIT").unwrap_or_default();
    if commit.is_empty() {
        return env!("CARGO_PKG_VERSION").to_owned();
    }
    let Some(timestamp) =
        option_env!("GPUI_BUILD_COMMIT_TIME").and_then(|time| time.parse::<u64>().ok())
    else {
        return format!("git@{commit}");
    };
    let now = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let seconds = now.abs_diff(timestamp);
    let past = now >= timestamp;
    let age = if seconds < 60 && past {
        "just now".to_owned()
    } else {
        // Match the Control UI's nested relative-time rounding and 48-hour day boundary.
        let minutes = seconds.saturating_add(30) / 60;
        let hours = minutes.saturating_add(30) / 60;
        let (value, unit) = if seconds < 60 {
            (seconds, "s")
        } else if minutes < 60 {
            (minutes, "m")
        } else if hours < 48 {
            (hours, "h")
        } else {
            (hours.saturating_add(12) / 24, "d")
        };
        if past {
            format!("{value}{unit} ago")
        } else {
            format!("in {value}{unit}")
        }
    };
    format!("git@{commit} · {age}")
}
