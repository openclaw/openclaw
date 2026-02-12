# Fix: Gateway crashes on Telegram fetch errors (Issue #12835)

## Description

This PR fixes a bug where the gateway would crash when checking for Telegram updates if the network connection failed with a native `fetch failed` error (e.g., `TypeError: fetch failed`).

Previously, the unhandled rejection handler in `src/telegram/monitor.ts` only suppressed errors that were BOTH `GrammyHttpError` AND recoverable network errors. Native fetch errors are not wrapped in `GrammyHttpError`, so they were allowed to bubble up and crash the process.

This change relaxes the check to suppress **any** error that matches `isRecoverableTelegramNetworkError`, regardless of its type wrapper.

## Related Issue

Fixes #12835

## Changes

- Modified `src/telegram/monitor.ts` to remove the `isGrammyHttpError` check in the unhandled rejection handler.
- Removed the unused `isGrammyHttpError` helper function.

## Verification

- Created a reproduction script simulating a `TypeError: fetch failed` with `ConnectTimeoutError` cause.
- Verified that the new logic correctly identifies and suppresses this error.
- Ran `pnpm check` and `pnpm test` to ensure no regressions.
