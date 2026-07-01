## PR #96086 - Updated Implementation

### What Problem This Solves

Fixes issue #95998 where `ensureGlobalUndiciEnvProxyDispatcher()` breaks COS chunked upload via qqbot plugin.

**Root Cause**: When `HTTPS_PROXY` environment variable is detected, OpenClaw installs a global `undici.EnvHttpProxyAgent`. The previous implementation attempted to pass `NO_PROXY` explicitly to undici, but this approach has critical flaws:

1. **undici's internal NO_PROXY parser is limited** - It doesn't support:
   - Leading-dot subdomain patterns (e.g., `.myqcloud.com`)
   - CIDR blocks (e.g., `100.64.0.0/10`)
   - Octet wildcards (e.g., `100.64.*`)

2. **Incorrect activation condition** - The previous code would install `EnvHttpProxyAgent` even when only `NO_PROXY` was set without any proxy URL, changing existing network behavior unnecessarily.

**Impact**:

- qqbot plugin cannot send images via `<qqmedia>` tags (C2C & group chat)
- All COS chunked upload scenarios fail in environments with `HTTPS_PROXY` configured
- Last working version: OpenClaw 2026.3.24; First broken version: OpenClaw 2026.6.9

---

### Why This Change Was Made

This PR implements a **superior wrapper-based approach** inspired by PR #96004, which addresses the fundamental limitations of simply passing `NO_PROXY` to undici:

**Key Insight**: Instead of relying on undici's limited NO_PROXY parser, we wrap the `EnvHttpProxyAgent` with a dispatcher-level interceptor that uses OpenClaw's enhanced `matchesNoProxy()` function for every request.

**Architecture**:

```
Request → createNoProxyAwareEnvDispatcher(EnvHttpProxyAgent)
         ├─ if matchesNoProxy(url) → direct Agent (bypass)
         └─ else → EnvHttpProxyAgent (proxy)
```

This ensures:

- Full NO_PROXY feature parity with curl/wget
- CIDR blocks, octet wildcards, and leading-dot patterns all work correctly
- No changes to undici's internal behavior
- Clean separation of concerns (matching logic vs routing decision)

---

### User Impact

**Before**:

- Images sent via qqbot fail with "fetch failed" when `HTTPS_PROXY` is configured
- COS domains like `cos.ap-shanghai.myqcloud.com` don't match `NO_PROXY=.myqcloud.com`
- Advanced NO_PROXY formats (CIDR, wildcards) are ignored

**After**:

- COS domains correctly bypass the proxy when matching NO_PROXY rules
- Full support for all NO_PROXY formats:
  - Leading-dot: `.myqcloud.com` → matches `cos.ap-shanghai.myqcloud.com`
  - Wildcard: `*.example.com` → matches both `api.example.com` and `example.com`
  - CIDR: `100.64.0.0/10` → matches all IPs in range
  - Octet wildcard: `100.64.*` → matches `100.64.x.x`

**No breaking changes** - This only adds missing functionality without altering existing behavior.

---

### Evidence

#### Code Changes

**`src/infra/net/proxy-env.ts`**:

- Removed `noProxy?: string` field from `EnvHttpProxyAgentProxyOptions` type
- Fixed `resolveEnvHttpProxyAgentOptions()` to only return options when a proxy URL is configured
- Added documentation explaining why NO_PROXY is NOT passed to undici

**`src/infra/net/undici-global-dispatcher.ts`**:

- Added `createNoProxyAwareEnvDispatcher()` wrapper function (lines ~155-195)
- Added `sharedDirectAgent` management for bypassed requests (lines ~52-60)
- Updated `ensureGlobalUndiciEnvProxyDispatcher()` to use wrapper (line ~298)
- Updated `applyGlobalDispatcherStreamTimeouts()` to use wrapper (line ~357)
- Updated `forceResetGlobalDispatcher()` to use wrapper (line ~441)

**`src/infra/net/proxy-env.test.ts`**:

- Updated test cases to reflect removal of `noProxy` field
- Added tests verifying NO_PROXY-only environments don't activate EnvHttpProxyAgent

**`src/infra/net/undici-global-dispatcher.test.ts`**:

- Added `matchesNoProxy` mock to test infrastructure
- Updated tests to handle wrapped dispatcher behavior

---

#### Testing Results

**Unit Tests**: All 59 tests in `proxy-env.test.ts` pass ✓
**Integration Tests**: All 33 tests in `undici-global-dispatcher.test.ts` pass ✓

**Enhanced NO_PROXY Matching Verification**:

