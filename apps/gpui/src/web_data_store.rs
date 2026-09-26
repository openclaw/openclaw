//! Root-scoped WebKit stores. WebKit owns their on-disk location, identity.json owns deletion.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Record {
    pub identifier: [u8; 16],
    #[serde(default)]
    pub pending_removal: bool,
}

pub(crate) fn control_scope(
    gateway: &str,
    profile: Option<&(String, String)>,
) -> Result<String, String> {
    let canonical_gateway = profile.map_or(gateway, |(_, url)| url.as_str());
    let scope = format!(
        "control:{}",
        crate::model::web_urls::control_base_url(canonical_gateway)?
            .origin()
            .ascii_serialization()
    );
    Ok(match profile {
        Some((id, _)) => format!("profile:{id}:{scope}"),
        None => scope,
    })
}

pub(crate) fn reading_scope(profile_id: Option<&str>) -> String {
    profile_id.map_or_else(|| "reading".into(), |id| format!("profile:{id}:reading"))
}

pub(crate) fn directory(root: &Path, scope: &str) -> Result<PathBuf, String> {
    let name = if scope.starts_with("profile:") {
        format!("profile-{:x}", Sha256::digest(scope.as_bytes()))
    } else if let Some(origin) = scope.strip_prefix("control:") {
        format!("control-{:x}", Sha256::digest(origin.as_bytes()))
    } else if scope == "reading" {
        "reading".into()
    } else {
        return Err("Unknown web session scope".into());
    };
    Ok(root.join("webviews").join(name))
}

pub(crate) fn identifier(root: &Path, scope: &str) -> [u8; 16] {
    let root = root.as_os_str().as_encoded_bytes();
    let mut hash = Sha256::new();
    hash.update(b"org.openclaw.gpui.web-data-store.v1\0");
    hash.update((root.len() as u64).to_be_bytes());
    hash.update(root);
    hash.update(scope.as_bytes());
    let mut bytes: [u8; 16] = hash.finalize()[..16].try_into().expect("SHA-256 prefix");
    // UUIDv8: custom SHA-256 payload, with the RFC 4122 variant.
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    bytes
}

#[cfg(target_os = "macos")]
pub(crate) fn supported() -> bool {
    if objc2::available!(macos = 14.0) {
        true
    } else {
        static WARNING: std::sync::Once = std::sync::Once::new();
        WARNING.call_once(|| log::warn!("Persistent web sessions require macOS 14; using isolated ephemeral stores on this system."));
        false
    }
}

