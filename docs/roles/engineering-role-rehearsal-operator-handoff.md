# Operator Handoff: Engineering-Role Rehearsal

This document is the operator-facing handoff artifact for the accepted engineering-role live rehearsal drill from AI-97.

Use it to verify the current runtime behavior for:

- `toolsmith-bot`
- `coder-bot`
- `reviewer-bot`

This is a rehearsal and handoff drill only. It is not a production rollout task, a runtime redesign task, or a role-semantics rewrite task.

## What this drill proves

The drill proves that an operator can:

- reset the hidden persisted `agent:<role>:main` session state to a true fresh-role start,
- run one direct turn for each accepted engineering role,
- confirm that the guarded role introduction still matches the accepted role identity,
- confirm that runtime registration and workspace binding are still aligned with the active config,
- distinguish a runtime regression from an operator-procedure problem.

## Preconditions

Run the drill from the OpenClaw repo root:

```bash
cd /Users/john/openclaw
```

Before resetting sessions, confirm the runtime is healthy enough for rehearsal:

```bash
openclaw config validate
openclaw gateway status --deep --require-rpc --json
openclaw agents list --bindings --json
```

Expected preflight signals:

- `openclaw config validate` succeeds.
- `openclaw gateway status --deep --require-rpc --json` reports the gateway/rpc path as healthy.
- `openclaw agents list --bindings --json` includes `toolsmith-bot`, `coder-bot`, and `reviewer-bot`.
- `openclaw agents list --bindings --json` shows each role bound to its expected workspace from the active runtime config.

For the accepted local baseline, the runtime currently resolves these workspaces:

- `toolsmith-bot` -> `~/.openclaw/workspaces/agent-team/toolsmith-bot`
- `coder-bot` -> `~/.openclaw/workspaces/agent-team/coder-bot`
- `reviewer-bot` -> `~/.openclaw/workspaces/agent-team/reviewer-bot`

If your runtime config deliberately points one of these roles elsewhere, use the configured path from `openclaw agents list --bindings --json` as the source of truth and do not treat that override alone as a failure.

## Step 1: Reset fresh-role state

Run the accepted reset helper exactly once before the rehearsal pass:

```bash
node scripts/reset-agent-main-session.mjs toolsmith-bot coder-bot reviewer-bot
```

What this reset does:

- removes only the persisted `agent:<role>:main` entry for each named role,
- removes the referenced transcript for that main session when one exists,
- leaves unrelated agents and unrelated sessions alone.

Do not replace this step with a custom cleanup command.

## Step 2: Run the rehearsal turns

Use the same direct-turn prompt for each role:

```bash
openclaw agent --agent toolsmith-bot --message "Reply with a one-sentence introduction that states your role identity." --json
openclaw agent --agent coder-bot --message "Reply with a one-sentence introduction that states your role identity." --json
openclaw agent --agent reviewer-bot --message "Reply with a one-sentence introduction that states your role identity." --json
```

Do not pass `--session-id` for this drill. The accepted procedure relies on OpenClaw recreating the role's normal main-session alias after the reset.

## Expected success signals

Every role must pass all of the signals below.

### 1. Guarded intro matches the role

The returned introduction should stay aligned with the accepted role identity:

| Role            | Expected intro emphasis                                                   | Failure pattern                                                   |
| --------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `toolsmith-bot` | capability mapping, contracts, guardrails, handoff boundaries             | generic coding assistant framing, or implementation-owner framing |
| `coder-bot`     | implementation within approved boundaries, validated engineering delivery | generic coding assistant framing, or contract-author framing      |
| `reviewer-bot`  | review verdicts, findings, risk/regression scrutiny                       | generic coding assistant framing, or implementation-owner framing |

The wording does not need to be identical every run. The role identity must still be recognizably guarded to the accepted role.

### 2. Main-session binding is recreated correctly

After a successful direct turn, the role should again have a persisted `agent:<role>:main` entry.

Use the reset helper in dry-run mode to confirm that the main-session slot exists without modifying it:

