---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Direct `openclaw agent` CLI runs (with optional delivery)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying the agent CLI entrypoint（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Agent Send"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw agent` (direct agent runs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw agent` runs a single agent turn without needing an inbound chat message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default it goes **through the Gateway**; add `--local` to force the embedded（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
runtime on the current machine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Required: `--message <text>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session selection:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--to <dest>` derives the session key (group/channel targets preserve isolation; direct chats collapse to `main`), **or**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--session-id <id>` reuses an existing session by id, **or**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--agent <id>` targets a configured agent directly (uses that agent's `main` session key)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runs the same embedded agent runtime as normal inbound replies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Thinking/verbose flags persist into the session store.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Output:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - default: prints reply text (plus `MEDIA:<url>` lines)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--json`: prints structured payload + metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional delivery back to a channel with `--deliver` + `--channel` (target formats match `openclaw message --target`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `--reply-channel`/`--reply-to`/`--reply-account` to override delivery without changing the session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway is unreachable, the CLI **falls back** to the embedded local run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --to +15555550123 --message "status update"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --agent ops --message "Summarize logs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --to +15555550123 --message "Summon reply" --deliver（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--local`: run locally (requires model provider API keys in your shell)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--deliver`: send the reply to the chosen channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--channel`: delivery channel (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, default: `whatsapp`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--reply-to`: delivery target override（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--reply-channel`: delivery channel override（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--reply-account`: delivery account id override（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--thinking <off|minimal|low|medium|high|xhigh>`: persist thinking level (GPT-5.2 + Codex models only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--verbose <on|full|off>`: persist verbose level（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout <seconds>`: override agent timeout（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: output structured JSON（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
