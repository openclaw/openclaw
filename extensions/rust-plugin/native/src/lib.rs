//! OpenClaw Rust Plugin - Universal Native Addon
//!
//! This plugin works with ANY OpenClaw-based project (forks, clones, etc.)
//! via npm distribution with pre-built binaries.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use sha2::{Digest, Sha256, Sha512};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;

// =============================================================================
// STRING PROCESSING
// =============================================================================

#[napi]
pub async fn process_string(
    input: String,
    options: Option<HashMap<String, bool>>,
) -> Result<String> {
    // Limit input size to prevent DoS
    if input.len() > 10_000_000 {
        return Err(Error::new(Status::InvalidArg, "Input too large (max 10MB)"));
    }

    let opts = options.unwrap_or_default();
    let mut result = input;

    if *opts.get("uppercase").unwrap_or(&false) {
        result = result.to_uppercase();
    }
    if *opts.get("lowercase").unwrap_or(&false) {
        result = result.to_lowercase();
    }
    if *opts.get("reverse").unwrap_or(&false) {
        result = result.chars().rev().collect();
    }
    if *opts.get("trim").unwrap_or(&false) {
        result = result.trim().to_string();
    }
    if *opts.get("remove_spaces").unwrap_or(&false) {
        result = result.replace(' ', "");
    }
    if *opts.get("remove_newlines").unwrap_or(&false) {
        result = result.replace(['\n', '\r'], "");
    }

    Ok(result)
}

#[napi]
pub async fn batch_process(
    inputs: Vec<String>,
    options: Option<HashMap<String, bool>>,
) -> Result<Vec<String>> {
    let mut results = Vec::with_capacity(inputs.len());
    for input in inputs {
        results.push(process_string(input, options.clone()).await?);
    }
    Ok(results)
}

#[napi(object)]
pub struct TextStats {
    pub characters: f64,
    pub characters_no_spaces: f64,
    pub words: f64,
    pub lines: f64,
    pub bytes: f64,
}

#[napi]
pub fn text_stats(text: String) -> TextStats {
    TextStats {
        characters: text.chars().count() as f64,
        characters_no_spaces: text.chars().filter(|c| !c.is_whitespace()).count() as f64,
        words: text.split_whitespace().count() as f64,
        lines: text.lines().count() as f64,
        bytes: text.len() as f64,
    }
}

// =============================================================================
// CRYPTOGRAPHY
// =============================================================================

#[napi]
pub fn compute_hash(data: String, algorithm: Option<String>) -> Result<String> {
    let algo = algorithm.unwrap_or_else(|| "sha256".to_string());

    let hash = match algo.as_str() {
        "sha256" => {
            let mut hasher = Sha256::new();
            hasher.update(data.as_bytes());
            format!("{:x}", hasher.finalize())
        }
        "sha512" => {
            let mut hasher = Sha512::new();
            hasher.update(data.as_bytes());
            format!("{:x}", hasher.finalize())
        }
        "blake3" => blake3::hash(data.as_bytes()).to_hex().to_string(),
        _ => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Unknown algorithm: {}", algo),
            ))
        }
    };

    Ok(hash)
}

#[napi]
pub fn hash_file(path: String, algorithm: Option<String>) -> Result<String> {
    let algo = algorithm.unwrap_or_else(|| "sha256".to_string());

    // Use shared validate_path for consistency with other file operations
    validate_path(&path)?;

    let metadata = fs::metadata(&path).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to access file: {}", e),
        )
    })?;

    // Validate file size (max 100MB to prevent DoS)
    const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(Error::new(
            Status::InvalidArg,
            format!("File too large (max {}MB)", MAX_FILE_SIZE / 1024 / 1024),
        ));
    }

    let mut file = fs::File::open(&path).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to open file: {}", e),
        )
    })?;

    match algo.as_str() {
        "sha256" => {
            let mut hasher = Sha256::new();
            std::io::copy(&mut file, &mut hasher)
                .map_err(|e| Error::new(Status::GenericFailure, format!("Read error: {}", e)))?;
            Ok(format!("{:x}", hasher.finalize()))
        }
        "blake3" => {
            let mut hasher = blake3::Hasher::new();
            let mut buffer = Vec::new();
            file.read_to_end(&mut buffer)
                .map_err(|e| Error::new(Status::GenericFailure, format!("Read error: {}", e)))?;
            hasher.update(&buffer);
            Ok(hasher.finalize().to_hex().to_string())
        }
        _ => Err(Error::new(
            Status::InvalidArg,
            format!("Unsupported: {}", algo),
        )),
    }
}

