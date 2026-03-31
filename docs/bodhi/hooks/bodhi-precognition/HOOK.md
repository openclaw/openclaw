---
name: bodhi-precognition
description: "Pre-cognition pipeline: infers nervous system state from each message before Bo responds. Writes somatic-state.json. Runs on every inbound message."
metadata: { "openclaw": { "emoji": "🧠", "events": ["message:preprocessed"], "requires": { "bins": ["python3"] } } }
---

# bodhi-precognition

Runs the pre-cognition pipeline on every fully preprocessed inbound message.

**What it does:**

1. Passes the fully enriched message body (`bodyForAgent`) to the Python pre-cognition module
2. The module extracts signals, infers nervous system state, selects a response strategy
3. Writes `~/.openclaw/somatic-state.json` (atomic)
4. Appends to `~/.openclaw/somatic-history.jsonl`
5. If RED tier is detected, pushes a system notice to `context.messages` so it appears before Bo responds

**What it does NOT do:**

- Does not block message processing
- Does not make LLM calls
- Does not modify the message body
- Does not crash the gateway on failure

**Requirements:**

- `python3` on PATH
- `bodhi_vault` package installed: `pip install -e ~/openbodhi/packages/bodhi_vault`
- `OPENBODHI_PATH` env var set to `~/openbodhi` (or default assumed)

**Enable:**

```bash
openclaw hooks enable bodhi-precognition
```

**State file:** `~/.openclaw/somatic-state.json`
**History log:** `~/.openclaw/somatic-history.jsonl`
