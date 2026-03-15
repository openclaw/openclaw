# VioDashboard Stable Snapshot

Version: 2026-03-11-ui-v1

## Scope locked in this snapshot
- Repo-backed launchd startup (`/Users/visen24/MAS/openclaw_fork/apps/viodashboard`)
- Ultra-wide dashboard layout tuned for 32-inch ultrawide usage
- Real websocket-driven mood / routing / telemetry / debug panels
- Token totals sourced from `sessions.usage`
- Model window estimate sourced from `sessions.usage` + `models.list`
- Chat avatars, timestamps, streaming/final visual split
- V1 status-linked UI (gateway link, mood states, model window threshold)
- Lightweight Notes controls:
  - animations on/off
  - compact mode on/off
  - telemetry density normal/compact
- Dev/debug info block:
  - workspace path
  - port
  - session key
  - current model
  - css/app short hashes

## Restore checklist
1. Confirm LaunchAgent points to workspace root, not runtime copy.
2. Confirm wrapper URL is `http://127.0.0.1:8789`.
3. Confirm `/styles.css?v=2` returns 200.
4. Confirm Notes panel shows settings + dev info.
5. Confirm sending a message causes:
   - mood -> thinking/streaming
   - streaming assistant text -> neon blue
   - final assistant text -> neon purple with border

## Known approximations
- `Model Window` is estimated usage, not provider-native real-time context occupancy.
- `Last Tokens` is calculated from cumulative `sessions.usage` deltas.
