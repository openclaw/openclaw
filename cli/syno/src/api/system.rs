use anyhow::Result;
use serde::Deserialize;

use super::client::SynoClient;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct DsmInfo {
    pub model: Option<String>,
    pub ram: Option<u64>,
    pub serial: Option<String>,
    pub temperature: Option<i32>,
    pub uptime: Option<u64>,
    pub version: Option<String>,
    pub version_string: Option<String>,
}

/// Get DSM system info (SYNO.DSM.Info).
pub async fn get_info(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
) -> Result<DsmInfo> {
    client
        .post_api_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.DSM.Info"),
                ("version", "2"),
                ("method", "getinfo"),
            ],
        )
        .await
}
