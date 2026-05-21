# Ask plugin

`/ask` is a minimal Discord HITL question UI.

It chooses one Discord interaction style from the prompt:

- Button: quick GO/STOP, Yes/No, or 2–5 option decisions
- Select: option lists, categories, styles, or more than 5 options
- Modal: reasons, details, free-form answers, or supplemental notes

Safety defaults:

- `allowedUsers` is the command sender only
- `reusable=false`
- session TTL is 30 minutes
- answer handling is `log_only`
- `requires_second_go=true`
- `action_scope=answer_capture_only`

Initial scope deliberately excludes poll routing, select+modal composite flows, approval execution, external send/deploy/config writes, long-running task starts, LLM classification, and presets.

Example:

```text
/ask Minimal /ask implementation GO? --options=GO:go,STOP:stop
```

The resulting Discord component uses `callbackData = "ask:<ask_id>"` and is handled by the bundled `ask` plugin interactive handler.
