# Plugin Internals

## Hook Flow

```
User message arrives
  │
  ▼ before_prompt_build (priority 20)
  ├─ skip if trigger === "heartbeat"
  ├─ parse time range from query (今天/昨天/最近N天)
  ├─ POST /retrieve  → memories[]
  ├─ POST /concepts  → concepts[]
  └─ return { prependSystemContext: "### [Engram 概念層]\n...\n### [Engram 記憶層]\n..." }

AI responds
  │
  ▼ agent_end
  ├─ skip if !event.success
  ├─ skip if sessionKey doesn't include SESSION_FILTER
  ├─ extractLastTurnFromMessages(event.messages)
  ├─ classifyEmotional(user text) → emotional score
  ├─ POST /add { content: userText, type: 1|2, emotional }
  └─ POST /add { content: assistantText, type: 1, emotional: 0.25 }
```

## Emotional Classifier

```js
// High signals (each hit adds weight):
["決定","決策","失敗","成功","重要","緊急","錯誤","教訓",
 "警告","風險","平倉","爆倉","虧損","獲利","授權",
 "important","critical","error","failed","success","warning"]

// Score:
hits >= 2  → 0.75  (type=2 Event)
hits == 1  → 0.55  (type=2 Event)
hits == 0  → 0.30  (type=1 Conversation)
```

## Time Range Parsing

Parses Chinese time expressions from the user query to add `time_from`/`time_to` filters:

| Expression      | Range              |
| --------------- | ------------------ |
| 今天/今日       | today start → now  |
| 昨天            | yesterday          |
| 這兩天/最近兩天 | yesterday → now    |
| 最近N天         | N-1 days ago → now |

## Message Extraction

`event.messages` from `agent_end` contains the full session. Scans from the end:

1. Find last `role=assistant` message with non-empty text content
2. Find last `role=user` message before it (skips `System:` prefixed and <10 char strings)

Supports both `msg.content` and `msg.message.content` layouts (OpenClaw normalisation).

## Error Handling

All `fetch` calls use `AbortSignal.timeout(3000)`. Any network error is silently caught and logged at `debug` level. The plugin never throws — Engram server downtime is transparent to the user.

## Extending the Plugin

To add more emotional signals, edit the `highSignals` array in `index.js`.

To change session filtering (e.g. also record subagent turns), set `sessionFilter: ""` in config or edit the condition in `agent_end` handler.

To tune injection volume, adjust `maxResults` / `maxConcepts` in plugin config.
