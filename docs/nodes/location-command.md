---
summary: "Location command (location.get) and event (location.update) for nodes, permission modes, and background behavior"
read_when:
  - Adding location node support or permissions UI
  - Designing Android location permissions or foreground behavior
title: "Location Command"
---

# Location command (nodes)

## TL;DR

- `location.get` is a node command (via `node.invoke`).
- Off by default.
- Android app settings use a selector: Off / While Using.
- Separate toggle: Precise Location.

## Why a selector (not just a switch)

OS permissions are multi-level. We can expose a selector in-app, but the OS still decides the actual grant.

- iOS/macOS may expose **While Using** or **Always** in system prompts/Settings.
- Android app currently supports foreground location only.
- Precise location is a separate grant (iOS 14+ “Precise”, Android “fine” vs “coarse”).

Selector in UI drives our requested mode; actual grant lives in OS settings.

## Settings model

Per node device:

- `location.enabledMode`: `off | whileUsing`
- `location.preciseEnabled`: bool

UI behavior:

- Selecting `whileUsing` requests foreground permission.
- If OS denies requested level, revert to the highest granted level and show status.

## Permissions mapping (node.permissions)

Optional. macOS node reports `location` via the permissions map; iOS/Android may omit it.

## Command: `location.get`

Called via `node.invoke`.

Params (suggested):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Response payload:

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

Errors (stable codes):

- `LOCATION_DISABLED`: selector is off.
- `LOCATION_PERMISSION_REQUIRED`: permission missing for requested mode.
- `LOCATION_BACKGROUND_UNAVAILABLE`: app is backgrounded but only While Using allowed.
- `LOCATION_TIMEOUT`: no fix in time.
- `LOCATION_UNAVAILABLE`: system failure / no providers.

## Event: `location.update`

Nodes can push location updates to the gateway via `node.event` with
`event: "location.update"`. The gateway enqueues the update as a system event
so hooks (e.g. severance) can react to location changes.

Payload:

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "source": "ios-significant-location"
}
```

- `lat` and `lon` are required (finite numbers).
- `accuracyMeters` and `source` are optional.
- `sessionKey` is optional; defaults to `node-<nodeId>`.

The gateway deduplicates events per node via `contextKey: location:<nodeId>` and
triggers a heartbeat wake so the agent session can process the location change.

### Heartbeat delivery

`location.update` is **event-driven, not polling-based**. The gateway:

1. Enqueues the location summary as a system event (`enqueueSystemEvent`).
2. Immediately triggers `requestHeartbeatNow` with reason `"location-update"`.
3. The heartbeat runner wakes within 250ms (coalesce window).

The reason `"location-update"` is classified as `"wake"`, which means:

- **File gate bypass**: the heartbeat runs even if `HEARTBEAT.md` is empty.
- **Pending events inspection**: system events tagged with `location:*` context
  keys are included in the heartbeat prompt, so the agent sees the location
  data (lat, lon, accuracy, source) in the same run.

This follows the same tagged-event pattern as cron events (`cron:*` context
keys). The agent receives the location data as part of its heartbeat prompt
and can act on it immediately (e.g. record to memory, trigger severance logic).

### iOS significant location monitoring

On iOS, the app uses `SignificantLocationMonitor` to push `location.update`
events automatically when the "Always" location mode is enabled and
`authorizedAlways` permission is granted. When the app is backgrounded, the
monitor wakes the gateway connection before sending (see
`handleSignificantLocationWakeIfNeeded`).

## Background behavior

- Android app denies `location.get` while backgrounded.
- Keep OpenClaw open when requesting location on Android.
- Other node platforms may differ.

## Model/tooling integration

- Tool surface: `nodes` tool adds `location_get` action (node required).
- CLI: `openclaw nodes location get --node <id>`.
- Agent guidelines: only call when user enabled location and understands the scope.

## UX copy (suggested)

- Off: “Location sharing is disabled.”
- While Using: “Only when OpenClaw is open.”
- Precise: “Use precise GPS location. Toggle off to share approximate location.”
