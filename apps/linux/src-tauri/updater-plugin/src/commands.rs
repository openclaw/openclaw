// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use crate::{Result, Update, UpdaterExt};

use http::{HeaderMap, HeaderName, HeaderValue};
use serde::Serialize;
use tauri::{ipc::Channel, Manager, Resource, ResourceId, Runtime, Webview};

use std::{str::FromStr, time::Duration};
use url::Url;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Metadata {
    rid: ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

struct DownloadedBytes(pub Vec<u8>);
impl Resource for DownloadedBytes {}

#[tauri::command]
pub(crate) async fn check<R: Runtime>(
    webview: Webview<R>,
    headers: Option<Vec<(String, String)>>,
    timeout: Option<u64>,
    proxy: Option<String>,
    target: Option<String>,
    allow_downgrades: Option<bool>,
) -> Result<Option<Metadata>> {
    let mut builder = webview.updater_builder();
    if let Some(headers) = headers {
        for (k, v) in headers {
            builder = builder.header(k, v)?;
        }
    }
    if let Some(timeout) = timeout {
        builder = builder.timeout(Duration::from_millis(timeout));
    }
    if let Some(ref proxy) = proxy {
        let url = Url::parse(proxy.as_str())?;
        builder = builder.proxy(url);
    }
    if let Some(target) = target {
        builder = builder.target(target);
    }
    if allow_downgrades.unwrap_or(false) {
        builder = builder.version_comparator(|current, update| update.version != current);
    }

    let updater = builder.build()?;
    let update = updater.check().await?;

    if let Some(update) = update {
        let formatted_date = if let Some(date) = update.date {
            let formatted_date = date
                .format(&time::format_description::well_known::Rfc3339)
                .map_err(|_| crate::Error::FormatDate)?;
            Some(formatted_date)
        } else {
            None
        };
        let metadata = Metadata {
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            date: formatted_date,
            body: update.body.clone(),
            raw_json: update.raw_json.clone(),
            rid: webview.resources_table().add(update),
        };
        Ok(Some(metadata))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub(crate) async fn download<R: Runtime>(
    webview: Webview<R>,
    rid: ResourceId,
    on_event: Channel<DownloadEvent>,
    headers: Option<Vec<(String, String)>>,
    timeout: Option<u64>,
) -> Result<ResourceId> {
    let update = webview.resources_table().get::<Update>(rid)?;

    let mut update = (*update).clone();

    if let Some(headers) = headers {
        let mut map = HeaderMap::new();
        for (k, v) in headers {
            map.append(HeaderName::from_str(&k)?, HeaderValue::from_str(&v)?);
        }
        update.headers = map;
    }

    if let Some(timeout) = timeout {
        update.timeout = Some(Duration::from_millis(timeout));
    }

    let mut first_chunk = true;
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if first_chunk {
                    first_chunk = !first_chunk;
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await?;

    Ok(webview.resources_table().add(DownloadedBytes(bytes)))
}

#[tauri::command]
pub(crate) async fn install<R: Runtime>(
    webview: Webview<R>,
    update_rid: ResourceId,
    bytes_rid: ResourceId,
    restart_after_install: Option<bool>,
) -> Result<()> {
    let update = webview.resources_table().get::<Update>(update_rid)?;
    let bytes = webview
        .resources_table()
        .get::<DownloadedBytes>(bytes_rid)?;

    if let Some(restart_after_install) = restart_after_install {
        let update = (*update).clone();
        update
            .restart_after_install(restart_after_install)
            .install(&bytes.0)?;
    } else {
        update.install(&bytes.0)?;
    }

    let _ = webview.resources_table().close(bytes_rid);
    Ok(())
}

#[tauri::command]
pub(crate) async fn download_and_install<R: Runtime>(
    webview: Webview<R>,
    rid: ResourceId,
    on_event: Channel<DownloadEvent>,
    headers: Option<Vec<(String, String)>>,
    timeout: Option<u64>,
    restart_after_install: Option<bool>,
) -> Result<()> {
    let update = webview.resources_table().get::<Update>(rid)?;

    let mut update = (*update).clone();

    if let Some(headers) = headers {
        let mut map = HeaderMap::new();
        for (k, v) in headers {
            map.append(HeaderName::from_str(&k)?, HeaderValue::from_str(&v)?);
        }
        update.headers = map;
    }

    if let Some(timeout) = timeout {
        update.timeout = Some(Duration::from_millis(timeout));
    }

    if let Some(restart_after_install) = restart_after_install {
        update = update.restart_after_install(restart_after_install);
    }

    let mut first_chunk = true;

    update
        .download_and_install(
            |chunk_length, content_length| {
                if first_chunk {
                    first_chunk = !first_chunk;
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await?;

    Ok(())
}
