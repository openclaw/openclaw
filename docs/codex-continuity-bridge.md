# Codex Continuity Bridge

The Codex continuity bridge is implemented inside the bundled `codex` plugin. It keeps Codex UI as the primary coding workbench while giving OpenClaw and Telegram a quiet operator surface.

## Commands

- `/codex status` shows bridge status, active/recent threads, watch count, and whether data is live app-server state or stale SQLite fallback.
- `/codex threads` lists recent threads and watch hints.
- `/codex watch [thread-id]` registers an explicit watch for completion/failure/blocker/approval/auth events.
- `/codex handoff [thread-id]` returns an evidence-separated handoff brief.
- `/codex goal <goal text>` is present but disabled by default by the bridge safety policy.

## Routes

All routes require gateway auth:

- `GET /codex/status`
- `GET /codex/threads`
- `POST /codex/watch`
- `POST /codex/watch/check`
- `POST /codex/handoff`
- `POST /codex/goal`
- `POST /codex/steer`

## Safety Defaults

The bridge is read-only with respect to Codex unless `codexBridge.enableTelegramWrites` is explicitly enabled and all write gates pass. SQLite is a read-only fallback only. Telegram notifications are sent only for explicit watches and are deduped/redacted.

Write requests require provenance, trusted sender policy, repo allowlist, unambiguous target selection, acceptable risk class, and explicitly confirmed app-server write methods.
