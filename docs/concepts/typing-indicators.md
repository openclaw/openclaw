---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "When OpenClaw shows typing indicators and how to tune them"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing typing indicator behavior or defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Typing Indicators"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Typing indicators（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Typing indicators are sent to the chat channel while a run is active. Use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.typingMode` to control **when** typing starts and `typingIntervalSeconds`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to control **how often** it refreshes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `agents.defaults.typingMode` is **unset**, OpenClaw keeps the legacy behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Direct chats**: typing starts immediately once the model loop begins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Group chats with a mention**: typing starts immediately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Group chats without a mention**: typing starts only when message text begins streaming.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Heartbeat runs**: typing is disabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `agents.defaults.typingMode` to one of:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `never` — no typing indicator, ever.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `instant` — start typing **as soon as the model loop begins**, even if the run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  later returns only the silent reply token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `thinking` — start typing on the **first reasoning delta** (requires（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `reasoningLevel: "stream"` for the run).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message` — start typing on the **first non-silent text delta** (ignores（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the `NO_REPLY` silent token).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Order of “how early it fires”:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`never` → `message` → `thinking` → `instant`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agent: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    typingMode: "thinking",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    typingIntervalSeconds: 6,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can override mode or cadence per session:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    typingMode: "message",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    typingIntervalSeconds: 4,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message` mode won’t show typing for silent-only replies (e.g. the `NO_REPLY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  token used to suppress output).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `thinking` only fires if the run streams reasoning (`reasoningLevel: "stream"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  If the model doesn’t emit reasoning deltas, typing won’t start.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeats never show typing, regardless of mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `typingIntervalSeconds` controls the **refresh cadence**, not the start time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  The default is 6 seconds.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
