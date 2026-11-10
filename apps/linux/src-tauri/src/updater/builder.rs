use tauri::AppHandle;
use tauri_plugin_updater::{UpdaterBuilder, UpdaterExt};

#[cfg(target_os = "macos")]
// Test desktop builds need a channel that Linux-only releases never replace.
const DESKTOP_TEST_UPDATE_ENDPOINT: &str =
    "https://github.com/openclaw/openclaw/releases/download/desktop-test/latest-desktop-test.json";
#[cfg(target_os = "windows")]
const WINDOWS_UPDATE_ENDPOINT: &str =
    "https://github.com/openclaw/openclaw/releases/download/windows-stable/latest-windows.json";

fn calendar_release_key(version: &str) -> Option<(u64, u64, u64, u8, u64)> {
    // Keep recognition and safe integer bounds aligned with scripts/lib/release-version.mjs.
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let positive_part = |part: &str| {
        if part.is_empty() || part.starts_with('0') || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse::<u64>().ok().filter(|n| *n <= MAX_SAFE_INTEGER)
    };
    let (base, prerelease) = match version.split_once('-') {
        Some((base, prerelease)) => (base, Some(prerelease)),
        None => (version, None),
    };
    let mut parts = base.split('.');
    let year = parts.next()?;
    if year.len() != 4 || !year.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let year = year.parse().ok()?;
    let month = positive_part(parts.next()?)?;
    let patch = positive_part(parts.next()?)?;
    if month > 12 || parts.next().is_some() {
        return None;
    }
    let (rank, sequence) = match prerelease {
        None => (2, 0),
        Some(value) => match value.split_once('.') {
            Some(("alpha", number)) => (0, positive_part(number)?),
            Some(("beta", number)) => (1, positive_part(number)?),
            Some(_) => return None,
            None => (2, positive_part(value)?),
        },
    };
    Some((year, month, patch, rank, sequence))
}

fn release_is_newer<T: Ord + std::fmt::Display>(current: &T, candidate: &T) -> bool {
    match (
        calendar_release_key(&current.to_string()),
        calendar_release_key(&candidate.to_string()),
    ) {
        (Some(current), Some(candidate)) => candidate > current,
        // Preserve Tauri's exact comparator, including build metadata, outside the calendar grammar.
        _ => candidate > current,
    }
}

pub(super) fn updater_builder(app: &AppHandle) -> tauri_plugin_updater::Result<UpdaterBuilder> {
    let builder = app
        .updater_builder()
        .version_comparator(|current, candidate| release_is_newer(&current, &candidate.version));
    #[cfg(target_os = "linux")]
    let builder = Ok(builder);
    #[cfg(target_os = "macos")]
    let builder = builder.endpoints(vec![DESKTOP_TEST_UPDATE_ENDPOINT
        .parse()
        .expect("desktop test updater endpoint is valid")]);
    #[cfg(target_os = "windows")]
    let builder = builder.endpoints(vec![WINDOWS_UPDATE_ENDPOINT
        .parse()
        .expect("Windows updater endpoint is valid")]);
    builder
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct ReleaseVersionCases {
        ordered: Vec<ReleaseVersionCase>,
        unrecognized: Vec<String>,
    }

    #[derive(serde::Deserialize)]
    struct ReleaseVersionCase {
        current: String,
        candidate: String,
        ordering: i8,
    }

    fn release_version_cases() -> ReleaseVersionCases {
        serde_json::from_str(include_str!("../../../tests/release_version_cases.json")).unwrap()
    }

    fn remote_release(
        version: &str,
    ) -> Result<tauri_plugin_updater::RemoteRelease, serde_json::Error> {
        serde_json::from_value(serde_json::json!({
            "version": version,
            "platforms": {},
        }))
    }

    #[test]
    fn release_version_correction_replaces_base() {
        let current = remote_release("2026.9.3").unwrap().version;
        let candidate = remote_release("2026.9.3-1").unwrap().version;
        assert!(
            candidate < current,
            "the locked vendor default treats the correction as a prerelease"
        );
        assert!(
            release_is_newer(&current, &candidate),
            "base -> correction must offer the correction"
        );
    }

    #[test]
    fn release_version_shared_calendar_cases() {
        for case in release_version_cases().ordered {
            let current = remote_release(&case.current).unwrap().version;
            let candidate = remote_release(&case.candidate).unwrap().version;
            assert_eq!(
                release_is_newer(&current, &candidate),
                case.ordering > 0,
                "{} -> {}",
                case.current,
                case.candidate,
            );
            assert_eq!(
                release_is_newer(&candidate, &current),
                case.ordering < 0,
                "{} -> {}",
                case.candidate,
                case.current,
            );
        }
    }

    #[test]
    fn release_version_unrecognized_versions_keep_vendor_order() {
        for version in release_version_cases().unrecognized {
            let candidate = remote_release(&version).unwrap().version;
            assert_eq!(
                calendar_release_key(&candidate.to_string()),
                None,
                "{version}"
            );
            for current in ["2026.9.3", "2026.9.3-1", version.as_str()] {
                let current = remote_release(current).unwrap().version;
                assert_eq!(
                    release_is_newer(&current, &candidate),
                    candidate > current,
                    "{current} -> {candidate}",
                );
                assert_eq!(
                    release_is_newer(&candidate, &current),
                    current > candidate,
                    "{candidate} -> {current}",
                );
            }
        }
    }

    #[test]
    fn release_version_vendor_parsing_is_preserved() {
        for version in [
            "2026.9",
            "2026.09.3",
            "2026.9.03",
            "2026.9.3-01",
            "2026.9.3-beta.01",
            "2026.9.3-",
            "2026.9.3+",
            "2026.9.18446744073709551616",
            " 2026.9.3",
            "2026.9.3 ",
            "V2026.9.3",
        ] {
            assert!(remote_release(version).is_err(), "{version}");
        }
        let current = remote_release("2026.9.3").unwrap().version;
        let candidate = remote_release("v2026.9.3-1").unwrap().version;
        assert_eq!(candidate.to_string(), "2026.9.3-1");
        assert!(release_is_newer(&current, &candidate));
    }
}
