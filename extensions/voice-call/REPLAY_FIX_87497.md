# Replay protection: Twilio webhook fix (Issue #87497)

## Summary

This change prevents replayed Twilio webhooks from triggering side effects (notably issuing fresh realtime stream tokens).

## What we changed

- Added an early replay guard in `extensions/voice-call/src/webhook.ts` that runs immediately after request verification. If a request is detected as a replay, the handler returns cached TwiML (if available) or a safe empty TwiML response and avoids any token minting or other side effects.
- Implemented a small in-memory replay TwiML cache with a TTL (120s) and a maximum size (1000 entries) to ensure retries receive the same TwiML response.
- Added `buildEmptyTwiML()` which returns a safe `<Response><Reject/></Response>` TwiML body for cache misses.
- Updated tests in `extensions/voice-call/src/webhook.test.ts` to assert that replayed requests do not call `buildTwiMLPayload()` or issue tokens, and that responses are either cached TwiML or the safe reject TwiML.

## Key files modified

- `extensions/voice-call/src/webhook.ts` — early replay guard, replay cache, helpers `getReplayTwiML()` and `storeReplayTwiML()`.
- `extensions/voice-call/src/webhook.test.ts` — updated/added tests to cover replay behavior and ensure no token issuance.

## Behavioral notes

- Cache key uses the verified request key from the verification provider to avoid poisoning from user input.
- Replay cache TTL: 120000 ms (2 minutes).
- Replay cache max entries: 1000. Oldest entries are evicted when full.
- On cache miss for a replay, the handler returns the safe empty TwiML and a 200 OK with `Content-Type: text/xml`.

## How to run tests locally

Run the voice-call tests (you can target the file changed):

```powershell
npx vitest run extensions/voice-call/src/webhook.test.ts
```

## Branch & PR

- Local branch: `fix/87497-replay-stream-token-guard`
- Suggested PR title: `fix(voice-call): prevent replayed Twilio webhooks from minting stream tokens (fixes #87497)`

## Rollout & verification

1. Push the branch and open a PR (if you don't have write access, push to your fork and open PR from the fork).
2. Run CI and ensure the voice-call tests pass and no regressions are introduced.
3. After merging, monitor production logs for any unexpected rejections or replay-related warnings for a short period.

## Follow-ups

- Add more unit/integration tests per the implementation plan (cache eviction/expiry, multi-replay scenarios).
- Consider adding a persistent audit route for issued stream tokens and a security regression CI check.

## Contact

If you want, I can push this branch for you (requires GitHub push access or a fork) and open the PR. Tell me how you'd like to proceed.
