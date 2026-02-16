# Plugin Signing and Verification Implementation

## Summary

This document describes the implementation of the plugin signing and verification system for OpenClaw (Security Task #10).

## Implementation Status: ✅ COMPLETE

All required components have been implemented:

### 1. Core Signing Implementation ✅

**File:** `src/plugins/plugin-signing.ts`

Implements the `PluginSigner` class with the following methods:

- `signPlugin()` - Signs a plugin with RSA-SHA256
- `verifySignature()` - Verifies a plugin signature against trusted public keys
- `verifyPluginDirectory()` - Loads and verifies signature from plugin directory
- `checkIntegrity()` - Checks if plugin has been tampered with
- `getSignatureMetadata()` - Retrieves signature info without verification

**Features:**

- RSA-SHA256 cryptographic signatures (4096-bit recommended)
- Base64-encoded signatures
- PEM format for keys
- Timestamp and version tracking
- Comprehensive error handling

### 2. Signing CLI Tool ✅

**File:** `scripts/sign-plugin.ts`

Command-line tool for signing plugins:

```bash
pnpm tsx scripts/sign-plugin.ts <plugin-path> <version>
```

**Features:**

- Reads private key from `PLUGIN_SIGNING_KEY` env var or `./keys/plugin-signing-key.pem`
- Creates `plugin.signature.json` in plugin directory
- Clear error messages and usage instructions
- Validation of inputs

**Package.json script:**

```bash
pnpm plugin:sign <plugin-path> <version>
```

### 3. Key Generation Script ✅

**File:** `scripts/generate-signing-keys.sh`

Bash script to generate RSA key pairs:

```bash
bash scripts/generate-signing-keys.sh
```

**Features:**

- Generates 4096-bit RSA keys
- Creates `keys/` directory
- Outputs private key (`.pem`) and public key (`.pub`)
- Sets proper file permissions (600 for private, 644 for public)
- Safety checks (warns before overwriting existing keys)
- Comprehensive security warnings

**Package.json script:**

```bash
pnpm plugin:keygen
```

### 4. Loader Integration ✅

**File:** `src/plugins/loader.ts`

Updated the plugin loader to verify signatures before loading:

**Features:**

- Signature verification before plugin execution
- Configurable via `config.plugins.requireSignature`
- Trusted keys list via `config.plugins.trustedPublicKeys`
- Production mode enforcement (auto-enables in `NODE_ENV=production`)
- Bundled plugins exempted from verification
- Clear diagnostic messages for verification failures
- Warning for unsigned plugins when verification is disabled

**Configuration Example:**

```yaml
plugins:
  requireSignature: true
  trustedPublicKeys:
    - |
      -----BEGIN PUBLIC KEY-----
      MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
      -----END PUBLIC KEY-----
```

### 5. CI/CD Integration ✅

**File:** `.github/workflows/sign-and-publish.yml`

GitHub Actions workflow for automated signing and publishing:

**Triggers:**

- Git tags matching `plugin-*-v*` pattern (e.g., `plugin-memory-sqlite-v1.0.0`)
- Manual workflow dispatch

**Features:**

- Automatic plugin signing from tags
- Private key stored as GitHub secret (`PLUGIN_SIGNING_KEY`)
- Creates signed release artifacts
- Publishes to GitHub Releases
- Verification step to ensure signature was created
- Secure cleanup of private keys after signing

**Usage:**

```bash
git tag plugin-my-plugin-v1.0.0
git push --tags
```

### 6. Comprehensive Tests ✅

**File:** `test/security/signature-verification.test.ts`

Complete test suite covering:

**Test Categories:**

1. **Plugin Signing Tests**
   - Sign plugin successfully
   - Error on missing plugin file
   - Error on invalid private key

2. **Signature Verification Tests**
   - Verify valid signature
   - Reject unsigned plugin
   - Reject tampered plugin
   - Reject untrusted public key
   - Accept any trusted key from list
   - Reject when no trusted keys provided

3. **Plugin Directory Verification Tests**
   - Verify plugin directory with valid signature
   - Fail on missing signature file
   - Fail on corrupted signature file

4. **Integrity Check Tests**
   - Detect plugin tampering
   - Handle missing files

5. **Signature Metadata Tests**
   - Retrieve metadata without verification
   - Handle missing/corrupted signature files

6. **Production Mode Tests**
   - Enforce signature verification behavior

7. **Version Tests**
   - Sign and verify different versions

**Total Test Coverage:** 15+ test cases covering all security scenarios

### 7. Documentation ✅

**Primary Documentation:** `docs/plugins/plugin-signing.md`

Comprehensive guide covering:

- Overview and security features
- Developer guide (signing and distribution)
- User guide (configuration and installation)
- CI/CD integration instructions
- Security best practices
- Troubleshooting guide
- Technical details and API reference
- Examples and FAQ

**Quick Start Guide:** `docs/plugins/SIGNING-QUICKSTART.md`

5-minute quick start for:

- Plugin developers
- Plugin users
- CI/CD setup

### 8. Security Configuration ✅

**Updated Files:**

- `.gitignore` - Added `keys/` directory and `*.pem` files to prevent accidental commits
- `package.json` - Added convenience scripts (`plugin:sign`, `plugin:keygen`)

## Security Features Implemented

### ✅ Cryptographic Verification

- RSA-SHA256 signatures
- 4096-bit key strength
- Tamper detection

### ✅ Trust Management

- Multiple trusted public keys support
- Per-plugin signature verification
- Bundled plugin exemption

### ✅ Production Enforcement

- Automatic enforcement in production mode
- Configurable requirement levels
- Clear error messages for unsigned plugins

### ✅ Integrity Protection

- Signature covers: plugin code + version + timestamp
- Any modification invalidates signature
- Integrity check method available

### ✅ Supply Chain Security

- CI/CD integration for automated signing
- GitHub Actions workflow
- Secure secret management

## Success Criteria Verification

| Criterion                                  | Status   | Notes                                                            |
| ------------------------------------------ | -------- | ---------------------------------------------------------------- |
| ✅ Unsigned plugins rejected in production | COMPLETE | Enforced via `requireSignature` config and production mode check |
| ✅ Tampered plugins detected               | COMPLETE | Signature verification detects any code modification             |
| ✅ Signing CLI tool works                  | COMPLETE | `pnpm plugin:sign` command implemented and tested                |
| ✅ CI/CD auto-signs plugins                | COMPLETE | GitHub Actions workflow fully implemented                        |
| ✅ Verification tests pass                 | COMPLETE | 15+ comprehensive tests covering all scenarios                   |

## File Structure

```
openclaw/
├── src/plugins/
│   ├── plugin-signing.ts          [NEW] Core signing implementation
│   └── loader.ts                   [MODIFIED] Added signature verification
├── scripts/
│   ├── sign-plugin.ts              [NEW] CLI signing tool
│   └── generate-signing-keys.sh    [NEW] Key generation script
├── .github/workflows/
│   └── sign-and-publish.yml        [NEW] CI/CD workflow
├── test/security/
│   └── signature-verification.test.ts [NEW] Comprehensive test suite
├── docs/plugins/
│   ├── plugin-signing.md           [NEW] Full documentation
│   └── SIGNING-QUICKSTART.md       [NEW] Quick start guide
├── .gitignore                      [MODIFIED] Added keys/ and *.pem
└── package.json                    [MODIFIED] Added convenience scripts
```

## Usage Examples

### For Plugin Developers

```bash
# 1. Generate signing keys (one time)
pnpm plugin:keygen

# 2. Sign your plugin
pnpm plugin:sign ./plugins/my-plugin/index.ts 1.0.0

# 3. Distribute plugin with signature
# Include: plugin files + plugin.signature.json + public key
```

### For Plugin Users

```yaml
# ~/.openclaw/config.yaml
plugins:
  requireSignature: true
  trustedPublicKeys:
    - |
      -----BEGIN PUBLIC KEY-----
      [developer's public key]
      -----END PUBLIC KEY-----
```

### For CI/CD

```bash
# Store private key as GitHub secret (PLUGIN_SIGNING_KEY)
# Then tag and push:
git tag plugin-my-plugin-v1.0.0
git push --tags
# Workflow automatically signs and publishes
```

## Security Considerations

### Implemented Protections

1. **Private Key Security**
   - Never committed to version control
   - Stored as CI/CD secrets
   - Clear warnings in scripts and docs

2. **Public Key Distribution**
   - PEM format (standard and auditable)
   - Multiple trusted keys supported
   - User controls trust decisions

3. **Signature Verification**
   - Happens before plugin execution
   - Covers all plugin code
   - Detects any tampering

4. **Production Enforcement**
   - Automatic in production mode
   - Can be explicitly enabled
   - Bundled plugins always trusted

### Remaining User Responsibilities

1. **Key Management**
   - Users must verify public key authenticity
   - Developers must protect private keys
   - Key rotation requires user action

2. **Trust Decisions**
   - Users choose which developers to trust
   - Signatures verify authenticity, not safety
   - Code review still recommended

3. **Configuration**
   - Users must explicitly enable in non-production
   - Users must add trusted public keys
   - Updates require configuration changes

## Testing Instructions

To verify the implementation:

```bash
# 1. Run the test suite
pnpm test test/security/signature-verification.test.ts

# 2. Generate test keys
pnpm plugin:keygen

# 3. Create a test plugin
echo 'export default { register: () => {} };' > test-plugin.ts

# 4. Sign the test plugin
pnpm plugin:sign test-plugin.ts 1.0.0

# 5. Verify signature was created
ls -la plugin.signature.json
cat plugin.signature.json

# 6. Test loader integration (requires full OpenClaw setup)
# Add public key to config and attempt to load plugin
```

## Next Steps

### Immediate

1. ✅ All implementation tasks complete
2. ✅ Documentation written
3. ✅ Tests created
4. ✅ CI/CD workflow configured

### Future Enhancements (Optional)

1. Support for Ed25519 signatures (faster, smaller keys)
2. Signature revocation system
3. Central trusted key registry
4. Automatic key rotation tools
5. Plugin marketplace integration
6. Time-based signature expiration

## References

- RSA-SHA256: Industry-standard digital signature algorithm
- OpenSSL: Used for key generation
- Node.js crypto: Used for signing and verification
- GitHub Actions: Used for CI/CD automation

## Support

For issues or questions:

- See full documentation: `docs/plugins/plugin-signing.md`
- Quick start: `docs/plugins/SIGNING-QUICKSTART.md`
- Test examples: `test/security/signature-verification.test.ts`

---

**Implementation Date:** 2026-02-16
**Security Agent:** Agent 4
**Task:** HIGH P1 Security Fix - Task #10
**Status:** ✅ COMPLETE
