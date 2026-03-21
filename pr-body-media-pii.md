## Summary

When a media fetch operation fails, the raw error message — which may contain serialized JSON with private group IDs, phone numbers, user names, and internal system paths — was posted to the configured channel as if it were a normal reply. This exposed PII to public-facing channels like Discord and Telegram.

**Example of what was leaking:**

```
Media failed: {"group_id":"@g.us","sender":"+905...","name":"John Doe","path":"/home/user/.openclaw/..."}
```

## Details

Added `SAFE_MEDIA_FETCH_ERROR_MESSAGE` constant and `isSafeMediaFetchError()` helper to `src/media/fetch.ts`. When a `MediaFetchError` is detected at the outbound delivery layer (`message-action-params.ts`, `message-action-runner.ts`, `deliver.ts`), the raw error is replaced with:

```
⚠️ Media fetch failed. The attachment could not be retrieved.
```

The original error is still logged internally via `logVerbose` — it is only redacted from the outbound channel payload.

Three sanitization boundary points:

1. `message-action-params.ts` — params resolution for media actions
2. `message-action-runner.ts` — action execution runner
3. `deliver.ts` — final delivery layer

## Related Issues

Fixes #20279

## How to Validate

Trigger a media fetch that fails (invalid URL or timeout). Confirm:

- Channel receives the generic safe message
- `logVerbose` / internal logs still contain the full error

Run unit tests:

```bash
pnpm test -- --testPathPattern="fetch|message-action-runner.media"
```

Note: `message-action-runner.media.test.ts` requires `@anthropic-ai/vertex-sdk` which was added to `main` today (commit `6e20c4baa0`). The test will pass once dependencies are installed in CI. The `fetch.test.ts` suite (12 tests) passes locally and covers the core PII sanitization behavior.

## Pre-Merge Checklist

- [x] Updated relevant documentation and README (if needed)
- [x] Added/updated tests (if needed)
- [ ] Noted breaking changes (if any)
- [x] Validated on required platforms/methods:
  - [x] Windows
    - [x] npm run
