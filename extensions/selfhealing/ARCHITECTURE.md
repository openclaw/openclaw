# Self-Healing Agent — Architecture

## Overview

The extension is built on top of OpenClaw's plugin hook system. It intercepts the agent's lifecycle at five points — when a session starts, before every turn, after the model responds, before a message is saved, and when a session ends. At each point it either injects learned knowledge or verifies that what the agent claims is true.

---

## Data Flow

```
┌─────────────────────────────────────────────────────────┐
│                     New Session                         │
│                         ↓                               │
│            session_start                                │
│      reads selfhealing.jsonl                            │
│      loads past lessons into sessionCache               │
│                         ↓                               │
│            before_prompt_build                          │
│      prepends lessons to every agent turn               │
│      agent starts knowing what worked before            │
│                         ↓                               │
│              Agent runs the task                        │
│                         ↓                               │
│            after_tool_call (every exec)                 │
│      agent ran a background process or wrote a log      │
│      extract: process name, log file path               │
│      append to processCache for this session            │
│      (builds up over entire session, all execs)         │
│                         ↓                               │
│              llm_output (async)                         │
│      agent produces a response                          │
│      scans for success/completion language              │
│      if found → reads processCache                      │
│      runs verification against ALL tracked processes    │
│      and ALL tracked log files from this session        │
│      stores result in verificationCache                 │
│                         ↓                               │
│           before_message_write (sync)                   │
│      reads verificationCache                            │
│      if verification failed → block message             │
│      agent never delivers the wrong claim               │
│                         ↓                               │
│              Session ends                               │
│                         ↓                               │
│              agent_end                                  │
│      writes what happened to selfhealing.jsonl          │
│      lessons available for next session                 │
└─────────────────────────────────────────────────────────┘
```

---

## In-Memory State

Three Maps live in memory for the duration of the gateway process:

**`sessionCache`** — keyed by sessionId
Holds lessons loaded from `selfhealing.jsonl` at session start. Used by `before_prompt_build` to inject context. Cleared on `agent_end`.

**`processCache`** — keyed by sessionId
Built up by `after_tool_call` throughout the session. Every time the agent runs a background exec, the process name and log file path are appended. By the time the agent claims success, this contains every process and log file the agent created — not just the last one.

**`verificationCache`** — keyed by sessionId
Holds the result of the last verification check. Written by `llm_output` after reading `processCache`, read by `before_message_write`. Cleared on `agent_end`.

```
sessionCache:      Map<sessionId, { text: string; lessons: string[] }>
processCache:      Map<sessionId, Array<{ process: string; logFile: string }>>
verificationCache: Map<sessionId, { passed: boolean; reason: string }>
```

---

## Files

### `index.ts`

Entry point. Registers all hooks against the OpenClaw plugin API. Owns the three in-memory Maps and passes them to the source modules. No business logic here.

### `src/memory.ts`

Reads and writes `selfhealing.jsonl` in the workspace directory. Each line is a JSON entry with a timestamp, lesson, and source tag. Append-only writes. Read at session start, written at session end.

```typescript
type MemoryEntry = {
  timestamp: string;
  lesson: string;
  source: "session_success" | "session_failure";
};
```

### `src/verifier.ts`

Three responsibilities:

1. **Tracking** — when `after_tool_call` fires, extract the process name and log file path from exec params and append to `processCache`. Runs on every exec, builds up the full picture of what the agent created.

2. **Claim detection** — given the agent's output text, determine if it contains a success or completion claim worth verifying.

3. **Verification** — reads ALL entries in `processCache` for this session. For each tracked process and log file, checks if the process is still alive and if the log output is real. Returns pass/fail with a reason covering everything the agent created, not just the last thing.

Stores results in the `verificationCache` Map passed in from `index.ts`.

---

## Hook Responsibilities

### `session_start`

- Read `selfhealing.jsonl`
- Build lesson text from last N entries
- Store in `sessionCache`

### `before_prompt_build`

- Read `sessionCache` for this session
- Return `{ prependContext: lessons }` so OpenClaw injects it before the model sees the prompt

### `after_tool_call`

- Check if exec params contain a background process or log file
- Extract process name and log file path
- Append to `processCache` for this session

### `llm_output`

- Scan `event.assistantTexts` for success language
- If found, read `processCache` to get all tracked processes and logs
- Run verification against all of them
- Store result in `verificationCache`

### `before_message_write`

- Check `verificationCache` for this session
- If result exists and `passed === false` → return `{ block: true }`
- Clear the entry from `verificationCache` after reading

### `agent_end`

- Determine if session succeeded or failed
- Write a lesson to `selfhealing.jsonl` capturing what happened
- Clear `sessionCache`, `processCache`, and `verificationCache` for this session

---

## Timing Guarantee

`llm_output` and `before_message_write` fire in the right order for this to work. `llm_output` runs first (after the model generates output), stores the verification result. `before_message_write` runs after (before the message is saved), reads the stored result. The async verification in `llm_output` must complete before `before_message_write` fires.

This is guaranteed by the OpenClaw pipeline — `before_message_write` is on the write path which happens after the response is fully generated and all post-generation hooks have run.

---

## selfhealing.jsonl Format

Stored in `~/.openclaw/workspace/selfhealing.jsonl`. One JSON object per line. Append-only. Read at session start, written at session end.

```jsonl
{"timestamp":"2026-03-12T22:34:00Z","lesson":"Gemini API works for BTC price. CoinGecko rate limits after a few calls.","source":"session_success"}
{"timestamp":"2026-03-12T22:35:00Z","lesson":"venv required for Python deps on this machine. pip install fails system-wide.","source":"session_success"}
{"timestamp":"2026-03-12T22:36:00Z","lesson":"Slack bot token must be exported as env var in bash scripts. Not passed automatically.","source":"session_success"}
```

---

## Extension File Structure

```
extensions/selfhealing/
├── EXPERIMENT.md         — what we observed
├── SOLUTION.md           — why this design
├── ARCHITECTURE.md       — this file
├── package.json
├── openclaw.plugin.json
├── index.ts              — hook registration + in-memory state
├── src/
│   ├── memory.ts         — selfhealing.jsonl read/write
│   └── verifier.ts       — claim detection + shell verification
└── tests/
    ├── memory.test.ts
    └── verifier.test.ts
```
