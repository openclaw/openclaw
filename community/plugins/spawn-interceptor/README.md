# spawn-interceptor — Community ACP Task Tracking Plugin

A zero-config OpenClaw plugin that automatically tracks `sessions_spawn` calls and detects task completion through a 3-layer defense system.

## Why?

OpenClaw's ACP runtime has no native completion notification mechanism (see [#40272](https://github.com/openclaw/openclaw/issues/40272)). This plugin fills that gap without requiring any core modifications.

### Key Discoveries

1. **`subagent_ended` hook does NOT fire for ACP runtime** — ACP sessions are managed by the `acpx` binary, separate from OpenClaw's hook system
2. **Prompt injection doesn't work for oneshot ACP** — Agents ignore injected instructions after completing their primary task
3. **`~/.acpx/sessions/index.json` is the source of truth** for ACP session lifecycle

## How It Works

| Layer | Mechanism | Latency | Coverage |
|-------|-----------|---------|----------|
| L1 | `subagent_ended` hook | <1s | `runtime=subagent` |
| L2 | ACP Session Poller (`~/.acpx/sessions/index.json`) | ~15s | `runtime=acp` |
| L3 | Stale Reaper | 30min | All (safety net) |

## Install

```bash
cp -r community/plugins/spawn-interceptor ~/.openclaw/extensions/
# Restart Gateway
```

## Output

All events are written to `~/.openclaw/shared-context/monitor-tasks/task-log.jsonl` as JSONL.

## Full Documentation

See the [openclaw-multiagent-framework](https://github.com/lanyasheng/openclaw-multiagent-framework) repository for architecture docs, protocol specs, and integration guides.

## License

MIT
