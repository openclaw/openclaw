---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Location command for nodes (location.get), permission modes, and background behavior"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding location node support or permissions UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Designing background location + push flows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Location Command"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Location command (nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## TL;DR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `location.get` is a node command (via `node.invoke`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Off by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Settings use a selector: Off / While Using / Always.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Separate toggle: Precise Location.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why a selector (not just a switch)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OS permissions are multi-level. We can expose a selector in-app, but the OS still decides the actual grant.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iOS/macOS: user can choose **While Using** or **Always** in system prompts/Settings. App can request upgrade, but OS may require Settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android: background location is a separate permission; on Android 10+ it often requires a Settings flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Precise location is a separate grant (iOS 14+ “Precise”, Android “fine” vs “coarse”).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Selector in UI drives our requested mode; actual grant lives in OS settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Settings model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per node device:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `location.enabledMode`: `off | whileUsing | always`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `location.preciseEnabled`: bool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
UI behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Selecting `whileUsing` requests foreground permission.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Selecting `always` first ensures `whileUsing`, then requests background (or sends user to Settings if required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If OS denies requested level, revert to the highest granted level and show status.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Permissions mapping (node.permissions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional. macOS node reports `location` via the permissions map; iOS/Android may omit it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Command: `location.get`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Called via `node.invoke`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Params (suggested):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "timeoutMs": 10000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "maxAgeMs": 15000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "desiredAccuracy": "coarse|balanced|precise"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Response payload:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "lat": 48.20849,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "lon": 16.37208,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "accuracyMeters": 12.5,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "altitudeMeters": 182.0,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "speedMps": 0.0,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "headingDeg": 270.0,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "timestamp": "2026-01-03T12:34:56.000Z",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "isPrecise": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "source": "gps|wifi|cell|unknown"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Errors (stable codes):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LOCATION_DISABLED`: selector is off.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LOCATION_PERMISSION_REQUIRED`: permission missing for requested mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LOCATION_BACKGROUND_UNAVAILABLE`: app is backgrounded but only While Using allowed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LOCATION_TIMEOUT`: no fix in time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LOCATION_UNAVAILABLE`: system failure / no providers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Background behavior (future)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Goal: model can request location even when node is backgrounded, but only when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- User selected **Always**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OS grants background location.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- App is allowed to run in background for location (iOS background mode / Android foreground service or special allowance).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Push-triggered flow (future):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Gateway sends a push to the node (silent push or FCM data).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Node wakes briefly and requests location from the device.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Node forwards payload to Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iOS: Always permission + background location mode required. Silent push may be throttled; expect intermittent failures.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android: background location may require a foreground service; otherwise, expect denial.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Model/tooling integration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool surface: `nodes` tool adds `location_get` action (node required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw nodes location get --node <id>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent guidelines: only call when user enabled location and understands the scope.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## UX copy (suggested)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Off: “Location sharing is disabled.”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- While Using: “Only when OpenClaw is open.”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Always: “Allow background location. Requires system permission.”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Precise: “Use precise GPS location. Toggle off to share approximate location.”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
