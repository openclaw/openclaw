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

## Grill Mode

`/ask grill <request>` starts a one-question-at-a-time clarification protocol for ambiguous work.
It is a prefix mode on the current `/ask` command, not a native Discord subcommand yet.

Grill Mode asks six fixed prompts:

1. Goal
2. Context
3. Scope
4. Risk / HITL
5. Acceptance
6. Output format

Each step uses a short modal prompt and stores the answer in `ask.sessions`.
The visible message only shows the current question and progress; it does not replay the whole answer history on every turn.
The final summary is still `log_only` and keeps `requires_second_go=true`.
It must not trigger implementation, external sends, deploys, config writes, deletes, billing, or gateway restarts.

Example:

```text
/ask grill 曖昧な依頼をSPECと実装タスクまで詰めたい
```

## Runtime smoke test

After merge and runtime rollout, verify the Discord path in a private test channel:

1. Restart the gateway/runtime process that loads bundled plugins.
2. Run `/ask Minimal /ask smoke? --options=GO:go,STOP:stop`.
3. Confirm the command renders Discord components.
4. Click an allowed answer as the requester and confirm the session records the answer, clears components, and does not execute any action.
5. Run `/ask grill Build a small dashboard`.
6. Submit one Grill modal answer and confirm the next Grill question is shown with progress.
7. Finish the Grill sequence and confirm the final summary keeps `log_only`, `requires_second_go=true`, and `action_scope=answer_capture_only`.
8. Confirm a non-requester interaction is rejected privately and does not overwrite the shared prompt.

Rollback is to revert the merge commit or disable/remove the bundled `ask` plugin from the deployed runtime, then restart the gateway/runtime process.
No data migration is required because the initial Ask sessions are keyed runtime records and no external action is executed.
