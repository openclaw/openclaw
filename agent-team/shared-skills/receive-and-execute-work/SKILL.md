---
name: receive_and_execute_work
description: Specialist protocol for receiving an Orchestrator dispatch, executing it, and closing the loop correctly. Trigger whenever a specialist sees an @mention from Orchestrator in #dispatch.
---

# Receive and Execute Work

Specialist-side protocol for accepting a task from the Orchestrator and closing the loop cleanly. Mirror image of `explicit_dispatch` on the Orchestrator side.

## Trigger

You are a specialist (Scout, Analyst, Quant, or Devil's Advocate) and you just saw an `@App Name` mention in `#dispatch` from the Orchestrator.

## Inputs

The dispatch post, which should contain:
- One question
- One specialist (you)
- A required reply channel
- A required `@Orchestrator - Portfolio Manager` mention in the reply
- A deadline in ET

## Steps

1. **Confirm receipt.** React to the dispatch post with a ✅ emoji via `message(action: "react", ...)`. This is the machine-readable acknowledgement.
2. **Restate the question in one line.** If you cannot restate it cleanly, the dispatch is ambiguous — ask exactly one clarifying question in `#dispatch`, tag `@Orchestrator - Portfolio Manager`, and wait. Do not guess.
3. **Execute.** Use the specialist skill most appropriate for the task. Cite via `source_and_confidence` + `approved_sources`. Save any large artifact to `files/YYYY-MM-DD/` with the correct category prefix and append a row to `files/index.md` (see `file_layout_discipline`).
4. **Reply in the exact channel Orchestrator specified.** Do not redirect to a different channel.
5. **Tag `@Orchestrator - Portfolio Manager` at the top of the reply.** Use the exact handle. Without the mention, the Orchestrator will not see the reply.
6. **Restate the question in one line at the top of the reply.** Then your answer. Then sources + confidence.
7. **Close the thread.** One reply closes one dispatch. If you discover follow-up work, that's a new question for Orchestrator to dispatch — do not start it unilaterally.

## Output format

```
@Orchestrator - Portfolio Manager  re: <one-line restatement of the question>

<answer, structured, dense>

Sources:
- ...
Confidence: <High|Medium|Low>
Files written: files/YYYY-MM-DD/<file>  (optional)
```

## Where to post

The exact reply channel specified by the Orchestrator in the dispatch. Never somewhere else.

## Rules

- One reply per dispatch.
- Never guess an ambiguous dispatch. Ask in `#dispatch` with `@Orchestrator - Portfolio Manager` and wait.
- Never redirect to a different channel.
- Never skip the mention at the top of the reply.
- Never combine two dispatches into one reply. One in, one out.
- If you miss the deadline, still reply and say what is missing — do not go silent.

## Next step

Append a MEMORY.md entry at session end noting the dispatch you answered, the channel you replied in, and any open thread you noticed but did not start.
