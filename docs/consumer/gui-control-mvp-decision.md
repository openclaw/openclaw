# Consumer GUI Control MVP Decision

Last updated: 2026-03-22
Status: deferred by default

## Decision

Consumer GUI control is not part of the first MVP by default.

Reason:

- most consumer users do not need desktop GUI control on day one
- GUI control adds extra macOS permission and setup burden
- shipping it half-working would create more confusion than value

## Current product rule

Treat GUI control as a later feasibility check, not a launch blocker.

Keep it out of the default consumer product surface unless all of the following become true:

- the packaged `OpenClaw Consumer` app can expose GUI control through the consumer Telegram bot
- the setup is simple enough for non-technical users
- one safe GUI-control action works reliably end to end
- failures are explained clearly without developer jargon

If that bar is not met, strip or hide GUI control from the consumer experience for now.

## What to test later

When this comes back into scope, keep the validation lane narrow:

1. Use the packaged consumer app, not a dev-only local shortcut.
2. Use the existing consumer Telegram bot path, not a separate operator-only control lane.
3. Test one safe, visible GUI action first.
4. Verify both success and clean failure behavior.

Recommended first smoke action:

- open or focus the consumer app window
- or open one clearly visible, low-risk system surface

Do not start with arbitrary desktop control. Prove one stable consumer-safe action first.

## Non-goals for the current pass

- no full GUI-control redesign
- no new onboarding flow just for desktop automation
- no new public CLI surface
- no shipping decision based on developer-only setups
