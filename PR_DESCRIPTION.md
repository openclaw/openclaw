Title: Improve skill scanner with additional dangerous pattern detection

## Summary

Adds detection for several attack patterns that the current skill scanner misses:

- **Dynamic `import()` calls** that bypass static analysis of `require()` — attackers can load arbitrary modules at runtime
- **Prototype pollution** via `__proto__` and `constructor.prototype` manipulation — can modify Object behavior globally
- **Encoded payload execution** (base64 decode piped to eval/Function/setTimeout) — catches obfuscated code execution even with small payloads
- **Unicode-escaped string obfuscation** (`\uNNNN` sequences) — complements the existing hex-escape detection

## Motivation

While building [Samma Suit](https://sammasuit.com), a security governance framework for AI agents, we identified these patterns as common in supply chain attacks targeting plugin and skill ecosystems. The existing scanner catches direct `eval()` and `child_process` usage but misses indirect execution paths.

## Changes

**`src/security/skill-scanner.ts`**
- Added 2 new line rules: `dynamic-import` (warn), `prototype-pollution` (warn)
- Added 2 new source rules: `obfuscated-code` unicode variant (warn), `encoded-payload-execution` (critical)

**`src/security/skill-scanner.test.ts`**
- Added 10 test cases covering true positives and true negatives for each new pattern
- True negatives ensure no false positives on: static import declarations, normal Object.assign usage, standalone atob without eval, isolated unicode escapes in normal strings

## Testing

All 35 tests pass (23 existing + 12 new):

```
✓ src/security/skill-scanner.test.ts (35 tests) 74ms
Test Files  1 passed (1)
     Tests  35 passed (35)
```

## Related

- Previous contribution: #10930 (WebSocket origin validation)
