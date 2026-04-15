# Progress - whatsapp-baileys-fix

- 05:00 EDT — Started staged repair workflow after CI showed `build-smoke` and `extension-fast-whatsapp` failures; upstream also pushed additional commits.
- 05:05 EDT — Confirmed `preflight` is green again after `.gitmodules` addition; active failures are `build-smoke` and WhatsApp login tests.
- 05:08 EDT — Traced test regression to `loginWeb` signature drift: `login.test.ts` still uses legacy `loginWeb(false, waiter)` form while coverage tests use injected `createSocket` as later arg.
- 05:10 EDT — Reworked `login.ts` to accept both legacy and new call shapes, preserving explicit `waitForConnection` and `createSocket` injection.
