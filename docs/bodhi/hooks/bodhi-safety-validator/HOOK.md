---
name: bodhi-safety-validator
description: "Post-response safety validator: checks outgoing messages for dismissal patterns; logs; flags emergency contact on RED tier. Runs on message:sent."
metadata: { "openclaw": { "emoji": "🛡️", "events": ["message:sent"] } }
---

# bodhi-safety-validator

Runs after every outbound message. Validates against dismissal patterns and logs safety events.

**What it does:**

1. Checks outgoing message content for dismissal language patterns
2. Reads current `~/.openclaw/somatic-state.json` to get the tier
3. If ORANGE/RED tier + dismissal pattern found: appends a FLAGGED entry to safety log
4. If RED tier + emergency_flag active: logs an emergency notification entry
5. All operations append-only to `~/.openclaw/safety-log.jsonl`

**Dismissal patterns checked:**

- "look on the bright side"
- "have you tried"
- "you should"
- "everyone feels that way"
- "at least"
- "that's just"
- "not a big deal"
- "it could be worse"

**Safety log format:**

```jsonl
{"at":"2026-03-30T14:30:00Z","tier":"orange","type":"DISMISSAL_PATTERN","pattern":"you should","excerpt":"..."}
{"at":"2026-03-30T02:15:00Z","tier":"red","type":"EMERGENCY_FLAG","note":"RED tier response sent"}
```

**Enable:**

```bash
openclaw hooks enable bodhi-safety-validator
```

**Log file:** `~/.openclaw/safety-log.jsonl` (append-only, never rewritten)
