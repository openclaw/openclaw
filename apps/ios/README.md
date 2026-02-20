# OpenClaw iOS (Super Alpha)

NO TEST FLIGHT AVAILABLE AT THIS POINT

This iPhone app is super-alpha and internal-use only. It connects to an OpenClaw Gateway as a `role: node`.

## Distribution Status

NO TEST FLIGHT AVAILABLE AT THIS POINT

- Current distribution: local/manual deploy from source via Xcode.
- App Store flow is not part of the current internal development path.

## Super-Alpha Disclaimer

- Breaking changes are expected.
- UI and onboarding flows can change without migration guarantees.
- Foreground use is the only reliable mode right now.
- Treat this build as sensitive while permissions and background behavior are still being hardened.

## Exact Xcode Manual Deploy Flow

1. Prereqs:
   - Xcode 16+
   - `pnpm`
   - `xcodegen`
   - Apple Development signing set up in Xcode
2. From repo root:

```bash
pnpm install
./scripts/ios-configure-signing.sh
cd apps/ios
xcodegen generate
open OpenClaw.xcodeproj
```

3. In Xcode:
   - Scheme: `OpenClaw`
   - Destination: connected iPhone (recommended for real behavior)
   - Build configuration: `Debug`
   - Run (`Product` -> `Run`)
4. If signing fails on a personal team:
   - Use unique local bundle IDs via `apps/ios/LocalSigning.xcconfig`.
   - Start from `apps/ios/LocalSigning.xcconfig.example`.

Shortcut command (same flow + open project):

```bash
pnpm ios:open
```

## APNs Expectations For Local/Manual Builds

- The app calls `registerForRemoteNotifications()` at launch.
- `apps/ios/Sources/OpenClaw.entitlements` sets `aps-environment` to `development`.
- APNs token registration to gateway happens only after gateway connection (`push.apns.register`).
- Your selected team/profile must support Push Notifications for the app bundle ID you are signing.
- If push capability or provisioning is wrong, APNs registration fails at runtime (check Xcode logs for `APNs registration failed`).
- Debug builds register as APNs sandbox; Release builds use production.

## What Works Now (Concrete)

- Pairing via setup code flow (`/pair` then `/pair approve` in Telegram).
- Gateway connection via discovery or manual host/port with TLS fingerprint trust prompt.
- Chat + Talk surfaces through the operator gateway session.
- iPhone node commands in foreground: camera snap/clip, canvas present/navigate/eval/snapshot, screen record, location, contacts, calendar, reminders, photos, motion, local notifications.
- Share extension deep-link forwarding into the connected gateway session.

## Known Issues / Limitations / Problems

- Foreground-first: iOS can suspend sockets in background; reconnect recovery is still being tuned.
- Background command limits are strict: `canvas.*`, `camera.*`, `screen.*`, and `talk.*` are blocked when backgrounded.
- Background location requires `Always` location permission.
- Pairing/auth errors intentionally pause reconnect loops until a human fixes auth/pairing state.
- Voice Wake and Talk contend for the same microphone; Talk suppresses wake capture while active.
- APNs reliability depends on local signing/provisioning/topic alignment.
- Expect rough UX edges and occasional reconnect churn during active development.

## Current In-Progress Workstream

Automatic wake/reconnect hardening:

- improve wake/resume behavior across scene transitions
- reduce dead-socket states after background -> foreground
- tighten node/operator session reconnect coordination
- reduce manual recovery steps after transient network failures

## Debugging Checklist

1. Confirm build/signing baseline:
   - regenerate project (`xcodegen generate`)
   - verify selected team + bundle IDs
2. In app `Settings -> Gateway`:
   - confirm status text, server, and remote address
   - verify whether status shows pairing/auth gating
3. If pairing is required:
   - run `/pair approve` from Telegram, then reconnect
4. If discovery is flaky:
   - enable `Discovery Debug Logs`
   - inspect `Settings -> Gateway -> Discovery Logs`
5. If network path is unclear:
   - switch to manual host/port + TLS in Gateway Advanced settings
6. In Xcode console, filter for subsystem/category signals:
   - `ai.openclaw.ios`
   - `GatewayDiag`
   - `APNs registration failed`
7. Validate background expectations:
   - repro in foreground first
   - then test background transitions and confirm reconnect on return
