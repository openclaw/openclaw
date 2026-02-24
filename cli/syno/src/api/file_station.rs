use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;

use super::client::{SynoClient, format_syno_error};

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

/// Download a file to a local path. Returns bytes written.
pub async fn download(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    remote_path: &str,
    local_path: &Path,
) -> Result<u64> {
    let path_param = format!("[\"{}\"]", remote_path);
    client
        .post_download(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.FileStation.Download"),
                ("version", "2"),
                ("method", "download"),
                ("path", &path_param),
                ("mode", "\"download\""),
            ],
            local_path,
        )
        .await
}

/// Create a folder. Returns the created folder info.
pub async fn create_folder(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    folder_path: &str,
    name: &str,
) -> Result<Value> {
    let folder_param = format!("[\"{}\"]", folder_path);
    let name_param = format!("[\"{}\"]", name);
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.FileStation.CreateFolder"),
                ("version", "2"),
                ("method", "create"),
                ("folder_path", &folder_param),
                ("name", &name_param),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("{}", format_syno_error("FileStation.CreateFolder", &val));
    }
    Ok(val["data"].clone())
}

/// Rename a file or folder. Returns renamed item info.
pub async fn rename(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    path: &str,
    name: &str,
) -> Result<Value> {
    let path_param = format!("[\"{}\"]", path);
    let name_param = format!("[\"{}\"]", name);
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.FileStation.Rename"),
                ("version", "2"),
                ("method", "rename"),
                ("path", &path_param),
                ("name", &name_param),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("{}", format_syno_error("FileStation.Rename", &val));
    }
    Ok(val["data"].clone())
}

/// Delete files/folders (moves to recycle bin by default).
pub async fn delete(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    path: &str,
) -> Result<()> {
    let path_param = format!("[\"{}\"]", path);
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.FileStation.Delete"),
                ("version", "2"),
                ("method", "delete"),
                ("path", &path_param),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("{}", format_syno_error("FileStation.Delete", &val));
    }
    Ok(())
}

/// Upload a file to a remote folder. Returns upload result.
pub async fn upload(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    dest_folder: &str,
    local_path: &Path,
    overwrite: bool,
) -> Result<Value> {
    let overwrite_str = if overwrite { "true" } else { "false" };
    let val = client
        .post_upload(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.FileStation.Upload"),
                ("version", "2"),
                ("method", "upload"),
                ("path", dest_folder),
                ("create_parents", "true"),
                ("overwrite", overwrite_str),
            ],
            local_path,
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("{}", format_syno_error("FileStation.Upload", &val));
    }
    Ok(val["data"].clone())
}
