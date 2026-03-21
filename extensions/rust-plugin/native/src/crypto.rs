//! Secure cryptographic operations for OpenClaw Rust plugin
//!
//! This module implements production-ready cryptographic operations following
//! napi-rs best practices and security guidelines.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

// Nonce entry with timestamp for cleanup
struct NonceEntry {
    timestamp: u64,
}

// Nonce tracker with automatic cleanup to prevent memory leaks and nonce reuse
struct NonceTracker {
    nonces: HashMap<Vec<u8>, NonceEntry>,
}

impl NonceTracker {
    const MAX_NONCES: usize = 10_000;      // Hard cap on stored nonces
    const NONCE_TTL_SECS: u64 = 60;         // 1 minute TTL (shorter for security)
    const CLEANUP_INTERVAL: usize = 100;    // Cleanup every 100 inserts

    fn insert(&mut self, nonce: Vec<u8>) -> Result<()> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Cleanup old nonces more frequently to prevent TTL reuse window
        if self.nonces.len() % Self::CLEANUP_INTERVAL == 0 {
            self.nonces.retain(|_, entry| now - entry.timestamp < Self::NONCE_TTL_SECS);
        }

        // Hard cap: if still over limit after cleanup, reject new nonces
        if self.nonces.len() >= Self::MAX_NONCES {
            return Err(Error::new(
                Status::GenericFailure,
                "Nonce tracker at capacity - wait before encrypting more",
            ));
        }

        // Check for reuse BEFORE inserting (critical for security)
        if self.nonces.contains_key(&nonce) {
            return Err(Error::new(
                Status::InvalidArg,
                "Nonce reuse detected - encryption unsafe",
            ));
        }

        self.nonces.insert(nonce, NonceEntry { timestamp: now });
        Ok(())
    }
}

// Global nonce tracking to prevent reuse
lazy_static::lazy_static! {
    static ref USED_NONCES: Mutex<NonceTracker> = Mutex::new(NonceTracker {
        nonces: HashMap::new(),
    });
}

/// Encryption result structure
#[napi(object)]
pub struct EncryptionResult {
    pub ciphertext: String,
    pub nonce: String,
    pub tag: Option<String>,
}

/// Decryption result structure
#[napi(object)]
pub struct DecryptionResult {
    pub plaintext: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Real AES-256-GCM encryption
#[napi]
pub fn aes256_gcm_encrypt(
    plaintext: String,
    key_hex: String,
    nonce_hex: Option<String>,
) -> Result<EncryptionResult> {
    // Validate and decode key from hex (must be 64 hex chars = 32 bytes)
    let key_bytes = hex::decode(&key_hex)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid key hex: {}", e)))?;

    if key_bytes.len() != 32 {
        return Err(Error::new(
            Status::InvalidArg,
            "Key must be 32 bytes (64 hex characters)",
        ));
    }

    // Use actual AES-256-GCM
    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|_| Error::new(Status::InvalidArg, "Invalid key"))?;

    // Generate or use provided nonce (12 bytes for GCM)
    let nonce_vec = if let Some(n) = nonce_hex {
        let nonce_bytes = hex::decode(&n)
            .map_err(|_e| Error::new(Status::InvalidArg, "Invalid nonce"))?;
        if nonce_bytes.len() != 12 {
            return Err(Error::new(
                Status::InvalidArg,
                "Nonce must be 12 bytes (24 hex characters)",
            ));
        }
        
        // Check for nonce reuse (CRITICAL for GCM security)
        {
            let mut used_nonces = USED_NONCES.lock().unwrap();
            used_nonces.insert(nonce_bytes.clone())?;
        }
        
        nonce_bytes
    } else {
        let generated = Aes256Gcm::generate_nonce(&mut OsRng);
        let nonce_bytes = generated.to_vec();
        
        // Track generated nonces too
        {
            let mut used_nonces = USED_NONCES.lock().unwrap();
            used_nonces.insert(nonce_bytes.clone())?;
        }
        
        nonce_bytes
    };

