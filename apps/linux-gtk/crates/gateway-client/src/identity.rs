use std::path::PathBuf;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{SigningKey, VerifyingKey, Signer};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use thiserror::Error;
use tracing::{debug, info};

#[derive(Error, Debug)]
pub enum IdentityError {
    #[error("failed to read identity file: {0}")]
    Read(#[from] std::io::Error),
    #[error("failed to parse identity file: {0}")]
    Parse(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredIdentity {
    version: u32,
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "secretKey")]
    secret_key: String,
    #[serde(rename = "publicKey")]
    public_key: String,
    #[serde(rename = "createdAtMs")]
    created_at_ms: u64,
}

#[derive(Debug, Clone)]
pub struct DeviceIdentity {
    signing_key: SigningKey,
    verifying_key: VerifyingKey,
    device_id: String,
}

impl DeviceIdentity {
    /// Load existing identity from disk or generate a new one.
    pub fn load_or_create() -> Result<Self, IdentityError> {
        let path = Self::identity_path();
        if path.exists() {
            debug!("loading device identity from {}", path.display());
            let data = std::fs::read_to_string(&path)?;
            let stored: StoredIdentity = serde_json::from_str(&data)?;
            let secret_bytes = URL_SAFE_NO_PAD.decode(&stored.secret_key)
                .expect("invalid base64 in stored identity");
            let key_bytes: [u8; 32] = secret_bytes.try_into()
                .expect("secret key must be 32 bytes");
            let signing_key = SigningKey::from_bytes(&key_bytes);
            let verifying_key = signing_key.verifying_key();
            Ok(Self {
                signing_key,
                verifying_key,
                device_id: stored.device_id,
            })
        } else {
            info!("generating new device identity");
            let identity = Self::generate();
            identity.save()?;
            Ok(identity)
        }
    }

    fn generate() -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let device_id = Self::compute_device_id(&verifying_key);
        Self {
            signing_key,
            verifying_key,
            device_id,
        }
    }

    fn save(&self) -> Result<(), IdentityError> {
        let path = Self::identity_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let stored = StoredIdentity {
            version: 1,
            device_id: self.device_id.clone(),
            secret_key: URL_SAFE_NO_PAD.encode(self.signing_key.to_bytes()),
            public_key: URL_SAFE_NO_PAD.encode(self.verifying_key.to_bytes()),
            created_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
        };
        let json = serde_json::to_string_pretty(&stored)?;
        // Write with restricted permissions from the start to avoid a
        // TOCTOU window where the secret key is world-readable.
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&path)?;
            file.write_all(json.as_bytes())?;
        }
        #[cfg(not(unix))]
        std::fs::write(&path, &json)?;
        info!("saved device identity to {}", path.display());
        Ok(())
    }

    /// SHA-256 of the raw 32-byte Ed25519 public key, hex-encoded.
    fn compute_device_id(verifying_key: &VerifyingKey) -> String {
        let mut hasher = Sha256::new();
        hasher.update(verifying_key.as_bytes());
        format!("{:x}", hasher.finalize())
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// Base64url-encoded raw 32-byte public key.
    pub fn public_key_b64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.verifying_key.as_bytes())
    }

    /// Sign the payload string and return base64url-encoded signature.
    pub fn sign(&self, payload: &str) -> String {
        let signature = self.signing_key.sign(payload.as_bytes());
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    }

    /// Build the v2 auth payload string for the connect handshake.
    #[allow(clippy::too_many_arguments)]
    pub fn build_auth_payload(
        &self,
        client_id: &str,
        client_mode: &str,
        role: &str,
        scopes: &[&str],
        signed_at_ms: u64,
        token: &str,
        nonce: &str,
    ) -> String {
        format!(
            "v2|{}|{}|{}|{}|{}|{}|{}|{}",
            self.device_id,
            client_id,
            client_mode,
            role,
            scopes.join(","),
            signed_at_ms,
            token,
            nonce,
        )
    }

    fn identity_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".openclaw")
            .join("gtk-identity")
            .join("device.json")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_and_sign() {
        let identity = DeviceIdentity::generate();
        assert_eq!(identity.device_id().len(), 64);
        let payload = identity.build_auth_payload(
            "test-client", "app", "operator",
            &["operator.admin"], 1000, "", "nonce123",
        );
        assert!(payload.starts_with("v2|"));
        let sig = identity.sign(&payload);
        assert!(!sig.is_empty());
    }

    #[test]
    fn device_id_is_sha256_of_pubkey() {
        let identity = DeviceIdentity::generate();
        let raw_pub = identity.verifying_key.as_bytes();
        use sha2::{Sha256, Digest};
        let expected = format!("{:x}", Sha256::digest(raw_pub));
        assert_eq!(identity.device_id(), expected);
    }
}
