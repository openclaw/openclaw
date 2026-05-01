# Session Transcript Encryption - Implementation Status

## Current Implementation

### What Works:
1. **Encryption utilities** - `encryption.ts`, `line-encryption.ts`, `file-encryption.ts`
2. **EncryptedSessionManager wrapper** - Wraps Pi SessionManager with transparent encryption
3. **Transcript reader** - `transcript-reader.ts` for reading encrypted/plaintext files
4. **Migration utilities** - `migrate-transcripts.ts` for converting plaintext → encrypted
5. **sessions.json encryption** - Whole-file encryption for metadata store

### What's Partially Implemented:
1. **Delivery-mirror encryption** - `appendExactAssistantMessageToSessionTranscript` uses encryption
2. **Gateway readers** - Some reading functions handle encryption

## Critical Issues Identified by Codex Review

### 1. Async/Sync Mismatch
- Changed synchronous functions (`readSessionMessages`, `readSessionTitleFieldsFromTranscript`) to async
- Callers expect synchronous API
- Breaks TypeScript/build

### 2. Incomplete Coverage
- Only covers delivery-mirror messages
- Main session writes (`SessionManager.open` in embedded runner) bypass encryption
- Mixed plaintext/encrypted transcripts possible

### 3. ESM Compatibility
- Using `require()` in ESM package (`"type": "module"` in package.json)
- Should use dynamic `import()` or static ESM imports

### 4. Security Concerns
- Key material stored alongside encrypted data
- Same filesystem read exposes both
- Doesn't provide defense-in-depth as claimed

## Architecture Problem

The current approach patches individual read/write paths instead of implementing a "central session persistence seam" that covers all Pi SessionManager operations.

## Required for Complete Solution

### 1. Central Persistence Seam
- Intercept ALL `SessionManager.open()` calls
- Wrap ALL SessionManager operations (append, getBranch, getEntries, etc.)
- Cover embedded runner, compaction, repair, history reads

### 2. API Compatibility
- Maintain synchronous API where expected
- Use proper ESM imports (`import` not `require`)
- Update all callers if API changes

### 3. Security Model
- Secure key storage (OS keychain, user secret, etc.)
- Threat model review by maintainers
- Migration safety (fail closed, backups, verification)

### 4. Testing & Documentation
- Unit tests for encryption/decryption
- Integration tests for migration
- Security documentation
- Migration guide
- CHANGELOG entry

## Next Steps

### Short-term (fix current issues):
1. Revert async changes to maintain API compatibility
2. Fix ESM `require()` calls
3. Document limitations clearly

### Medium-term (complete solution):
1. Implement central SessionManager wrapper/interceptor
2. Secure key management design
3. Comprehensive test suite
4. Feature flags for rollout

### Long-term (production-ready):
1. Security review by maintainers
2. Gradual rollout with monitoring
3. User documentation
4. Recovery/rollback procedures

## Files Created/Modified

### New Files:
- `src/config/sessions/encryption.ts` - Master key management
- `src/config/sessions/line-encryption.ts` - Per-line encryption
- `src/config/sessions/file-encryption.ts` - Whole-file encryption
- `src/config/sessions/encrypted-session-manager.ts` - SessionManager wrapper
- `src/config/sessions/transcript-reader.ts` - Unified reader
- `src/config/sessions/migrate-transcripts.ts` - Migration utilities

### Modified Files:
- `src/config/sessions/transcript.ts` - Uses EncryptedSessionManager for delivery-mirror
- `src/config/sessions/store.ts` - Encrypts sessions.json writes
- `src/config/sessions/store-load.ts` - Decrypts sessions.json reads
- `src/gateway/session-utils.fs.ts` - Updated reading functions

## Recommendations

1. **Pause current implementation** - Too many breaking changes
2. **Design central persistence seam** - Architectural solution needed
3. **Security review required** - Before any encryption deployment
4. **Incremental approach** - Start with logging/monitoring, then encryption

The foundation is laid but the implementation needs significant architectural work to be production-ready.
