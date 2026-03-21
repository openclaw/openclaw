# Feature: Exec Transparency Log Mode (Issue #51928)

## Summary

Add a `"log"` mode to exec transparency that posts the command being executed to the
active channel BEFORE running it — without requiring confirmation.

Currently only two modes exist:

- `"off"` (silent) — default
- `"confirm"` (approval required) — via exec-approvals system

We want to add:

- `"log"` — show command + workdir to channel, then run immediately, no approval needed

## Key files to read first

- `src/infra/exec-approvals.ts` — ExecAsk type, normalizeExecAsk()
- `src/agents/bash-tools.exec-runtime.ts` — exec execution flow
- `src/agents/bash-tools.exec.ts` — main exec tool handler
- `src/infra/exec-approval-forwarder.ts` — how approvals are forwarded to channels
- `src/infra/exec-approval-command-display.ts` — command display formatting (already exists!)
- `src/agents/bash-tools.exec-approval-request.ts` — approval request building

## What to implement

### 1. Add `"log"` to ExecAsk type

In `src/infra/exec-approvals.ts`, add `"log"` to the `ExecAsk` union type alongside existing values.

### 2. Handle `"log"` in exec flow

In `src/agents/bash-tools.exec.ts` or the approval request flow:

- When `ask === "log"`, emit a channel notification with the command text
- Format: `🔧 Running: \`<command>\``(use existing`resolveExecApprovalCommandDisplay`)
- Then proceed to execute immediately (no waiting for approval)

### 3. Config schema

Add `"log"` as valid value in the config schema for `ask` parameter.

### 4. Tests

Add tests verifying:

- `"log"` mode emits a notification but does NOT block execution
- Command text is properly sanitized before display (use existing `sanitizeExecApprovalDisplayText`)

## Instructions

1. Read the key files to understand the existing approval flow
2. Plan the implementation — "log" should reuse existing display infrastructure
3. Implement with minimal diff
4. Run formatter: `npx oxfmt` on changed files
5. Run tests: `npx vitest run --reporter=verbose` on changed test files
6. Show output — only commit if ALL tests pass
7. Do NOT use `String(err)` — use `err instanceof Error ? err.message : "unknown error"`
8. Do NOT use `new Error(msg)` without `{ cause: err }` when rethrowing
9. Do NOT run npm/pnpm install

## When done

- git add changed files
- Commit: "feat(exec): add log mode for transparent command visibility without approval"
- Run: openclaw system event --text "Claude Code: exec transparency PR ready" --mode now
