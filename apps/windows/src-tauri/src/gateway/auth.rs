use crate::models::config::Config;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::json;

/// The gateway WebSocket protocol version this client supports.
const PROTOCOL_VERSION: u32 = 3;

pub fn sign_nonce(
    device_id: &str,
    private_key: &[u8],
    client_id: &str,
    client_mode: &str,
    role: &str,
    scopes: &[String],
    signed_at: u128,
    token: Option<&str>,
    nonce: Option<&str>,
) -> anyhow::Result<String> {
    use ed25519_dalek::{Signer, SigningKey};

    let bytes: [u8; 32] = private_key
        .to_vec()
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid private key length"))?;
    let signing_key = SigningKey::from_bytes(&bytes);

    let version = if nonce.is_some() { "v2" } else { "v1" };
    let scopes_str = scopes.join(",");
    let token_str = token.unwrap_or("");

    let mut payload = format!(
        "{}|{}|{}|{}|{}|{}|{}|{}",
        version, device_id, client_id, client_mode, role, scopes_str, signed_at, token_str
    );

    if version == "v2" {
        payload.push('|');
        payload.push_str(nonce.unwrap_or(""));
    }

    let signature = signing_key.sign(payload.as_bytes());
    let encoded = URL_SAFE_NO_PAD.encode(signature.to_bytes());

    Ok(encoded)
}

pub fn get_operator_connection_req(
    nonce: &str,
    config: &Config,
) -> anyhow::Result<serde_json::Value> {
    let signed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis();

    let token = config.auth_token.clone();
    let client_id = "openclaw-windows";
    let scopes = vec![
        "operator.admin".to_string(),
        "operator.approvals".to_string(),
        "operator.pairing".to_string(),
        "operator.read".to_string(),
        "operator.write".to_string(),
    ];

    let signature = sign_nonce(
        &config.device_id,
        &config.private_key,
        client_id,
        "ui",
        "operator",
        &scopes,
        signed_at,
        Some(&token),
        Some(nonce),
    )?;

    Ok(json!({
        "type": "req",
        "id": "1",
        "method": "connect",
        "params": {
            "minProtocol": PROTOCOL_VERSION,
            "maxProtocol": PROTOCOL_VERSION,
            "client": {
                "id": client_id,
                "version": "1.0.1",
                "platform": "windows",
                "mode": "ui",
                "displayName": "OpenClaw Windows"
            },
            "role": "operator",
            "scopes": scopes,
            "caps": ["tool-events"],
            "commands": [],
            "permissions": {},
            "auth": {
                "token": token
            },
            "device": {
                "id": config.device_id,
                "publicKey": URL_SAFE_NO_PAD.encode(&config.public_key),
                "signature": signature,
                "signedAt": signed_at,
                "nonce": nonce
            }
        }
    }))
}

pub fn get_node_connection_req(nonce: &str, config: &Config) -> anyhow::Result<serde_json::Value> {
    let signed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis();

    let token = config.auth_token.clone();
    let client_id = "openclaw-windows";

    let scopes: Vec<String> = vec![];

    let mut commands = vec![
        "screen.record".to_string(),
        "system.notify".to_string(),
        "system.run".to_string(),
        "system.which".to_string(),
        "system.exec_approvals.get".to_string(),
        "system.exec_approvals.set".to_string(),
    ];

    if config.camera_enabled {
        commands.push("camera.snap".to_string());
        commands.push("camera.list".to_string());
    }

    let signature = sign_nonce(
        &config.device_id,
        &config.private_key,
        client_id,
        "ui",
        "node",
        &scopes,
        signed_at,
        Some(&token),
        Some(nonce),
    )?;

    Ok(json!({
        "type": "req",
        "id": "1",
        "method": "connect",
        "params": {
            "minProtocol": PROTOCOL_VERSION,
            "maxProtocol": PROTOCOL_VERSION,
            "client": {
                "id": client_id,
                "version": "1.0.1",
                "platform": "windows",
                "mode": "ui",
                "displayName": "OpenClaw Windows"
            },
            "role": "node",
            "scopes": scopes,
            "caps": ["tool-events"],
            "commands": commands,
            "permissions": {},
            "auth": {
                "token": token
            },
            "device": {
                "id": config.device_id,
                "publicKey": URL_SAFE_NO_PAD.encode(&config.public_key),
                "signature": signature,
                "signedAt": signed_at,
                "nonce": nonce
            }
        }
    }))
}
