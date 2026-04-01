# Atlas Contract Reference

This file is the detailed contract for the `atlas-delivery` skill. Read it when you need
the exact meaning of Atlas functions or when a task depends on transport, artifact, or
status semantics.

## 1. Boundary

`OpenClaw` owns:

- user clarification
- business framing
- brief construction
- readonly inspection
- execution tracking
- user-facing narration

`Atlas` owns:

- mutable repo work
- branch/workspace/stand lifecycle
- verify execution
- preview publishing
- MR evidence
- durable runtime state

Never collapse these boundaries by promising direct code pushes or by treating local chat
state as the source of truth.

## 2. Atlas Auth And Base URL

The current OpenClaw client resolves Atlas from:

- `OPENCLAW_ATLAS_WEB_BASE_URL`, else `ATLAS_WEB_BASE_URL`
- `OPENCLAW_ATLAS_A2A_TOKEN`, else `ATLAS_A2A_TOKEN`, else `ATLAS_WEB_LOGS_TOKEN`

If these are missing, report configuration failure instead of emulating Atlas locally.

Default Homio assumption:

- unless the user explicitly says otherwise, implementation work targets `homio/core`
- do not ask “which repo?” or “which branch?” in ordinary Homio delivery flows unless the default is contradicted by evidence

## 3. OpenClaw Tool Surface

### `atlas_inspect`

Readonly inspection against a commit-pinned Atlas snapshot.

Actions:

- `context`
  - Atlas endpoint: `GET /api/runtime/inspect/context`
  - use to resolve repo, requested ref, `headSha`, optional `baseRef/baseSha`, and changed files against a base
- `tree`
  - Atlas endpoint: `GET /api/runtime/inspect/tree`
  - use to browse tracked paths at the resolved snapshot
- `file`
  - Atlas endpoint: `GET /api/runtime/inspect/file`
  - use to read one tracked file from the snapshot
- `search`
  - Atlas endpoint: `GET /api/runtime/inspect/search`
  - use to find anchors before reading full files
- `changed_files`
  - Atlas endpoint: `GET /api/runtime/inspect/changed-files`
  - requires `baseRef` and `headRef`
- `diff`
  - Atlas endpoint: `GET /api/runtime/inspect/diff`
  - requires `baseRef` and `headRef`
- `git_status`
  - Atlas endpoint: `GET /api/runtime/inspect/git-status`
  - use only when workspace dirtiness matters

Important invariants:

- this is readonly
- Atlas resolves a real git repo under the trusted inspect root
- invalid repo/path/ref inputs return structured errors
- this is not a live workspace mount

### `atlas_execution`

Atlas execution and lifecycle access.

Actions:

- `agent_card`
  - Atlas endpoint: `GET /api/a2a/agent-card`
  - use to confirm capabilities
- `submit`
  - Atlas endpoint: `POST /api/a2a/tasks`
  - use only after the brief is actionable
- `list`
  - Atlas endpoint: `GET /api/a2a/tasks`
  - use to find related tasks or recover status
- `get`
  - Atlas endpoint: `GET /api/a2a/tasks/{id}`
  - primary source of truth for task state
- `events`
  - Atlas endpoint: `GET /api/a2a/tasks/{id}/events`
  - use to explain lifecycle transitions
- `artifacts`
  - Atlas endpoint: `GET /api/a2a/tasks/{id}/artifacts`
  - use to fetch evidence

Important invariants:

- `brief` is required for `submit`
- `telegram-topic` submit requires real `sourceChatId` and `sourceThreadId`
- `409 conflict` means Atlas already has an active execution for the same topic/thread; attach to that task instead of creating another one
- `atlas_execution` is mutating and must not be exposed through generic HTTP tool invoke or subagent execution

## 4. Submit Envelope Meaning

The current OpenClaw submit path sends:

- `executionSpec.kind = "ExecutionSpec"`
- `executionSpec.taskId`
- `executionSpec.intent`
- `executionSpec.repo`
- `executionSpec.summary`
- `executionSpec.target.taskId`
- `executionSpec.target.env`
- `executionSpec.target.branch`
- top-level `atlasTaskId`
- `executionSpec.metadata.title`
- `executionSpec.metadata.brief`
- `executionSpec.metadata.acceptanceCriteria`
- `executionSpec.metadata.nonGoals`
- `executionSpec.metadata.verifyPlan`
- `executionSpec.metadata.stagePlan`
- `executionSpec.metadata.linkedTargetTaskId` when the user-facing linked work item differs from the Atlas-owned task id

