---
summary: "Troubleshooting guide for the web gateway/Baileys stack"
read_when:
  - Diagnosing web gateway socket or login issues
---
# Web Gateway Troubleshooting (Nov 26, 2025)

## Symptoms & quick fixes
- **Stream Errored / Conflict / status 409–515:** WhatsApp closed the socket because another session is active or creds went stale. Run `clawdbot logout`, then `clawdbot login`, then restart the Gateway.
- **Logged out:** Console prints “session logged out”; re-link with `clawdbot login`.
- **Repeated retries then exit:** Tune reconnect behavior via config `web.reconnect` and restart the Gateway.
- **No inbound messages:** Ensure the QR-linked account is online in WhatsApp, and check logs for `web-heartbeat` to confirm auth age/connection.
- **Status 515 right after pairing:** The QR login flow now auto-restarts once; you should not need a manual gateway restart after scanning.
- **Fast nuke:** From an allowed WhatsApp sender you can send `/restart` to request a supervised restart (launchd/mac app setups); wait a few seconds for it to come back.

## Helpful commands
- Start the Gateway: `clawdbot gateway --verbose`
- Logout (clear creds): `clawdbot logout`
- Relink (show QR): `clawdbot login --verbose`
- Tail logs (default): `tail -f /tmp/clawdbot/clawdbot-*.log`

## Reading the logs
- `web-reconnect`: close reasons, retry/backoff, max-attempt exit.
- `web-heartbeat`: connectionId, messagesHandled, authAgeMs, uptimeMs (every 60s by default).
- `web-auto-reply`: inbound/outbound message records with correlation IDs.

## When to tweak knobs
- High churn networks: increase `web.reconnect.maxAttempts`.
- Slow links: raise `web.reconnect.maxMs` to give more headroom before bailing.
- Chatty monitors: increase `web.heartbeatSeconds` if log volume is high.

## If it keeps failing
1) `clawdbot logout` → `clawdbot login` (fresh QR link).
2) Ensure no other device/browser is using the same WA Web session.
3) Check WhatsApp mobile app is online and not in low-power mode.
4) If status is 515, let the client restart once after pairing (already handled automatically).
5) Capture the last `web-reconnect` entry and the status code before escalating.
