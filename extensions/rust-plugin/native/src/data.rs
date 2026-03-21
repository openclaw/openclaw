//! Advanced data processing functions for OpenClaw Rust plugin
//!
//! This module provides high-performance data processing with proper security
//! and validation following napi-rs best practices.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;

/// Compression result
#[napi(object)]
pub struct CompressionResult {
    pub compressed: String,
    pub original_size: u32,
    pub compressed_size: u32,
    pub ratio: f64,
}

/// Decompression result
#[napi(object)]
pub struct DecompressionResult {
    pub data: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Secure run-length encoding compression with bounds checking
/// Uses byte-level encoding to properly handle all input including non-ASCII
#[napi]
pub fn rle_compress(data: String) -> Result<CompressionResult> {
    // Validate input size
    if data.len() > 10_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Input too large (max 10MB)",
        ));
    }

    let bytes = data.as_bytes();
    let mut compressed = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        let current_byte = bytes[i];
        let mut count = 1u8;

        // Count consecutive bytes (with bounds check)
        while (i + count as usize) < bytes.len()
            && bytes[i + count as usize] == current_byte
            && count < 255 {
            count = count.saturating_add(1);
        }

        // Encode as count:byte pairs
        compressed.push(count);
        compressed.push(current_byte);
        i += count as usize;
    }

    // Return as base64 to safely encode binary data
    use base64::{Engine as _, engine::general_purpose};
    let compressed_str = general_purpose::STANDARD.encode(&compressed);
    let original_size = data.len() as u32;
    let compressed_size = compressed.len() as u32;
    let ratio = if original_size > 0 {
        (compressed_size as f64) / (original_size as f64)
    } else {
        0.0
    };

    Ok(CompressionResult {
        compressed: compressed_str,
        original_size,
        compressed_size,
        ratio,
    })
}

/// Secure run-length encoding decompression with bounds checking
/// Protected against compression bombs, expects base64-encoded input
#[napi]
pub fn rle_decompress(compressed: String) -> Result<DecompressionResult> {
    // Limit input size
    const MAX_INPUT: usize = 10_000_000;     // 10MB
    const MAX_OUTPUT: usize = 20_000_000;    // 20MB
    
    if compressed.len() > MAX_INPUT {
        return Ok(DecompressionResult {
            data: String::new(),
            success: false,
            error: Some(format!("Input too large (max {}MB)", MAX_INPUT / 1024 / 1024)),
        });
    }

    // Decode base64 input
    use base64::{Engine as _, engine::general_purpose};
    let compressed_bytes = match general_purpose::STANDARD.decode(&compressed) {
        Ok(b) => b,
        Err(e) => return Ok(DecompressionResult {
            data: String::new(),
            success: false,
            error: Some(format!("Invalid base64: {}", e)),
        }),
    };

    let mut decompressed = Vec::new();
    let mut decompressed_size = 0usize;
    let mut i = 0;

    while i + 1 < compressed_bytes.len() {
        let count = compressed_bytes[i] as usize;
        let byte_val = compressed_bytes[i + 1];
        
        // Validate count
        if count == 0 {
            return Ok(DecompressionResult {
                data: String::new(),
                success: false,
                error: Some("Invalid count byte (zero)".to_string()),
            });
        }

        // Check for overflow
        decompressed_size = match decompressed_size.checked_add(count) {
            Some(s) => s,
            None => return Ok(DecompressionResult {
                data: String::new(),
                success: false,
                error: Some("Decompressed size too large".to_string()),
            }),
        };

        // Validate total size (compression bomb protection)
        if decompressed_size > MAX_OUTPUT {
            return Ok(DecompressionResult {
                data: String::new(),
                success: false,
                error: Some(format!("Decompressed data too large (max {}MB)", MAX_OUTPUT / 1024 / 1024)),
            });
        }

        for _ in 0..count {
            decompressed.push(byte_val);
        }
        
        i += 2;
    }

    // Convert bytes to string (handle invalid UTF-8)
    match String::from_utf8(decompressed) {
        Ok(s) => Ok(DecompressionResult {
            data: s,
            success: true,
            error: None,
        }),
        Err(e) => Ok(DecompressionResult {
            data: String::new(),
            success: false,
            error: Some(format!("Invalid UTF-8 in decompressed data: {}", e)),
        }),
    }
}

