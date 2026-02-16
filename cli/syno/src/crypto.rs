//! OpenSSL-compatible AES-256-CBC decryption.
//!
//! NoteStation encrypts note content using OpenSSL's `enc -aes-256-cbc`
//! format: base64("Salted__" + 8-byte salt + ciphertext).
//! Key/IV are derived via `EVP_BytesToKey` with MD5.

use aes::Aes256;
use anyhow::{bail, Result};
use base64::Engine;
use cbc::cipher::{BlockDecryptMut, KeyIvInit};
use md5::{Digest, Md5};

type Aes256CbcDec = cbc::Decryptor<Aes256>;

/// Derive key and IV from password + salt using OpenSSL's `EVP_BytesToKey` (MD5, count=1).
/// For AES-256-CBC: key_len=32, iv_len=16 → need 48 bytes total.
fn evp_bytes_to_key(password: &[u8], salt: &[u8]) -> ([u8; 32], [u8; 16]) {
    let mut key = [0u8; 32];
    let mut iv = [0u8; 16];

    // We need 48 bytes: 3 rounds of MD5 (each produces 16 bytes).
    let mut derived = Vec::with_capacity(48);
    let mut prev_hash: Vec<u8> = Vec::new();

    while derived.len() < 48 {
        let mut hasher = Md5::new();
        if !prev_hash.is_empty() {
            hasher.update(&prev_hash);
        }
        hasher.update(password);
        hasher.update(salt);
        prev_hash = hasher.finalize().to_vec();
        derived.extend_from_slice(&prev_hash);
    }

    key.copy_from_slice(&derived[..32]);
    iv.copy_from_slice(&derived[32..48]);
    (key, iv)
}

/// Remove PKCS#7 padding from decrypted plaintext.
fn unpad_pkcs7(data: &[u8]) -> Result<&[u8]> {
    if data.is_empty() {
        bail!("Empty data for PKCS7 unpad");
    }
    let pad_len = *data.last().unwrap() as usize;
    if pad_len == 0 || pad_len > 16 || pad_len > data.len() {
        bail!("Invalid PKCS7 padding: pad_len={pad_len}");
    }
    // Verify all padding bytes
    for &b in &data[data.len() - pad_len..] {
        if b as usize != pad_len {
            bail!("Invalid PKCS7 padding byte");
        }
    }
    Ok(&data[..data.len() - pad_len])
}

/// Decrypt OpenSSL-compatible AES-256-CBC encrypted content.
///
/// Input: base64-encoded string starting with "Salted__" prefix.
/// Returns the decrypted UTF-8 plaintext.
pub fn decrypt_aes256cbc(encrypted_base64: &str, password: &str) -> Result<String> {
    let raw = base64::engine::general_purpose::STANDARD.decode(encrypted_base64)?;

    // Check "Salted__" magic (8 bytes)
    if raw.len() < 16 || &raw[..8] != b"Salted__" {
        bail!("Not an OpenSSL Salted format");
    }

    let salt = &raw[8..16];
    let ciphertext = &raw[16..];

    if ciphertext.is_empty() || ciphertext.len() % 16 != 0 {
        bail!("Invalid ciphertext length: {}", ciphertext.len());
    }

    let (key, iv) = evp_bytes_to_key(password.as_bytes(), salt);

    let decryptor = Aes256CbcDec::new(&key.into(), &iv.into());
    let mut buf = ciphertext.to_vec();
    let decrypted = decryptor
        .decrypt_padded_mut::<cbc::cipher::block_padding::NoPadding>(&mut buf)
        .map_err(|e| anyhow::anyhow!("AES decrypt failed: {e}"))?;

    let plaintext = unpad_pkcs7(decrypted)?;
    Ok(String::from_utf8_lossy(plaintext).into_owned())
}