#[napi]
pub fn generate_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[napi]
pub fn generate_uuids(count: u32) -> Vec<String> {
    // Prevent OOM by limiting count
    let safe_count = count.min(100_000);
    (0..safe_count)
        .map(|_| uuid::Uuid::new_v4().to_string())
        .collect()
}

// =============================================================================
// FILE SYSTEM
// =============================================================================

/// Maximum file size for read operations (10MB)
const MAX_READ_SIZE: u64 = 10 * 1024 * 1024;

/// Validates a file path for security
/// - Prevents path traversal attacks
/// - Validates path length
/// - Checks for null bytes
fn validate_path(path: &str) -> Result<()> {
    // Check for null bytes (potential injection attack)
    if path.contains('\0') {
        return Err(Error::new(
            Status::InvalidArg,
            "Invalid path: null byte detected",
        ));
    }

    // Check for path traversal
    if path.contains("..") {
        return Err(Error::new(
            Status::InvalidArg,
            "Invalid path: path traversal detected",
        ));
    }

    // Validate path length
    if path.len() > 4096 {
        return Err(Error::new(
            Status::InvalidArg,
            "Path too long (max 4096 characters)",
        ));
    }

    Ok(())
}

#[napi(object)]
pub struct FileInfo {
    pub exists: bool,
    pub is_file: bool,
    pub is_dir: bool,
    pub size: Option<f64>,
    pub readonly: Option<bool>,
    pub name: Option<String>,
    pub extension: Option<String>,
    pub error: Option<String>,
}

#[napi(object)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_file: bool,
    pub is_dir: bool,
    pub size: Option<f64>,
}

#[napi]
pub fn get_file_info(path: String) -> FileInfo {
    if let Err(e) = validate_path(&path) {
        return FileInfo {
            exists: false,
            is_file: false,
            is_dir: false,
            size: None,
            readonly: None,
            name: None,
            extension: None,
            error: Some(e.to_string()),
        };
    }
    let path = Path::new(&path);
    match fs::metadata(path) {
        Ok(metadata) => FileInfo {
            exists: true,
            is_file: metadata.is_file(),
            is_dir: metadata.is_dir(),
            size: Some(metadata.len() as f64),
            readonly: Some(metadata.permissions().readonly()),
            name: path.file_name().and_then(|n| n.to_str()).map(String::from),
            extension: path.extension().and_then(|e| e.to_str()).map(String::from),
            error: None,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => FileInfo {
            exists: false,
            is_file: false,
            is_dir: false,
            size: None,
            readonly: None,
            name: None,
            extension: None,
            error: None,
        },
        Err(e) => FileInfo {
            exists: false,
            is_file: false,
            is_dir: false,
            size: None,
            readonly: None,
            name: None,
            extension: None,
            error: Some(e.to_string()),
        },
    }
}

#[napi]
pub fn read_file_string(path: String) -> Result<String> {
    validate_path(&path)?;

    // Check file size before reading
    let metadata = fs::metadata(&path).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to access file: {}", e),
        )
    })?;

    if metadata.len() > MAX_READ_SIZE {
        return Err(Error::new(
            Status::InvalidArg,
            format!("File too large (max {}MB)", MAX_READ_SIZE / 1024 / 1024),
        ));
    }

    fs::read_to_string(&path)
        .map_err(|e| Error::new(Status::GenericFailure, format!("Read failed: {}", e)))
}

