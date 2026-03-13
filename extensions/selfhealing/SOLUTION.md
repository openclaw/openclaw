# Self-Healing Agent — Solution Design

## The Problem in One Sentence

The agent treats "I ran a command" as success. The user defines success as "the thing is actually working." The extension bridges that gap.

## Core Principleare

The extension is a mechanism, not a rulebook. It ships empty. It learns from real sessions. The solutions are not pre-programmed — they accumulate from what actually happens.

---

## How It Works

### Verification — Blocking False Success

The agent currently has no feedback loop between what it claims and what is actually true. It says "running" based on the fact that an exec command completed — not based on any evidence that the thing is actually running. This is where most of the user frustration in the experiment came from.

Two hooks work together to fix this.

**`llm_output`** (async, runs in background after every model response)

Every time the agent produces a response, the hook scans the text for completion language — phrases like "successfully deployed", "the monitor is now running", "done, you should receive". When it finds one, it immediately kicks off a lightweight verification in the background:

- Is the process still alive? (`ps aux | grep <name>`)
- Is the log file showing real output? (`tail -5 /tmp/<logfile>`)
- Did the last delivery actually go through?

This runs asynchronously and stores a pass/fail result in an in-memory Map keyed by session ID. It does not block anything yet — it just observes and stores.

**`before_message_write`** (sync, runs before message is saved and delivered)

This hook fires just before the agent's response gets written to the session transcript and sent to the user. It checks the in-memory Map from the previous step — synchronously, because this hook cannot be async.

- If verification **passed** — the message goes through. User sees it.
- If verification **failed** — the message is **blocked**. It is never written to the session, never delivered to the user. The agent's turn ends without a response.

On the next turn, the agent has no record of having claimed success. It will check the actual state, find the real problem, and try again. The user never had to say "does not work."

**The timing works because** `llm_output` fires first (async, stores the result), and `before_message_write` fires after (sync, reads the stored result). By the time the write hook runs, the verification result is already in memory.

**What the user experiences:**

Without extension:

```
Agent: "It's working!" ← wrong, user sees this
User: "does not work"
Agent: oh sorry, let me check...
(repeat 7 times)
```

With extension:

```
Agent produces "It's working!" ← verification runs in background
before_message_write fires ← verification failed, message blocked
Agent never delivered the wrong claim
Agent: on next turn, checks reality, finds the actual problem, fixes it
Agent: "Fixed — the process was exiting immediately because the log showed X"
```

---

### Memory — Learning from What Actually Happened

The extension starts with zero knowledge. It does not ship with pre-programmed solutions. Everything it knows comes from observing real sessions.

**`agent_end`** fires when a session ends — success or failure. At that point the extension writes a structured lesson to `selfhealing.jsonl` in the workspace. Not just "it worked" or "it failed" — it captures what was attempted, what failed, and what the working approach ended up being. This is the raw material for future sessions.

**`session_start`** fires when a new session begins. The extension reads the last N lessons from `selfhealing.jsonl` and prepends them to the agent's context before the first turn. The agent starts the session already knowing what worked before on this machine, for this type of task.

**`before_prompt_build`** fires before every turn in the current session. It injects any corrections that have accumulated during the session — things the extension noticed were wrong and the agent needs to account for going forward.

The result: the memory grows organically. After the BTC monitor session, it knows the Gemini API works and CoinGecko rate limits. After a Slack session, it knows the token format that worked. After a Python script session, it knows venv is required on this machine. None of this was pre-programmed. It was all learned from what actually happened.

---

## What the Extension Does Not Do

- **Does not hardcode solutions.** No "if 429 then say this." The agent reasons about failures itself. The extension gives it the right context.
- **Does not use a separate LLM call.** Verification is done with shell commands. Memory is a JSONL file. No inference cost.
- **Does not replace the agent's reasoning.** The agent still figures out the approach. The extension verifies outcomes and injects what it has learned.
- **Does not block the message on the same turn.** The wrong claim reaches the user once. The correction is injected on the next turn. This is a limitation of the hook system — `llm_output` is fire-and-forget and `before_message_write` is sync-only, so async verification can't block in time.

---

## Architecture

```
extensions/selfhealing/
├── index.ts          — registers all hooks
├── src/
│   ├── memory.ts     — read/write selfhealing.jsonl
│   └── verifier.ts   — process tracking, claim detection, verification
```

## Hooks Used

| Hook                  | Type  | Job                                              |
| --------------------- | ----- | ------------------------------------------------ |
| `session_start`       | async | Load past lessons into context                   |
| `before_prompt_build` | sync  | Prepend lessons + active corrections             |
| `after_tool_call`     | sync  | Track exec/subagent processes                    |
| `llm_output`          | sync  | Detect success claims, verify, store corrections |
| `agent_end`           | async | Write what happened to memory                    |

```

```
