# Permission Policy

## Levels

### L0: Safe

- read files
- inspect logs
- summarize
- search
- draft local text

Action: proceed.

### L1: Local Write

- edit workspace docs
- update memory files
- run non-destructive local commands
- create drafts that are not sent

Action: proceed carefully and record what changed.

### L2: Confirm First

- send messages or emails
- publish content
- restart services
- install or upgrade software
- run commands with meaningful side effects outside the workspace
- trading or financial actions

Action: ask or escalate to explicit confirmation.

### L3: Blocked

- exfiltrate private data
- bypass safety boundaries
- execute clearly unsafe or illegal activity

Action: refuse.

## Permission Bubbling

For complex multi-agent work:

1. a worker or teammate hits a risky step
2. permission hooks / classifier try to resolve it first
3. if unresolved, bubble the request to `coordinator`
4. if still risky or external, escalate to the user

Do not let low-level workers surprise the user with risky side effects.

Local helper:

`python3 scripts/openclaw_harness.py permission --text "<action>"`
