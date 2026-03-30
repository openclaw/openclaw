# Security Vulnerability Fix - GHSA-h4jx-hjr3-fhgc

**Date:** 2026-03-30
**Reporter:** OpenClaw Security Team
**Severity:** High
**CVE:** N/A
**GHSA:** GHSA-h4jx-hjr3-fhgc

## Vulnerability Details

### Summary
OpenClaw Gateway Plugin Subagent Fallback `deleteSession` Uses Synthetic `operator.admin`

### Description
When plugin subagents call privileged gateway methods (like `sessions.delete`), the fallback dispatch path used a synthetic client with elevated `operator.admin` scope, regardless of the actual caller's permissions. This allowed plugins with limited scopes to escalate privileges and perform admin-only operations.

### Vulnerable Code
Location: `src/gateway/server-plugins.ts`

The `dispatchGatewayMethod` function used `createSyntheticOperatorClient()` as a fallback:
```typescript
client: scope?.client ?? createSyntheticOperatorClient(),
```

The `createSyntheticOperatorClient()` returned:
```typescript
scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
```

### Affected Versions
- `<= 2026.3.24` (vulnerable)
- `>= 2026.3.28` (patched)

### Impact
- Plugins with only `operator.read` or `operator.write` scope could perform admin-only operations
- Specifically affected: `sessions.delete` (and potentially other admin methods)
- Privilege escalation within the trusted plugin boundary

## Fix Applied

### Changes Made
1. **Created limited fallback client**: Replaced the admin-granting fallback with a client that only has basic `operator.read` and `operator.write` scopes
2. **Stored fallback client in state**: Added client storage to `fallbackGatewayContextState`
3. **Updated dispatch logic**: Modified `dispatchGatewayMethod` to use the limited fallback instead of the synthetic admin client

### Key Changes

```typescript
// Before (vulnerable):
client: scope?.client ?? createSyntheticOperatorClient(),

// After (fixed):
const client = scope?.client ?? fallbackGatewayContextState.client ?? createFallbackOperatorClient();
```

New fallback client has minimal scopes:
```typescript
scopes: ["operator.read", "operator.write"],  // No admin!
```

### Testing
- Basic type checking passed
- The fix ensures that when no request scope is available, the fallback has minimal privileges
- This forces plugins to either provide proper scope context or have their privileged operations rejected

## Remediation

Users should upgrade to version `2026.3.28` or later.

## References
- GHSA: GHSA-h4jx-hjr3-fhgc
- Related: OpenClaw Security Policy, Plugin Trust Boundary

---

*记录于: 2026-03-30 08:00 UTC*
