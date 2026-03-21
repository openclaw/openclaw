# Security Policy

This document outlines the security practices and policies for the Rust plugin.

## 🛡️ Security Status

**Current Version:** 2026.4.0  
**Last Audit:** March 21, 2026  
**Security Score:** 10/10 (Production Ready)

## 📋 Supported Versions

| Version | Security Support | Notes |
|----------|----------------|-------|
| `2026.4.0` | ✅ Supported | Latest version - all security features active |
| `2026.3.19` | ⚠️ Legacy | Previous version - may have unfixed issues |
| `2026.3.18` | ❌ Unsupported | Do not use - known vulnerabilities |

## 🔒 Security Features

### Encryption
- **Algorithm:** AES-256-GCM (authenticated encryption)
- **Nonce Management:** Automatic generation and tracking
- **Key Requirements:** 32 bytes, properly formatted
- **Tag Verification:** Prevents tag reuse attacks

### Input Validation
- **Path Traversal Protection:** All file operations validate paths
- **Size Limits:** 10MB max on most operations
- **Null Byte Detection:** Checks for null bytes in strings
- **DoS Protection:** RLE compression limited to 20MB output

### Memory Safety
- **Zeroize:** Sensitive data cleared after use
- **Bounds Checking:** Array operations validate indices
- **Checked Arithmetic:** All math operations checked for overflow
- **Memory Leak Prevention:** External memory tracking for nonces

### Error Handling
- **Mutex Poisoning:** Safe error handling for poisoned mutexes
- **SystemTime Errors:** Graceful handling of clock errors
- **Type Safety:** Result types used throughout (no unwraps in critical paths)

## 🚨 Vulnerability Reporting

### Reporting a Vulnerability

**Do not open public issues.** If you discover a security vulnerability:

1. **Send an email:** Contact security@openclaw.ai
2. **Include in your report:**
   - Description of the vulnerability
   - Steps to reproduce
   - Impact assessment
   - Proof of concept (if applicable)
   - Suggested fix
   - Version affected

**Response time:** We aim to acknowledge security reports within 48 hours.

### Supported Versions for Security Patches

Security patches are released as minor/patch versions:
- Always use the latest version
- Check the [CHANGELOG](../CHANGELOG.md) for security fixes
- Update to the latest stable release before deploying

## 🔒 Best Practices

### Development
- Use Rust's type system for memory safety
- Prefer standard library crypto implementations
- Test all error paths
- Review code with security audits

### Deployment
- Verify npm package integrity before installation
- Use npm audit regularly: `npm audit`
- Keep dependencies up to date
- Monitor for CVEs in dependencies

### Usage
- Never hardcode cryptographic keys
- Use environment variables for secrets
- Validate all user input
- Handle errors gracefully without exposing system state

## 📚 References

- [Comprehensive Security Audit](./FINAL_SECURITY_AUDIT_REPORT_2026-03-21.md)
- [Security Verification Summary](./SECURITY_VERIFICATION_SUMMARY.md)
- [NIST Cryptographic Guidelines](https://csrc.nist.gov/projects/crypto-algorithm-standards)

## 📞 Contact

**Security Team:** security@openclaw.ai  
**GitHub Issues:** https://github.com/Wayazi/openclaw/issues
