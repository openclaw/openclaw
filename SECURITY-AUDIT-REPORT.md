# OpenClaw Security Audit Report

**Project**: OpenClaw WhatsApp Gateway CLI
**Audit Date**: February 7, 2026
**Scope**: Authentication, Authorization, Input Validation, Plugin Security, Secrets Management, Network Security, Sandbox Security, Dependencies, and Data Exposure

---

## Executive Summary

OpenClaw is a WhatsApp gateway that bridges messaging channels to AI agents. The codebase demonstrates strong security awareness with implementations like timing-safe comparisons, credential redaction, and sandbox isolation. However, several critical and high-severity issues require attention, particularly around command injection risks, authorization bypass potential, and incomplete input validation.

**Overall Risk Level**: **HIGH**

| Severity | Count |
| -------- | ----- |
| Critical | 3     |
| High     | 8     |
| Medium   | 12    |
| Low      | 7     |

### Known Dependency Vulnerabilities (pnpm audit)

| Severity | Package              | Issue                       | Path                                                      |
| -------- | -------------------- | --------------------------- | --------------------------------------------------------- |
| Moderate | `request` (<=2.88.2) | Server-Side Request Forgery | `extensions/matrix > @vector-im/matrix-bot-sdk > request` |

The project actively mitigates known CVEs via `pnpm.overrides`: `tar@7.5.7`, `qs@6.14.1`, `fast-xml-parser@5.3.4`, `tough-cookie@4.1.3`, `form-data@2.5.4`.

---

## 1. Authentication & Authorization

### CRITICAL: Weak Tailscale Header Authentication

**Location**: `src/gateway/auth.ts:130-146`

The `getTailscaleUser()` function trusts HTTP headers (`tailscale-user-login`, `tailscale-user-name`, `tailscale-user-profile-pic`) without cryptographic verification. An attacker controlling a reverse proxy or performing header injection could forge these headers. Although `resolveVerifiedTailscaleUser()` does verify via the Tailscale whois API, the initial trust in headers before verification creates a potential bypass window.

**Recommendation**:

- Remove initial header trust; always verify via Tailscale whois API first
- Implement rate limiting on whois lookups
- Add logging for mismatched header attempts

### HIGH: Local Direct Request Bypass Risk

**Location**: `src/gateway/auth.ts:107-128`

`isLocalDirectRequest()` allows authentication bypass for localhost connections but relies on `X-Forwarded-For`, `X-Real-IP`, and `X-Forwarded-Host` headers which can be spoofed if trusted proxies are misconfigured.

**Recommendation**:

- Require explicit `trustedProxies` configuration (fail-safe defaults)
- Log warnings when `trustedProxies` is empty but forwarded headers are present
- Document security implications in gateway configuration

### HIGH: OAuth State Validation Weakness

**Location**: `src/commands/chutes-oauth.ts:42-119`

OAuth local callback server accepts connections on the redirect URI path without origin validation or additional CSRF tokens. The state parameter uses simple string comparison (not timing-safe).

**Recommendation**:

- Add origin validation for OAuth callbacks
- Implement timing-safe state comparison
- Rely on PKCE (already implemented) as primary security mechanism

### MEDIUM: Device Auth Token Lacks Signature Verification

**Location**: `src/gateway/device-auth.ts:13-31`

`buildDeviceAuthPayload()` creates auth payloads by concatenating fields with `|` delimiter, with no HMAC or signature to prevent tampering. An attacker could modify role, timestamp, or scope fields.

**Recommendation**: Add HMAC-SHA256 signature using a server-side secret; consider JWT instead of custom format.

---

## 2. Input Validation & Injection

### CRITICAL: Command Injection in Exec Tool

**Location**: `src/agents/bash-tools.exec.ts:421-798`

`runExecProcess()` executes shell commands directly. While an approval system and allowlist exist, the command string is passed to the shell interpreter with minimal escaping. Shell metacharacters (`;`, `&&`, `||`, `|`, `$(...)`, backticks) allow command chaining.

**Existing Mitigations**: Approval system, allowlist evaluation, sandbox mode (Docker isolation), dangerous env var filtering.

**Gaps**: No shell metacharacter escaping; compound commands not blocked; subshells not prevented.

**Recommendation**:

1. Add shell metacharacter validation before approval
2. Use `child_process.execFile()` with argument arrays instead of shell strings
3. Implement strict command parser that disallows pipeline operators, command separators, redirections, and subshells
4. Add detection for suspicious patterns in approval UI

