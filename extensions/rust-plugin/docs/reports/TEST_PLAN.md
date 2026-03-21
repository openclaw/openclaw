# Test Plan for @wayazi/rust-plugin

## Current State

**Test Coverage:** ~5% (only config parsing)
**Test Files:** 1 (index.test.ts - 21 lines)
**Test Status:** ❌ **INSUFFICIENT FOR PRODUCTION**

---

## Required Test Suite

### 1. Rust Unit Tests (native/src/)

#### 1.1 String Processing Tests

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process_string_uppercase() {
        let result = process_string("hello".to_string(), None);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "HELLO");
    }

    #[test]
    fn test_process_string_multiple_options() {
        let mut opts = HashMap::new();
        opts.insert("uppercase".to_string(), true);
        opts.insert("trim".to_string(), true);

        let result = process_string("  hello  ".to_string(), Some(opts));
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "HELLO");
    }

    #[test]
    fn test_batch_process() {
        let inputs = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let result = batch_process(inputs, None);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 3);
    }

    #[test]
    fn test_text_stats() {
        let stats = text_stats("Hello world\n".to_string());
        assert_eq!(stats.characters, 12);
        assert_eq!(stats.words, 2);
        assert_eq!(stats.lines, 1);
    }
}
```

#### 1.2 Cryptography Tests

```rust
#[test]
fn test_compute_hash_sha256() {
    let result = compute_hash("hello".to_string(), Some("sha256".to_string()));
    assert!(result.is_ok());
    let hash = result.unwrap();
    assert_eq!(hash, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
}

#[test]
fn test_compute_hash_blake3() {
    let result = compute_hash("hello".to_string(), Some("blake3".to_string()));
    assert!(result.is_ok());
    let hash = result.unwrap();
    assert_eq!(hash.len(), 64); // BLAKE3 is 64 hex chars
}

#[test]
fn test_aes256_gcm_encrypt_decrypt() {
    let key_hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let plaintext = "Hello, World!".to_string();

    let encrypted = aes256_gcm_encrypt(plaintext.clone(), key_hex.to_string(), None);
    assert!(encrypted.is_ok());

    let enc_result = encrypted.unwrap();
    let decrypted = aes256_gcm_decrypt(
        enc_result.ciphertext,
        key_hex.to_string(),
        enc_result.nonce,
    );
    assert!(decrypted.is_ok());

    let dec_result = decrypted.unwrap();
    assert!(dec_result.success);
    assert_eq!(dec_result.plaintext, plaintext);
}

#[test]
fn test_argon2_hash_verify() {
    let password = "test_password_123".to_string();
    let hash = argon2_hash(password.clone(), None);
    assert!(hash.is_ok());

    let hash_str = hash.unwrap();
    let verified = argon2_verify(password, hash_str);
    assert!(verified.is_ok());
    assert!(verified.unwrap());
}

#[test]
fn test_random_bytes_length() {
    let bytes = random_bytes(32);
    assert!(bytes.is_ok());
    assert_eq!(bytes.unwrap().len(), 32);
}

#[test]
fn test_random_bytes_limit() {
    let result = random_bytes(2_000_000); // Over 1MB limit
    assert!(result.is_err());
}
```

#### 1.3 File System Tests

```rust
#[test]
fn test_validate_path_rejects_traversal() {
    assert!(validate_path("../etc/passwd").is_err());
    assert!(validate_path("/etc/passwd").is_err());
    assert!(validate_path("C:\\Windows\\System32").is_err());
}

#[test]
fn test_validate_path_rejects_long_paths() {
    let long_path = "a".repeat(5000);
    assert!(validate_path(&long_path).is_err());
}

#[test]
fn test_validate_path_accepts_valid() {
    assert!(validate_path("relative/path/to/file.txt").is_ok());
    assert!(validate_path("file.txt").is_ok());
}

#[test]
fn test_hash_file_size_limit() {
    // Test with a file over 100MB limit
    // This should return an error
}
```

#### 1.4 Input Validation Tests

```rust
#[test]
fn test_size_limits() {
    // Test all size limits
    assert!(random_bytes(1_000_001).is_err()); // Over 1MB
    assert!(batch_process(vec!["test".to_string(); 10_001], None).is_err()); // Over 10k items
}

#[test]
fn test_key_validation() {
    // Test AES key validation
    let short_key = "0123456789abcdef"; // 16 hex chars = 8 bytes
    let result = aes256_gcm_encrypt("test".to_string(), short_key.to_string(), None);
    assert!(result.is_err());
}
```

### 2. TypeScript Integration Tests

#### 2.1 Tool Registration Tests

```typescript
describe("Rust Plugin - Tool Registration", () => {
  it("should register all 38 tools", async () => {
    const plugin = await import("./index.ts");
    // Verify all tools are registered
    const expectedTools = [
      "rust_process_string",
      "rust_batch_process",
      "rust_compute_hash",
      "rust_aes256_gcm_encrypt",
      // ... all 38 tools
    ];

    for (const toolName of expectedTools) {
      expect(await toolExists(toolName)).toBe(true);
    }
  });
});
```

#### 2.2 Cryptography Integration Tests

```typescript
describe("Rust Plugin - Cryptography", () => {
  it("should compute SHA-256 hash correctly", async () => {
    const result = await executeTool("rust_compute_hash", {
      data: "hello",
      algorithm: "sha256",
    });

    expect(result.success).toBe(true);
    expect(result.hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("should encrypt and decrypt correctly", async () => {
    const keyHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const plaintext = "Secret message";

    const encrypted = await executeTool("rust_aes256_gcm_encrypt", {
      plaintext,
      key_hex: keyHex,
    });

    expect(encrypted.success).toBe(true);
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.nonce).toBeDefined();

    const decrypted = await executeTool("rust_aes256_gcm_decrypt", {
      ciphertext_hex: encrypted.ciphertext,
      key_hex: keyHex,
      nonce_hex: encrypted.nonce,
    });

    expect(decrypted.success).toBe(true);
    expect(decrypted.plaintext).toBe(plaintext);
  });
});
```

#### 2.3 File System Integration Tests

```typescript
describe("Rust Plugin - File System", () => {
  it("should reject path traversal", async () => {
    const result = await executeTool("rust_get_file_info", {
      path: "../../../etc/passwd",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("path traversal");
  });

  it("should handle file operations correctly", async () => {
    const testFile = "/tmp/test-rust-plugin.txt";
    const content = "Hello, Rust!";

    // Write
    await executeTool("rust_write_file", {
      path: testFile,
      content,
    });

    // Read
    const readResult = await executeTool("rust_read_file", {
      path: testFile,
    });

    expect(readResult.content).toBe(content);

    // Cleanup
    await executeTool("rust_delete_file", { path: testFile });
  });
});
```

### 3. Security Tests

#### 3.1 Input Validation Security Tests

```typescript
describe("Rust Plugin - Security", () => {
  it("should reject oversized inputs", async () => {
    const largeInput = "a".repeat(100_000_001); // Over 100MB

    const result = await executeTool("rust_process_string", {
      input: largeInput,
      options: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("too large");
  });

  it("should reject invalid cryptographic keys", async () => {
    const shortKey = "0123456789abcdef"; // Too short for AES-256

    const result = await executeTool("rust_aes256_gcm_encrypt", {
      plaintext: "test",
      key_hex: shortKey,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("32 bytes");
  });
});
```

#### 3.2 Path Traversal Tests

```typescript
describe("Rust Plugin - Path Traversal Protection", () => {
  const maliciousPaths = [
    "../../../etc/passwd",
    "/etc/passwd",
    "C:\\Windows\\System32\\config\\SAM",
    "..\\..\\..\\windows\\system32",
    "./../../etc/shadow",
  ];

  maliciousPaths.forEach((path) => {
    it(`should block malicious path: ${path}`, async () => {
      const result = await executeTool("rust_read_file", { path });
      expect(result.success).toBe(false);
      expect(result.error).toContain("path traversal");
    });
  });
});
```

### 4. Property-Based Tests (proptest)

```rust
#[cfg(test)]
mod proptests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn test_roundtrip_hash(s in "\\PC*") {
            let hash = compute_hash(s.clone(), Some("sha256".to_string()));
            prop_assert!(hash.is_ok());
            prop_assert_eq!(hash.unwrap().len(), 64);
        }

        #[test]
        fn test_string_transformations(s in "\\PC*") {
            let result = process_string(s.clone(), None);
            prop_assert!(result.is_ok());
            prop_assert_eq!(result.unwrap(), s);
        }

        #[test]
        fn test_encrypt_decrypt_roundtrip(plaintext in "[a-zA-Z0-9]{1,100}") {
            let key_hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

            let encrypted = aes256_gcm_encrypt(plaintext.clone(), key_hex.to_string(), None);
            prop_assert!(encrypted.is_ok());

            let enc = encrypted.unwrap();
            let decrypted = aes256_gcm_decrypt(enc.ciphertext, key_hex.to_string(), enc.nonce);
            prop_assert!(decrypted.is_ok());

            let dec = decrypted.unwrap();
            prop_assert_eq!(dec.plaintext, plaintext);
        }
    }
}
```

### 5. Performance Benchmarks

```rust
#[cfg(test)]
mod benchmarks {
    use super::*;
    use std::time::Instant;

    #[test]
    fn benchmark_sha256() {
        let start = Instant::now();
        for _ in 0..10_000 {
            let _ = compute_hash("test data".to_string(), Some("sha256".to_string()));
        }
        let duration = start.elapsed();
        println!("SHA-256 (10k ops): {:?}", duration);
        assert!(duration.as_millis() < 1000); // Should be fast
    }

    #[test]
    fn benchmark_blake3() {
        let start = Instant::now();
        for _ in 0..10_000 {
            let _ = compute_hash("test data".to_string(), Some("blake3".to_string()));
        }
        let duration = start.elapsed();
        println!("BLAKE3 (10k ops): {:?}", duration);
        assert!(duration.as_millis() < 500); // BLAKE3 should be faster
    }
}
```

---

## Test Infrastructure

### Cargo.toml Additions

```toml
[dev-dependencies]
proptest = "1.5"
criterion = "0.5"

[[bench]]
name = "crypto_bench"
harness = false
```

### Package.json Scripts

```json
{
  "scripts": {
    "test": "vitest run",
    "test:rust": "cargo test",
    "test:coverage": "cargo tarpaulin --out Html",
    "test:bench": "cargo bench",
    "test:all": "pnpm test:rust && pnpm test"
  }
}
```

---

## Coverage Goals

| Module      | Target   | Priority     |
| ----------- | -------- | ------------ |
| lib.rs      | 90%      | HIGH         |
| crypto.rs   | 95%      | CRITICAL     |
| data.rs     | 85%      | HIGH         |
| advanced.rs | 80%      | MEDIUM       |
| index.ts    | 80%      | HIGH         |
| **Overall** | **85%+** | **CRITICAL** |

---

## Test Execution Plan

### Phase 1: Critical Path (Week 1)

- [ ] Cryptography tests (encrypt/decrypt, hash, random)
- [ ] Input validation tests (size limits, key validation)
- [ ] Path traversal tests
- [ ] Basic integration tests

### Phase 2: Coverage (Week 2)

- [ ] String processing tests
- [ ] File system tests
- [ ] Encoding tests
- [ ] Regex tests
- [ ] Property-based tests

### Phase 3: Performance (Week 3)

- [ ] Benchmark suite
- [ ] Performance regression tests
- [ ] Load tests
- [ ] Memory profiling

### Phase 4: CI/CD Integration (Week 4)

- [ ] Set up GitHub Actions
- [ ] Automated testing on PR
- [ ] Coverage reporting
- [ ] Performance regression detection

---

## Success Criteria

- [ ] All tests pass consistently
- [ ] Coverage ≥ 85%
- [ ] No flaky tests
- [ ] CI/CD pipeline green
- [ ] Performance benchmarks documented
- [ ] Security tests passing
- [ ] Property-based tests finding no bugs

---

## Timeline

**Week 1:** Critical security tests
**Week 2:** Comprehensive coverage
**Week 3:** Performance benchmarks
**Week 4:** CI/CD integration

**Total:** 4 weeks to full test suite

---

_Last Updated: March 20, 2026_
_Priority: HIGH - Required for next release_
