---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "RPC adapters for external CLIs (signal-cli, legacy imsg) and gateway patterns"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or changing external CLI integrations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging RPC adapters (signal-cli, imsg)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "RPC Adapters"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# RPC adapters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw integrates external CLIs via JSON-RPC. Two patterns are used today.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pattern A: HTTP daemon (signal-cli)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `signal-cli` runs as a daemon with JSON-RPC over HTTP.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Event stream is SSE (`/api/v1/events`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Health probe: `/api/v1/check`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw owns lifecycle when `channels.signal.autoStart=true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Signal](/channels/signal) for setup and endpoints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pattern B: stdio child process (legacy: imsg)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **Note:** For new iMessage setups, use [BlueBubbles](/channels/bluebubbles) instead.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw spawns `imsg rpc` as a child process (legacy iMessage integration).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- JSON-RPC is line-delimited over stdin/stdout (one JSON object per line).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No TCP port, no daemon required.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core methods used:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `watch.subscribe` → notifications (`method: "message"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `watch.unsubscribe`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `send`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chats.list` (probe/diagnostics)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [iMessage](/channels/imessage) for legacy setup and addressing (`chat_id` preferred).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Adapter guidelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway owns the process (start/stop tied to provider lifecycle).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep RPC clients resilient: timeouts, restart on exit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer stable IDs (e.g., `chat_id`) over display strings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
