use crate::{
    gateway::access,
    model::{avatars::MAX_AVATAR_BYTES, web_urls::WebAuth},
};
use gpui_kit::ImageFormat;
use std::time::Duration;

pub(super) async fn download_avatar(
    url: &str,
    auth: &WebAuth,
    device_token: Option<&str>,
) -> Option<(ImageFormat, Vec<u8>)> {
    if !auth.trusts(url) {
        return None;
    }
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let mut credentials: Vec<_> = [
        device_token,
        auth.token.as_deref(),
        auth.password.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter(|token| !token.is_empty())
    .collect();
    credentials.dedup();
    if credentials.is_empty() {
        credentials.push("");
    }
    for retry in 0..=3 {
        let mut retry_after = None;
        for credential in &credentials {
            let mut request = http.get(url).header("Accept", "image/*");
            if !credential.is_empty() {
                request = request.bearer_auth(credential);
            }
            if let Some(token) = auth
                .access_session
                .as_ref()
                .and_then(|session| session.authorization_header(url, access::now()))
            {
                request = request.header("Cf-Access-Token", token);
            }
            let mut response = request.send().await.ok()?;
            let status = response.status();
            if matches!(status.as_u16(), 401 | 403) {
                continue;
            }
            if status.as_u16() == 503 {
                retry_after = response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .filter(|seconds| (1..=30).contains(seconds));
                break;
            }
            if !status.is_success()
                || response
                    .content_length()
                    .is_some_and(|size| size > MAX_AVATAR_BYTES as u64)
            {
                return None;
            }
            let mime = response
                .headers()
                .get("content-type")?
                .to_str()
                .ok()?
                .split(';')
                .next()?
                .trim();
            let format = ImageFormat::from_mime_type(mime)?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.ok()? {
                if bytes.len() + chunk.len() > MAX_AVATAR_BYTES {
                    return None;
                }
                bytes.extend(chunk);
            }
            return Some((format, bytes));
        }
        if retry == 3 {
            return None;
        }
        tokio::time::sleep(Duration::from_secs(retry_after?)).await;
    }
    None
}
