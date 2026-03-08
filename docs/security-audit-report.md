# Security Audit Report: openclaw

**Date:** 2026-02-24
**Method:** Claude Code Multi-Agent Security Audit

## Summary

- Critical: 0 | High: 0 | Medium: 2 | Low: 0 | Info: 1
- Overall risk level: Medium

## Project Overview

- Technology stack
  - TypeScript / ESM project, using pnpm for dependency management
  - Multi-channel AI gateway supporting various communication channels (Discord, Telegram, Slack, etc.)
  - Plugin system supporting tools, HTTP routes, channels, providers, and other extensions
  - Gateway server providing HTTP/WebSocket interface with authentication middleware
- Attack surface analysis
  - Gateway HTTP/WebSocket endpoints (authentication, rate limiting, origin checks)
  - Plugin HTTP routes (registered by plugins, bypass gateway authentication middleware)
  - Browser control endpoints (CDP remote connections)
  - Tool execution system (sandbox, safe bins, elevated exec)
  - File system permissions for config files and state directories
  - Environment variable loading (shell profile)

## Findings

### [Medium] O1: Gateway password mode lacks strength check

**Status:** Fixed
**File:** `src/security/audit.ts`
**Description:** Token mode has a `gateway.token_too_short` check, but password mode lacked a corresponding strength check.
**Impact:** Users could set overly short passwords, reducing gateway security.
**Fix:** Added `gateway.password_too_short` audit finding that warns when password length < 16 characters.
**Verification:** Run `pnpm test` to confirm tests pass.

### [Medium] O2: Plugin HTTP routes lack authentication check

**Status:** Fixed (added audit warning)
**File:** `src/security/audit.ts`
**Description:** Plugins can register HTTP routes via the registry; these routes do not pass through gateway authentication middleware.
**Impact:** Malicious or misconfigured plugins could expose unprotected endpoints.
**Fix:** Added `plugin.http_routes_no_auth` audit info finding to alert operators to review plugin routes.
**Verification:** Run `pnpm test` to confirm tests pass.

### [Info] O3: Shell environment variable loading

**Status:** Risk accepted
**Description:** The `OPENCLAW_LOAD_SHELL_ENV` option can load environment variables from shell profiles; this is by design.
**Impact:** If a shell profile is tampered with, malicious environment variables could be injected.
**Recommendation:** Explicitly document the security implications of this option.

## Positive Security Observations

1. **Timing-safe secret comparison** -- uses node:crypto timingSafeEqual
2. **Rate limiting** -- IP tracking, sliding window, lockout mechanism
3. **Input validation** -- Zod + AJV dual validation
4. **Output sanitization** -- UI uses dompurify
5. **Audit logging** -- comprehensive audit log system
6. **Tool policy** -- tool execution policies and dangerous tool detection
7. **Path guards** -- directory traversal protection
8. **Secrets detection** -- detect-secrets integration
9. **Trusted proxy support** -- trusted proxy header verification

## Recommendations

1. Consider adding optional authentication middleware for plugin HTTP routes
2. Regularly update dependencies to patch known vulnerabilities
3. Consider adding CSP headers to gateway HTTP responses

## Appendix: Modified Files

- `src/security/audit.ts` -- added password strength and plugin route audit findings