#[napi]
pub fn read_file_buffer(path: String) -> Result<Buffer> {
    validate_path(&path)?;

    // Check file size before reading
    let metadata = fs::metadata(&path).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to access file: {}", e),
        )
    })?;

    if metadata.len() > MAX_READ_SIZE {
        return Err(Error::new(
            Status::InvalidArg,
            format!("File too large (max {}MB)", MAX_READ_SIZE / 1024 / 1024),
        ));
    }

    let bytes = fs::read(&path)
        .map_err(|e| Error::new(Status::GenericFailure, format!("Read failed: {}", e)))?;
    Ok(bytes.into())
}

#[napi]
pub fn write_file_buffer(path: String, content: Buffer) -> Result<()> {
    validate_path(&path)?;
    // Limit content size to prevent DoS
    if content.len() > 10_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Content too large (max 10MB)",
        ));
    }
    let content_bytes = content.as_ref();
    fs::write(&path, content_bytes)
        .map_err(|e| Error::new(Status::GenericFailure, format!("Write failed: {}", e)))
}

#[napi]
pub fn write_file_string(path: String, content: String) -> Result<()> {
    validate_path(&path)?;
    // Limit content size to prevent DoS
    if content.len() > 10_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Content too large (max 10MB)",
        ));
    }
    fs::write(&path, content)
        .map_err(|e| Error::new(Status::GenericFailure, format!("Write failed: {}", e)))
}

#[napi]
pub fn list_directory(path: String) -> Result<Vec<DirEntry>> {
    validate_path(&path)?;
    let entries = fs::read_dir(&path).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Directory read failed: {}", e),
        )
    })?;
    let mut results = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|e| Error::new(Status::GenericFailure, format!("Entry error: {}", e)))?;
        let ft = entry
            .file_type()
            .map_err(|e| Error::new(Status::GenericFailure, format!("File type error: {}", e)))?;
        let metadata = entry
            .metadata()
            .map_err(|e| Error::new(Status::GenericFailure, format!("Metadata error: {}", e)))?;
        results.push(DirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().display().to_string(),
            is_file: ft.is_file(),
            is_dir: ft.is_dir(),
            size: Some(metadata.len() as f64),
        });
    }
    Ok(results)
}

#[napi]
pub fn create_directory(path: String) -> Result<()> {
    validate_path(&path)?;
    fs::create_dir_all(&path).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to create directory: {}", e),
        )
    })
}

#[napi]
pub fn delete_file(path: String) -> Result<()> {
    validate_path(&path)?;
    fs::remove_file(&path).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to delete file: {}", e),
        )
    })
}

#[napi]
pub fn delete_directory(path: String) -> Result<()> {
    validate_path(&path)?;
    fs::remove_dir_all(&path).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to delete directory: {}", e),
        )
    })
}

#[napi]
pub fn copy_file(from: String, to: String) -> Result<f64> {
    validate_path(&from)?;
    validate_path(&to)?;
    let bytes = fs::copy(&from, &to)
        .map_err(|e| Error::new(Status::GenericFailure, format!("Copy failed: {}", e)))?;
    Ok(bytes as f64)
}

// =============================================================================
// ENCODING
// =============================================================================

#[napi]
pub fn base64_encode(input: String) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.encode(input.as_bytes())
}

#[napi]
pub fn base64_decode(input: String) -> Result<String> {
    // Limit input size to prevent DoS
    if input.len() > 20_000_000 {
        return Err(Error::new(Status::InvalidArg, "Input too large (max 20MB)"));
    }

    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = STANDARD
        .decode(input)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid base64: {}", e)))?;

    // Limit output size
    if bytes.len() > 15_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Decoded data too large (max 15MB)",
        ));
    }

    String::from_utf8(bytes)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid UTF-8: {}", e)))
}

