## Summary

When `models.providers` contains a validation error in any single provider (e.g., a custom `models` array with a missing `apiKey`), the entire `models.json` config was silently rejected. This caused all custom `baseUrl` overrides and model definitions to be lost without any warning — often unnoticed until requests started failing against the wrong endpoints.

## Details

Added per-provider validation isolation in `src/config/validation.ts`. When a provider-level validation error is detected:

- A clear warning is logged identifying the provider key and the specific validation error
- The invalid provider is skipped
- All other valid providers continue to load normally

**Before:**

```
[silent] All custom models and baseUrl overrides lost
```

**After:**

```
⚠️ Provider "minimax" failed validation: "apiKey" is required when defining custom models. Skipping this provider.
```

## Related Issues

Fixes #21584

## How to Validate

1. Configure two providers: one valid (with custom `baseUrl`), one invalid (missing `apiKey`)
2. Start the gateway
3. Confirm the valid provider uses its configured `baseUrl`
4. Check logs — warning shows which provider was skipped and why

Run unit tests: `pnpm test -- --testPathPattern=validation.provider-sanitize`

## Pre-Merge Checklist

- [x] Updated relevant documentation and README (if needed)
- [x] Added/updated tests (if needed)
- [ ] Noted breaking changes (if any)
- [x] Validated on required platforms/methods:
  - [x] Windows
    - [x] npm run
