use crate::gateway::identity::{DeviceAuth, Identity};
use openclaw_gateway_client::{ClientError, GatewayClientConfig};
use serde_json::{Map, Value, json};

use crate::gateway::{
    access::{self, Session},
    config::ConnectionConfig,
};

pub(super) fn gateway_credentials(config: &ConnectionConfig, protected: bool) -> ConnectionConfig {
    let mut current = config.clone();
    if protected {
        current.token = None;
        current.password = None;
    }
    current
}

// This projection runs for each socket admission, using the session just read
// from the state owner. Neither the transport nor a reconnect closure caches it.
pub(super) fn upgrade_headers<'a>(
    url: &str,
    session: Option<&'a Session>,
    now: f64,
) -> Result<Vec<(&'static str, &'a str)>, String> {
    match session {
        Some(session) => session
            .authorization_header(url, now)
            .map(|token| vec![("Cf-Access-Token", token)])
            .ok_or_else(|| "Cloudflare Access authorization expired. Sign in again.".into()),
        None => Ok(Vec::new()),
    }
}

pub(super) fn transport(
    url: &str,
    session: Option<&Session>,
) -> Result<GatewayClientConfig, String> {
    let mut transport = GatewayClientConfig::new(url).map_err(|error| error.to_string())?;
    for (name, value) in upgrade_headers(url, session, access::now())? {
        transport = transport
            .header(name, value)
            .map_err(|_| "The sign-in token cannot be sent safely")?;
    }
    Ok(transport)
}

pub(super) fn identity_proxy_rejection(error: &ClientError) -> bool {
    // tungstenite 0.30 Error::Http displays precisely this status line. The
    // shared client currently retains that text but discards response headers.
    if let ClientError::Transport(message) = error {
        return matches!(
            message.as_str(),
            "HTTP error: 401 Unauthorized" | "HTTP error: 403 Forbidden"
        );
    }
    let ClientError::Gateway {
        method,
        details: Some(details),
        ..
    } = error
    else {
        return false;
    };
    method == "connect"
        && details["reason"].as_str() == Some("websocket-upgrade-rejected")
        && matches!(
            details["httpStatus"].as_u64(),
            Some(301 | 302 | 303 | 307 | 308 | 401 | 403)
        )
}

pub(super) fn connect_params(
    config: &ConnectionConfig,
    identity: &Identity,
    token_key: &str,
    instance_id: &str,
    nonce: &str,
    signed_at: u64,
) -> Result<Value, String> {
    let client_id = if cfg!(target_os = "macos") {
        "openclaw-macos"
    } else {
        "openclaw-linux"
    };
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let scopes = [
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.questions",
        "operator.admin",
    ];
    let device_token = identity.device_token(token_key);
    let signature_token = config.token.as_deref().or(device_token).unwrap_or_default();
    let device = identity.proof(DeviceAuth {
        device_id: "",
        client_id,
        scopes: &scopes,
        signed_at,
        token: signature_token,
        nonce,
        platform,
        device_family: "",
    })?;
    let mut auth = Map::new();
    for (name, value) in [
        ("token", config.token.as_deref()),
        ("password", config.password.as_deref()),
        ("deviceToken", device_token),
    ] {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            auth.insert(name.into(), Value::String(value.into()));
        }
    }
    let mut params = json!({
        "minProtocol": 4,
        "maxProtocol": 4,
        "client": { "id": client_id, "version": env!("CARGO_PKG_VERSION"), "platform": platform,
            "mode": "ui", "displayName": "OpenClaw GPUI", "instanceId": instance_id },
        "role": "operator", "scopes": scopes, "caps": [], "device": device,
        "locale": std::env::var("LANG").ok().and_then(|language| language.split('.').next().map(|language| language.replace('_', "-"))).unwrap_or_else(|| "en-US".into()),
        "userAgent": concat!("openclaw-gpui/", env!("CARGO_PKG_VERSION")),
    });
    if !auth.is_empty() {
        params["auth"] = Value::Object(auth);
    }
    Ok(params)
}

pub(super) fn redacted_error(
    error: &ClientError,
    config: &ConnectionConfig,
    identity: &Identity,
    token_key: &str,
) -> String {
    redact(error.to_string(), config, identity, token_key)
}

pub(super) fn redact(
    mut message: String,
    config: &ConnectionConfig,
    identity: &Identity,
    token_key: &str,
) -> String {
    let origin = access::origin(&config.url).ok();
    let access_token = origin
        .as_deref()
        .and_then(|origin| identity.access_session(origin))
        .map(|session| session.token.as_str());
    for secret in [
        access_token,
        config.token.as_deref(),
        config.password.as_deref(),
        identity.device_token(token_key),
    ]
    .into_iter()
    .flatten()
    {
        if !secret.is_empty() {
            message = message.replace(secret, "<redacted>");
        }
    }
    message
}

