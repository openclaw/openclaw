## Summary

`maskApiKey()` exposes up to 16 characters of API keys when displaying `/models list` output in chat channels. For keys with 16 or fewer characters, the masked output may reveal most or all of the key.

**Before:**

```
sk-ant-api03-abc...wxyz1234   ← 16 chars exposed
abcdefghijklmnop              ← ab...op (4 chars exposed — may be most of key)
```

**After:**

```
sk-a...   ← only 4 chars, never the end
abcd...   ← only 4 chars, never the end
```

## Details

Simplified `maskApiKey()` to two branches:

- Keys ≤ 4 chars: show first 1 char + `...`
- Keys > 4 chars: show first 4 chars + `...`

The end of the key is **never** exposed. This follows the same pattern used by GitHub, npm, and other credential-handling systems.

Updated tests to match the new behavior and added assertions that verify the last 8 characters of a key are never present in masked output.

## Related Issues

Fixes #34452

## How to Validate

Run `/models list` in any channel — confirm API keys show only the first 4 characters followed by `...`.

Run unit tests: `pnpm test -- --testPathPattern=mask-api-key`

## Pre-Merge Checklist

- [x] Updated relevant documentation and README (if needed)
- [x] Added/updated tests (if needed)
- [ ] Noted breaking changes (if any)
- [x] Validated on required platforms/methods:
  - [x] Windows
    - [x] npm run
