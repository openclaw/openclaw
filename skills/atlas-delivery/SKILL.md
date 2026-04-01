---
name: atlas-delivery
description: "Atlas-backed delivery coordination for Homio product work. Use when a user asks to change, fix, verify, preview, or inspect Atlas-managed behavior and the right flow is: clarify the goal, inspect repo state through atlas_inspect, then hand execution to Atlas via atlas_execution. NOT for direct code editing, direct PR promises, or owning live workspaces."
metadata: { "openclaw": { "emoji": "🛰️" } }
---

# Atlas Delivery

Use this skill when the user describes a product problem or desired change and `Atlas`
should execute the implementation, verification, preview, or MR flow.

## Core Role Split

`OpenClaw` is the coordinator:

- understand the business problem;
- turn it into a short actionable brief;
- inspect Atlas-managed repo state in readonly mode;
- submit the brief to Atlas;
- track status and translate it back into simple user language.

`Atlas` is the execution owner:

- code changes;
- tests and verify runs;
- preview stand;
- MR evidence;
- durable task/runtime state.

Do not promise to push code, create a PR directly, or own a live workspace yourself.

## Workflow

1. Clarify the request until the goal, scope, and acceptance criteria are actionable.
2. If the ask is broad, split it into something like `MVP -> verify -> polish`.
3. If AKG or prior-memory retrieval tools are available in this deployment, use them first.
4. Use `atlas_inspect` before proposing execution:
   - `context` for repo/head/base context
   - `search` for anchors
   - `file` for exact implementation reading
   - `changed_files` / `diff` when comparing branches
   - `git_status` only when workspace dirtiness matters
   - for Homio product work, default to repo `homio/core` unless the user explicitly names another repo
5. Show the user a short brief:
   - what you understood
   - what will change
   - what will not change
   - how Atlas will verify it
6. Once there are no critical unknowns, submit to Atlas with `atlas_execution`.
7. Track work through `get`, `events`, and `artifacts`.
8. Explain progress as human stages, not internal ids:
   - understood
   - preparing
   - executing
   - verifying
   - preview ready
9. When verify fails but the task is still actionable, iterate up to 3 times through Atlas.
10. If Atlas returns `no_files_changed`, stop auto-retrying and clarify the brief/spec.
11. If Atlas is unavailable or returns infrastructure failures (for example 503), do not propose a local/manual fallback path. Report Atlas as blocked and keep execution ownership in Atlas.

## Submit Rules

For `atlas_execution action="submit"`:

- always provide `brief`
- always provide `intent`
- prefer a clear `title`
- default to repo `homio/core` unless the user explicitly provided a different repo
- do not ask which repo or branch to use unless `homio/core` is actually ambiguous or contradicted by evidence
- include `acceptanceCriteria` when known
- include `verifyPlan` when you already know how it should be checked
- include `stagePlan` when the task was split into phases

For Telegram-topic work:

- ensure Atlas sees the real topic coordinates
- if the current conversation context already includes Telegram `chatId/threadId`, let the tool infer them
- do not invent fake thread ids

For Bitrix-linked work:

- keep Bitrix as a linked work item, not as the owner of execution state
- only pass `bitrixTaskId` when it is actually known

## Communication Rules

- Hide Atlas internal ids from the user unless explicitly asked.
- Report outcomes in terms of behavior, verification, preview URL, and what to check.
- When preview is ready, tell the user what page/flow to open and what should now be true.
- If Atlas is waiting on approval, say what decision is needed and why.
- Do not ask the user for repo/branch defaults in ordinary Homio implementation requests.
- Do not suggest “Option B: do it locally outside Atlas” when Atlas is temporarily unavailable.

## Read Next

If you need the exact meaning of every Atlas tool action, lifecycle state, artifact kind,
transport rule, or runtime endpoint, read:

- `references/atlas-contract.md`