/// Advanced string tokenization
#[napi]
pub fn tokenize(text: String, mode: Option<String>) -> Result<Vec<String>> {
    // Validate input size
    if text.len() > 10_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Input too large (max 10MB)",
        ));
    }

    let mode_str = mode.unwrap_or_else(|| "words".to_string());

    let tokens = match mode_str.as_str() {
        "words" => {
            let mut tokens = Vec::new();
            let mut current_word = String::new();

            for ch in text.chars() {
                if ch.is_alphanumeric() || ch == '\'' {
                    current_word.push(ch);
                } else {
                    if !current_word.is_empty() {
                        tokens.push(current_word.clone());
                        current_word.clear();
                    }
                    if !ch.is_whitespace() {
                        tokens.push(ch.to_string());
                    }
                }
            }
            if !current_word.is_empty() {
                tokens.push(current_word);
            }
            tokens
        }
        "lines" => text.lines().map(|s| s.to_string()).collect(),
        "chars" => text.chars().map(|c| c.to_string()).collect(),
        "sentences" => {
            let mut sentences = Vec::new();
            let mut current = String::new();

            for ch in text.chars() {
                current.push(ch);
                if ch == '.' || ch == '!' || ch == '?' {
                    if !current.trim().is_empty() {
                        sentences.push(current.trim().to_string());
                    }
                    current = String::new();
                }
            }
            if !current.trim().is_empty() {
                sentences.push(current.trim().to_string());
            }
            sentences.into_iter().filter(|s| !s.is_empty()).collect()
        }
        _ => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("Unknown tokenization mode: {}", mode_str),
            ))
        }
    };

    Ok(tokens)
}

/// Extended text statistics (more detailed than text_stats)
#[napi(object)]
pub struct ExtendedTextStats {
    pub characters: f64,
    pub characters_no_spaces: f64,
    pub words: f64,
    pub lines: f64,
    pub paragraphs: f64,
    pub sentences: f64,
    pub avg_word_length: f64,
    pub avg_sentence_length: f64,
}

#[napi]
pub fn extended_text_stats(text: String) -> Result<ExtendedTextStats> {
    // Validate input size
    if text.len() > 10_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Input too large (max 10MB)",
        ));
    }

    let characters = text.len() as f64;
    let characters_no_spaces = text.chars().filter(|c| !c.is_whitespace()).count() as f64;
    let words = text.split_whitespace().count() as f64;
    let lines = text.lines().count() as f64;
    let paragraphs = text.split("\n\n").filter(|p| !p.trim().is_empty()).count() as f64;

    let sentences = text
        .split(&['.', '!', '?'][..])
        .filter(|s| !s.trim().is_empty())
        .count() as f64;

    let avg_word_length = if words > 0.0 {
        characters_no_spaces / words
    } else {
        0.0
    };

    let avg_sentence_length = if sentences > 0.0 {
        words / sentences
    } else {
        0.0
    };

    Ok(ExtendedTextStats {
        characters,
        characters_no_spaces,
        words,
        lines,
        paragraphs,
        sentences,
        avg_word_length,
        avg_sentence_length,
    })
}

