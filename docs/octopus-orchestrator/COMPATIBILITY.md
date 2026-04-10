<!-- This file is human-reviewed after M0-14 completes. Do not modify from loop runs. -->

# OpenClaw Octopus Orchestrator — Upstream Compatibility

## Status

Milestone 0 baseline — this file records the OpenClaw version floor that Octopus commits to support, together with the versions it has been tested against. It is the canonical source for the compatibility matrix referenced by `INTEGRATION.md` §Upstream Compatibility Matrix and governed by `DECISIONS.md` OCTO-DEC-034.

Octopus probes the running OpenClaw version at enable time (via `hello-ok.protocol` or a version helper) and refuses to enable below the `Supported minimum` row below, logging a structured error naming the required floor. There is no partial-operation mode.

## Read-only discipline

This file is **written once by the M0-14 loop turn and is then human-reviewed and frozen**. Subsequent loop runs MUST NOT modify it. Updates happen only on explicit compatibility-audit turns driven by a human reviewer, per OCTO-DEC-034's commitment to a controlled upgrade cadence. Any drift between this file and the integration-test lanes is a release blocker, not a silent auto-fix.

## Compatibility matrix

| Supported minimum | Known working | Floor reason | Last test run |
| ----------------- | ------------- | ------------ | ------------- |
| 2026.4.7-1        | 2026.4.7-1    | M0 baseline  | 2026-04-10    |

**Deployed reference.** OpenClaw 2026.4.8 is the deployed production version; the tree is pinned to upstream commit `9ece252` which still reports package version `2026.4.7-1` in `package.json`. The `Supported minimum` and `Known working` rows therefore record `2026.4.7-1` (the package-declared version of the pinned commit) rather than the deployed tag. Future updates to this row follow the Upstream Change Playbook in `INTEGRATION.md`.

## PR Draft Compatibility

Verified against pinned upstream commit `9ece252` (package.json 2026.4.7-1) on 2026-04-10.

| PR    | Target file(s)                                                                          | Status   | Notes                                                                                                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-01 | `src/gateway/server-methods-list.ts`                                                    | verified | `BASE_METHODS` array present (line 4), WebChat block ends at line 126 with `chat.send` followed by `];` — insertion point intact. `listGatewayMethods()` dedup logic unchanged (line 131).                                                                       |
| PR-02 | `src/gateway/server/ws-connection/message-handler.ts`                                   | verified | `features: { methods: gatewayMethods, events }` at line 1212 — single-site construction intact.                                                                                                                                                                  |
| PR-03 | `src/gateway/protocol/schema/frames.ts`, `src/gateway/node-registry.ts`                 | verified | `ConnectParamsSchema` at line 20 in frames.ts. `NodeSession` type at line 4 in node-registry.ts with `caps: string[]` at line 18. Both insertion points intact.                                                                                                  |
| PR-04 | `src/auto-reply/commands-registry.shared.ts`                                            | verified | `buildBuiltinChatCommands()` at line 124, `defineChatCommand` pattern throughout. `subagents` block at line 312. Insertion point intact.                                                                                                                         |
| PR-05 | `src/gateway/protocol/schema/cron.ts`, `src/cron/service/timer.ts`, `src/cron/types.ts` | verified | `CronPayloadSchema` union at line 130 in cron.ts. `executeDetachedCronJob` at line 1248 in timer.ts with `payload.kind !== "agentTurn"` gate at line 1256. `CronPayload` union at line 84 in types.ts. All insertion points intact.                              |
| PR-06 | `src/tasks/task-flow-registry.types.ts`, `src/tasks/task-flow-registry.ts`              | verified | `TaskFlowSyncMode = "task_mirrored" \| "managed"` at line 12 in types.ts. Registry file present with `normalizeRestoredFlowRecord` and `createTaskFlowForTask`. Insertion points intact.                                                                         |
| PR-07 | `src/hooks/internal-hooks.ts`                                                           | verified | `InternalHookEventType = "command" \| "session" \| "agent" \| "gateway" \| "message"` at line 17. Single-line union, exact match to PR draft.                                                                                                                    |
| PR-08 | `src/cli/program/subcli-descriptors.ts`, `src/cli/program/register.subclis.ts`          | verified | Descriptor catalog with `name`/`description`/`hasSubcommands` shape intact. `defineImportedProgramCommandGroupSpecs` blocks with `commandNames` entries intact. No existing `octo` entry (clean insertion).                                                      |
| PR-09 | `src/agents/tool-catalog.ts`                                                            | verified | `CORE_TOOL_DEFINITIONS` array at line 53. Profile-based pipeline and `includeInOpenClawGroup` pattern present. No existing `octo_*` entries (clean insertion).                                                                                                   |
| PR-10 | `src/gateway/operator-scopes.ts`, `src/gateway/method-scopes.ts`                        | verified | Scope literals (`ADMIN_SCOPE` through `TALK_SECRETS_SCOPE`) and `OperatorScope` union at lines 1-14 in operator-scopes.ts. `METHOD_SCOPE_GROUPS` at line 42 and `authorizeOperatorScopesForMethod` at line 228 in method-scopes.ts. All insertion points intact. |
| PR-11 | `src/config/io.ts`, `src/config/types.openclaw.ts`                                      | verified | `OpenClawConfig` type at line 32 in types.openclaw.ts with subsystem fields (`channels`, `cron`, `tools`, `hooks`). `loadConfig()` at line 1033 in io.ts with `materializeRuntimeConfig` at line 1131. Insertion points intact.                                  |

**Summary:** All 11 PR drafts verified compatible. Zero drift detected against pinned commit `9ece252`. All target files exist, all insertion points match the shapes described in the PR drafts. No file moves, no function renames, no structural changes that would invalidate any draft.

## Update cadence

This file is updated only on explicit compatibility-audit turns — typically after a new OpenClaw release has been exercised through the Octopus integration-test lanes, or when a floor bump is proposed as part of an Octopus release. It is never edited mid-loop by routine orchestrator turns.
