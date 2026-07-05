---
summary: "Location command for nodes (location.get), permission modes, and Android foreground behavior"
read_when:
  - Adding location node support or permissions UI
  - Designing Android location permissions or foreground behavior
title: "Location command"
---

## TL;DR

- `location.get` is a node command, invoked via `node.invoke` or `openclaw nodes location get`.
- Off by default.
- Android app settings use a selector: Off / While Using.
- Precise Location is a separate toggle.

## Why a selector (not just a switch)

OS location permissions are multi-level (iOS/macOS expose While Using vs Always; Android currently supports foreground-only). Precise location is a separate OS grant too (iOS 14+ "Precise", Android "fine" vs "coarse"). The in-app selector drives the requested mode, but the OS still decides the actual grant.

## Settings model

Per node device:

- `location.enabledMode`: `off | whileUsing`
- `location.preciseEnabled`: bool

UI behavior:

- Selecting `whileUsing` requests foreground permission.
- If the OS denies the requested level, the app reverts to the highest granted level and shows status.

## Permissions mapping (node.permissions)

Optional. The macOS node reports `location` via the `permissions` map on `node.list`/`node.describe`; iOS/Android may omit it.

## Command: `location.get`

Called via `node.invoke`, or the CLI helper:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Params:

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

CLI flags map directly: `--location-timeout` -> `timeoutMs`, `--max-age` -> `maxAgeMs`, `--accuracy` -> `desiredAccuracy`.

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
- `LOCATION_BACKGROUND_UNAVAILABLE`: app is backgrounded but only While Using is granted.
- `LOCATION_TIMEOUT`: no fix in time.
- `LOCATION_UNAVAILABLE`: system failure or no providers.

## Background behavior

- The Android app denies `location.get` while backgrounded; keep OpenClaw open when requesting location on Android.
- Other node platforms may differ.

## Model/tooling integration

- Agent tool: the `nodes` tool's `location_get` action (node required).
- CLI: `openclaw nodes location get --node <id>`.
- Agent guidelines: only call when the user enabled location and understands the scope.

## UX copy (suggested)

- Off: "Location sharing is disabled."
- While Using: "Only when OpenClaw is open."
- Precise: "Use precise GPS location. Toggle off to share approximate location."

## Related

- [Nodes overview](/nodes)
- [Channel location parsing](/channels/location)
- [Camera capture](/nodes/camera)
- [Talk mode](/nodes/talk)
