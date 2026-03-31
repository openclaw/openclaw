---
name: bodhi-somatic-context
description: "Injects SOMATIC_CONTEXT.md into Bo's bootstrap files when a fresh somatic state exists. Runs on agent:bootstrap."
metadata: { "openclaw": { "emoji": "🫀", "events": ["agent:bootstrap"], "requires": { "config": ["workspace.dir"] } } }
---

# bodhi-somatic-context

Injects the current somatic state into Bo's context as a bootstrap file.

**What it does:**

1. Reads `~/.openclaw/somatic-state.json`
2. If state exists and is less than 5 minutes old (fresh):
   - Formats state as `SOMATIC_CONTEXT.md` markdown
   - Injects it into `context.bootstrapFiles` so Bo sees it at the start of its turn
3. If state is stale, missing, or malformed: skips silently

**Why 5 minutes:**

The somatic state is computed per-message. If a message was received more than 5 minutes ago, the state may no longer reflect the current moment. Stale context is worse than no context — it can misdirect Bo.

**What Bo reads:**

SOMATIC_CONTEXT.md contains:
- Tier (green/yellow/orange/red) — the most important field
- Circadian phase and sleep signal
- ZPD estimate and complexity cap
- Attachment signal
- Somatic signals (verbatim body mentions)
- Response strategy
- Incongruence detection flag
- Reading protocol (what to do with this context)

**Enable:**

```bash
openclaw hooks enable bodhi-somatic-context
```

**State file:** `~/.openclaw/somatic-state.json`
