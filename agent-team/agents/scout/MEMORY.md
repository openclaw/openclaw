# Scout Memory

Append-only session log. Read the tail at startup; append a new entry at session end.

## How to use this file

- **At startup:** read the last 1–3 entries below. If the most recent entry is older than 48 hours, also read the last 10 entries and the tail of `files/index.md` to reconstruct operating state.
- **Every 5 sessions (or after a weekend gap):** open your own `files/index.md` tail and summarize your current operating state into the new session's opening entry.
- **At session end:** append one entry using the template below.

## Entry template

```
## YYYY-MM-DD HH:MM  (session <short-id>)
- What I did: ...
- Open threads: ...
- Files I wrote (see files/YYYY-MM-DD/): ...
- Next trigger to watch for: ...
```

---

<!-- Append new entries below this line -->