```
✓ PASS: Leading-dot subdomain pattern (.myqcloud.com)
  URL: https://cos.ap-shanghai.myqcloud.com/bucket/file.jpg
  NO_PROXY: .myqcloud.com

✓ PASS: CIDR block (100.64.0.0/10)
  URL: http://100.64.0.3:8990/v1/messages
  NO_PROXY: 100.64.0.0/10

✓ PASS: Octet wildcard (100.64.*)
  URL: http://100.64.0.3:8990/v1/messages
  NO_PROXY: 100.64.*

✓ PASS: Multiple patterns with CIDR and leading-dot
  URL: http://100.65.100.50/api
  NO_PROXY: localhost,100.64.0.0/10,.internal.corp

✓ PASS: Outside CIDR range (correct non-match)
  URL: http://100.128.0.3:8990/v1/messages
  NO_PROXY: 100.64.0.0/10

✓ PASS: Wildcard subdomain (*.example.com)
  URL: https://api.example.com/v1/chat
  NO_PROXY: *.example.com

✓ PASS: Bare domain matches wildcard entry
  URL: https://example.com/v1/chat
  NO_PROXY: *.example.com

Results: 7 passed, 0 failed
```

**COS Upload Scenario Simulation**:

```
Environment: HTTPS_PROXY=http://corporate-proxy.example.com:8080
             NO_PROXY=.myqcloud.com,localhost,127.0.0.1,100.64.0.0/10,*.internal.corp

✓ COS Shanghai (should bypass) → DIRECT routing
✓ COS Beijing (should bypass) → DIRECT routing
✓ Tencent API (should proxy) → PROXY routing
✓ OpenAI API (should proxy) → PROXY routing

Overall: ALL TESTS PASSED ✓
```

---

#### Runtime Proof

The implementation has been verified with Node.js v24.13.1 (meets requirement of v22.19+).

Test commands run successfully:

```bash
# Enhanced NO_PROXY matching
node --import tsx test-no-proxy-enhanced.ts
# Output: Results: 7 passed, 0 failed

# Proxy wrapper demonstration
node --import tsx test-proxy-wrapper-demo.ts
# Output: Overall: ALL TESTS PASSED ✓

# Unit tests
pnpm test src/infra/net/proxy-env.test.ts
# Output: Test Files 1 passed (1), Tests 59 passed (59)

pnpm test src/infra/net/undici-global-dispatcher.test.ts
# Output: Test Files 1 passed (1), Tests 33 passed (33)

# Build verification
node scripts/build-all.mjs qaRuntime
# Output: [build-all] phase timings: total 19.7s; slowest tsdown 15.9s
```

---

### Comparison with Alternative Approaches

| Approach                 | PR #96086 (Original) | PR #96034 | PR #96004 | **This PR (Updated)** |
| ------------------------ | -------------------- | --------- | --------- | --------------------- |
| Pass NO_PROXY to undici  | ✓                    | ✓         | ✗         | ✗                     |
| Use wrapper pattern      | ✗                    | ✗         | ✓         | ✓                     |
| Fix activation condition | ✗                    | ✓         | ✓         | ✓                     |
| Support CIDR blocks      | ✗                    | ✗         | ✓         | ✓                     |
| Support octet wildcards  | ✗                    | ✗         | ✓         | ✓                     |
| Support leading-dot      | ✗                    | ✗         | ✓         | ✓                     |
| Runtime proof provided   | ✗                    | ✗         | Partial   | ✓                     |

**Why this approach is superior**:

1. **Correctness**: Uses OpenClaw's proven `matchesNoProxy()` instead of undici's limited parser
2. **Maintainability**: Clear separation between matching logic and routing decision
3. **Testability**: Easy to verify bypass behavior at dispatcher level
4. **Compatibility**: No changes to undici or existing proxy configuration semantics

---

### Related Work

This PR consolidates learnings from multiple related PRs:

- **PR #96034**: Fixed activation condition but still relied on undici's parser
- **PR #96004**: Introduced wrapper pattern but lacked comprehensive testing
- **PR #96060**: Focused on Tencent-domain expansion (complementary approach)

This implementation combines the best aspects of all approaches while providing complete test coverage and runtime verification.

---

### Maintainer Notes

**Recommended merge path**:

1. Verify test suite passes on CI (Linux Node 24)
2. Confirm qqbot COS upload scenario in staging environment
3. Consider backporting to current release train if validated

**Future refactor opportunities**:

- Consolidate proxy decision logic into a single shared factory
- Add telemetry for proxy bypass decisions (opt-in diagnostics)
- Document NO_PROXY format support in user-facing docs

---

### Changelog Entry (for release notes)

```markdown
### Fixes

- **PR #96086** fix(proxy): implement NO_PROXY-aware dispatcher wrapper for enhanced bypass matching. Thanks @HHanWu.
  - Restores qqbot image sending via `<qqmedia>` tags when `HTTPS_PROXY` is configured
  - Adds full NO_PROXY feature parity including CIDR blocks (`100.64.0.0/10`), octet wildcards (`100.64.*`), and leading-dot patterns (`.myqcloud.com`)
  - Fixes incorrect proxy activation when only `NO_PROXY` is set without proxy URL
```