#[napi]
pub fn url_decode(input: String) -> Result<String> {
    // Limit input size
    if input.len() > 10_000_000 {
        return Err(Error::new(Status::InvalidArg, "Input too large (max 10MB)"));
    }

    urlencoding::decode(&input)
        .map(|s| s.to_string())
        .map_err(|e| Error::new(Status::InvalidArg, format!("URL decode failed: {}", e)))
}

#[napi]
pub fn hex_encode(input: Buffer) -> String {
    hex::encode(input.as_ref())
}

#[napi]
pub fn hex_decode(input: String) -> Result<Buffer> {
    // Limit input size
    if input.len() > 20_000_000 {
        return Err(Error::new(Status::InvalidArg, "Input too large (max 20MB)"));
    }

    let bytes = hex::decode(input)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Hex decode failed: {}", e)))?;

    // Limit output size
    if bytes.len() > 10_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Decoded data too large (max 10MB)",
        ));
    }

    Ok(bytes.into())
}

// =============================================================================
// DATA PROCESSOR CLASS
// =============================================================================

#[napi(custom_finalize)]
pub struct DataProcessor {
    buffer: Vec<u8>,
}

impl ObjectFinalize for DataProcessor {
    fn finalize(self, mut env: Env) -> Result<()> {
        env.adjust_external_memory(-(self.buffer.len() as i64))?;
        Ok(())
    }
}

#[napi]
impl DataProcessor {
    #[napi(constructor)]
    pub fn new(mut env: Env) -> Result<Self> {
        env.adjust_external_memory(0)?;
        Ok(DataProcessor { buffer: Vec::new() })
    }

    #[napi(factory)]
    pub fn with_capacity(mut env: Env, capacity: u32) -> Result<Self> {
        let capacity = capacity as usize;
        env.adjust_external_memory(capacity as i64)?;
        Ok(DataProcessor {
            buffer: Vec::with_capacity(capacity),
        })
    }

    #[napi]
    pub fn append(&mut self, mut env: Env, data: Buffer) -> Result<()> {
        const MAX_BUFFER_SIZE: usize = 100_000_000; // 100MB limit

        let data_len = data.len();
        let new_len = self
            .buffer
            .len()
            .checked_add(data_len)
            .ok_or_else(|| Error::new(Status::GenericFailure, "Buffer overflow"))?;

        if new_len > MAX_BUFFER_SIZE {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Buffer too large (max {}MB)", MAX_BUFFER_SIZE / 1_000_000),
            ));
        }

        self.buffer.extend_from_slice(&data);
        env.adjust_external_memory(data_len as i64)?;
        Ok(())
    }

    #[napi]
    pub fn append_string(&mut self, mut env: Env, data: String) -> Result<()> {
        const MAX_BUFFER_SIZE: usize = 100_000_000;
        let data_len = data.len();
        let new_len = self
            .buffer
            .len()
            .checked_add(data_len)
            .ok_or_else(|| Error::new(Status::GenericFailure, "Buffer overflow"))?;
        if new_len > MAX_BUFFER_SIZE {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Buffer too large (max {}MB)", MAX_BUFFER_SIZE / 1024 / 1024),
            ));
        }
        self.buffer.extend_from_slice(data.as_bytes());
        env.adjust_external_memory(data_len as i64)?;
        Ok(())
    }

    #[napi]
    pub fn process(&self) -> Result<Buffer> {
        Ok(self
            .buffer
            .iter()
            .rev()
            .copied()
            .collect::<Vec<u8>>()
            .into())
    }

    #[napi]
    pub fn clear(&mut self, mut env: Env) -> Result<()> {
        let old_len = self.buffer.len();
        // Securely zero the buffer before clearing
        use zeroize::Zeroize;
        self.buffer.zeroize();
        env.adjust_external_memory(-(old_len as i64))?;
        Ok(())
    }

    #[napi]
    pub fn len(&self) -> u32 {
        self.buffer.len() as u32
    }

    #[napi]
    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    #[napi(js_name = "toString")]
    pub fn to_string_impl(&self) -> Result<String> {
        String::from_utf8(self.buffer.clone())
            .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid UTF-8: {}", e)))
    }

    #[napi]
    pub fn to_base64(&self) -> String {
        use base64::{engine::general_purpose::STANDARD, Engine};
        STANDARD.encode(&self.buffer)
    }

    #[napi]
    pub fn from_base64(&mut self, mut env: Env, encoded: String) -> Result<()> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let old_len = self.buffer.len();
        self.buffer = STANDARD
            .decode(encoded)
            .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid base64: {}", e)))?;
        env.adjust_external_memory((self.buffer.len() as i64) - (old_len as i64))?;
        Ok(())
    }

    #[napi]
    pub fn hash(&self, algorithm: Option<String>) -> Result<String> {
        let algo = algorithm.unwrap_or_else(|| "sha256".to_string());
        match algo.as_str() {
            "sha256" => {
                let mut hasher = Sha256::new();
                hasher.update(&self.buffer);
                Ok(format!("{:x}", hasher.finalize()))
            }
            "blake3" => Ok(blake3::hash(&self.buffer).to_hex().to_string()),
            _ => Err(Error::new(
                Status::InvalidArg,
                format!("Unknown algorithm: {}", algo),
            )),
        }
    }
}

