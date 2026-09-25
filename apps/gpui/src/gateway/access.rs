//! Cloudflare Access's signed discovery and encrypted native-app token transfer.
//! The wire contract is shared with the iOS and Android CloudflareAccess clients.

use std::{
    fmt,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE},
};
use crypto_box::{PublicKey, SalsaBox, SecretKey, aead::Aead};
use percent_encoding::percent_decode_str;
use rand::rngs::OsRng;
use reqwest::{Client, RequestBuilder, Response, header::HeaderMap};
use serde::{Deserialize, Serialize};
use url::Url;
use zeroize::Zeroizing;

mod jwt;

use jwt::{Claims, app_claims, metadata_application, validate_application, verify_jwt};

const INVALID_GATEWAY: &str =
    "Enter an HTTPS gateway address without credentials, a query, or a fragment.";
const INVALID_APPLICATION: &str = "This Gateway did not provide valid Cloudflare Access sign-in details. Contact its administrator.";
const CONNECTION_FAILED: &str =
    "Could not reach the Gateway's sign-in service. Check your connection and try again.";
const LOGIN_FAILED: &str = "Browser sign-in did not complete. Check that your account can access this Gateway and try again.";
const TIMED_OUT: &str = "Browser sign-in timed out. Start sign-in again to continue.";
const INVALID_SESSION: &str =
    "The Cloudflare Access session could not be verified or has expired. Sign in again.";
const USER_AGENT: &str = "OpenClaw CloudflareAccess (cloudflared/2026.8.3)";
const MAX_RESPONSE: usize = 1_048_576;
const MAX_TRANSFER: usize = 131_072;
const MAX_TOKEN: usize = 32_768;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Application {
    pub origin: String,
    pub audience: String,
    pub issuer: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub application: Application,
    pub subject: String,
    pub email: Option<String>,
    pub token: String,
    pub expires_at: f64,
}

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CloudflareAccessSession(<redacted>)")
    }
}

impl Session {
    // Stored grants were signature-verified on admission, just as on mobile.
    // Recheck their claims and authority before publishing them after restart.
    pub fn is_valid(&self, now: f64) -> bool {
        origin(&self.application.origin).is_ok_and(|value| value == self.application.origin)
            && app_claims(&self.token, &self.application, now)
                .is_ok_and(|claims| claims.sub == self.subject && claims.exp == self.expires_at)
    }

    pub fn authorization_header(&self, url: &str, now: f64) -> Option<&str> {
        (contains(&self.application.origin, url) && self.is_valid(now))
            .then_some(self.token.as_str())
    }
}

pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

pub fn origin(value: &str) -> Result<String, String> {
    let authority = value
        .split_once("://")
        .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or_default());
    let mut url = Url::parse(value).map_err(|_| INVALID_GATEWAY)?;
    if value.len() > 4096
        || authority.is_none_or(|authority| authority.is_empty() || authority.contains('@'))
        || !matches!(url.scheme(), "https" | "wss")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port() == Some(0)
        || value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte == b'\\')
    {
        return Err(INVALID_GATEWAY.into());
    }
    url.set_scheme("https").map_err(|_| INVALID_GATEWAY)?;
    url.set_path("");
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn contains(expected: &str, value: &str) -> bool {
    if value
        .bytes()
        .any(|byte| byte.is_ascii_whitespace() || byte == b'\\')
        || value.split_once("://").is_none_or(|(_, rest)| {
            rest.split(['/', '?', '#'])
                .next()
                .is_none_or(|authority| authority.is_empty() || authority.contains('@'))
        })
    {
        return false;
    }
    let Ok(mut url) = Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return false;
    }
    url.set_query(None);
    origin(url.as_str()).is_ok_and(|value| value == expected)
}

#[derive(Clone)]
pub struct AccessClient {
    http: Client,
}

impl AccessClient {
    pub fn new() -> Result<Self, String> {
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            // Cookie support is not compiled in. Only get-identity gets one explicit cookie.
            .build()
            .map_err(|_| CONNECTION_FAILED)?;
        Ok(Self { http })
    }