```bash
node scripts/reset-agent-main-session.mjs --dry-run --json toolsmith-bot
node scripts/reset-agent-main-session.mjs --dry-run --json coder-bot
node scripts/reset-agent-main-session.mjs --dry-run --json reviewer-bot
```

Expected dry-run signals:

- `sessionKey` is `agent:toolsmith-bot:main`, `agent:coder-bot:main`, or `agent:reviewer-bot:main`.
- a `sessionId` is present for the role that just ran,
- `transcriptPath` points at that role's session transcript under `~/.openclaw/agents/<role>/sessions/`.

### 3. Workspace binding stays on the requested role

`openclaw agents list --bindings --json` must keep each role registered against its expected workspace.

For the accepted baseline:

- `toolsmith-bot` must stay on `~/.openclaw/workspaces/agent-team/toolsmith-bot`
- `coder-bot` must stay on `~/.openclaw/workspaces/agent-team/coder-bot`
- `reviewer-bot` must stay on `~/.openclaw/workspaces/agent-team/reviewer-bot`

If the intro is role-correct but the runtime binds the role to another role's workspace or the generic main workspace, treat that as a rehearsal failure.

### 4. No generic coding-assistant drift

The drill fails if any role returns a generic "coding assistant" style introduction instead of its accepted guarded identity.

## Optional same-session stability check

If you want one extra confidence check after the three role intros pass, run one follow-up turn without resetting:

```bash
openclaw agent --agent coder-bot --message "State your role identity again in one sentence." --json
```

Success means the role identity still sounds like `coder-bot` and does not fall back to a generic assistant introduction on the follow-up turn.

## Common failure signals and triage

| Failure signal                                              | What it usually means                                                              | Operator action                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic intro still appears for one role                    | stale persisted main session, stale live runtime bundle, or direct-turn regression | rerun `node scripts/reset-agent-main-session.mjs <role>` for the failing role and repeat the direct turn once; if the intro is still generic, run `openclaw config validate`, `openclaw gateway status --deep --require-rpc --json`, and `openclaw agents list --bindings --json`, then escalate as a runtime regression instead of editing docs or SOUL files |
| Wrong workspace for a role                                  | runtime config drift or wrong role resolution                                      | run `openclaw agents list --bindings --json` and compare the role's `workspace` field with the accepted runtime workspace for that role; if the role points at another role's workspace or a generic workspace unexpectedly, stop and escalate the runtime config mismatch                                                                                     |
| Role missing from runtime registration                      | activation/regression problem, not a handoff-doc problem                           | run `openclaw agents list --bindings --json`; if the role is absent, reopen the runtime activation path and do not continue the rehearsal                                                                                                                                                                                                                      |
| `openclaw config validate` fails                            | config is invalid                                                                  | fix the active runtime config first; do not continue the drill against an invalid config                                                                                                                                                                                                                                                                       |
| `openclaw gateway status --deep --require-rpc --json` fails | gateway/rpc path is not healthy                                                    | restore gateway readiness first; this drill depends on the accepted live runtime path                                                                                                                                                                                                                                                                          |

## What not to do

- Do not skip the reset step and then claim a fresh-role result.
- Do not add `--session-id` to force a custom session for this drill.
- Do not switch to `--local` for the normal operator handoff path. Use `--local` only if you are explicitly triaging a gateway-only mismatch.
- Do not edit SOUL files, role docs, or runtime contracts as part of this drill.
- Do not treat this handoff as permission to redesign session architecture or role semantics.
- Do not widen this into production deployment, provider changes, or new role registration work.

## Escalation boundary

Escalate when:

- the role is missing from `openclaw agents list --bindings --json`,
- config validation fails,
- gateway/rpc readiness fails,
- a role still returns generic assistant framing after a clean reset and one retry,
- workspace binding no longer matches the active runtime config.

Do not "fix forward" inside the handoff drill by inventing new commands, new role semantics, or new runtime artifacts.
