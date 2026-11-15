---
summary: "Durable user preference and profile directives"
title: "USER template"
read_when:
  - Bootstrapping a workspace manually
---

# USER.md - User Model

Store stable user preferences and profile facts as directives that can guide future sessions.

Use one directive per entry:

```md
- Prefer concise progress updates during implementation work.
```

- Begin each directive with an imperative such as `Always`, `Never`, or `Prefer`.
- Keep only current directives; no date or status metadata is required.
- When a preference changes, replace the old directive in place. If history matters, record it with its observation date in `memory/YYYY-MM-DD.md`, not here.
- Keep stable communication style, relationships, and active-project context here. Put durable non-profile facts and decisions in `MEMORY.md`.
- Save this file at the workspace root as `USER.md`. It loads every session with a separate 4,000-character budget. All text counts, including comments and history; the loader does not filter them.

## Directives

Replace the example below with a real directive before you save this file. Never leave a placeholder directive.

- Prefer ...

## Related

- [Agent workspace](/concepts/agent-workspace)
