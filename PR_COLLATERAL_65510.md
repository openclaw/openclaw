# PR Collateral: Fix Firecrawl SecretRef (op://) Not Resolved

**Issue**: #65510 - [Bug]: Firecrawl webFetch.apiKey fails with SecretRef, but works with plaintext
**Author**: Lydia (OpenClaw Agent)
**Date**: 2026-04-15

---

## Summary

Detect and reject unresolved secret references (like 1Password `op://` URIs) in Firecrawl API key configuration. Previously, these references were passed through as literal strings, causing `401 Unauthorized` errors from the Firecrawl API.

## Problem

When users configure `plugins.entries.firecrawl.config.webFetch.apiKey` with a 1Password SecretRef like `"op://openclaw/Firecrawl API key/credential"`:

1. OpenClaw's secret system doesn't automatically resolve `op://` URI strings
2. The raw `op://...` string passes through `normalizeSecretInput()` unchanged
3. Firecrawl sends `Authorization: Bearer op://openclaw/Firecrawl API key/credential` to the API
4. The API returns `401 Unauthorized: Invalid token`

The user sees a confusing error because the config appears "resolved/masked" in gateway views (it's just masking the string, not actually resolving it).

## Root Cause

`op://` is a 1Password CLI convention, not a native OpenClaw SecretRef format. OpenClaw's `coerceSecretRef()` only recognizes:

- SecretRef objects: `{ source: "env"|"file"|"exec", provider: "...", id: "..." }`
- Environment templates: `${VAR_NAME}`

Plain `op://` strings are treated as literal credential values.

## Solution

Add detection for common unresolved secret reference patterns and throw a clear error message guiding users to proper configuration.

### Changes

#### `src/utils/normalize-secret-input.ts` (+28 lines)

```typescript
const UNRESOLVED_SECRET_PATTERNS = [
  /^op:\/\//i, // 1Password CLI reference (op://vault/item/field)
  /^secret:\/\//i, // Generic secret:// URI scheme
  /^\$\{[A-Z_][A-Z0-9_]*\}$/, // Environment variable template ${VAR_NAME}
];

export function detectUnresolvedSecretReference(value: string): string | undefined {
  // Returns pattern name if unresolved reference detected
}
```

#### `src/plugin-sdk/secret-input.ts` (+2 lines)

- Export `detectUnresolvedSecretReference` for plugin use

#### `extensions/firecrawl/src/config.ts` (+15 lines)

```typescript
function normalizeConfiguredSecret(value: unknown, path: string): string | undefined {
  const normalized = normalizeSecretInput(...);
  if (normalized) {
    const unresolvedType = detectUnresolvedSecretReference(normalized);
    if (unresolvedType) {
      throw new Error(
        `${path}: unresolved ${unresolvedType} detected. ` +
        `Configure a secret provider in config.secrets.providers to resolve this reference, ` +
        `or use a plaintext API key. See https://openclaw.ai/docs/secrets for setup instructions.`
      );
    }
  }
  return normalized;
}
```

## New Error Message

Instead of a confusing `401 Unauthorized: Invalid token` from Firecrawl, users now see:

```
plugins.entries.firecrawl.config.webFetch.apiKey: unresolved 1Password reference (op://) detected.
Configure a secret provider in config.secrets.providers to resolve this reference,
or use a plaintext API key. See https://openclaw.ai/docs/secrets for setup instructions.
```

## Proper Configuration for 1Password

Users should configure a secrets provider:

```json
{
  "secrets": {
    "providers": {
      "1password": {
        "source": "exec",
        "command": "op",
        "args": ["read", "--no-newline"],
        "timeoutMs": 10000
      }
    }
  },
  "plugins": {
    "entries": {
      "firecrawl": {
        "config": {
          "webFetch": {
            "apiKey": {
              "source": "exec",
              "provider": "1password",
              "id": "op://openclaw/Firecrawl API key/credential"
            }
          }
        }
      }
    }
  }
}
```

## Testing

### Manual Testing

1. Configure `apiKey: "op://vault/item/field"` without a secrets provider
2. Attempt to use `web_fetch`
3. Verify clear error message instead of `401 Unauthorized`

### Recommended Test Cases

```typescript
describe("detectUnresolvedSecretReference", () => {
  it("detects 1Password op:// references", () => {
    expect(detectUnresolvedSecretReference("op://vault/item/field")).toBe(
      "1Password reference (op://)",
    );
  });

  it("detects secret:// URIs", () => {
    expect(detectUnresolvedSecretReference("secret://provider/path")).toBe("secret:// URI");
  });

  it("returns undefined for normal API keys", () => {
    expect(detectUnresolvedSecretReference("fc-abc123")).toBeUndefined();
  });
});
```

## Backward Compatibility

- **No breaking changes** for users with working configurations
- Users with misconfigured `op://` strings will now get a helpful error instead of a confusing 401
- The detection is conservative - only specific patterns are flagged

---

## PR Title

```
fix(firecrawl): detect unresolved secret references (op://) and show helpful error
```

## PR Body

```markdown
## Summary

- Detect unresolved secret references (1Password `op://`, `secret://`, `${VAR}`) in Firecrawl API key config
- Show clear error message with setup instructions instead of confusing `401 Unauthorized`

## Changes

- Add `detectUnresolvedSecretReference()` utility function
- Export from `openclaw/plugin-sdk/secret-input` for plugin use
- Update Firecrawl config to validate API key before use

Fixes #65510
```
