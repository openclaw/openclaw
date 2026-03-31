---
name: bodhi-session-context
description: "Injects SESSION_CONTEXT.md into Bo's bootstrap files. Reads vault node count, domains, and last session time. Enables cold-start awareness and return-gap detection. Runs on agent:bootstrap."
metadata: { "openclaw": { "emoji": "🧭", "events": ["agent:bootstrap"] } }
---

# bodhi-session-context

Injects the current session context into Bo's context as a bootstrap file.

**What it does:**

1. Reads `~/.alfred/vault/nodes.json` to count nodes per domain
2. Reads `~/.openclaw/somatic-history.jsonl` for last session timestamp
3. Formats as `SESSION_CONTEXT.md` markdown
4. Injects it into `context.bootstrapFiles` so Bo reads it at the start of its turn

**Why this matters:**

Bo's core function is accumulation and threshold detection. Without knowing vault state,
Bo cannot know whether it is in intake mode (vault empty) or synthesis mode (patterns exist).
This hook closes that gap every session.

**Enable:**

```bash
openclaw hooks enable bodhi-session-context
```

**State file:** `~/.alfred/vault/nodes.json`
