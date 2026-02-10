---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Command queue design that serializes inbound auto-reply runs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing auto-reply execution or concurrency（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Command Queue"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Command Queue (2026-01-16)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
We serialize inbound auto-reply runs (all channels) through a tiny in-process queue to prevent multiple agent runs from colliding, while still allowing safe parallelism across sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply runs can be expensive (LLM calls) and can collide when multiple inbound messages arrive close together.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Serializing avoids competing for shared resources (session files, logs, CLI stdin) and reduces the chance of upstream rate limits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A lane-aware FIFO queue drains each lane with a configurable concurrency cap (default 1 for unconfigured lanes; main defaults to 4, subagent to 8).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `runEmbeddedPiAgent` enqueues by **session key** (lane `session:<key>`) to guarantee only one active run per session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each session run is then queued into a **global lane** (`main` by default) so overall parallelism is capped by `agents.defaults.maxConcurrent`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When verbose logging is enabled, queued runs emit a short notice if they waited more than ~2s before starting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Typing indicators still fire immediately on enqueue (when supported by the channel) so user experience is unchanged while we wait our turn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Queue modes (per channel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inbound messages can steer the current run, wait for a followup turn, or do both:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `steer`: inject immediately into the current run (cancels pending tool calls after the next tool boundary). If not streaming, falls back to followup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `followup`: enqueue for the next agent turn after the current run ends.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `collect`: coalesce all queued messages into a **single** followup turn (default). If messages target different channels/threads, they drain individually to preserve routing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `steer-backlog` (aka `steer+backlog`): steer now **and** preserve the message for a followup turn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `interrupt` (legacy): abort the active run for that session, then run the newest message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `queue` (legacy alias): same as `steer`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Steer-backlog means you can get a followup response after the steered run, so（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
streaming surfaces can look like duplicates. Prefer `collect`/`steer` if you want（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
one response per inbound message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send `/queue collect` as a standalone command (per-session) or set `messages.queue.byChannel.discord: "collect"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults (when unset in config):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- All surfaces → `collect`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Configure globally or per channel via `messages.queue`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    queue: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mode: "collect",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      debounceMs: 1000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cap: 20,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      drop: "summarize",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      byChannel: { discord: "collect" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Queue options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options apply to `followup`, `collect`, and `steer-backlog` (and to `steer` when it falls back to followup):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `debounceMs`: wait for quiet before starting a followup turn (prevents “continue, continue”).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cap`: max queued messages per session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `drop`: overflow policy (`old`, `new`, `summarize`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summarize keeps a short bullet list of dropped messages and injects it as a synthetic followup prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Per-session overrides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send `/queue <mode>` as a standalone command to store the mode for the current session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Options can be combined: `/queue collect debounce:2s cap:25 drop:summarize`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/queue default` or `/queue reset` clears the session override.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Scope and guarantees（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Applies to auto-reply agent runs across all inbound channels that use the gateway reply pipeline (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat, etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default lane (`main`) is process-wide for inbound + main heartbeats; set `agents.defaults.maxConcurrent` to allow multiple sessions in parallel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Additional lanes may exist (e.g. `cron`, `subagent`) so background jobs can run in parallel without blocking inbound replies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-session lanes guarantee that only one agent run touches a given session at a time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No external dependencies or background worker threads; pure TypeScript + promises.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If commands seem stuck, enable verbose logs and look for “queued for …ms” lines to confirm the queue is draining.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you need queue depth, enable verbose logs and watch for queue timing lines.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
