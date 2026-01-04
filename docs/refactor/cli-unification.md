---
summary: "Refactor: unify on the clawdbot CLI + gateway-first control; retire clawdbot-mac"
read_when:
  - Removing or replacing the macOS CLI helper
  - Adding node capabilities or permissions metadata
  - Updating macOS app packaging/install flows
---

# CLI unification (clawdbot-only)

Status: active refactor · Date: 2025-12-20

## Goals
- **Single CLI**: use `clawdbot` for all automation (local + remote). Retire `clawdbot-mac`.
- **Gateway-first**: all agent actions flow through the Gateway WebSocket + node.invoke.
- **Permission awareness**: nodes advertise permission state so the agent can decide what to run.
- **No duplicate paths**: remove macOS control socket + Swift CLI surface.

## Non-goals
- Keep legacy `clawdbot-mac` compatibility.
- Support agent control when no Gateway is running.

## Key decisions
1) **No Gateway → no control**
   - If the macOS app is running but the Gateway is not, remote commands (canvas/run/notify) are unavailable.
   - This is acceptable to keep one network surface.

2) **Remove ensure-permissions CLI**
   - Permissions are **advertised by the node** (e.g., screen recording granted/denied).
   - Commands will still fail with explicit errors when permissions are missing.

3) **Mac app installs/symlinks `clawdbot`**
   - Bundle a standalone `clawdbot` binary in the app (bun-compiled).
   - Install/symlink that binary to `/usr/local/bin/clawdbot` and `/opt/homebrew/bin/clawdbot`.
   - No `clawdbot-mac` helper remains.

4) **Canvas parity across node types**
   - Use `node.invoke` commands consistently (`canvas.present|navigate|eval|snapshot|a2ui.*`).
   - The TS CLI provides convenient wrappers so agents never have to craft raw `node.invoke` calls.

## Command surface (new/normalized)
- `clawdbot nodes invoke --command canvas.*` remains valid.
- New CLI wrappers for convenience:
  - `clawdbot canvas present|navigate|eval|snapshot|a2ui push|a2ui reset`
- New node commands (mac-only initially):
  - `system.run` (shell execution)
  - `system.notify` (local notifications)

## Permission advertising
- Node hello/pairing includes a `permissions` map:
  - Example keys: `screenRecording`, `accessibility`, `microphone`, `notifications`, `speechRecognition`.
  - Values: boolean (`true` = granted, `false` = not granted).
- Gateway `node.list` / `node.describe` surfaces the map.

## Gateway mode + config
- Gateways should only auto-start when explicitly configured for **local** mode.
- When config is missing or explicitly remote, `clawdbot gateway` should refuse to auto-start unless forced.

## Implementation checklist
- Add bun-compiled `clawdbot` binary to macOS app bundle; update codesign + install flows.
- Remove `ClawdbotCLI` target and control socket server.
- Add node command(s) for `system.run` and `system.notify` on macOS.
- Add permission map to node hello/pairing + gateway responses.
- Update TS CLI + docs to use `clawdbot` only.