    pub async fn discover(&self, gateway_url: &str) -> Result<Option<Application>, String> {
        let expected = origin(gateway_url)?;
        let mut url = Url::parse(gateway_url).map_err(|_| INVALID_GATEWAY)?;
        url.set_scheme("https").map_err(|_| INVALID_GATEWAY)?;
        let response = send(self.http.get(url.clone())).await?;
        if !is_challenge(
            response.url().as_str(),
            response.status().as_u16(),
            response.headers(),
            &expected,
        ) {
            return Ok(None);
        }
        drop(response);
        let response = send(
            self.http
                .head(url)
                .header("Cf-Access-Metadata-Request", "true")
                .header("User-Agent", USER_AGENT),
        )
        .await?;
        if response.status() != 200 {
            return Err(INVALID_APPLICATION.into());
        }
        let token = response
            .headers()
            .get("Cf-Access-Metadata")
            .and_then(|value| value.to_str().ok())
            .ok_or(INVALID_APPLICATION)?
            .to_owned();
        drop(response);
        let application =
            metadata_application(&token, &expected, now()).map_err(|_| INVALID_APPLICATION)?;
        let keys = self.keys(&application).await?;
        verify_jwt(&token, &keys).map_err(|_| INVALID_APPLICATION)?;
        Ok(Some(application))
    }

    pub fn prepare_sign_in(&self, application: &Application) -> Result<Transfer, String> {
        validate_application(application)?;
        let secret = EphemeralSecret(Box::new(SecretKey::generate(&mut OsRng)));
        let public = URL_SAFE.encode(secret.0.public_key().as_bytes());
        let browser_url = browser_url(application, &public)?;
        Ok(Transfer {
            secret,
            public,
            browser_url,
            application: application.clone(),
        })
    }

    pub async fn session_rejected(
        &self,
        gateway_url: &str,
        session: &Session,
    ) -> Result<bool, String> {
        let expected = origin(gateway_url)?;
        let Some(token) = session.authorization_header(gateway_url, now()) else {
            return Ok(true);
        };
        let mut url = Url::parse(gateway_url).map_err(|_| INVALID_GATEWAY)?;
        url.set_scheme("https").map_err(|_| INVALID_GATEWAY)?;
        let response = send(self.http.get(url).header("Cf-Access-Token", token)).await?;
        Ok(matches!(response.status().as_u16(), 401 | 403)
            || is_challenge(
                response.url().as_str(),
                response.status().as_u16(),
                response.headers(),
                &expected,
            ))
    }

