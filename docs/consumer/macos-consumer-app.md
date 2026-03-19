# Consumer macOS App

The consumer macOS app is the simplified local controller for the OpenClaw consumer product.

## Purpose

- Keep the default experience local-first and beginner-friendly.
- Let the consumer app coexist with the founder app on the same Mac.
- Hide operator-heavy controls behind an **Advanced** toggle instead of exposing everything on day 1.

## Isolation model

The consumer build is a separate app/runtime identity, not a separate repository.

- App identity: separate bundle identifier and app variant metadata
- State directory: `~/.openclaw-consumer`
- Local gateway port: `19001`
- Launch labels: `ai.openclaw.consumer.mac` and `ai.openclaw.consumer.gateway`
- Logs: `/tmp/openclaw-consumer`

This keeps consumer testing from silently reusing the founder runtime.

## Default UX

The consumer app defaults to:

- Local setup on this Mac
- Minimal menu bar controls
- Minimal settings tabs: General, Permissions, About
- Remote configuration hidden behind **Advanced**
- Power-user areas such as Skills, Config, Sessions, Cron, and Debug hidden by default

The goal is to reduce cognitive overload without deleting advanced capabilities yet.

## Safe local testing

Package the consumer app with a separate app identity:

```bash
APP_NAME="OpenClaw Consumer" \
APP_BUNDLE_NAME="OpenClaw Consumer.app" \
BUNDLE_ID="ai.openclaw.consumer.mac.debug" \
APP_VARIANT=consumer \
URL_SCHEME=openclaw-consumer \
scripts/package-mac-app.sh
```

This produces a consumer-flavored app bundle that can be tested alongside the founder app.

## Distribution assumption

Consumer v1 targets signed + notarized direct download distribution.

- Web-based subscriptions and billing are allowed and assumed outside the app.
- Mac App Store distribution is deferred.
- Current product decisions should not be shaped by Mac App Store constraints.

## Future iPhone path

The Mac remains the execution host.

- Telegram is the current primary consumer interface.
- A future iPhone app should act as a companion/controller for the same consumer runtime.
- Consumer UI copy should describe a local AI operator, not hardcode Telegram as the only long-term control surface.