// =============================================================================
// REGEX OPERATIONS
// =============================================================================

#[napi(object)]
pub struct RegexMatch {
    pub matched: bool,
    pub matches: Vec<String>,
    pub count: u32,
}

#[napi]
pub fn regex_find(text: String, pattern: String) -> Result<RegexMatch> {
    // Size limits to prevent ReDoS
    if text.len() > 10_000_000 {
        return Err(Error::new(Status::InvalidArg, "Text too large (max 10MB)"));
    }
    if pattern.len() > 10_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Pattern too large (max 10KB)",
        ));
    }

    let re = regex::Regex::new(&pattern)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid regex: {}", e)))?;

    let matches: Vec<String> = re
        .find_iter(&text)
        .map(|m| m.as_str().to_string())
        .collect();

    Ok(RegexMatch {
        matched: !matches.is_empty(),
        count: matches.len() as u32,
        matches,
    })
}

#[napi]
pub fn regex_replace(text: String, pattern: String, replacement: String) -> Result<String> {
    // Size limits to prevent ReDoS
    if text.len() > 10_000_000 {
        return Err(Error::new(Status::InvalidArg, "Text too large (max 10MB)"));
    }
    if pattern.len() > 10_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Pattern too large (max 10KB)",
        ));
    }

    let re = regex::Regex::new(&pattern)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid regex: {}", e)))?;
    Ok(re.replace_all(&text, replacement.as_str()).to_string())
}

#[napi]
pub fn regex_test(text: String, pattern: String) -> Result<bool> {
    // Size limits to prevent ReDoS
    if text.len() > 10_000_000 {
        return Err(Error::new(Status::InvalidArg, "Text too large (max 10MB)"));
    }
    if pattern.len() > 10_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Pattern too large (max 10KB)",
        ));
    }

    let re = regex::Regex::new(&pattern)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid regex: {}", e)))?;
    Ok(re.is_match(&text))
}

// =============================================================================
// JSON OPERATIONS
// =============================================================================

#[napi(object)]
pub struct JsonValidation {
    pub valid: bool,
    pub error: Option<String>,
}

#[napi]
pub fn validate_json(json_string: String) -> JsonValidation {
    // Limit input size to prevent DoS
    if json_string.len() > 10_000_000 {
        return JsonValidation {
            valid: false,
            error: Some("Input too large (max 10MB)".to_string()),
        };
    }

    match serde_json::from_str::<serde_json::Value>(&json_string) {
        Ok(_) => JsonValidation {
            valid: true,
            error: None,
        },
        Err(e) => JsonValidation {
            valid: false,
            error: Some(e.to_string()),
        },
    }
}