    /// Dropping this future cancels polling and drops the zeroizing ephemeral key.
    pub async fn sign_in(
        &self,
        application: &Application,
        transfer: Transfer,
    ) -> Result<Session, String> {
        if transfer.application != *application {
            return Err(INVALID_APPLICATION.into());
        }
        tokio::time::timeout(Duration::from_secs(300), async {
            let url = format!(
                "https://login.cloudflareaccess.org/transfer/{}",
                transfer.public
            );
            for _ in 0..10 {
                let response = send(
                    self.http
                        .get(&url)
                        .header("User-Agent", USER_AGENT)
                        .timeout(Duration::from_secs(60)),
                )
                .await?;
                let status = response.status().as_u16();
                let peer = response
                    .headers()
                    .get("service-public-key")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                let bytes = body(response, MAX_TRANSFER).await?;
                if status == 200 && !bytes.is_empty() {
                    let token = app_token(
                        &bytes,
                        peer.as_deref().ok_or(LOGIN_FAILED)?,
                        &transfer.secret.0,
                    )?;
                    return self.verified_session(token, application).await;
                }
                if !(status < 300 || (400..500).contains(&status)) {
                    return Err(LOGIN_FAILED.into());
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Err(TIMED_OUT.into())
        })
        .await
        .map_err(|_| TIMED_OUT.to_owned())?
    }

    async fn keys(&self, application: &Application) -> Result<Vec<u8>, String> {
        validate_application(application)?;
        let response = send(
            self.http
                .get(format!("{}/cdn-cgi/access/certs", application.issuer)),
        )
        .await?;
        if response.status() != 200 {
            return Err(INVALID_APPLICATION.into());
        }
        body(response, MAX_RESPONSE).await
    }

    async fn verified_session(
        &self,
        token: String,
        application: &Application,
    ) -> Result<Session, String> {
        verify_jwt(&token, &self.keys(application).await?)?;
        let claims = app_claims(&token, application, now())?;
        let response = send(
            self.http
                .get(format!(
                    "{}/cdn-cgi/access/get-identity",
                    application.origin
                ))
                .header("Cookie", format!("CF_Authorization={token}")),
        )
        .await?;
        if response.status() != 200 {
            return Err(INVALID_SESSION.into());
        }
        let bytes = body(response, MAX_RESPONSE).await?;
        session_from_identity(token, application, claims, &bytes)
    }
}

async fn send(builder: RequestBuilder) -> Result<Response, String> {
    let (client, request) = builder.build_split();
    let request = request.map_err(|_| CONNECTION_FAILED)?;
    let expected = request.url().clone();
    // Do not include reqwest's error text: URLs can carry an ephemeral transfer key.
    let response = client
        .execute(request)
        .await
        .map_err(|_| CONNECTION_FAILED)?;
    if *response.url() != expected {
        return Err(CONNECTION_FAILED.into());
    }
    Ok(response)
}

async fn body(mut response: Response, maximum: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > maximum as u64)
    {
        return Err(CONNECTION_FAILED.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| CONNECTION_FAILED)? {
        if chunk.len() > maximum.saturating_sub(bytes.len()) {
            return Err(CONNECTION_FAILED.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub struct Transfer {
    secret: EphemeralSecret,
    public: String,
    browser_url: String,
    application: Application,
}

struct EphemeralSecret(Box<SecretKey>);

impl Drop for EphemeralSecret {
    fn drop(&mut self) {
        // crypto_box 0.9 erases its scalar but retains the source byte array.
        // Replace the entire key in its stable allocation with public zero key
        // material before the dependency's destructor runs. SecretKey contains
        // only inline bytes/scalar, so no owned resource is skipped here.
        // SAFETY: this exclusively borrowed, initialized allocation remains a
        // valid SecretKey; volatile prevents elimination of the overwrite.
        unsafe { std::ptr::write_volatile(&mut *self.0, SecretKey::from([0; 32])) };
    }
}

impl Transfer {
    pub fn browser_url(&self) -> &str {
        &self.browser_url
    }
}

fn browser_url(application: &Application, public: &str) -> Result<String, String> {
    let mut redirect = Url::parse(&application.origin).map_err(|_| INVALID_APPLICATION)?;
    redirect
        .query_pairs_mut()
        .append_pair("token", public)
        .append_pair("aud", &application.audience);
    let mut browser = redirect.clone();
    browser.set_path("/cdn-cgi/access/cli");
    browser
        .query_pairs_mut()
        .append_pair("redirect_url", redirect.as_str())
        .append_pair("send_org_token", "true")
        .append_pair("edge_token_transfer", "true")
        .append_pair("close_interstitial", "true");
    Ok(browser.into())
}

fn app_token(body: &[u8], service_public_key: &str, secret: &SecretKey) -> Result<String, String> {
    if body.len() > MAX_TRANSFER || service_public_key.len() != 44 {
        return Err(LOGIN_FAILED.into());
    }
    // The body is standard padded base64, but the peer key is padded base64url.
    let envelope = STANDARD.decode(body).map_err(|_| LOGIN_FAILED)?;
    let peer: [u8; 32] = URL_SAFE
        .decode(service_public_key)
        .map_err(|_| LOGIN_FAILED)?
        .try_into()
        .map_err(|_| LOGIN_FAILED)?;
    if envelope.len() < 40 {
        return Err(LOGIN_FAILED.into());
    }
    let cipher = SalsaBox::new(&PublicKey::from(peer), secret);
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(envelope[..24].into(), &envelope[24..])
            .map_err(|_| LOGIN_FAILED)?,
    );
    #[derive(Deserialize)]
    struct Payload {
        app_token: String,
    }
    // Unknown fields (including the organization token) are skipped by serde.
    let payload: Payload = serde_json::from_slice(&plaintext).map_err(|_| LOGIN_FAILED)?;
    if payload.app_token.is_empty() || payload.app_token.len() > MAX_TOKEN {
        return Err(LOGIN_FAILED.into());
    }
    Ok(payload.app_token)
}

pub fn is_challenge(
    response_url: &str,
    status: u16,
    headers: &HeaderMap,
    expected_origin: &str,
) -> bool {
    if !contains(expected_origin, response_url) {
        return false;
    }
    if status == 302
        && headers
            .get("Location")
            .and_then(|value| value.to_str().ok())
            .and_then(|location| redirect_path(response_url, location))
            .is_some_and(|path| path.starts_with("/cdn-cgi/access/login"))
    {
        return true;
    }
    if !matches!(status, 301 | 302 | 303 | 307 | 308 | 401 | 403) {
        return false;
    }
    let Some(header) = headers
        .get("WWW-Authenticate")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 8192)
    else {
        return false;
    };
    let Some((scheme, parameters)) = header.split_once(char::is_whitespace) else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("cloudflare-access") && !scheme.eq_ignore_ascii_case("bearer") {
        return false;
    }
    let metadata = parameters
        .match_indices("resource_metadata")
        .find_map(|(offset, _)| {
            if offset > 0
                && !parameters.as_bytes()[offset - 1].is_ascii_whitespace()
                && parameters.as_bytes()[offset - 1] != b','
            {
                return None;
            }
            let rest = parameters[offset + "resource_metadata".len()..]
                .trim_start()
                .strip_prefix('=')?
                .trim_start()
                .strip_prefix('"')?;
            let end = rest.find('"')?;
            (end > 0).then_some(&rest[..end])
        });
    let Some(metadata) = metadata.filter(|value| contains(expected_origin, value)) else {
        return false;
    };
    let Ok(url) = Url::parse(metadata) else {
        return false;
    };
    let path = percent_decode_str(url.path()).decode_utf8_lossy();
    let namespace = "/.well-known/cloudflare-access-protected-resource";
    url.scheme() == "https"
        && url.query().is_none()
        && (path == namespace || path.starts_with(&format!("{namespace}/")))
}

fn redirect_path(base: &str, reference: &str) -> Option<String> {
    if reference.is_empty()
        || reference
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte == b' ' || byte == b'\\')
    {
        return None;
    }
    let bytes = reference.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'%'
            && (index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit())
        {
            return None;
        }
    }
    let base = Url::parse(base).ok()?;
    if !reference.starts_with("///") {
        base.join(reference).ok()?;
    }
    let reference = reference.split(['?', '#']).next()?;
    // Resolve literal dots before percent decoding, preserving empty segments.
    // WHATWG URL joining would normalize encoded dots and triple slashes differently.
    let raw = if reference.starts_with("///") {
        reference
    } else if let Some((scheme, rest)) = reference.split_once("://") {
        if scheme.is_empty() {
            return None;
        }
        rest.find('/').map_or("", |index| &rest[index..])
    } else if let Some(rest) = reference.strip_prefix("//") {
        rest.find('/').map_or("", |index| &rest[index..])
    } else {
        reference
    };
    let path = if raw.starts_with('/') {
        raw.to_owned()
    } else if raw.is_empty() {
        base.path().to_owned()
    } else {
        format!(
            "{}/{}",
            base.path()
                .rsplit_once('/')
                .map_or("", |(prefix, _)| prefix),
            raw
        )
    };
    let mut segments = Vec::new();
    for segment in path.split('/').skip(1) {
        match segment {
            "." => {}
            ".." => {
                segments.pop();
            }
            _ => segments.push(segment),
        }
    }
    if path.ends_with("/.") || path.ends_with("/..") {
        segments.push("");
    }
    percent_decode_str(&format!("/{}", segments.join("/")))
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

fn session_from_identity(
    token: String,
    application: &Application,
    claims: Claims,
    bytes: &[u8],
) -> Result<Session, String> {
    #[derive(Deserialize)]
    struct Identity {
        user_uuid: String,
        email: Option<String>,
    }
    let identity: Identity = serde_json::from_slice(bytes).map_err(|_| INVALID_SESSION)?;
    if identity.user_uuid != claims.sub {
        return Err(INVALID_SESSION.into());
    }
    Ok(Session {
        application: application.clone(),
        subject: claims.sub,
        email: identity.email.filter(|value| !value.is_empty()),
        token,
        expires_at: claims.exp,
    })
}

#[cfg(test)]
mod tests;
