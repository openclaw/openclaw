use anyhow::{bail, Result};
use reqwest::multipart;
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;
use tokio::io::AsyncWriteExt;

/// Generic Synology API response wrapper.
#[derive(Debug, Deserialize)]
pub struct SynoResponse<T> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<SynoError>,
}

#[derive(Debug, Deserialize)]
pub struct SynoError {
    pub code: i32,
}

impl SynoError {
    /// Human-readable description for common Synology DSM API error codes.
    /// These are split into common codes (100-199) and Auth-specific codes (400+).
    pub fn description(&self) -> &'static str {
        match self.code {
            // ── Common error codes (all APIs) ──
            100 => "unknown error",
            101 => "missing api/method/version parameter",
            102 => "requested API does not exist",
            103 => "requested method does not exist",
            104 => "requested version does not support this method",
            105 => "insufficient user privilege",
            106 => "connection time out",
            107 => "multiple login detected",
            108..=114 => "file operation error",
            115 => "not allowed to upload file",
            116 => "not allowed to download file",
            117 => "not allowed to overwrite file",
            119 => "SID not found — session invalid or expired, need to re-login (call syno_login)",
            120 => "insufficient application privilege",
            // ── Auth API error codes (SYNO.API.Auth) ──
            400 => "no such account or incorrect password",
            401 => "account disabled",
            402 => "permission denied — account has no API access",
            403 => "2-step verification code required (OTP)",
            404 => "failed to authenticate 2-step verification code",
            406 => "enforce to authenticate with 2-step verification code (OTP enforced)",
            407 => "blocked IP or gateway — too many failed login attempts, IP has been auto-blocked by DSM",
            408 => "expired password, cannot change inside DSM",
            409 => "expired password, need to change inside DSM",
            410 => "password must be changed",
            411 => "account locked out (too many failed attempts)",
            // ── NoteStation error codes ──
            800 => "NoteStation: note locked or encrypted",
            // ── FileStation error codes ──
            900 => "FileStation: failed to create a folder — already exists or permission denied",
            // fallback
            _ => "unknown Synology API error",
        }
    }
}

impl std::fmt::Display for SynoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Synology API error code={}: {}", self.code, self.description())
    }
}

/// Format a Synology API error from a raw JSON response value.
/// Extracts `error.code` and appends the human-readable description.
pub fn format_syno_error(api_label: &str, val: &Value) -> String {
    let code = val["error"]["code"].as_i64().unwrap_or(-1) as i32;
    let err = SynoError { code };
    format!("{api_label} failed (code={code}): {}", err.description())
}

/// A thin HTTP client wrapper for Synology Web API.
#[derive(Clone)]
pub struct SynoClient {
    pub base_url: String,
    pub client: Client,
}

