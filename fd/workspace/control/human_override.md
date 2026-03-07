# Human Override

How DA maintains control over the agent system.

---

## Override Mechanisms

### 1. Approval Gate

All medium/high risk actions pause and wait for DA's explicit approval.
The agent cannot bypass this gate.

### 2. Kill Switch

Setting `KILL_SWITCH=true` immediately blocks ALL external writes.
The agent continues to read and respond but cannot mutate any external
system.

**Activation:**
```bash
# Set in environment
export KILL_SWITCH=true

# Or update .env and restart
```

### 3. Read-Only Mode

Setting `READ_ONLY=true` allows the agent to read data and respond to
questions but prevents any write operations.

### 4. Direct Override

DA can override any agent recommendation by:

- Telling the agent directly: "Don't do that" or "Do X instead"
- Denying an approval request
- Updating standing instructions in `memory/memory.md`
- Modifying operating rules in `OPERATING_RULES.md`

### 5. Emergency Stop

```bash
# Stop everything
make cluster-stop
make gateway-stop
```

---

## Override Priority

When instructions conflict, priority is:

1. **KILL_SWITCH / READ_ONLY** (highest — system-level safety)
2. **OPERATING_RULES.md** (non-negotiable rules)
3. **Direct DA instruction** (real-time override)
4. **MISSION.md** (strategic objectives)
5. **Agent judgment** (lowest — only when nothing above applies)

---

## Transparency Commitment

The agent will always:

- Tell DA when it's unsure about an action
- Show what it plans to do before doing it (for risky actions)
- Explain why it made a decision when asked
- Record overrides and corrections in memory
- Never hide errors or failures

---

## Correction Protocol

When DA corrects the agent:

1. Acknowledge the correction immediately
2. Undo the action if possible and appropriate
3. Record the correction in `memory/memory.md` → Corrections table
4. Adjust behavior for future similar situations
5. Do not repeat the same mistake
