use anyhow::{bail, Result};
use serde::Deserialize;

use super::client::SynoClient;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct LoginData {
    pub sid: String,
    pub synotoken: Option<String>,
    pub account: Option<String>,
    pub device_id: Option<String>,
    pub ik_message: Option<String>,
    pub is_portal_port: Option<bool>,
}

/// Login to Synology DSM via POST (matches real DSM 7 behavior).
pub async fn login(
    client: &SynoClient,
    account: &str,
    passwd: &str,
    otp_code: Option<&str>,
) -> Result<LoginData> {
    let otp = otp_code.unwrap_or("");
    let params = vec![
        ("api", "SYNO.API.Auth"),
        ("version", "7"),
        ("method", "login"),
        ("account", account),
        ("passwd", passwd),
        ("otp_code", otp),
        ("enable_syno_token", "yes"),
        ("enable_device_token", "no"),
        ("logintype", "local"),
        ("session", "webui"),
        ("client", "browser"),
        ("rememberme", "0"),
    ];

    let data: LoginData = client.post_api("entry.cgi", &params).await?;
    Ok(data)
}

/// Logout from Synology DSM.
pub async fn logout(client: &SynoClient, sid: &str) -> Result<()> {
    let val = client
        .post(
            "entry.cgi",
            &[
                ("api", "SYNO.API.Auth"),
                ("version", "7"),
                ("method", "logout"),
                ("_sid", sid),
            ],
        )
        .await?;

    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        bail!("Logout failed: {val}");
    }
    Ok(())
}