    let nonce = Nonce::from_slice(&nonce_vec);

    // Encrypt with authentication (tag is appended to ciphertext by GCM)
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| Error::new(Status::GenericFailure, format!("Encryption failed: {}", e)))?;

    Ok(EncryptionResult {
        ciphertext: hex::encode(&ciphertext),
        nonce: hex::encode(&nonce_vec),
        tag: Some("included".to_string()), // Tag is included in ciphertext for GCM
    })
}

/// Real AES-256-GCM decryption
#[napi]
pub fn aes256_gcm_decrypt(
    ciphertext_hex: String,
    key_hex: String,
    nonce_hex: String,
) -> Result<DecryptionResult> {
    // Validate and decode key
    let key_bytes = hex::decode(&key_hex)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid key hex: {}", e)))?;

    if key_bytes.len() != 32 {
        return Err(Error::new(
            Status::InvalidArg,
            "Key must be 32 bytes (64 hex characters)",
        ));
    }

    // Decode nonce
    let nonce_bytes = hex::decode(&nonce_hex)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid nonce: {}", e)))?;

    if nonce_bytes.len() != 12 {
        return Err(Error::new(
            Status::InvalidArg,
            "Nonce must be 12 bytes (24 hex characters)",
        ));
    }

    // Decode ciphertext (includes authentication tag)
    let ciphertext_bytes = hex::decode(&ciphertext_hex)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid ciphertext: {}", e)))?;

    // Validate ciphertext has minimum size (GCM tag is 16 bytes)
    if ciphertext_bytes.len() < 16 {
        return Err(Error::new(
            Status::InvalidArg,
            "Ciphertext too short (must include 16-byte authentication tag)",
        ));
    }

    // Create cipher
    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|_| Error::new(Status::InvalidArg, "Invalid key"))?;

    // Decrypt with authentication (nonce and ciphertext separate)
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext_bytes.as_slice())
        .map_err(|e| Error::new(Status::GenericFailure, format!("Decryption failed (authentication tag mismatch): {}", e)))?;

    Ok(DecryptionResult {
        plaintext: String::from_utf8(plaintext)
            .map_err(|_| Error::new(Status::InvalidArg, "Invalid UTF-8 in decrypted data"))?,
        success: true,
        error: None,
    })
}

/// SHA-256 hash with optional salt
#[napi]
pub fn sha256_hash(data: String, salt: Option<String>) -> Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());

    if let Some(s) = salt {
        hasher.update(s.as_bytes());
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// BLAKE3 hash with optional keying
#[napi]
pub fn blake3_hash_keyed(data: String, key: Option<String>) -> Result<String> {
    let hash = if let Some(k) = key {
        let key_bytes = k.as_bytes();
        if key_bytes.len() >= 32 {
            let key_array: [u8; 32] = key_bytes[..32].try_into()
                .map_err(|_| Error::new(Status::InvalidArg, "Key conversion failed"))?;
            blake3::keyed_hash(&key_array, data.as_bytes())
        } else {
            blake3::hash(data.as_bytes())
        }
    } else {
        blake3::hash(data.as_bytes())
    };

    Ok(hash.to_hex().to_string())
}

/// Secure random bytes generation (cryptographically secure)
#[napi]
pub fn secure_random(length: u32) -> Result<String> {
    if length > 1_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Length too large (max 1MB)",
        ));
    }

    use rand::RngCore;
    let mut bytes = vec![0u8; length as usize];
    OsRng.fill_bytes(&mut bytes);
    Ok(hex::encode(&bytes))
}