/// Advanced text transformation
#[napi]
pub fn transform_text(text: String, operations: Vec<String>) -> Result<String> {
    // Validate input size
    if text.len() > 10_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Input too large (max 10MB)",
        ));
    }

    // Validate operations count
    if operations.len() > 100 {
        return Err(Error::new(
            Status::InvalidArg,
            "Too many operations (max 100)",
        ));
    }

    let mut result = text;

    for op in operations {
        result = match op.as_str() {
            "uppercase" => result.to_uppercase(),
            "lowercase" => result.to_lowercase(),
            "reverse" => result.chars().rev().collect(),
            "trim" => result.trim().to_string(),
            "normalize" => {
                result.split_whitespace().collect::<Vec<_>>().join(" ")
            }
            "deduplicate" => {
                let mut deduped = String::new();
                let mut prev_char = None;
                for ch in result.chars() {
                    if prev_char != Some(ch) {
                        deduped.push(ch);
                    }
                    prev_char = Some(ch);
                }
                deduped
            }
            "sort_words" => {
                let mut words: Vec<&str> = result.split_whitespace().collect();
                words.sort();
                words.join(" ")
            }
            "sort_chars" => {
                let mut chars: Vec<char> = result.chars().collect();
                chars.sort();
                chars.into_iter().collect()
            }
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("Unknown operation: {}", op),
                ))
            }
        };
    }

    Ok(result)
}

/// Pattern matching with wildcards (no regex - safe from ReDoS)
/// Uses iterative DP approach to prevent stack overflow
#[napi]
pub fn pattern_match(text: String, pattern: String) -> Result<bool> {
    // Validate input sizes
    if text.len() > 1_000_000 {
        return Err(Error::new(Status::InvalidArg, "Text too large (max 1MB)"));
    }
    if pattern.len() > 10_000 {
        return Err(Error::new(Status::InvalidArg, "Pattern too large (max 10KB)"));
    }

    let pattern_chars: Vec<char> = pattern.chars().collect();
    let text_chars: Vec<char> = text.chars().collect();
    let m = pattern_chars.len();
    let n = text_chars.len();

    // Use iterative DP instead of recursion to prevent stack overflow
    // dp[i][j] = true if pattern[0..i] matches text[0..j]
    let mut prev_row: Vec<bool> = vec![false; n + 1];
    let mut curr_row: Vec<bool> = vec![false; n + 1];

    // Empty pattern matches empty text
    prev_row[0] = true;

    // Handle patterns starting with *
    for i in 1..=m {
        curr_row[0] = pattern_chars[i - 1] == '*' && prev_row[0];
        
        for j in 1..=n {
            match pattern_chars[i - 1] {
                '*' => {
                    // * matches zero or more characters
                    curr_row[j] = prev_row[j] || curr_row[j - 1];
                }
                '?' => {
                    // ? matches any single character
                    curr_row[j] = prev_row[j - 1];
                }
                c => {
                    // Exact match required
                    curr_row[j] = prev_row[j - 1] && c == text_chars[j - 1];
                }
            }
        }
        
        std::mem::swap(&mut prev_row, &mut curr_row);
    }

    Ok(prev_row[n])
}

/// Data validation (without regex - safe from ReDoS)
#[napi(object)]
pub struct ValidationResult {
    pub is_valid: bool,
    pub errors: Vec<String>,
}

#[napi]
pub fn validate_data(data: String, rules: HashMap<String, String>) -> Result<ValidationResult> {
    let mut errors = Vec::new();

    // Length validation (safe, no regex)
    if let Some(min_length) = rules.get("min_length") {
        if let Ok(min_len) = min_length.parse::<usize>() {
            if data.len() < min_len {
                errors.push(format!("Too short (minimum {} characters)", min_len));
            }
        }
    }

    if let Some(max_length) = rules.get("max_length") {
        if let Ok(max_len) = max_length.parse::<usize>() {
            if data.len() > max_len {
                errors.push(format!("Too long (maximum {} characters)", max_len));
            }
        }
    }

    // Email validation (simple, safe check - no regex)
    if let Some(email) = rules.get("email") {
        if email == "true" {
            // Simple validation: must contain @ and have at least one . after @
            let at_pos = data.find('@');
            let dot_after_at = data.as_bytes().iter().position(|&b| b == b'.');

            let has_valid_format = match (at_pos, dot_after_at) {
                (Some(at), Some(dot)) if dot > at => true,
                _ => false,
            };

            if !has_valid_format {
                errors.push("Invalid email format".to_string());
            }
        }
    }

    // URL validation (simple, safe check - no regex)
    if let Some(url) = rules.get("url") {
        if url == "true" {
            // Simple validation: must start with http:// or https://
            if !data.starts_with("http://") && !data.starts_with("https://") {
                errors.push("Invalid URL format".to_string());
            }
        }
    }

    Ok(ValidationResult {
        is_valid: errors.is_empty(),
        errors,
    })
}