### CRITICAL: Path Traversal in Sandbox Workdir Resolution

**Location**: `src/agents/bash-tools.exec.ts:952-965`

User-provided `workdir` parameter is used to resolve paths without sufficient validation against directory traversal. `../../etc/passwd` could escape sandbox; symlink following could access restricted paths.

**Recommendation**:

- Implement strict path canonicalization
- Reject paths containing `..` segments
- Validate resolved path is within allowed directories
- Use `realpath()` and check against whitelist

### HIGH: Insufficient WebSocket Message Validation

**Location**: `src/gateway/server-http.ts:311-451`

WebSocket upgrade handling doesn't validate message origins or implement rate limiting before passing to handlers. Missing: per-IP connection rate limiting, origin header validation, message size limits at upgrade time, per-client connection limits.

**Recommendation**: Add origin validation, connection rate limiting (10/min per IP), per-client connection limits, and connection attempt logging.

### HIGH: Hook Token Leak via Query Parameters

**Location**: `src/gateway/server-http.ts:150-157`

Token-in-query rejection doesn't log the attempt (security monitoring gap), error message reveals authentication mechanism, and no rate limiting exists on failed auth attempts.

**Recommendation**: Log all attempts with IP/timestamp, use generic error messages, implement rate limiting after 5 failed attempts.

### MEDIUM: OpenAI HTTP Endpoint Missing Request Size Limits

**Location**: `src/gateway/openai-http.ts:171-426`

The `/v1/chat/completions` endpoint uses a 1MB default body limit. No limit on number of messages in array, message content length, or streaming response timeout.

**Recommendation**: Reduce default to 256KB; add limits of 50 messages/request, 10K chars/message, 30s streaming timeout.

### MEDIUM: Origin Check Insufficient for CORS

**Location**: `src/gateway/origin-check.ts:57-85`

`checkBrowserOrigin()` allows loopback addresses to bypass origin restrictions but doesn't validate scheme (HTTP vs HTTPS), enabling mixed content and downgrade attacks on localhost.

---

## 3. Plugin/Extension Security

### HIGH: Plugin SDK Exposes Sensitive Gateway Methods

**Location**: `src/plugin-sdk/index.ts`

The plugin SDK exports extensive gateway internals. Plugins can register HTTP routes without isolation, there's no sandboxing of plugin code execution, and plugins can access full config schema.

**Recommendation**: Implement plugin capability system, restrict plugin access to API subset, add plugin permission manifest, sandbox plugin HTTP routes under `/plugins/<plugin-id>/`.

### MEDIUM: No Plugin Code Signing or Verification

No plugin signature verification or integrity checks before loading extensions. Supply chain attack risk if plugin registry is compromised.

**Recommendation**: Implement plugin signature verification, add plugin manifest with hash checksums, warn users when loading unsigned plugins.

### MEDIUM: Tool Policy Enforcement Gaps

**Location**: `src/agents/tool-policy.ts:91-110`

`applyOwnerOnlyToolPolicy()` removes owner-only tools at runtime rather than configuration validation time. Tools appear available until execution attempt fails; no audit logging of unauthorized attempts.

**Recommendation**: Filter tools at discovery time, log all unauthorized access attempts, add rate limiting for repeated violations.

---

## 4. Secrets Management

### GOOD: Comprehensive Secret Redaction

**Location**: `src/config/redact-snapshot.ts`

Robust implementation: pattern-based detection (`/token/i`, `/password/i`, `/secret/i`, `/api.?key/i`), deep object traversal, sentinel value system for round-trip safety. Consider adding patterns for bearer tokens and database connection strings.

### MEDIUM: Environment Variable Secrets Not Validated

**Location**: `src/infra/dotenv.ts`

`.env` file loading doesn't validate that loaded secrets meet minimum security standards. No validation of API key lengths, no warning for default/example values.

### MEDIUM: Secrets Baseline Exclusion Patterns

**Location**: `.detect-secrets.cfg`

Some exclusion patterns (`=== "string"`, `typeof remote?.password`) are broad enough to potentially hide real secrets. Make exclusion patterns more specific and run baseline updates regularly.

---

## 5. Network Security

### HIGH: Tailscale Command Injection Risk

**Location**: `src/infra/tailscale.ts:271-295`

