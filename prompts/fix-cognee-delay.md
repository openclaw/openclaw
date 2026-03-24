<!-- Authored by: cc (Claude Code) | 2026-03-24 -->

# Fix: Cognee hook causing ~2min delay per agent turn

## Problem

The `cognee-openclaw` plugin is configured as the memory provider and hooks into every agent turn. It calls `localhost:8765` for recall/store operations. The cognee service is down, so every call blocks until the abort timeout (~2 min), making all Discord/webchat responses take minutes instead of seconds.

## Evidence

```
gateway.err.log:
06:34:37 [gateway] cognee-openclaw: recall failed: AbortError: This operation was aborted
06:36:16 [gateway] cognee-openclaw: recall failed: AbortError: This operation was aborted
(repeats every agent turn)
```

## Config locations

- `~/.openclaw/openclaw.json` — cognee references:
  - `plugins.allow` array contains `"cognee-openclaw"`
  - `plugins.entries.cognee-openclaw` — plugin spec `@cognee/cognee-openclaw@2026.3.0`
  - `plugins.entries.cognee-openclaw.installPath` — `~/.openclaw/extensions/cognee-openclaw`
  - `agents.defaults.memory` — set to `"cognee-openclaw"`

## Option A: Fix the cognee service (preferred if you want memory)

1. Check if cognee is installed: `pip show cognee` or `which cognee`
2. Check if the service can start: `cognee serve` or however it was originally launched
3. Verify it listens on `localhost:8765`: `curl -s http://localhost:8765/health`
4. If it needs Docker: check `docker ps -a | grep cognee`
5. Once running, gateway should auto-recover — no restart needed

## Option B: Disable cognee (stops the delay immediately)

1. Edit `~/.openclaw/openclaw.json`:
   - Remove `"cognee-openclaw"` from `plugins.allow` array
   - Remove the `"cognee-openclaw"` entry from `plugins.entries`
   - Remove or comment out `"memory": "cognee-openclaw"` from `agents.defaults`
2. Restart gateway: `cd ~/Developer/openclaw-323 && pnpm deploy:stable:fast`
   Or quick restart: `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`

## Option C: Reduce timeout (compromise — keep cognee configured but fail fast)

Check if the cognee plugin config accepts a timeout setting. If so, set it to 2-3 seconds so failed recalls don't block the agent turn for 2 minutes.
