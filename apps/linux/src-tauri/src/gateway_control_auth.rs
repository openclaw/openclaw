//! The native operator owner signs dashboard challenges; the renderer never owns keys.
use crate::gateway_device_identity::{
    GatewayAuth, GatewayDeviceIdentity, GatewayDeviceIdentityStore, CLIENT_DEVICE_FAMILY,
    CLIENT_ID, CLIENT_MODE, CLIENT_PLATFORM,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Url;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Challenge {
    pub id: String,
    pub nonce: String,
    pub signed_at: u64,
}

impl Challenge {
    pub(crate) fn validate(&self) -> Result<(), String> {
        // The Gateway owns challenge freshness; its clock may differ from this device's.
        if self.id.is_empty()
            || self.id.len() > 128
            || self.nonce.trim().is_empty()
            || self.nonce.len() > 512
            || self.nonce.contains('|')
            || self.signed_at == 0
            || self.signed_at > 9_007_199_254_740_991
        {
            return Err("Invalid native authentication challenge.".into());
        }
        Ok(())
    }
}

pub(crate) fn initialization_script(dashboard: &Url, gateway: &Url) -> Result<String, String> {
    initialization_script_with_legacy_auth(dashboard, gateway, json!({}))
}

pub(crate) fn initialization_script_with_legacy_auth(
    dashboard: &Url,
    gateway: &Url,
    legacy_auth: Value,
) -> Result<String, String> {
    let config = json!({
        "origin": dashboard.origin().ascii_serialization(),
        "base": dashboard.path().trim_end_matches('/'),
        "gatewayUrl": gateway.as_str(),
        "legacyAuth": legacy_auth,
    });
    Ok(format!(
        "({})({config});",
        include_str!("../../ui/native-control-auth.js")
    ))
}

// This is a live-session fact, not a second credential store. A device-token session
// always rereads its current scoped grant; shared auth is retained only if hello
// confirms its method. Older hello responses may omit method; the successful
// socket's submitted auth remains authoritative in that case.
pub(crate) struct NativeControlSession {
    pub scopes: Vec<String>,
    auth: GatewayAuth,
}

impl NativeControlSession {
    pub(crate) fn from_hello(
        auth: GatewayAuth,
        method: Option<&str>,
        scopes: Option<Vec<String>>,
        issued_device_token: Option<&str>,
    ) -> Option<Self> {
        let compatible = match &auth {
            GatewayAuth::SharedToken(_) => method.is_none_or(|method| method == "token"),
            GatewayAuth::SharedPassword(_) => method.is_none_or(|method| method == "password"),
            GatewayAuth::DeviceToken(_) => method.is_none_or(|method| method == "device-token"),
            GatewayAuth::None => false,
        };
        let auth = if compatible {
            auth
        } else {
            // Verified-network and bootstrap methods may issue a device grant.
            // Use that grant, never a supplied shared secret they did not accept.
            let issued = issued_device_token
                .map(str::trim)
                .filter(|token| !token.is_empty())?;
            GatewayAuth::DeviceToken(issued.to_string())
        };
        Some(Self {
            auth,
            scopes: scopes?,
        })
    }

    pub(crate) fn legacy_auth(&self) -> Value {
        // v2026.9.6 understands shared bootstrap credentials, not this app's
        // device grant. Only an accepted hello can create this session fact.
        match &self.auth {
            GatewayAuth::SharedToken(token) => json!({"token": token}),
            GatewayAuth::SharedPassword(password) => json!({"password": password}),
            _ => json!({}),
        }
    }

    pub(crate) fn current_auth(
        &self,
        store: &GatewayDeviceIdentityStore,
        gateway: &str,
    ) -> Result<GatewayAuth, String> {
        if matches!(self.auth, GatewayAuth::DeviceToken(_)) {
            let auth = store.select_auth(gateway, None, None);
            return match auth {
                GatewayAuth::DeviceToken(_) => Ok(auth),
                _ => Err("The native Gateway device grant changed. Reconnect the app.".into()),
            };
        }
        Ok(self.auth.clone())
    }
}

pub(crate) fn connect_auth(
    identity: &GatewayDeviceIdentity,
    auth: &GatewayAuth,
    scopes: &[String],
    challenge: &Challenge,
) -> Result<Value, String> {
    if auth.is_none() {
        return Err(
            "The native Gateway has not accepted dashboard authentication. Reconnect the app."
                .into(),
        );
    }
    let scope_refs: Vec<_> = scopes.iter().map(String::as_str).collect();
    Ok(json!({
        "client": {
            "id": CLIENT_ID,
            "version": env!("CARGO_PKG_VERSION"),
            "platform": CLIENT_PLATFORM,
            "mode": CLIENT_MODE,
            "deviceFamily": CLIENT_DEVICE_FAMILY,
        },
        "scopes": scopes,
        "auth": auth.json(),
        "device": identity.signed_device_with_scopes(auth, &challenge.nonce, challenge.signed_at, &scope_refs)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway_device_identity::GatewayDeviceIdentityStore;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    #[test]
    fn challenge_accepts_gateway_clock_skew_and_rejects_unsafe_timestamps_or_authority() {
        for (signed_at, valid) in [
            (0_u64, false),
            (1, true),
            (1_000_000, true),
            (9_007_199_254_740_991, true),
            (9_007_199_254_740_992, false),
            (u64::MAX, false),
        ] {
            let challenge: Challenge = serde_json::from_value(json!({
                "id":"request", "nonce":"nonce", "signedAt":signed_at,
            }))
            .unwrap();
            assert_eq!(challenge.validate().is_ok(), valid, "timestamp {signed_at}");
        }
        for signed_at in [json!(-1), json!(1.5), json!("1000000"), Value::Null] {
            assert!(serde_json::from_value::<Challenge>(json!({
                "id":"request", "nonce":"nonce", "signedAt":signed_at,
            }))
            .is_err());
        }
        for field in ["scopes", "auth", "device", "role", "gatewayUrl"] {
            let mut request = json!({"id":"request", "nonce":"nonce", "signedAt":1_000_000});
            request[field] = json!("untrusted");
            assert!(
                serde_json::from_value::<Challenge>(request).is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn accepted_shared_auth_preserves_wire_field_and_signature_despite_stored_device_grant() {
        let directory = std::env::temp_dir().join(format!(
            "openclaw-shared-control-auth-{}",
            uuid::Uuid::new_v4()
        ));
        let mut store =
            GatewayDeviceIdentityStore::load_or_create(directory.join("identity.json")).unwrap();
        store
            .persist_device_token(
                "wss://gateway.example",
                "device-grant-not-the-accepted-method",
            )
            .unwrap();
        let identity = store.identity();
        let scopes = vec!["operator.read".to_string()];
        let challenge = Challenge {
            id: "request".into(),
            nonce: "shared-auth-nonce".into(),
            signed_at: 1_800_000_000_000,
        };
        for (accepted, method, field, credential, signed_token) in [
            (
                GatewayAuth::SharedToken("accepted-native-token".into()),
                "token",
                "token",
                "accepted-native-token",
                "accepted-native-token",
            ),
            (
                GatewayAuth::SharedPassword("accepted-native-password".into()),
                "password",
                "password",
                "accepted-native-password",
                "",
            ),
        ] {
            for reported in [Some(method), None] {
                let session = NativeControlSession::from_hello(
                    accepted.clone(),
                    reported,
                    Some(scopes.clone()),
                    None,
                )
                .unwrap();
                assert_eq!(session.legacy_auth(), json!({(field):credential}));
                let auth = session
                    .current_auth(&store, "wss://gateway.example")
                    .unwrap();
                let result = connect_auth(&identity, &auth, &session.scopes, &challenge).unwrap();
                assert_eq!(result["auth"], json!({(field):credential}));
                assert_eq!(result["scopes"], json!(["operator.read"]));
                let device = &result["device"];
                let public: [u8; 32] = URL_SAFE_NO_PAD
                    .decode(device["publicKey"].as_str().unwrap())
                    .unwrap()
                    .try_into()
                    .unwrap();
                let signature = Signature::from_slice(
                    &URL_SAFE_NO_PAD
                        .decode(device["signature"].as_str().unwrap())
                        .unwrap(),
                )
                .unwrap();
                let payload = format!("v3|{}|openclaw-linux|ui|operator|operator.read|1800000000000|{signed_token}|shared-auth-nonce|linux|desktop", device["id"].as_str().unwrap());
                VerifyingKey::from_bytes(&public)
                    .unwrap()
                    .verify(payload.as_bytes(), &signature)
                    .unwrap();
            }
            for reported in [
                "device-token",
                "trusted-proxy",
                "tailscale",
                "none",
                "bootstrap-token",
            ] {
                assert!(NativeControlSession::from_hello(accepted.clone(), Some(reported), Some(scopes.clone()), None).is_none(),
                    "a supplied but unaccepted credential must not become dashboard auth: {reported}");
            }
        }
        assert!(
            NativeControlSession::from_hello(GatewayAuth::None, None, Some(scopes), None).is_none()
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn handoff_signs_exact_granted_scopes_and_current_rotated_device_token() {
        let directory =
            std::env::temp_dir().join(format!("openclaw-native-auth-{}", uuid::Uuid::new_v4()));
        let mut store =
            GatewayDeviceIdentityStore::load_or_create(directory.join("identity.json")).unwrap();
        let challenge = Challenge {
            id: "request".into(),
            nonce: "fixture-nonce".into(),
            signed_at: 1_800_000_000_000,
        };
        let scopes = vec!["operator.read".to_string()];
        let identity = store.identity();
        assert!(connect_auth(&identity, &GatewayAuth::None, &scopes, &challenge).is_err());
        let mut previous_signature = None;
        for token in ["first-device-grant", "rotated-device-grant"] {
            store
                .persist_device_token("wss://gateway.example", token)
                .unwrap();
            let auth = store.select_auth("wss://gateway.example", None, None);
            let result = connect_auth(&identity, &auth, &scopes, &challenge).unwrap();
            assert_eq!(result["scopes"], json!(["operator.read"]));
            assert_eq!(result["auth"], json!({"deviceToken":token}));
            let device = &result["device"];
            let public: [u8; 32] = URL_SAFE_NO_PAD
                .decode(device["publicKey"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            let signature = Signature::from_slice(
                &URL_SAFE_NO_PAD
                    .decode(device["signature"].as_str().unwrap())
                    .unwrap(),
            )
            .unwrap();
            let payload = format!("v3|{}|openclaw-linux|ui|operator|operator.read|1800000000000|{token}|fixture-nonce|linux|desktop", device["id"].as_str().unwrap());
            VerifyingKey::from_bytes(&public)
                .unwrap()
                .verify(payload.as_bytes(), &signature)
                .unwrap();
            assert!(VerifyingKey::from_bytes(&public)
                .unwrap()
                .verify(
                    payload
                        .replace("operator.read", "operator.admin")
                        .as_bytes(),
                    &signature
                )
                .is_err());
            assert_ne!(previous_signature.as_ref(), Some(&device["signature"]));
            previous_signature = Some(device["signature"].clone());
        }
        assert!(connect_auth(
            &identity,
            &store.select_auth("wss://other.example", None, None),
            &scopes,
            &challenge
        )
        .is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
