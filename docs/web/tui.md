---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Terminal UI (TUI): connect to the Gateway from any machine"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a beginner-friendly walkthrough of the TUI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need the complete list of TUI features, commands, and shortcuts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "TUI"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# TUI (Terminal UI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Start the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Open the TUI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw tui（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Type a message and press Enter.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remote Gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw tui --url ws://<host>:<port> --token <gateway-token>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `--password` if your Gateway uses password auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What you see（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Header: connection URL, current agent, current session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Chat log: user messages, assistant replies, system notices, tool cards.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Status line: connection/run state (connecting, running, streaming, idle, error).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Footer: connection state + agent + session + model + think/verbose/reasoning + token counts + deliver.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Input: text editor with autocomplete.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Mental model: agents + sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents are unique slugs (e.g. `main`, `research`). The Gateway exposes the list.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions belong to the current agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session keys are stored as `agent:<agentId>:<sessionKey>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If you type `/session main`, the TUI expands it to `agent:<currentAgent>:main`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If you type `/session agent:other:main`, you switch to that agent session explicitly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session scope:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `per-sender` (default): each agent has many sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `global`: the TUI always uses the `global` session (the picker may be empty).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The current agent + session are always visible in the footer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sending + delivery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messages are sent to the Gateway; delivery to providers is off by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Turn delivery on:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `/deliver on`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - or the Settings panel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - or start with `openclaw tui --deliver`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pickers + overlays（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model picker: list available models and set the session override.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent picker: choose a different agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session picker: shows only sessions for the current agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Settings: toggle deliver, tool output expansion, and thinking visibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Keyboard shortcuts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enter: send message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Esc: abort active run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ctrl+C: clear input (press twice to exit)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ctrl+D: exit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ctrl+L: model picker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ctrl+G: agent picker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ctrl+P: session picker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ctrl+O: toggle tool output expansion（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ctrl+T: toggle thinking visibility (reloads history)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Slash commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/help`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/agent <id>` (or `/agents`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/session <key>` (or `/sessions`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/model <provider/model>` (or `/models`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Session controls:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/think <off|minimal|low|medium|high>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/verbose <on|full|off>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/reasoning <on|off|stream>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/usage <off|tokens|full>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/elevated <on|off|ask|full>` (alias: `/elev`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/activation <mention|always>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/deliver <on|off>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Session lifecycle:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/new` or `/reset` (reset the session)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/abort` (abort the active run)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/settings`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/exit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Other Gateway slash commands (for example, `/context`) are forwarded to the Gateway and shown as system output. See [Slash commands](/tools/slash-commands).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Local shell commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefix a line with `!` to run a local shell command on the TUI host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The TUI prompts once per session to allow local execution; declining keeps `!` disabled for the session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Commands run in a fresh, non-interactive shell in the TUI working directory (no persistent `cd`/env).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A lone `!` is sent as a normal message; leading spaces do not trigger local exec.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool calls show as cards with args + results.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ctrl+O toggles between collapsed/expanded views.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- While tools run, partial updates stream into the same card.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## History + streaming（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On connect, the TUI loads the latest history (default 200 messages).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Streaming responses update in place until finalized.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The TUI also listens to agent tool events for richer tool cards.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Connection details（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The TUI registers with the Gateway as `mode: "tui"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reconnects show a system message; event gaps are surfaced in the log.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--url <url>`: Gateway WebSocket URL (defaults to config or `ws://127.0.0.1:<port>`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token <token>`: Gateway token (if required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--password <password>`: Gateway password (if required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--session <key>`: Session key (default: `main`, or `global` when scope is global)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--deliver`: Deliver assistant replies to the provider (default off)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--thinking <level>`: Override thinking level for sends（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout-ms <ms>`: Agent timeout in ms (defaults to `agents.defaults.timeoutSeconds`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: when you set `--url`, the TUI does not fall back to config or environment credentials.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No output after sending a message:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `/status` in the TUI to confirm the Gateway is connected and idle/busy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check the Gateway logs: `openclaw logs --follow`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirm the agent can run: `openclaw status` and `openclaw models status`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you expect messages in a chat channel, enable delivery (`/deliver on` or `--deliver`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--history-limit <n>`: History entries to load (default 200)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Connection troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `disconnected`: ensure the Gateway is running and your `--url/--token/--password` are correct.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No agents in picker: check `openclaw agents list` and your routing config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Empty session picker: you might be in global scope or have no sessions yet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