#[napi(object)]
pub struct JsonProcessResult {
    pub success: bool,
    pub data: Option<String>,
    pub error: Option<String>,
}

#[napi]
pub async fn process_json(json_string: String) -> Result<JsonProcessResult> {
    // Limit input size
    if json_string.len() > 10_000_000 {
        return Err(Error::new(Status::InvalidArg, "Input too large (max 10MB)"));
    }

    match serde_json::from_str::<serde_json::Value>(&json_string) {
        Ok(value) => Ok(JsonProcessResult {
            success: true,
            data: Some(value.to_string()),
            error: None,
        }),
        Err(e) => Ok(JsonProcessResult {
            success: false,
            data: None,
            error: Some(e.to_string()),
        }),
    }
}

#[napi]
pub async fn minify_json(json_string: String) -> Result<String> {
    // Limit input size
    if json_string.len() > 10_000_000 {
        return Err(Error::new(Status::InvalidArg, "Input too large (max 10MB)"));
    }

    let value: serde_json::Value = serde_json::from_str(&json_string)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid JSON: {}", e)))?;

    serde_json::to_string(&value).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Serialization failed: {}", e),
        )
    })
}

#[napi]
pub async fn prettify_json(json_string: String, indent: Option<u32>) -> Result<String> {
    // Limit input size
    if json_string.len() > 10_000_000 {
        return Err(Error::new(Status::InvalidArg, "Input too large (max 10MB)"));
    }

    let value: serde_json::Value = serde_json::from_str(&json_string)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid JSON: {}", e)))?;

    let indent_spaces = indent.unwrap_or(2) as usize;

    // Use serde_json's formatter with custom indent
    let formatted = serde_json::to_string_pretty(&value).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Serialization failed: {}", e),
        )
    })?;

    // Safe indent replacement: only replace leading spaces on each line
    let lines: Vec<&str> = formatted.lines().collect();
    let mut result = String::new();

    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            result.push('\n');
        }

        // Count leading spaces
        let leading_spaces = line.chars().take_while(|&c| c == ' ').count();

        // Convert indent depth (2 spaces = 1 level)
        let indent_level = leading_spaces / 2;
        let new_indent = " ".repeat(indent_level * indent_spaces);

        // Replace leading spaces with new indent
        let trimmed = line.trim_start();
        result.push_str(&new_indent);
        result.push_str(trimmed);
    }

    Ok(result)
}

// =============================================================================
// PLUGIN METADATA
// =============================================================================

#[napi(object)]
pub struct PluginInfo {
    pub name: String,
    pub version: String,
    pub rust_version: String,
    pub target_triple: String,
    pub features: Vec<String>,
}

#[napi]
pub fn get_plugin_info() -> PluginInfo {
    PluginInfo {
        name: env!("CARGO_PKG_NAME").to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        rust_version: "1.91.0".to_string(),
        target_triple: std::env::consts::ARCH.to_string() + "-" + std::env::consts::OS,
        features: vec![
            "string_processing".to_string(),
            "cryptography".to_string(),
            "json".to_string(),
            "filesystem".to_string(),
            "webhooks".to_string(),
            "encoding".to_string(),
            "regex".to_string(),
            "uuid".to_string(),
            "data_processor".to_string(),
        ],
    }
}

#[napi]
pub fn health_check() -> String {
    "ok".to_string()
}

#[napi]
pub fn benchmark(iterations: u32) -> f64 {
    let start = std::time::Instant::now();
    let mut count = 0u64;
    for i in 0..iterations {
        count = count.wrapping_add(i as u64);
    }
    start.elapsed().as_micros() as f64
}

// =============================================================================
// ADVANCED NAPI-RS FEATURES
// =============================================================================

mod advanced;
mod crypto;
mod data;
mod pure_logic;

// Re-export commonly used functions
pub use advanced::*;
pub use crypto::*;
pub use data::*;
