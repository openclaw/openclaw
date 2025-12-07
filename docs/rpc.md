# Clawdis Agent RPC (proposal)

## Motivation
- Voice wake forwarding and mac CLI currently shell out to `pnpm clawdis agent --json`, spawning a Node process per send.
- pi-mono’s coding-agent keeps a hot process in RPC mode: read JSON on stdin, emit JSON on stdout.
- We want the same pattern so cross-host voice → WhatsApp uses a long-lived Node worker, better latency, and structured errors.

## Goal
Run the Node CLI in `--mode rpc` on the host that has the active WhatsApp session. Communicate over stdin/stdout with newline-delimited JSON messages.

## Proposed protocol
### Commands (stdin)
- `{"type":"send", "text":"hi", "session":"main", "thinking":"low"}`
- `{"type":"abort"}` – cancel current generation (if supported)
- `{"type":"status"}` – health ping
- (Optional) `{"type":"compact"}` – trigger session compaction

### Events (stdout)
- `{"type":"message_start", "role":"assistant"}`
- `{"type":"message_end", "text":"..."}`
- `{"type":"error", "error":"message"}`
- `{"type":"status", "ok":true, "details":"..."}`
- Preserve existing `--json` payload shape where possible so consumers can reuse parsers.

## Runtime design (Node CLI)
- Add `--mode rpc` to the Node CLI (similar to pi-mono’s coding-agent).
- Initialize agent/session once, keep it alive.
- Use readline on stdin; for each JSON line, dispatch:
  - `send` → call agent, stream message events to stdout as they occur.
  - `abort` → cancel current request.
  - `status` → emit `{type:"status", ok:true}`.
- Never exit unless stdin closes; log fatal errors to stderr and emit `{type:"error"}` before exit.

## Mac-side integration
- Create an `RpcAgentProcess` helper:
  - Spawn `pnpm clawdis --mode rpc` in repo root (`/Users/steipete/Projects/clawdis`).
  - Keep stdin/stdout pipes; restart on exit.
  - Method `send(text, session, thinking)` → write JSON line, wait for `message_end` or `error`, return result.
- XPC handler `agent`:
  - Prefer RpcAgentProcess; if unavailable, fall back to one-shot `pnpm clawdis agent --json` (existing behavior).
  - Return errors to callers (voice wake, CLI) so failures are visible in logs/UI.

## Voice wake path
- Voice wake forward still SSHes to the WhatsApp host; the host’s XPC `agent` uses RpcAgentProcess to deliver the message without extra process spawn.
- If RPC is down, it falls back to one-shot and logs the failure.

## Error handling & observability
- All non-OK responses emit an `error` event with the message/exit code.
- Mac logs on `VoiceWakeForwarder` already surface SSH/CLI failures; extend to tag RPC restarts.
- Consider a `clawdis-mac status --rpc` flag to report whether the RPC worker is live.

## Next steps
1) Implement `--mode rpc` in Node CLI (mirror pi-mono’s coding-agent main.ts rpc path).
2) Add `RpcAgentProcess` in the mac app; switch XPC `agent` to use it.
3) Wire `clawdis-mac agent` to prefer RPC, fall back to one-shot.
4) Optional: add a tiny RPC health metric to status JSON.