It also sends source identity:

- `source.agent = "openclaw"`
- `source.transport`
- `source.chatId`
- `source.threadId`
- `source.messageId`

And extra linkage:

- `sessionId`
- `branch`
- `envName`
- `metadata.workThreadId`
- `metadata.bitrixTaskId`
- `metadata.linkedTargetTaskId`

Important invariant:

- `targetTaskId` is not the same thing as `atlasTaskId`
- Atlas-owned execution identity must remain canonical and separate from linked external work items such as Bitrix

## 5. Source Transport Inference

If transport is not explicitly provided, the current tool infers it this way:

1. explicit transport wins
2. if the agent channel is Telegram and chat/thread context exists -> `telegram-topic`
3. if the agent channel is Bitrix or `bitrixTaskId` is present -> `bitrix`
4. otherwise -> `openclaw`

Telegram context may come in either form:

- `telegram:group-or-channel:chat:topic:thread`
- split context like `agentTo="telegram:-100777"` plus `agentThreadId="4401"`

Do not infer `bitrix` from a generic `targetTaskId` alone.

## 6. Task Response Meaning

Atlas task responses can include:

- `task`
- `runtimeSession`
- `workThread`
- `artifacts`
- `latestArtifactByKind`

Treat `latestArtifactByKind` as the fastest source of truth for:

- `WorkspaceLease`
- `PreviewLink`
- `VerifyReport`
- `MergeRequestArtifact`

Do not infer completion from chat messages if Atlas artifacts disagree.

## 7. Lifecycle States

Common task states:

- `queued`
- `claimed`
- `running`
- `waiting_approval`
- `completed`
- `failed`
- `cancelled`

Translate them for the user as:

- `queued/claimed` -> preparing
- `running` -> executing
- `waiting_approval` -> needs your decision
- `completed` -> ready for review
- `failed` -> Atlas could not complete execution

## 8. Error Policy

### `no_files_changed`

Treat this as a brief/spec failure, not an implementation success and not a blind-retry case.
Explain that Atlas found nothing actionable to change, then clarify the intended behavior.

### Verify failure

When the goal is still clear and the failure looks fixable, allow up to 3 Atlas iterations.
After that, surface the blocker with evidence.

### `409 a2a_active_topic_execution_exists`

Do not create a parallel execution. Reuse or inspect the existing task.

### Missing Atlas config

If base URL or token is missing, say Atlas delivery is not configured and stop. Do not fall
back to direct repo mutation.

### Atlas infrastructure failure

If Atlas is temporarily unavailable or returns infrastructure errors such as `503`, report that
Atlas is blocked. Do not propose a local/manual bypass path that would move execution ownership
out of Atlas.

## 9. Atlas Runtime Endpoints Outside The Current Tool Surface

These Atlas functions exist even if there is not yet a dedicated OpenClaw wrapper for each:

- `GET /api/runtime/work-threads`
- `POST /api/runtime/work-threads/ensure`
- `GET /api/runtime/work-threads/by-topic`
- `POST /api/runtime/work-threads/link-bitrix`
- `POST /api/runtime/work-threads/unlink-bitrix`
- `POST /api/runtime/telegram-topic`

Meaning:

- `work_threads` are the canonical thread-level entity across Telegram, Bitrix, transport bindings, and A2A
- `by-topic` resolves a canonical work thread from `(chat_id, thread_id)`
- `ensure` upserts the canonical work thread
- `link-bitrix` and `unlink-bitrix` manage Bitrix as a linked work item
- `telegram-topic` creates/records a Telegram topic on the Atlas side

Current coordinator rule:

- know these functions exist
- prefer the wrapped tool surface
- do not fabricate raw HTTP calls unless the deployment explicitly exposes them as allowed tools

## 10. User-Facing Output

The user should usually see:

1. the brief
2. current stage
3. result of verification
4. preview link and what to check
5. next suggested iteration only if it is clearly useful

The user should not need to see:

- `A2A task id`
- `work_thread id`
- raw branch or lease bookkeeping
- callback plumbing
