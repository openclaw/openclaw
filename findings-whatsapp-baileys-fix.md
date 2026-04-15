# Findings - whatsapp-baileys-fix

## Initial Findings
- PR branch now includes newer upstream commits on the same branch, but local HEAD still contained our compatibility-breaking `loginWeb` signature.
- Current CI failures on our local head were:
  - `build-smoke`: root dist still imports `@whiskeysockets/baileys` from `monitor-*.js` and `session-*.js`
  - `extension-fast-whatsapp`: `login.coverage.test.ts` expected `createWaSocketMock` call count 1 but saw 0
  - `login.test.ts` still called legacy `loginWeb(false, waiter)` shape and crashed because runtime/waiter arg positions no longer matched.
- Practical immediate repair: make `loginWeb` backward compatible with both call shapes while preserving explicit injected `createSocket` / `waitForConnection` seams.
