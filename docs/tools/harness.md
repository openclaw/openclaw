---
summary: "Harness-aware agent execution: spec tracking, step/check reporting tools, and automatic protocol injection"
read_when:
  - Agent receives a harness-managed task
  - Understanding harness_report_step or harness_report_check tools
  - Debugging harness verification flow
  - Modifying task-continuation-runner harness injection
title: "Harness Execution"
---

# Harness Execution

Harness execution enables agents to **report progress against structured specs** defined in Task Hub's Harness system. When a harness project is launched, each item's steps and verification checklist are tracked through two agent tools (`harness_report_step`, `harness_report_check`) that call back to Task Hub's Verify API.

## Overview

```
Task Hub (Launch)
  -> delegateToAgent(harness_project_slug, harness_item_id)
  -> Gateway task_backlog_add
  -> TaskFile.md (backlog JSON with harness fields)
  -> task-continuation-runner picks up task
  -> injects harness protocol into pickup prompt
  -> agent executes steps, calls harness_report_step/check
  -> hubFetch -> POST /api/harness/{itemId}/verify
  -> Task Hub updates HarnessItem.verification
  -> all checks passed -> verification.status = "passed"
```

## Agent Tools

### `harness_report_step`

Reports completion of a spec step.

| Parameter    | Type   | Required | Description                       |
| ------------ | ------ | -------- | --------------------------------- |
| `item_id`    | string | yes      | HarnessItem `_id` from Task Hub   |
| `step_index` | number | yes      | 0-based index into `spec.steps[]` |
| `status`     | string | yes      | `"done"` or `"skipped"`           |
| `note`       | string | no       | Completion or skip reason         |

**Response fields:** `success`, `stepIndex`, `status`, `stepsRemaining`, `stepsDone`, `stepsTotal`, `verificationStatus`

### `harness_report_check`

Reports result of a verification checklist item. When all checks pass, the item's verification status is automatically set to `"passed"`.

| Parameter     | Type    | Required | Description                                  |
| ------------- | ------- | -------- | -------------------------------------------- |
| `item_id`     | string  | yes      | HarnessItem `_id` from Task Hub              |
| `check_index` | number  | yes      | 0-based index into `verificationChecklist[]` |
| `passed`      | boolean | yes      | Whether the check passed                     |
| `note`        | string  | no       | Verification note                            |

**Response fields:** `success`, `checkIndex`, `passed`, `checksRemaining`, `checksPassed`, `checksTotal`, `verificationStatus`, `allChecksPassed`

## Data Flow

### 1. Launch (Task Hub)

`POST /api/harness/{projectId}/launch` creates tasks via `delegateToAgent()` with two extra fields:

- `harnessProjectSlug` — slugified project title (e.g., `"my-project"`)
- `harnessItemId` — MongoDB `_id` of the HarnessItem

These are passed to Gateway's `task_backlog_add` as `harness_project_slug` and `harness_item_id`.

### 2. TaskFile Serialization (Gateway)

`TaskFile` interface includes `harnessProjectSlug` and `harnessItemId`. These are serialized into the backlog JSON block within the TaskFile markdown and parsed back on read.

**Relevant code:** `src/agents/tools/task-file-io.ts`

### 3. Prompt Injection (task-continuation-runner)

When `formatBacklogPickupPrompt()` detects `task.harnessProjectSlug`, it injects the harness protocol block into the agent's pickup prompt:

```
## Harness Protocol
This is a harness-managed task. You MUST follow the harness protocol:
- **Harness Item ID:** {harnessItemId}
- **Project Slug:** {harnessProjectSlug}

1. Read `.harness/{slug}/specs/` for spec files
2. Follow each spec's steps in order
3. After completing each step, call `harness_report_step(...)`
4. After all steps, verify each checklist item and call `harness_report_check(...)`
5. Only mark task complete after ALL checks pass
```

**Relevant code:** `src/infra/task-continuation-runner.ts:404-417`

### 4. Verify API (Task Hub)

`POST /api/harness/{itemId}/verify` handles two operation types:

**type: "step"**

- Lazy-initializes `verification.stepProgress[]` from `spec.steps`
- Upserts entry at `stepProgress[index]` with `{ status, note, updatedAt }`

**type: "check"**

- Updates `verification.checklist[index].checked` and optional `note`
- When **all** checklist items are checked, automatically sets `verification.status = "passed"`

**Important:** The `[id]` route param is the **itemId**, not projectId (unlike other harness routes).

## Model Extensions

### IStepProgress (Task Hub)

Added to `IVerification` in `src/models/Harness.ts`:

```typescript
interface IStepProgress {
  index: number;
  status: "pending" | "done" | "skipped";
  note?: string;
  updatedAt?: Date;
}

// IVerification.stepProgress?: IStepProgress[]
```

### TaskFile (Gateway)

Added to `TaskFile` in `src/agents/tools/task-file-io.ts`:

```typescript
harnessProjectSlug?: string;
harnessItemId?: string;
```

### TaskBacklogAddSchema (Gateway)

Added to schema in `src/agents/tools/task-blocking.ts`:

```typescript
harness_project_slug: Type.Optional(Type.String());
harness_item_id: Type.Optional(Type.String());
```

## Tool Registration

Harness tools are registered in `src/agents/openclaw-tools.ts` via `createHarnessTools()`, following the same factory pattern as milestone tools.

## Environment

| Variable       | Default                 | Used by      |
| -------------- | ----------------------- | ------------ |
| `TASK_HUB_URL` | `http://localhost:3102` | harness-tool |

## Testing

```bash
# Harness tool unit tests (8 tests)
npx vitest run src/agents/tools/harness-tool.test.ts

# TaskFile harness roundtrip tests (included in task-file-io suite)
npx vitest run src/agents/tools/task-file-io.test.ts
```

### Test patterns

- `harness-tool.test.ts` uses `globalThis.fetch = fetchMock` in `beforeEach` (required for vitest `forks` pool — `vi.stubGlobal` does not work)
- `task-file-io.test.ts` includes 3 harness-specific roundtrip tests: harness-only, milestone+harness combo, and undefined-when-not-set

## Related Files

| File                                                     | Description                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `src/agents/tools/harness-tool.ts`                       | Tool definitions (`harness_report_step`, `harness_report_check`) |
| `src/agents/tools/task-file-io.ts`                       | TaskFile serialization with harness fields                       |
| `src/agents/tools/task-blocking.ts`                      | `task_backlog_add` schema with harness params                    |
| `src/agents/openclaw-tools.ts`                           | Tool registration                                                |
| `src/infra/task-continuation-runner.ts`                  | Harness protocol prompt injection                                |
| `prontoclaw-config/workspace-shared/HARNESS-PROTOCOL.md` | Agent-facing protocol reference                                  |

## See Also

- [HARNESS-PROTOCOL.md](/workspace-shared/HARNESS-PROTOCOL.md) — agent-facing protocol document
- Task Hub Verify API — `task-hub/src/app/api/harness/[id]/verify/route.ts`
- Task Hub Launch API — `task-hub/src/app/api/harness/[id]/launch/route.ts`
