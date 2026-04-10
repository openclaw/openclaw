---
summary: "Forward important tool activity from a session JSONL log into a Feishu chat"
title: "Feishu Session Trace Relay"
---

# Feishu Session Trace Relay

Use this helper when you want a lightweight mission-control feed that mirrors important tool calls from a running OpenClaw session into a Feishu DM or group.

The script tails an agent `.jsonl` session log, summarizes a small allowlist of tool calls, redacts obvious secrets, and forwards each summary through `openclaw message send`.

## When to use this

- You want real-time visibility into what an agent is doing without watching the terminal
- You want a shared Feishu thread for risky or high-signal agent activity
- You want to keep an operator-facing audit trail of reads, edits, shell commands, and web actions

## Requirements

- OpenClaw CLI on PATH
- Feishu channel access configured for `openclaw message send`
- Access to the session log file under `~/.openclaw/agents/<agent-id>/sessions/*.jsonl`
- Node 22+ with `tsx` available through the repo install

## Script location

```text
scripts/feishu-session-trace.ts
```

## Usage

```bash
node --import tsx scripts/feishu-session-trace.ts \
  --session-file "${HOME}/.openclaw/agents/<agent-id>/sessions/<session-id>.jsonl" \
  --target "chat:oc_xxx" \
  --account default \
  --min-interval-ms 5000 \
  --max-len 260
```

### Arguments

| Flag                | Description                                                                 |
| ------------------- | --------------------------------------------------------------------------- |
| `--session-file`    | Required. Absolute path to the `.jsonl` session log to follow.              |
| `--target`          | Required. Feishu target such as `user:ou_xxx` or `chat:oc_xxx`.             |
| `--account`         | Optional Feishu account id configured in OpenClaw.                          |
| `--min-interval-ms` | Debounce window between forwarded messages. Default: `5000`.                |
| `--max-len`         | Maximum forwarded message length. Default: `260`.                           |
| `--dry-run`         | Print via `openclaw message send --dry-run` instead of delivering for real. |

## What gets forwarded

The helper emits one-line summaries for a short list of tool types:

- `read`
- `write`, `edit`, `apply_patch`
- `exec`, `bash`, `shell`
- `web_search`, `web_fetch`
- `todo_write`

Everything else is ignored to keep the relay low-noise.

## Finding the session log path

1. Identify the target agent id from the runtime banner, for example `agent=main`
2. Inspect `~/.openclaw/agents/<agent-id>/sessions/`
3. Pick the current `.jsonl` file
4. Pass that path to `--session-file`

## Running in the background

For longer-lived relays, run the helper under your preferred supervisor.

### launchd example (macOS)

Create `~/Library/LaunchAgents/ai.openclaw.session-trace.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.session-trace</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>--import</string>
    <string>tsx</string>
    <string>/path/to/openclaw/scripts/feishu-session-trace.ts</string>
    <string>--session-file</string>
    <string>/Users/you/.openclaw/agents/main/sessions/<session-id>.jsonl</string>
    <string>--target</string>
    <string>chat:oc_xxx</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/feishu-session-trace.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/feishu-session-trace.err</string>
</dict>
</plist>
```

Then load it:

```bash
launchctl load ~/Library/LaunchAgents/ai.openclaw.session-trace.plist
```

## Troubleshooting

| Symptom                       | Fix                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Missing required args         | Provide both `--session-file` and `--target`.                                                                                |
| `openclaw message send` fails | Check Feishu auth and target permissions, then try a manual `openclaw message send --channel feishu --target ... --message`. |
| No events forwarded           | Verify the session file is active and that new assistant tool-call records are appended.                                     |
| Too many messages             | Raise `--min-interval-ms` or tighten the tool allowlist in the helper.                                                       |

## Related

- [Automation & Tasks](/automation/index)
- [Hooks](/automation/hooks)
- [Background Tasks](/automation/tasks)
