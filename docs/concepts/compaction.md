---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Context window + compaction: how OpenClaw keeps sessions under model limits"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to understand auto-compaction and /compact（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are debugging long sessions hitting context limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Compaction"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Context Window & Compaction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Every model has a **context window** (max tokens it can see). Long-running chats accumulate messages and tool results; once the window is tight, OpenClaw **compacts** older history to stay within limits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What compaction is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Compaction **summarizes older conversation** into a compact summary entry and keeps recent messages intact. The summary is stored in the session history, so future requests use:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The compaction summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Recent messages after the compaction point（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Compaction **persists** in the session’s JSONL history.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Compaction config & modes](/concepts/compaction) for the `agents.defaults.compaction` settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auto-compaction (default on)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a session nears or exceeds the model’s context window, OpenClaw triggers auto-compaction and may retry the original request using the compacted context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You’ll see:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `🧹 Auto-compaction complete` in verbose mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/status` showing `🧹 Compactions: <count>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Before compaction, OpenClaw can run a **silent memory flush** turn to store（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
durable notes to disk. See [Memory](/concepts/memory) for details and config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Manual compaction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `/compact` (optionally with instructions) to force a compaction pass:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/compact Focus on decisions and open questions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Context window source（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Context window is model-specific. OpenClaw uses the model definition from the configured provider catalog to determine limits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Compaction vs pruning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Compaction**: summarises and **persists** in JSONL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Session pruning**: trims old **tool results** only, **in-memory**, per request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [/concepts/session-pruning](/concepts/session-pruning) for pruning details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tips（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `/compact` when sessions feel stale or context is bloated.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Large tool outputs are already truncated; pruning can further reduce tool-result buildup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you need a fresh slate, `/new` or `/reset` starts a new session id.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
