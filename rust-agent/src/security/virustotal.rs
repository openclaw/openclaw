use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use base64::Engine;
use reqwest::header::HeaderValue;
use reqwest::{Client, StatusCode};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::Config;

pub struct ThreatVerdict {
    pub risk: u8,
    pub reason: String,
    pub tag: String,
}

pub struct VirusTotalClient {
    client: Client,
}

impl VirusTotalClient {
    pub fn from_config(cfg: &Config) -> Result<Option<Self>> {
        let Some(api_key) = cfg.security.virustotal_api_key.clone() else {
            return Ok(None);
        };
        if api_key.trim().is_empty() {
            return Ok(None);
        }

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-apikey", HeaderValue::from_str(&api_key)?);
        let client = Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_millis(
                cfg.security.virustotal_timeout_ms.max(500),
            ))
            .build()?;
        Ok(Some(Self { client }))
    }

    pub async fn scan_url(&self, url: &str) -> Result<ThreatVerdict> {
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(url.as_bytes());
        let endpoint = format!("https://www.virustotal.com/api/v3/urls/{encoded}");
        let response = self.client.get(endpoint).send().await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(ThreatVerdict {
                risk: 10,
                reason: format!("VirusTotal has no URL history for {url}"),
                tag: "vt_url_unknown".to_owned(),
            });
        }
        if !response.status().is_success() {
            return Ok(ThreatVerdict {
                risk: 12,
                reason: format!("VirusTotal URL query failed: {}", response.status()),
                tag: "vt_url_error".to_owned(),
            });
        }
        let body = response.json::<Value>().await?;
        Ok(verdict_from_stats(body, "vt_url"))
    }

    pub async fn scan_file_path(&self, path: &str) -> Result<ThreatVerdict> {
        let p = Path::new(path);
        if !p.exists() {
            return Ok(ThreatVerdict {
                risk: 10,
                reason: format!("file does not exist for VT scan: {path}"),
                tag: "vt_file_missing".to_owned(),
            });
        }

        let bytes = tokio::fs::read(p)
            .await
            .with_context(|| format!("failed reading {path} for vt hash scan"))?;
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let hash = format!("{:x}", hasher.finalize());

        let endpoint = format!("https://www.virustotal.com/api/v3/files/{hash}");
        let response = self.client.get(endpoint).send().await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(ThreatVerdict {
                risk: 8,
                reason: format!("VirusTotal has no file history for {hash}"),
                tag: "vt_file_unknown".to_owned(),
            });
        }
        if !response.status().is_success() {
            return Ok(ThreatVerdict {
                risk: 12,
                reason: format!("VirusTotal file query failed: {}", response.status()),
                tag: "vt_file_error".to_owned(),
            });
        }
        let body = response.json::<Value>().await?;
        Ok(verdict_from_stats(body, "vt_file"))
    }
}

fn verdict_from_stats(body: Value, tag_prefix: &str) -> ThreatVerdict {
    let stats = body
        .pointer("/data/attributes/last_analysis_stats")
        .and_then(Value::as_object);

    let malicious = stats
        .and_then(|s| s.get("malicious"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let suspicious = stats
        .and_then(|s| s.get("suspicious"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let harmless = stats
        .and_then(|s| s.get("harmless"))
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let risk = if malicious > 0 {
        75
    } else if suspicious > 0 {
        45
    } else if harmless > 0 {
        0
    } else {
        10
    };
    let tag = if malicious > 0 {
        format!("{tag_prefix}_malicious")
    } else if suspicious > 0 {
        format!("{tag_prefix}_suspicious")
    } else if harmless > 0 {
        format!("{tag_prefix}_clean")
    } else {
        format!("{tag_prefix}_unknown")
    };
    let reason = format!(
        "VirusTotal stats => malicious={malicious}, suspicious={suspicious}, harmless={harmless}"
    );

    ThreatVerdict { risk, reason, tag }
}
