use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;

use super::client::SynoClient;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct TaskList {
    pub offset: Option<u64>,
    pub total: Option<u64>,
    pub tasks: Option<Vec<TaskItem>>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct TaskItem {
    pub id: String,
    pub title: Option<String>,
    pub status: Option<String>,
    pub size: Option<u64>,
    pub additional: Option<Value>,
}

/// List download tasks.
pub async fn list(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
) -> Result<TaskList> {
    client
        .post_api_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.DownloadStation.Task"),
                ("version", "1"),
                ("method", "list"),
                ("additional", "detail,transfer"),
            ],
        )
        .await
}

/// Create a download task by URL.
pub async fn create(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    uri: &str,
    destination: Option<&str>,
) -> Result<()> {
    let mut params = vec![
        ("api", "SYNO.DownloadStation.Task"),
        ("version", "1"),
        ("method", "create"),
        ("uri", uri),
    ];
    if let Some(dest) = destination {
        params.push(("destination", dest));
    }

    let val = client.post_with_sid("entry.cgi", sid, synotoken, &params).await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("Failed to create download task: {val}");
    }
    Ok(())
}

/// Delete download tasks by IDs.
pub async fn delete(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    ids: &str,
) -> Result<()> {
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.DownloadStation.Task"),
                ("version", "1"),
                ("method", "delete"),
                ("id", ids),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("Failed to delete task(s): {val}");
    }
    Ok(())
}

/// Pause download tasks.
pub async fn pause(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    ids: &str,
) -> Result<()> {
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.DownloadStation.Task"),
                ("version", "1"),
                ("method", "pause"),
                ("id", ids),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("Failed to pause task(s): {val}");
    }
    Ok(())
}

/// Resume download tasks.
pub async fn resume(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    ids: &str,
) -> Result<()> {
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.DownloadStation.Task"),
                ("version", "1"),
                ("method", "resume"),
                ("id", ids),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("Failed to resume task(s): {val}");
    }
    Ok(())
}
