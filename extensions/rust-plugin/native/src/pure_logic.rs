//! Pure logic functions for testing - NO NAPI dependencies
//! These functions can be tested with `cargo test`

#![allow(dead_code)]

/// Maximum sizes for validation
pub const MAX_PATH_LENGTH: usize = 4096;
pub const MAX_STRING_SIZE: usize = 10_000_000;
pub const MAX_LEVENSHTEIN_LEN: usize = 10_000;

/// Validate a file path for security issues
pub fn validate_path(path: &str) -> Result<(), String> {
    if path.contains('\0') {
        return Err("Invalid path: null byte detected".to_string());
    }
    if path.contains("..") {
        return Err("Invalid path: path traversal detected".to_string());
    }
    if path.len() > MAX_PATH_LENGTH {
        return Err(format!(
            "Path too long (max {} characters)",
            MAX_PATH_LENGTH
        ));
    }
    Ok(())
}

/// Validate string size for DoS prevention
pub fn validate_string_size(input: &str, max_size: usize) -> Result<(), String> {
    if input.len() > max_size {
        return Err(format!("Input too large (max {} bytes)", max_size));
    }
    Ok(())
}

/// Levenshtein distance with O(min(m,n)) space complexity
pub fn levenshtein_distance(s1: &str, s2: &str) -> Result<u32, String> {
    let len1 = s1.chars().count();
    let len2 = s2.chars().count();

    if len1 > MAX_LEVENSHTEIN_LEN || len2 > MAX_LEVENSHTEIN_LEN {
        return Err(format!(
            "Input too large (max {} chars each)",
            MAX_LEVENSHTEIN_LEN
        ));
    }

    let chars1: Vec<char> = s1.chars().collect();
    let chars2: Vec<char> = s2.chars().collect();

    let (shorter, longer) = if len1 < len2 {
        (&chars1, &chars2)
    } else {
        (&chars2, &chars1)
    };
    let short_len = shorter.len();

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

/// Pattern match with wildcards using iterative DP (no recursion)
pub fn pattern_match(text: &str, pattern: &str) -> bool {
    let pattern_chars: Vec<char> = pattern.chars().collect();
    let text_chars: Vec<char> = text.chars().collect();
    let m = pattern_chars.len();
    let n = text_chars.len();

    let mut prev_row: Vec<bool> = vec![false; n + 1];
    let mut curr_row: Vec<bool> = vec![false; n + 1];

    prev_row[0] = true;

    for i in 1..=m {
        curr_row[0] = pattern_chars[i - 1] == '*' && prev_row[0];
        for j in 1..=n {
            match pattern_chars[i - 1] {
                '*' => {
                    curr_row[j] = prev_row[j] || curr_row[j - 1];
                }
                '?' => {
                    curr_row[j] = prev_row[j - 1];
                }
                c => {
                    curr_row[j] = prev_row[j - 1] && c == text_chars[j - 1];
                }
            }
        }
        std::mem::swap(&mut prev_row, &mut curr_row);
    }

    prev_row[n]
}

/// Text statistics
#[derive(Debug, Clone, PartialEq)]
pub struct TextStats {
    pub characters: f64,
    pub characters_no_spaces: f64,
    pub words: f64,
    pub lines: f64,
    pub bytes: f64,
}

/// Compute text statistics
pub fn compute_text_stats(text: &str) -> TextStats {
    TextStats {
        characters: text.chars().count() as f64,
        characters_no_spaces: text.chars().filter(|c| !c.is_whitespace()).count() as f64,
        words: text.split_whitespace().count() as f64,
        lines: text.lines().count() as f64,
        bytes: text.len() as f64,
    }
}

/// RLE compress
pub fn rle_compress(data: &str) -> String {
    let mut compressed = Vec::new();
    let mut chars = data.chars().peekable();

    while let Some(c) = chars.next() {
        let mut count = 1u8;
        while chars.peek() == Some(&c) && count < 255 {
            chars.next();
            count = count.saturating_add(1);
        }
        compressed.push(count);
        compressed.push(c as u8);
    }

    compressed.iter().map(|&b| b as char).collect()
}

/// RLE decompress with bomb protection
pub fn rle_decompress(compressed: &str, max_output: usize) -> Result<String, String> {
    let mut decompressed = String::new();
    let mut bytes = compressed.bytes().peekable();
    let mut decompressed_size = 0usize;

    while let Some(count_byte) = bytes.next() {
        if count_byte == 0 {
            return Err("Invalid count byte (zero)".to_string());
        }

        if let Some(char_byte) = bytes.next() {
            let count = count_byte as usize;
            decompressed_size = decompressed_size
                .checked_add(count)
                .ok_or_else(|| "Decompressed size too large".to_string())?;

            if decompressed_size > max_output {
                return Err(format!(
                    "Decompressed data too large (max {} bytes)",
                    max_output
                ));
            }

            let ch = char_byte as char;
            for _ in 0..count {
                decompressed.push(ch);
            }
        } else {
            return Err("Invalid compressed data: missing character".to_string());
        }
    }

    Ok(decompressed)
}

// =============================================================================
// UNIT TESTS - These can run with `cargo test`
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // Path validation tests
    #[test]
    fn test_validate_path_null_byte() {
        assert!(validate_path("file\x00.txt").is_err());
    }

    #[test]
    fn test_validate_path_traversal() {
        assert!(validate_path("../../../etc/passwd").is_err());
        assert!(validate_path("..\\..\\windows").is_err());
    }

    #[test]
    fn test_validate_path_too_long() {
        let long_path = "a".repeat(5000);
        assert!(validate_path(&long_path).is_err());
    }

    #[test]
    fn test_validate_path_valid() {
        assert!(validate_path("/tmp/test.txt").is_ok());
        assert!(validate_path("relative/path.txt").is_ok());
    }

    // String size validation tests
    #[test]
    fn test_validate_string_size_ok() {
        let input = "x".repeat(100);
        assert!(validate_string_size(&input, 200).is_ok());
    }

    #[test]
    fn test_validate_string_size_too_large() {
        let input = "x".repeat(200);
        assert!(validate_string_size(&input, 100).is_err());
    }

    // Levenshtein distance tests
    #[test]
    fn test_levenshtein_basic() {
        assert_eq!(levenshtein_distance("hello", "hello").unwrap(), 0);
        assert_eq!(levenshtein_distance("hello", "hallo").unwrap(), 1);
        assert_eq!(levenshtein_distance("hello", "hola").unwrap(), 3);
    }

    #[test]
    fn test_levenshtein_empty() {
        assert_eq!(levenshtein_distance("", "").unwrap(), 0);
        assert_eq!(levenshtein_distance("hello", "").unwrap(), 5);
        assert_eq!(levenshtein_distance("", "hello").unwrap(), 5);
    }

    #[test]
    fn test_levenshtein_size_limit() {
        let big = "x".repeat(11_000);
        assert!(levenshtein_distance(&big, &big).is_err());
    }

    // Pattern match tests
    #[test]
    fn test_pattern_match_exact() {
        assert!(pattern_match("hello", "hello"));
        assert!(!pattern_match("hello", "world"));
    }

    #[test]
    fn test_pattern_match_wildcard_question() {
        assert!(pattern_match("hello", "h?llo"));
        assert!(pattern_match("hallo", "h?llo"));
        assert!(!pattern_match("hllo", "h?llo"));
    }

    #[test]
    fn test_pattern_match_wildcard_star() {
        assert!(pattern_match("hello", "h*o"));
        assert!(pattern_match("ho", "h*o"));
        assert!(pattern_match("hexxxxxo", "h*o"));
        assert!(!pattern_match("hello", "h*x"));
    }

    #[test]
    fn test_pattern_match_empty() {
        assert!(pattern_match("", ""));
        assert!(pattern_match("", "*"));
        assert!(!pattern_match("", "?"));
    }

    // Text stats tests
    #[test]
    fn test_text_stats_basic() {
        let stats = compute_text_stats("hello world");
        assert_eq!(stats.characters, 11.0);
        assert_eq!(stats.words, 2.0);
        assert_eq!(stats.lines, 1.0);
        assert_eq!(stats.bytes, 11.0);
    }

    #[test]
    fn test_text_stats_empty() {
        let stats = compute_text_stats("");
        assert_eq!(stats.characters, 0.0);
        assert_eq!(stats.words, 0.0);
    }

    #[test]
    fn test_text_stats_no_overflow() {
        // Large text should not overflow (using f64)
        let big = "x".repeat(1_000_000);
        let stats = compute_text_stats(&big);
        assert_eq!(stats.characters, 1_000_000.0);
    }

    // RLE tests
    #[test]
    fn test_rle_compress_basic() {
        let compressed = rle_compress("aaabbbccc");
        // Should have count+char pairs
        assert!(compressed.len() < "aaabbbccc".len() * 2);
    }

    #[test]
    fn test_rle_decompress_basic() {
        let original = "aaabbbccc";
        let compressed = rle_compress(original);
        let decompressed = rle_decompress(&compressed, 1000).unwrap();
        assert_eq!(decompressed, original);
    }

    #[test]
    fn test_rle_bomb_protection() {
        // Create a compressed string where each pair would decompress to 255 'x's
        // Use char::from(255u8) which is valid
        let count_char = char::from(255u8); // max count
        let mut bomb = String::new();
        for _ in 0..1_000 {
            bomb.push(count_char);
            bomb.push('x');
        }
        // Each pair = 255 chars, 1000 pairs = 255,000 chars
        let result = rle_decompress(&bomb, 1000);
        assert!(result.is_err());
    }

    #[test]
    fn test_rle_decompress_size_limit() {
        let original = "x".repeat(100);
        let compressed = rle_compress(&original);
        let result = rle_decompress(&compressed, 10);
        assert!(result.is_err());
    }
}