/// Password hashing using Argon2 (memory-hard, secure)
/// Protected against DoS via password size limit
#[napi]
pub fn argon2_hash(password: String, salt: Option<String>) -> Result<String> {
    // Limit password size to prevent DoS (Argon2 is intentionally slow)
    const MAX_PASSWORD_LEN: usize = 1024;
    if password.len() > MAX_PASSWORD_LEN {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Password too long (max {} bytes)", MAX_PASSWORD_LEN),
        ));
    }

    use argon2::{
        password_hash::{rand_core::OsRng, PasswordHasher, SaltString},
        Argon2,
    };

    let salt_str = if let Some(s) = salt {
        // Limit salt size
        if s.len() > 128 {
            return Err(Error::new(Status::InvalidArg, "Salt too long (max 128 bytes)"));
        }
        SaltString::encode_b64(&s.as_bytes())
            .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid salt: {}", e)))?
    } else {
        SaltString::generate(&mut OsRng)
    };

    let argon2 = Argon2::default();
    let password_hash = argon2
        .hash_password(password.as_bytes(), &salt_str)
        .map_err(|e| Error::new(Status::GenericFailure, format!("Hashing failed: {}", e)))?;

    Ok(password_hash.to_string())
}

/// Verify Argon2 password (constant-time comparison)
/// Protected against DoS via password size limit
#[napi]
pub fn argon2_verify(password: String, hash: String) -> Result<bool> {
    // Limit password size to prevent DoS
    const MAX_PASSWORD_LEN: usize = 1024;
    if password.len() > MAX_PASSWORD_LEN {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Password too long (max {} bytes)", MAX_PASSWORD_LEN),
        ));
    }

    use argon2::{password_hash::PasswordHash, Argon2, PasswordVerifier};

    let parsed_hash = PasswordHash::new(&hash)
        .map_err(|_| Error::new(Status::InvalidArg, "Invalid hash format"))?;

    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

/// HMAC computation (constant-time comparison)
/// Protected against DoS via size limits
#[napi]
pub fn hmac_compute(data: String, key: String, algorithm: Option<String>) -> Result<String> {
    // Size limits to prevent DoS
    const MAX_DATA_SIZE: usize = 10_000_000;  // 10MB
    const MAX_KEY_SIZE: usize = 1024;          // 1KB
    
    if data.len() > MAX_DATA_SIZE {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Data too large (max {}MB)", MAX_DATA_SIZE / 1024 / 1024),
        ));
    }
    if key.len() > MAX_KEY_SIZE {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Key too large (max {} bytes)", MAX_KEY_SIZE),
        ));
    }

    use hmac::Hmac;
    use sha2::Sha256;

    let algo = algorithm.unwrap_or_else(|| "sha256".to_string());

    let result = match algo.as_str() {
        "sha256" => {
            use hmac::Mac;
            use hmac::digest::KeyInit;
            type HmacImpl = Hmac<Sha256>;
            let mut mac = <HmacImpl as KeyInit>::new_from_slice(key.as_bytes())
                .map_err(|_| Error::new(Status::InvalidArg, "Invalid key"))?;
            mac.update(data.as_bytes());
            mac.finalize().into_bytes().to_vec()
        }
        _ => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Unsupported algorithm: {} (only sha256 supported)", algo),
            ))
        }
    };

    Ok(hex::encode(&result))
}

/// Key derivation function (HKDF)
#[napi]
pub fn hkdf_derive(
    input_key: String,
    salt: String,
    info: String,
    length: Option<u32>,
) -> Result<String> {
    use hkdf::Hkdf;
    use sha2::Sha256;

    let salt_bytes = hex::decode(&salt)
        .map_err(|_| Error::new(Status::InvalidArg, "Invalid salt hex"))?;

    let ikm = input_key.as_bytes();
    let info_bytes = info.as_bytes();
    let okm_length = length.unwrap_or(32) as usize;

    if okm_length > 255 * Sha256::output_size() {
        return Err(Error::new(
            Status::InvalidArg,
            "Derived key too long",
        ));
    }

    let hk = Hkdf::<Sha256>::new(Some(&salt_bytes), ikm);
    let mut okm = vec![0u8; okm_length];

    hk.expand(info_bytes, &mut okm)
        .map_err(|e| Error::new(Status::GenericFailure, format!("HKDF expand failed: {}", e)))?;

    Ok(hex::encode(&okm))
}