#[cfg(test)]
mod tests {
    use super::super::{AccessChange, Authority, Command, Connection, Lifetime, access_changed};
    use super::*;
    use crate::gateway::identity::Identity;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signature, SigningKey, Verifier};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn stored_session(subject: &str, expires_at: f64) -> Session {
        let issuer = "https://fixture.cloudflareaccess.com";
        let claims = json!({"iss": issuer, "aud": ["fixture-audience"], "sub": subject, "type": "app", "exp": expires_at});
        Session {
            application: access::Application {
                origin: "https://gateway.example".into(),
                audience: "fixture-audience".into(),
                issuer: issuer.into(),
            },
            subject: subject.into(),
            email: None,
            expires_at,
            // Stored grants have already passed signature verification. This
            // test exercises reconnect projection and claim/expiry admission.
            token: format!(
                "{}.{}.{}",
                URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","kid":"fixture"}"#),
                URL_SAFE_NO_PAD.encode(claims.to_string()),
                URL_SAFE_NO_PAD.encode([1; 256])
            ),
        }
    }

    #[test]
    fn reconnect_projects_the_current_session_and_rejects_expired_or_cross_origin_grants() {
        let first = stored_session("first", 2_000_000_000.0);
        let refreshed = stored_session("second", 2_000_000_100.0);
        let url = "wss://gateway.example/";
        assert_eq!(
            upgrade_headers(url, Some(&first), 1_900_000_000.0).unwrap(),
            vec![("Cf-Access-Token", first.token.as_str())]
        );
        assert_eq!(
            upgrade_headers(url, Some(&refreshed), 1_900_000_000.0).unwrap(),
            vec![("Cf-Access-Token", refreshed.token.as_str())]
        );
        assert!(upgrade_headers(url, Some(&first), first.expires_at).is_err());
        assert!(upgrade_headers("wss://other.example/", Some(&first), 1_900_000_000.0).is_err());
        assert!(upgrade_headers("ws://gateway.example/", Some(&first), 1_900_000_000.0).is_err());
        assert!(
            upgrade_headers(url, None, 1_900_000_000.0)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn identity_proxy_classification_requires_recognized_upgrade_evidence() {
        for (method, reason, status, expected) in [
            ("connect", "websocket-upgrade-rejected", 302, true),
            ("connect", "websocket-upgrade-rejected", 401, true),
            ("connect", "websocket-upgrade-rejected", 403, true),
            ("connect", "websocket-upgrade-rejected", 500, false),
            ("connect", "PAIRING_REQUIRED", 403, false),
            ("chat.send", "websocket-upgrade-rejected", 403, false),
        ] {
            let error = ClientError::Gateway {
                method: method.into(),
                code: "UNAVAILABLE".into(),
                message: "fixture".into(),
                details: Some(json!({"reason": reason, "httpStatus": status})),
                retryable: None,
                retry_after_ms: None,
            };
            assert_eq!(identity_proxy_rejection(&error), expected);
        }
        for text in ["HTTP error: 401 Unauthorized", "HTTP error: 403 Forbidden"] {
            assert!(identity_proxy_rejection(&ClientError::Transport(
                text.into()
            )));
        }
        for text in [
            "HTTP error: 302 Found",
            "HTTP error: 500 Internal Server Error",
            "connection reset: 403 Forbidden",
        ] {
            assert!(!identity_proxy_rejection(&ClientError::Transport(
                text.into()
            )));
        }
    }
    #[test]
    fn proxy_connect_keeps_app_device_identity_without_sending_shared_or_edge_credentials() {
        let original = ConnectionConfig {
            url: "wss://gateway.example/".into(),
            token: Some("shared-secret".into()),
            password: Some("shared-password".into()),
        };
        let config = gateway_credentials(&original, true);
        let mut identity: Identity =
            serde_json::from_value(json!({"secret_key": URL_SAFE_NO_PAD.encode([7; 32])})).unwrap();
        let first = connect_params(
            &config,
            &identity,
            &config.url,
            "window-one",
            "challenge",
            123,
        )
        .unwrap();
        assert!(first.get("auth").is_none());
        let tokens = json!({"wss://gateway.example/": "issued-device-token"});
        identity = serde_json::from_value(
            json!({"secret_key": URL_SAFE_NO_PAD.encode([7; 32]), "device_tokens": tokens}),
        )
        .unwrap();
        let reconnect = connect_params(
            &config,
            &identity,
            &config.url,
            "window-one",
            "challenge",
            123,
        )
        .unwrap();
        assert_eq!(
            reconnect["auth"],
            json!({"deviceToken": "issued-device-token"})
        );
        assert_eq!(reconnect["client"]["mode"], "ui");
        assert_eq!(reconnect["role"], "operator");
        for (params, token) in [(&first, ""), (&reconnect, "issued-device-token")] {
            let expected = format!(
                "v3|{}|{}|ui|operator|operator.read,operator.write,operator.approvals,operator.questions,operator.admin|123|{}|challenge|{}|",
                params["device"]["id"].as_str().unwrap(),
                params["client"]["id"].as_str().unwrap(),
                token,
                params["client"]["platform"].as_str().unwrap()
            );
            let signature = Signature::from_slice(
                &URL_SAFE_NO_PAD
                    .decode(params["device"]["signature"].as_str().unwrap())
                    .unwrap(),
            )
            .unwrap();
            SigningKey::from_bytes(&[7; 32])
                .verifying_key()
                .verify(expected.as_bytes(), &signature)
                .unwrap();
            assert!(!params.to_string().contains("shared-secret"));
            assert!(!params.to_string().contains("shared-password"));
        }
        assert_eq!(gateway_credentials(&original, false), original);
    }

    #[test]
    fn retired_authorization_cannot_commit_a_late_browser_result() {
        let lifetime = Arc::new(Mutex::new(Lifetime::default()));
        let (stop, canceled) = tokio::sync::watch::channel(false);
        let (commands, _instructions) = tokio::sync::watch::channel(Command::Idle);
        let connection = Connection {
            stop,
            commands,
            lifetime: lifetime.clone(),
        };
        let first = Authority {
            lifetime: lifetime.clone(),
            revision: 0,
        };
        assert!(first.write(|| Ok(())).is_ok());
        connection.sign_out();
        let mut committed = false;
        assert!(
            first
                .write(|| {
                    committed = true;
                    Ok(())
                })
                .is_err()
        );
        assert!(!committed);
        let current = Authority {
            lifetime: lifetime.clone(),
            revision: 1,
        };
        assert!(current.current());
        drop(connection);
        assert!(*canceled.borrow());
        assert!(
            current
                .write(|| {
                    committed = true;
                    Ok(())
                })
                .is_err()
        );
        assert!(!committed);
    }

    #[test]
    fn ssh_profile_handshakes_and_errors_use_the_profile_token_not_a_loopback_neighbor() {
        let first = crate::gateway::profiles::GatewayProfile {
            id: "first".into(),
            name: "First".into(),
            kind: crate::gateway::profiles::GatewayKind::Ssh {
                target: "operator@first.example".into(),
                remote_port: 19471,
                identity_file: None,
            },
            order: 0,
        };
        let second = crate::gateway::profiles::GatewayProfile {
            id: "second".into(),
            ..first.clone()
        };
        let first_key = first.device_token_key();
        let second_key = second.device_token_key();
        let canonical = first.canonical_url();
        let identity: Identity = serde_json::from_value(json!({
            "secret_key": URL_SAFE_NO_PAD.encode([7; 32]),
            "device_tokens": {
                (first_key.clone()): "first-pairing",
                (second_key.clone()): "second-pairing",
                (canonical.clone()): "local-gateway-pairing",
                "ws://127.0.0.1:49152/": "old-tunnel-pairing"
            }
        }))
        .unwrap();
        let config = ConnectionConfig {
            url: canonical,
            token: None,
            password: None,
        };
        for (key, instance, expected) in [
            (&first_key, "first-window", "first-pairing"),
            (&second_key, "second-window", "second-pairing"),
        ] {
            let params =
                connect_params(&config, &identity, key, instance, "challenge", 123).unwrap();
            assert_eq!(params["auth"], json!({"deviceToken": expected}));
            assert_eq!(params["client"]["instanceId"], instance);
            assert_eq!(
                redact(format!("Rejected {expected}"), &config, &identity, key),
                "Rejected <redacted>"
            );
        }
    }

    #[tokio::test]
    async fn access_changes_wake_only_sibling_origins_and_reconcile_overflow() {
        use futures_util::FutureExt;
        let (changes, mut receiver) = tokio::sync::broadcast::channel(2);
        let own_origin = "https://gateway.example";
        for (origin, instance_id) in [
            (own_origin, "this-window"),
            ("https://other.example", "other-window"),
        ] {
            changes
                .send(AccessChange {
                    origin: origin.into(),
                    instance_id: instance_id.into(),
                })
                .unwrap();
            assert!(
                access_changed(&mut receiver, Some(own_origin), "this-window")
                    .now_or_never()
                    .is_none()
            );
        }
        changes
            .send(AccessChange {
                origin: own_origin.into(),
                instance_id: "sibling-window".into(),
            })
            .unwrap();
        assert!(
            access_changed(&mut receiver, Some(own_origin), "this-window")
                .now_or_never()
                .is_some()
        );
        for _ in 0..3 {
            changes
                .send(AccessChange {
                    origin: "https://other.example".into(),
                    instance_id: "other-window".into(),
                })
                .unwrap();
        }
        assert!(
            access_changed(&mut receiver, Some(own_origin), "this-window")
                .now_or_never()
                .is_some()
        );
    }
}