#[cfg(target_os = "macos")]
fn initialize_webkit() -> Result<(), String> {
    let main = objc2::MainThreadMarker::new().ok_or("Web stores require the main thread")?;
    // Static store APIs do not initialize WebKit's main run loop. An ephemeral
    // store does so without opening the default persistent store.
    unsafe {
        objc2_web_kit::WKWebsiteDataStore::nonPersistentDataStore(main);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
async fn identifiers() -> Result<Vec<[u8; 16]>, String> {
    use wry::WebViewExtDarwin;
    let (send, receive) = async_channel::bounded(1);
    wry::WebView::fetch_data_store_identifiers(move |ids| {
        let _ = send.try_send(ids);
    })
    .map_err(|_| "Could not list WebKit stores")?;
    receive
        .recv()
        .await
        .map_err(|_| "Store listing callback was lost".into())
}

#[cfg(target_os = "macos")]
async fn clear(id: [u8; 16], executor: &gpui_kit::BackgroundExecutor) -> Result<(), String> {
    use objc2_foundation::{NSDate, NSUUID};
    use objc2_web_kit::WKWebsiteDataStore;
    let main = objc2::MainThreadMarker::new().ok_or("Web stores require the main thread")?;
    let (send, receive) = async_channel::bounded(1);
    // Service workers retain the store after its views close. Wry's clear API
    // discards this completion, so await the public WebKit callback directly.
    let retired = objc2::rc::autoreleasepool(|_| unsafe {
        let store = WKWebsiteDataStore::dataStoreForIdentifier(&NSUUID::from_bytes(id), main);
        let retired = objc2::rc::Weak::from_retained(&store);
        let done = block2::RcBlock::new(move || {
            let _ = send.try_send(());
        });
        store.removeDataOfTypes_modifiedSince_completionHandler(
            &WKWebsiteDataStore::allWebsiteDataTypes(main),
            &NSDate::dateWithTimeIntervalSince1970(0.),
            &done,
        );
        retired
    });
    receive
        .recv()
        .await
        .map_err(|_| "Web data clearing callback was lost")?;
    // Clear's completion still holds the store, and worker termination can
    // finish afterward. Wait for release before asking WebKit to remove it.
    // WebKit's worker idle termination delay is 10 seconds; leave room for
    // its process-close messages and disk cleanup on slower machines.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while retired.load().is_some() {
        if std::time::Instant::now() >= deadline {
            return Err(
                "WebKit is still closing this Gateway's web session. Retry Sign out.".into(),
            );
        }
        executor.timer(std::time::Duration::from_millis(25)).await;
    }
    Ok(())
}

// Both callers run on GPUI's main-thread executor; no state lock spans an await.
#[cfg(target_os = "macos")]
pub(crate) async fn remove(
    identity: &mut crate::gateway::identity::Identity,
    scope: &str,
    executor: &gpui_kit::BackgroundExecutor,
) -> Result<(), String> {
    use wry::WebViewExtDarwin;
    let Some(id) = identity.begin_web_store_removal(scope)? else {
        return Ok(());
    };
    if !supported() {
        return Err("Removing saved web sessions requires macOS 14 or newer".into());
    }
    initialize_webkit()?;
    // A failed/unused surface may have recorded an identifier without creating it.
    if identifiers().await?.contains(&id) {
        clear(id, executor).await?;
        let (send, receive) = async_channel::bounded(1);
        wry::WebView::remove_data_store(&id, move |result| {
            let _ = send.try_send(result);
        });
        receive
            .recv()
            .await
            .map_err(|_| "Store removal callback was lost")?
            .map_err(
                |_| "Could not remove the web session. Close other app windows and retry Sign out.",
            )?;
        if identifiers().await?.contains(&id) {
            return Err("WebKit still lists the web session; retry Sign out.".into());
        }
    }
    remove_directory(identity.state_directory(), scope)?;
    identity.finish_web_store_removal(scope, id)?;
    log::info!(
        "Removed web data store {}; verified absent from WebKit",
        uuid::Uuid::from_bytes(id)
    );
    Ok(())
}

fn remove_directory(root: &Path, scope: &str) -> Result<(), String> {
    match std::fs::remove_dir_all(directory(root, scope)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Could not remove the web session directory: {error}"
        )),
    }
}

