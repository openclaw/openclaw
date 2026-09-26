use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rsa::{BigUint, Pkcs1v15Sign, RsaPublicKey};
use serde::{Deserialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use url::Url;

use super::{Application, INVALID_APPLICATION, INVALID_SESSION, MAX_TOKEN, origin};

pub(super) fn issuer(domain: &str) -> Result<String, String> {
    let host = domain.to_ascii_lowercase();
    let Some(team) = host.strip_suffix(".cloudflareaccess.com") else {
        return Err(INVALID_APPLICATION.into());
    };
    if team.is_empty()
        || team.len() > 63
        || team.starts_with('-')
        || team.ends_with('-')
        || !team
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(INVALID_APPLICATION.into());
    }
    Ok(format!("https://{host}"))
}

pub(super) fn validate_application(application: &Application) -> Result<(), String> {
    let parsed = Url::parse(&application.issuer).map_err(|_| INVALID_APPLICATION)?;
    if issuer(parsed.host_str().ok_or(INVALID_APPLICATION)?)? != application.issuer
        || origin(&application.origin)? != application.origin
        || application.audience.is_empty()
        || application.audience.len() > 512
    {
        return Err(INVALID_APPLICATION.into());
    }
    Ok(())
}

#[derive(Deserialize)]
struct Metadata {
    #[serde(rename = "type")]
    kind: String,
    hostname: String,
    auth_domain: String,
    aud: String,
    iat: f64,
}

pub(super) fn metadata_application(
    token: &str,
    expected_origin: &str,
    now: f64,
) -> Result<Application, String> {
    let metadata: Metadata = decode(token)?;
    let parsed = Url::parse(expected_origin).map_err(|_| INVALID_APPLICATION)?;
    if metadata.kind != "match"
        || Some(metadata.hostname.to_ascii_lowercase().as_str()) != parsed.host_str()
        || metadata.aud.is_empty()
        || metadata.aud.len() > 512
        || !metadata.iat.is_finite()
        || metadata.iat <= 0.0
        || metadata.iat < now - 86400.0
        || metadata.iat > now + 300.0
    {
        return Err(INVALID_APPLICATION.into());
    }
    Ok(Application {
        origin: expected_origin.into(),
        issuer: issuer(&metadata.auth_domain)?,
        audience: metadata.aud,
    })
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize)]
pub(super) struct Claims {
    iss: String,
    aud: Audience,
    #[serde(rename = "type")]
    kind: String,
    pub(super) sub: String,
    pub(super) exp: f64,
    nbf: Option<f64>,
}

pub(super) fn app_claims(
    token: &str,
    application: &Application,
    now: f64,
) -> Result<Claims, String> {
    validate_application(application).map_err(|_| INVALID_SESSION)?;
    let claims: Claims = decode(token)?;
    let audience_matches = match &claims.aud {
        Audience::One(value) => value == &application.audience,
        Audience::Many(values) => values.len() <= 16 && values.contains(&application.audience),
    };
    if claims.iss != application.issuer
        || !audience_matches
        || claims.kind != "app"
        || claims.sub.is_empty()
        || claims.sub.len() > 512
        || !claims.exp.is_finite()
        || claims.exp <= now
        || claims
            .nbf
            .is_some_and(|value| !value.is_finite() || value > now)
    {
        return Err(INVALID_SESSION.into());
    }
    Ok(claims)
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: String,
    crit: Option<Vec<String>>,
}

fn parts(token: &str) -> Result<([&str; 3], Header), String> {
    if token.len() > MAX_TOKEN {
        return Err(INVALID_SESSION.into());
    }
    let parts: [&str; 3] = token
        .split('.')
        .collect::<Vec<_>>()
        .try_into()
        .map_err(|_| INVALID_SESSION)?;
    let header: Header =
        serde_json::from_slice(&base64url(parts[0])?).map_err(|_| INVALID_SESSION)?;
    if header.alg != "RS256"
        || header.kid.is_empty()
        || header.kid.len() > 512
        || header.crit.as_ref().is_some_and(|value| !value.is_empty())
    {
        return Err(INVALID_SESSION.into());
    }
    Ok((parts, header))
}

fn base64url(value: &str) -> Result<Vec<u8>, String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(INVALID_SESSION.into());
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| INVALID_SESSION.into())
}

fn decode<T: DeserializeOwned>(token: &str) -> Result<T, String> {
    let (parts, _) = parts(token)?;
    serde_json::from_slice(&base64url(parts[1])?).map_err(|_| INVALID_SESSION.into())
}

pub(super) fn verify_jwt(token: &str, jwks: &[u8]) -> Result<(), String> {
    #[derive(Deserialize)]
    struct Key {
        kty: String,
        kid: Option<String>,
        alg: Option<String>,
        r#use: Option<String>,
        n: Option<String>,
        e: Option<String>,
    }
    #[derive(Deserialize)]
    struct Keys {
        keys: Vec<Key>,
    }
    let (parts, header) = parts(token)?;
    let keys: Keys = serde_json::from_slice(jwks).map_err(|_| INVALID_SESSION)?;
    if keys.keys.len() > 64 {
        return Err(INVALID_SESSION.into());
    }
    let key = keys
        .keys
        .iter()
        .find(|key| {
            key.kid.as_deref() == Some(&header.kid)
                && key.kty == "RSA"
                && key.alg.as_deref().is_none_or(|alg| alg == "RS256")
                && key.r#use.as_deref().is_none_or(|usage| usage == "sig")
        })
        .ok_or(INVALID_SESSION)?;
    let n = base64url(key.n.as_deref().ok_or(INVALID_SESSION)?)?;
    let e = base64url(key.e.as_deref().ok_or(INVALID_SESSION)?)?;
    if !(256..=1024).contains(&n.len()) || !(1..=8).contains(&e.len()) {
        return Err(INVALID_SESSION.into());
    }
    let key = RsaPublicKey::new_with_max_size(
        BigUint::from_bytes_be(&n),
        BigUint::from_bytes_be(&e),
        8192,
    )
    .map_err(|_| INVALID_SESSION)?;
    let digest = Sha256::digest(format!("{}.{}", parts[0], parts[1]).as_bytes());
    key.verify(
        Pkcs1v15Sign::new::<Sha256>(),
        &digest,
        &base64url(parts[2])?,
    )
    .map_err(|_| INVALID_SESSION.into())
}