`execWithSudoFallback()` executes commands with sudo where the binary path comes from user environment or auto-detection. If `bin` is from untrusted PATH, malicious binaries could execute with elevated privileges.

**Recommendation**: Whitelist allowed Tailscale binary paths, validate binary location is in trusted directories, add explicit user confirmation for sudo operations.

### MEDIUM: WebSocket Missing Compression Bomb Protection

No protection against compression-based DoS attacks on WebSocket connections.

### MEDIUM: Missing HTTP Security Headers

HTTP responses don't include: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`.

---

## 6. Sandbox Security

### GOOD: Docker Sandbox Implementation

**Locations**: `Dockerfile.sandbox`, `Dockerfile.sandbox-browser`

Minimal base image (Debian Bookworm Slim), non-root user execution, limited package installation, proper multi-stage build. Consider adding seccomp profile, read-only root filesystem, `--cap-drop=ALL`.

### HIGH: Dangerous Environment Variables Not Blocked in Sandbox

**Location**: `src/agents/bash-tools.exec.ts:61-107`

Environment variable filtering (`validateHostEnv()`) only applies to host/gateway execution, not sandbox mode. Attacker with sandbox access could set `LD_PRELOAD`, `PYTHONPATH`, or `BASH_ENV`.

**Recommendation**: Apply `validateHostEnv()` to sandbox as well; add sandbox-specific blocklist.

### MEDIUM: Sandbox Container Escape via Elevated Mode

**Location**: `src/agents/bash-tools.exec.ts:933-935`

When `elevated` mode is used, commands execute as `host = "gateway"`, bypassing sandbox entirely.

**Recommendation**: Disable elevated mode in production; add warnings and strict audit logging.

---

## 7. Dependency Risks

### MEDIUM: Native Dependencies with Complex Build Processes

`onlyBuiltDependencies` includes 9 native packages (`@lydell/node-pty`, `sharp`, `protobufjs`, etc.) with complex C/C++ build processes that are harder to audit and pose supply chain risk.

### MEDIUM: Dependency Overrides Indicate CVE Mitigations

8 packages are overridden to specific versions, suggesting upstream transitive dependency CVEs. Document reason for each override and track when they can be removed.

---

## 8. Data Exposure

### MEDIUM: Error Messages May Leak Sensitive Context

Error messages in various locations include internal configuration structure and runtime environment details that could help attackers understand system architecture. Use generic error messages for untrusted clients; detailed errors only in logs.

### LOW: Verbose Logging in Production

Extensive debug logging could leak information if log level isn't properly configured. Ensure production defaults to INFO level or higher.

---

## Security Infrastructure Assessment

### Strengths

- Comprehensive pre-commit hooks (formatting, linting, secret detection, GitHub Actions security audit via zizmor)
- `detect-secrets` integrated into both CI and pre-commit workflows
- No `.env` files committed to repository
- Well-documented security policy with responsible disclosure process (`SECURITY.md`)
- Minimum Node.js version requirement (22.12.0) addresses CVE-2025-59466 and CVE-2026-21636
- Docker security guidance provided
- Most extensions are lightweight (18 of 31 are devDep-only), minimizing attack surface

### Pre-commit Security Hooks

| Hook                           | Purpose                        |
| ------------------------------ | ------------------------------ |
| `detect-secrets` (Yelp v1.5.0) | Secret detection with baseline |
| `shellcheck` (v0.11.0)         | Shell script linting           |
| `actionlint` (v1.7.10)         | GitHub Actions linting         |
| `zizmor` (v1.22.0)             | GitHub Actions security audit  |

---

## Priority Recommendations

### Immediate (Critical)

1. Fix command injection: implement shell metacharacter blocking in exec tool
2. Strengthen Tailscale auth: remove header trust, verify via API only
3. Path traversal protection: add strict canonicalization and validation

### Short-term (High)

1. Implement rate limiting on WebSocket connections and API endpoints
2. Add HMAC signature to device auth tokens
3. Validate environment variables for sandbox execution
4. Enhance OAuth callback security with origin validation
5. Audit and restrict plugin SDK API surface

### Medium-term

1. Implement plugin capability system and code signing
2. Add comprehensive HTTP security headers
3. Enhance error handling to prevent information leakage
4. Set up automated dependency vulnerability scanning
5. Add request size limits and DoS protections

### Long-term

1. Implement Web Application Firewall (WAF)
2. Add runtime integrity monitoring
3. Create security testing suite
4. Establish bug bounty program