/// The caller closes the profile's windows before deleting their recorded stores.
pub(crate) async fn remove_scopes(
    identity: &mut crate::gateway::identity::Identity,
    scopes: &[String],
    executor: &gpui_kit::BackgroundExecutor,
) -> Result<(), String> {
    for scope in scopes {
        #[cfg(target_os = "macos")]
        remove(identity, scope, executor).await?;
        #[cfg(not(target_os = "macos"))]
        if let Some(id) = identity.begin_web_store_removal(scope)? {
            let _ = executor;
            remove_directory(identity.state_directory(), scope)?;
            identity.finish_web_store_removal(scope, id)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn maintenance(action: String, cx: &mut gpui_kit::App) {
    // This command never loads Gateway configuration or creates a webview.
    let prepared = (|| {
        let root = std::env::var_os("OPENCLAW_GPUI_STATE_DIR")
            .filter(|root| !root.is_empty())
            .ok_or("Set OPENCLAW_GPUI_STATE_DIR explicitly for web-store maintenance")?;
        if !Path::new(&root).join("identity.json").is_file() {
            return Err("The selected state root has no identity.json".to_owned());
        }
        if !supported() {
            return Err("Web-store maintenance requires macOS 14 or newer".to_owned());
        }
        if !matches!(action.as_str(), "list" | "remove") {
            return Err("Use --web-data-stores list|remove".to_owned());
        }
        initialize_webkit()?;
        crate::gateway::identity::Identity::load()
    })();
    let executor = cx.background_executor().clone();
    cx.spawn(async move |cx| {
        let result =
            async {
                let mut identity = prepared?;
                let recorded = identity.web_store_records();
                if action == "remove" {
                    for scope in recorded.keys() {
                        remove(&mut identity, scope, &executor).await?;
                    }
                }
                let present = identifiers().await?;
                let records = crate::gateway::identity::Identity::load()?.web_store_records();
                let rows: Vec<_> = records
                    .iter()
                    .map(|(scope, record)| {
                        serde_json::json!({
                            "scope": scope,
                            "identifier": uuid::Uuid::from_bytes(record.identifier).to_string(),
                            "present": present.contains(&record.identifier),
                            "pendingRemoval": record.pending_removal,
                        })
                    })
                    .collect();
                let removed: Vec<_> =
                    if action == "remove" {
                        recorded.values().map(|record| serde_json::json!({
                    "identifier": uuid::Uuid::from_bytes(record.identifier).to_string(),
                    "present": present.contains(&record.identifier),
                })).collect()
                    } else {
                        Vec::new()
                    };
                if removed.iter().any(|row| row["present"] == true) {
                    return Err("WebKit still lists a removed store".into());
                }
                println!(
                    "{}",
                    serde_json::json!({"stores": rows, "removed": removed})
                );
                Ok::<(), String>(())
            }
            .await;
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_are_stable_origin_and_root_scoped_rfc_uuids() {
        let root = Path::new("/isolated/app-a");
        let origin = control_scope("wss://EXAMPLE.test:443/mount/", None).unwrap();
        assert_eq!(
            origin,
            control_scope("https://example.test/elsewhere", None).unwrap()
        );
        let id = identifier(root, &origin);
        assert_eq!(
            uuid::Uuid::from_bytes(id).to_string(),
            "a302d35f-2081-883b-80b3-433ee7bcfbbb"
        );
        assert_ne!(
            id,
            identifier(root, &control_scope("wss://other.test/", None).unwrap())
        );
        assert_ne!(
            id,
            identifier(
                root,
                &control_scope("wss://example.test:444/", None).unwrap()
            )
        );
        assert_ne!(id, identifier(Path::new("/isolated/app-b"), &origin));
        assert_ne!(id, identifier(root, "reading"));
        assert_eq!(id[6] >> 4, 8);
        assert_eq!(id[8] >> 6, 2);
    }

    #[test]
    fn profile_stores_isolate_reading_and_control_without_changing_legacy_stores() {
        let root = Path::new("/isolated/app");
        let control = control_scope(
            "wss://example.test/",
            Some(&("one".into(), "wss://example.test/".into())),
        )
        .unwrap();
        let reading = reading_scope(Some("one"));
        assert_eq!(reading, "profile:one:reading");
        assert_ne!(identifier(root, &control), identifier(root, &reading));
        assert_ne!(
            identifier(root, &reading),
            identifier(root, &reading_scope(Some("two")))
        );
        assert_ne!(
            directory(root, &control).unwrap(),
            directory(root, &reading).unwrap()
        );
        assert_ne!(
            directory(root, &reading).unwrap(),
            directory(root, &reading_scope(Some("two"))).unwrap()
        );
        assert_eq!(
            directory(root, &reading_scope(None)).unwrap(),
            root.join("webviews/reading")
        );
        assert!(directory(root, "../../outside").is_err());
    }
}
