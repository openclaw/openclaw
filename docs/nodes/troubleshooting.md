---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Troubleshoot node pairing, foreground requirements, permissions, and tool failures"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Node is connected but camera/canvas/screen/exec tools fail（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need the node pairing versus approvals mental model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Node Troubleshooting"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Node troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this page when a node is visible in status but node tools fail.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Command ladder（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then run node specific checks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes describe --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals get --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Healthy signals:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node is connected and paired for role `node`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes describe` includes the capability you are calling.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals show expected mode/allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Foreground requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`canvas.*`, `camera.*`, and `screen.*` are foreground only on iOS/Android nodes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick check and fix:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes describe --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas snapshot --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you see `NODE_BACKGROUND_UNAVAILABLE`, bring the node app to the foreground and retry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Permissions matrix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Capability                   | iOS                                     | Android                                      | macOS node app                | Typical failure code           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------------- | --------------------------------------- | -------------------------------------------- | ----------------------------- | ------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `camera.snap`, `camera.clip` | Camera (+ mic for clip audio)           | Camera (+ mic for clip audio)                | Camera (+ mic for clip audio) | `*_PERMISSION_REQUIRED`        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `screen.record`              | Screen Recording (+ mic optional)       | Screen capture prompt (+ mic optional)       | Screen Recording              | `*_PERMISSION_REQUIRED`        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `location.get`               | While Using or Always (depends on mode) | Foreground/Background location based on mode | Location permission           | `LOCATION_PERMISSION_REQUIRED` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `system.run`                 | n/a (node host path)                    | n/a (node host path)                         | Exec approvals required       | `SYSTEM_RUN_DENIED`            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pairing versus approvals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are different gates:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Device pairing**: can this node connect to the gateway?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Exec approvals**: can this node run a specific shell command?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick checks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw devices list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals get --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If pairing is missing, approve the node device first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If pairing is fine but `system.run` fails, fix exec approvals/allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common node error codes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `NODE_BACKGROUND_UNAVAILABLE` → app is backgrounded; bring it foreground.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `CAMERA_DISABLED` → camera toggle disabled in node settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `*_PERMISSION_REQUIRED` → OS permission missing/denied.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LOCATION_DISABLED` → location mode is off.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LOCATION_PERMISSION_REQUIRED` → requested location mode not granted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `LOCATION_BACKGROUND_UNAVAILABLE` → app is backgrounded but only While Using permission exists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SYSTEM_RUN_DENIED: approval required` → exec request needs explicit approval.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SYSTEM_RUN_DENIED: allowlist miss` → command blocked by allowlist mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Fast recovery loop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes describe --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals get --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If still stuck:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Re-approve device pairing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Re-open node app (foreground).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Re-grant OS permissions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Recreate/adjust exec approval policy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/nodes/index](/nodes/index)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/nodes/camera](/nodes/camera)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/nodes/location-command](/nodes/location-command)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/tools/exec-approvals](/tools/exec-approvals)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/gateway/pairing](/gateway/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