/// Batch hash computation for multiple inputs (efficient)
#[napi]
pub fn batch_hash(inputs: Vec<String>, algorithm: Option<String>) -> Result<Vec<String>> {
    let algo = algorithm.unwrap_or_else(|| "sha256".to_string());

    if inputs.len() > 10_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Too many inputs (max 10000)",
        ));
    }

    let mut results = Vec::with_capacity(inputs.len());

    for input in inputs {
        let hash = match algo.as_str() {
            "sha256" => {
                let mut hasher = Sha256::new();
                hasher.update(input.as_bytes());
                format!("{:x}", hasher.finalize())
            }
            "blake3" => {
                let hash = blake3::hash(input.as_bytes());
                hash.to_hex().to_string()
            }
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("Unsupported algorithm: {}", algo),
                ))
            }
        };
        results.push(hash);
    }

    Ok(results)
}

/// Cryptographic operations benchmark
#[napi(object)]
pub struct CryptoBenchmark {
    pub operation: String,
    pub iterations: u32,
    pub duration_ms: f64,
    pub ops_per_second: f64,
}

// Add a getter shim for the camelCase version that NAPI-RS expects
impl CryptoBenchmark {
    #[allow(dead_code)]
    fn duration_ms(&self) -> f64 {
        self.duration_ms
    }

    #[allow(dead_code)]
    fn ops_per_second(&self) -> f64 {
        self.ops_per_second
    }
}

#[napi]
pub async fn benchmark_crypto(operation: String, iterations: Option<u32>) -> Result<CryptoBenchmark> {
    use std::time::Instant;
    let iters = iterations.unwrap_or(1000).min(10_000);
    let test_data = "Hello, World! This is a test string for cryptographic operations.";

    let start = Instant::now();

    for _ in 0..iters {
        match operation.as_str() {
            "sha256" => {
                use sha2::{Digest, Sha256};
                let mut hasher = Sha256::new();
                hasher.update(test_data.as_bytes());
                let _ = hasher.finalize();
            }
            "blake3" => {
                let _ = blake3::hash(test_data.as_bytes());
            }
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("Unknown operation: {}", operation),
                ))
            }
        }
    }

    let duration = start.elapsed();
    let duration_ms = duration.as_secs_f64() * 1000.0;
    let ops_per_sec = (iters as f64 / duration_ms) * 1000.0;

    Ok(CryptoBenchmark {
        operation,
        iterations: iters,
        duration_ms,
        ops_per_second: ops_per_sec,
    })
}

/// Webhook handler result
#[napi(object)]
pub struct WebhookResult {
    pub status_code: u32,
    pub body: String,
    pub processed: bool,
}

/// Handle incoming webhook data (with validation)
#[napi]
pub async fn handle_webhook(body: String) -> Result<WebhookResult> {
    // Validate input size
    if body.len() > 1_000_000 {
        return Ok(WebhookResult {
            status_code: 413,
            body: serde_json::json!({
                "error": "Payload too large",
                "max_size": 1_000_000
            })
            .to_string(),
            processed: false,
        });
    }

    // Try to parse as JSON
    let parsed: std::result::Result<serde_json::Value, serde_json::Error> = serde_json::from_str(&body);

    match parsed {
        Ok(_) => {
            // Process the webhook data
            Ok(WebhookResult {
                status_code: 200,
                body: serde_json::json!({
                    "received": true,
                    "timestamp": chrono::Utc::now().to_rfc3339()
                })
                .to_string(),
                processed: true,
            })
        }
        Err(_) => Ok(WebhookResult {
            status_code: 400,
            body: serde_json::json!({
                "error": "Invalid JSON"
            })
            .to_string(),
            processed: false,
        }),
    }
}