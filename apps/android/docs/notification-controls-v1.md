# Android Notification Controls v1 (upstream-safe plan)

Status: draft implementation spec  
Branch: `feature/android-notification-controls-v1`  
Scope target: `openclaw/openclaw` main Android app (no custom-lane coupling)

## Goal
Add granular controls so NotificationListener permission does not automatically imply noisy ingestion into agent workflows.

## Non-goals (v1)
- No ML-based priority classification.
- No per-conversation deep parsing by app-specific APIs.
- No breaking changes to existing invoke methods.

## Current behavior (baseline)
- Android emits `notifications.changed` on posted/removed notifications.
- Gateway enqueues system events and wakes heartbeat.
- Flow is broadly enabled once notification access is granted.

## v1 Controls

### 1) Master ingestion switch
- `enabled`: keep listener permission state separate from forwarding behavior.
- If off: listener can remain granted, but no forwarding events are emitted.

### 2) App policy filter
- `mode`: `allowlist | blocklist`
- `packages`: string[] package names.
- Defaults:
  - mode: `blocklist`
  - packages: [OpenClaw package itself]

### 3) Quiet hours
- `quietHoursEnabled`: boolean
- `quietStart`: `HH:mm`
- `quietEnd`: `HH:mm`
- During quiet hours: suppress event forwarding (still keep local snapshot available to explicit tool calls).

### 4) Burst/rate guard
- `maxEventsPerMinute`: integer (default 20)
- Excess events are dropped with local counters.

### 5) Session routing key (Android side)
- `sessionKey`: optional string (default empty)
- If set, include in `notifications.changed` payload for gateway routing.
- If empty, preserve current gateway fallback behavior.

## Data model (Android prefs)

```json
{
  "notifications": {
    "enabled": true,
    "mode": "blocklist",
    "packages": ["ai.openclaw.android"],
    "quietHoursEnabled": false,
    "quietStart": "22:00",
    "quietEnd": "07:00",
    "maxEventsPerMinute": 20,
    "sessionKey": ""
  }
}
```

## Implementation file touch list (expected)

### Android
- `apps/android/app/src/main/java/ai/openclaw/android/SecurePrefs.kt`
  - add notification policy state + setters/getters.
- `apps/android/app/src/main/java/ai/openclaw/android/node/DeviceNotificationListenerService.kt`
  - gate `emitNotificationsChanged(...)` with policy checks:
    - master enabled
    - package filter
    - quiet hours
    - rate guard
  - include optional `sessionKey` in payload.
- `apps/android/app/src/main/java/ai/openclaw/android/ui/SettingsSheet.kt`
  - add Notification Controls section (minimal controls v1).
- `apps/android/app/src/main/java/ai/openclaw/android/ui/OnboardingFlow.kt` (optional)
  - keep permission flow unchanged; link to “advanced controls in settings”.

### Tests
- Unit tests for policy matcher/time window/rate limiter (new test file near listener service).
- Existing notification handler tests extended for payload `sessionKey` when configured.

## Backward compatibility
- Default behavior should remain effectively current when:
  - `enabled=true`
  - no package constraints beyond self-filter
  - quiet hours disabled
- Existing gateway handlers remain unchanged.

## Rollout plan
1. Land Android-side policy internals + tests.
2. Land settings UI toggles.
3. Dogfood on personal device for 3–5 days.
4. Capture metrics/observations (missed important notifications, false positives, token reduction).
5. Upstream PR with feature defaults + docs.

## PR strategy
- PR 1: policy engine + prefs + tests (no UI)
- PR 2: settings UI + docs
- Keep each PR under ~500 LOC net where possible.

## Acceptance criteria
- Notification permission can be ON while forwarding is OFF.
- Package filtering works deterministically.
- Quiet hours suppress forwarding.
- Rate limiter prevents bursts from flooding events.
- Optional sessionKey routing works and does not break default behavior.
