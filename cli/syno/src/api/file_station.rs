use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;

use super::client::SynoClient;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct FileList {
    pub offset: Option<u64>,
    pub total: Option<u64>,
    pub files: Option<Vec<FileItem>>,
}

#[derive(Debug, Deserialize)]
pub struct FileItem {
    pub name: String,
    pub path: String,
    pub isdir: bool,
    pub additional: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ShareList {
    pub offset: Option<u64>,
    pub total: Option<u64>,
    pub shares: Option<Vec<ShareItem>>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ShareItem {
    pub name: String,
    pub path: String,
    pub additional: Option<Value>,
}

/// List shared folders.
pub async fn list_share(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
) -> Result<ShareList> {
    client
        .post_api_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.FileStation.List"),
                ("version", "2"),
                ("method", "list_share"),
            ],
        )
        .await
}

/// List files in a folder.
pub async fn list(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    folder_path: &str,
    offset: u64,
    limit: u64,
) -> Result<FileList> {
    let offset_str = offset.to_string();
    let limit_str = limit.to_string();
    client
        .post_api_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.FileStation.List"),
                ("version", "2"),
                ("method", "list"),
                ("folder_path", folder_path),
                ("offset", &offset_str),
                ("limit", &limit_str),
                ("additional", "[\"size\",\"time\",\"type\"]"),
            ],
        )
        .await
}

/// Get info about a file/folder.
pub async fn get_info(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    path: &str,
) -> Result<FileList> {
    let path_param = format!("[\"{path}\"]");
    client
        .post_api_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.FileStation.List"),
                ("version", "2"),
                ("method", "getinfo"),
                ("path", &path_param),
                ("additional", "[\"size\",\"time\",\"type\"]"),
            ],
        )
        .await
}
