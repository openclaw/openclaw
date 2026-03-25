# Browser `open` -> `snapshot` race condition

## Summary

In some environments, a browser `snapshot` can fail with `tab not found` immediately after a successful `open`.
This appears to be a short-lived target propagation race rather than a real tab close.

## Impact

- Intermittent failures in the first `snapshot` after `open`
- Reduced confidence in browser automation stability
- More fallback traffic to `web_fetch`/`web_search`

## Proposed fix

1. Retry target resolution with short backoff (for example, 150ms x 3) when `tab not found` occurs right after `open`.
2. Keep a short-TTL map of recently opened `targetId` values to bridge propagation delay.
3. Improve terminal error output with actionable guidance when retries are exhausted.

## Acceptance criteria

- `open` + immediate `snapshot` no longer flakes in normal local usage
- Behavior remains unchanged for genuinely closed tabs
- Regression coverage exists for `open` -> `snapshot` sequence

## Related discussion

See local draft: `.github/openclaw-pr-draft-browser-tab-race.md`.