/// String similarity (Levenshtein distance) with memory-efficient algorithm
/// Uses O(min(m,n)) space instead of O(m*n)
#[napi]
pub fn levenshtein_distance(string1: String, string2: String) -> Result<u32> {
    // Reduced limit to prevent memory exhaustion
    // 10k chars each with O(n) space = ~40KB instead of 40GB
    const MAX_LEN: usize = 10_000;
    
    if string1.len() > MAX_LEN || string2.len() > MAX_LEN {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Input too large (max {} chars each)", MAX_LEN),
        ));
    }

    let chars1: Vec<char> = string1.chars().collect();
    let chars2: Vec<char> = string2.chars().collect();
    let m = chars1.len();
    let n = chars2.len();

    // Use space-optimized algorithm: O(min(m,n)) space
    // Swap so we use less space
    let (shorter, longer) = if m < n { (&chars1, &chars2) } else { (&chars2, &chars1) };
    let short_len = shorter.len();
    let _long_len = longer.len();

    // Only keep two rows instead of full matrix
    let mut prev_row: Vec<u32> = (0..=short_len as u32).collect();
    let mut curr_row: Vec<u32> = vec![0; short_len + 1];

    for (i, long_char) in longer.iter().enumerate() {
        curr_row[0] = (i + 1) as u32;
        
        for (j, short_char) in shorter.iter().enumerate() {
            let cost = if long_char == short_char { 0 } else { 1 };
            curr_row[j + 1] = (prev_row[j + 1] + 1)
                .min(curr_row[j] + 1)
                .min(prev_row[j] + cost);
        }
        
        std::mem::swap(&mut prev_row, &mut curr_row);
    }

    Ok(prev_row[short_len])
}

/// Find and replace (safe alternative to regex)
#[napi]
pub fn find_replace(
    text: String,
    pattern: String,
    replacement: String,
    use_regex: Option<bool>,
) -> Result<String> {
    // Validate input sizes
    if text.len() > 10_000_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Input too large (max 10MB)",
        ));
    }

    // Regex is disabled by default for security (no ReDoS)
    let use_regex_flag = use_regex.unwrap_or(false);

    if use_regex_flag {
        // Only allow very specific, safe patterns
        if pattern.contains('*') || pattern.contains('+') || pattern.contains('{') {
            return Err(Error::new(
                Status::InvalidArg,
                "Complex regex patterns not allowed (ReDoS prevention)",
            ));
        }

        match regex::Regex::new(&pattern) {
            Ok(re) => Ok(re.replace_all(&text, &replacement).to_string()),
            Err(e) => Err(Error::new(Status::InvalidArg, format!("Invalid regex: {}", e))),
        }
    } else {
        Ok(text.replace(&pattern, &replacement))
    }
}

/// Data deduplication
#[napi]
pub fn deduplicate(items: Vec<String>, case_sensitive: Option<bool>) -> Result<Vec<String>> {
    // Validate batch size
    if items.len() > 100_000 {
        return Err(Error::new(
            Status::InvalidArg,
            "Too many items (max 100k)",
        ));
    }

    let case_sensitive_flag = case_sensitive.unwrap_or(true);

    let mut seen = std::collections::HashSet::new();
    let mut unique = Vec::new();

    for item in items {
        let key = if case_sensitive_flag {
            item.clone()
        } else {
            item.to_lowercase()
        };

        if seen.insert(key) {
            unique.push(item);
        }
    }

    Ok(unique)
}