impl SynoClient {
    pub fn new(base_url: &str, accept_invalid_certs: bool) -> Result<Self> {
        let client = Client::builder()
            .danger_accept_invalid_certs(accept_invalid_certs)
            .build()?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client,
        })
    }

    /// Make a POST request with form-urlencoded body.
    pub async fn post(
        &self,
        cgi_path: &str,
        params: &[(&str, &str)],
    ) -> Result<Value> {
        let url = format!("{}/webapi/{}", self.base_url, cgi_path);
        let api_name = params.iter().find(|(k, _)| *k == "api").map(|(_, v)| *v).unwrap_or("?");
        let method_name = params.iter().find(|(k, _)| *k == "method").map(|(_, v)| *v).unwrap_or("?");
        let t = std::time::Instant::now();
        let resp = self
            .client
            .post(&url)
            .header("content-type", "application/x-www-form-urlencoded; charset=UTF-8")
            .form(params)
            .send()
            .await?;
        let t_send = t.elapsed();
        let status = resp.status();
        let body = resp.text().await?;
        let t_total = t.elapsed();
        eprintln!("[timing] HTTP {api_name}.{method_name}: send={t_send:?} total={t_total:?} body_len={}", body.len());
        if !status.is_success() {
            bail!("HTTP {status}: {body}");
        }
        let val: Value = serde_json::from_str(&body)?;
        Ok(val)
    }

    /// Make a POST request and parse into SynoResponse<T>.
    pub async fn post_api<T: serde::de::DeserializeOwned>(
        &self,
        cgi_path: &str,
        params: &[(&str, &str)],
    ) -> Result<T> {
        let val = self.post(cgi_path, params).await?;
        let resp: SynoResponse<T> = serde_json::from_value(val.clone())
            .map_err(|e| anyhow::anyhow!("Failed to parse response: {e}\nBody: {val}"))?;
        if !resp.success {
            let err = resp.error.unwrap_or(SynoError { code: -1 });
            bail!("{err}");
        }
        resp.data
            .ok_or_else(|| anyhow::anyhow!("API returned success but no data"))
    }

    /// POST with _sid in body + x-syno-token in header (matches real DSM 7 browser behavior).
    pub async fn post_with_sid(
        &self,
        cgi_path: &str,
        sid: &str,
        synotoken: Option<&str>,
        params: &[(&str, &str)],
    ) -> Result<Value> {
        let url = format!("{}/webapi/{}", self.base_url, cgi_path);
        let mut all_params: Vec<(&str, &str)> = params.to_vec();
        all_params.push(("_sid", sid));

        // Extract api name for logging
        let api_name = params.iter().find(|(k, _)| *k == "api").map(|(_, v)| *v).unwrap_or("?");
        let method_name = params.iter().find(|(k, _)| *k == "method").map(|(_, v)| *v).unwrap_or("?");
        let t = std::time::Instant::now();

        let mut req = self
            .client
            .post(&url)
            .header("content-type", "application/x-www-form-urlencoded; charset=UTF-8");

        if let Some(token) = synotoken {
            req = req.header("x-syno-token", token);
        }

        let resp = req.form(&all_params).send().await?;
        let t_send = t.elapsed();
        let status = resp.status();
        let body = resp.text().await?;
        let t_total = t.elapsed();
        eprintln!("[timing] HTTP {api_name}.{method_name}: send={t_send:?} total={t_total:?} body_len={}", body.len());
        if !status.is_success() {
            bail!("HTTP {status}: {body}");
        }
        let val: Value = serde_json::from_str(&body)?;
        Ok(val)
    }

    /// POST with _sid + x-syno-token, download binary response to a local file.
    /// Returns the number of bytes written.
    pub async fn post_download(
        &self,
        cgi_path: &str,
        sid: &str,
        synotoken: Option<&str>,
        params: &[(&str, &str)],
        dest: &Path,
    ) -> Result<u64> {
        let url = format!("{}/webapi/{}", self.base_url, cgi_path);
        let mut all_params: Vec<(&str, &str)> = params.to_vec();
        all_params.push(("_sid", sid));

        let mut req = self
            .client
            .post(&url)
            .header("content-type", "application/x-www-form-urlencoded; charset=UTF-8");

        if let Some(token) = synotoken {
            req = req.header("x-syno-token", token);
        }

        let resp = req.form(&all_params).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await?;
            bail!("HTTP {status}: {body}");
        }

        // Check content-type: if JSON, it's likely an error response
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if ct.contains("application/json") {
            let body = resp.text().await?;
            bail!("Expected file download but got JSON: {body}");
        }

        let bytes = resp.bytes().await?;
        let len = bytes.len() as u64;
        let mut file = tokio::fs::File::create(dest).await?;
        file.write_all(&bytes).await?;
        file.flush().await?;
        Ok(len)
    }

    /// POST with _sid + x-syno-token, parse into T.
    pub async fn post_api_with_sid<T: serde::de::DeserializeOwned>(
        &self,
        cgi_path: &str,
        sid: &str,
        synotoken: Option<&str>,
        params: &[(&str, &str)],
    ) -> Result<T> {
        let val = self.post_with_sid(cgi_path, sid, synotoken, params).await?;
        let resp: SynoResponse<T> = serde_json::from_value(val.clone())
            .map_err(|e| anyhow::anyhow!("Failed to parse response: {e}\nBody: {val}"))?;
        if !resp.success {
            let err = resp.error.unwrap_or(SynoError { code: -1 });
            bail!("{err}");
        }
        resp.data
            .ok_or_else(|| anyhow::anyhow!("API returned success but no data"))
    }

    /// Upload a file via multipart POST (SYNO.FileStation.Upload style).
    /// `text_parts` are string fields, `file_path` is the local file to upload.
    pub async fn post_upload(
        &self,
        cgi_path: &str,
        sid: &str,
        synotoken: Option<&str>,
        text_parts: &[(&str, &str)],
        file_path: &Path,
    ) -> Result<Value> {
        // _sid passed as query param for multipart uploads
        let url = format!("{}/webapi/{}?_sid={}", self.base_url, cgi_path, sid);

        let file_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("upload")
            .to_string();

        let file_bytes = tokio::fs::read(file_path).await?;

        let mut form = multipart::Form::new();
        for &(k, v) in text_parts {
            form = form.text(k.to_string(), v.to_string());
        }

        let file_part = multipart::Part::bytes(file_bytes)
            .file_name(file_name)
            .mime_str("application/octet-stream")?;
        form = form.part("file", file_part);

        let mut req = self.client.post(&url);
        if let Some(token) = synotoken {
            req = req.header("x-syno-token", token);
        }

        let resp = req.multipart(form).send().await?;
        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            bail!("HTTP {status}: {body}");
        }
        let val: Value = serde_json::from_str(&body)?;
        Ok(val)
    }
}
