# PR: Filesystem Access Control (PathGuard) #39672

## Summary

This PR introduces a stricter, policy-driven filesystem access layer for agent tools.

It closes the main security gaps from #39672 by:
- canonicalizing requested paths before evaluation,
- preventing traversal and symlink/junction escapes,
- enforcing allowedPaths / denyPaths consistently for both classic file tools and local media loads,
- preserving deny-overrides-allow semantics,
- anchoring workspace-relative policy entries to the workspace root,
- returning structured, user-guidance-oriented policy denial tool results for blocked paths,
- and enforcing a filesystem policy ceiling for spawned subagents (global + agent + subagent + spawn-time tightening).

Scope is intentionally limited to local filesystem access. Remote URLs (http(s)) and inline data: inputs are not treated as filesystem paths and are therefore outside this policy layer.

## Change Type

- [x] Feature
- [x] Security hardening
- [x] Bug fix
- [ ] Refactor
- [x] Docs
- [x] Tests

## Linked Issue

- Closes #39672
- Related #8719

## Problem Statement

Before this PR, filesystem tool enforcement had several security and consistency gaps:
- path traversal and symlink escape protection was not centralized enough,
- policy matching for absolute and relative paths was inconsistent,
- media tools (image, pdf) could diverge from read/write/edit-style filesystem policy behavior,
- sandbox and host flows did not fully share the same policy guarantees,
- relative workspace policy matching had edge cases around glob scoping and path escape semantics,
- and spawned subagents did not have an enforceable filesystem policy ceiling.

## What Changed

### 1) Core PathGuard enforcement

Implemented a dedicated PathGuard flow in `src/security/path-guard.ts` with these properties:
- canonical path resolution via `fs.realpath` for existing paths,
- nearest-existing-parent resolution for new/non-existent paths,
- symlink/junction-aware path comparison,
- deny-precedence semantics,
- workspace root equality treated as valid containment,
- canonicalization of absolute policy entries before comparison,
- canonicalization of relative literal entries to avoid symlink-alias mismatches,
- workspace anchoring for relative policy entries,
- correct detection of glob syntax including brace/extglob-style patterns via `Minimatch(...).hasMagic()`.

### 2) File tool integration

Policy resolution is wired into tool FS configuration and enforced for guarded filesystem tool operations (read/write/edit/apply_patch-style flows).

Additionally, when policy denies a path, tools now return a structured `policy_denied` tool result that:
- clearly states the restriction cannot be bypassed,
- describes what the tool attempted to do,
- and provides actionable remediation options (move file into workspace, paste content, or update config keys).

### 3) Media tool integration

Extended local filesystem policy enforcement to media loaders:
- `src/agents/tools/image-tool.ts`
- `src/agents/tools/pdf-tool.ts`

Important implementation detail:
- policy enforcement is applied on the resolved file path using `checkPathGuardStrict(...)`,
- not by approximating access through root-prefix filtering.

This avoids security regressions that happen when glob patterns are reduced to directory prefixes.

### 4) Sandbox behavior

For local media loads in sandbox mode:
- PathGuard runs in sandbox flows too,
- policy root is `sandbox.root` when sandboxed,
- otherwise `workspaceDir` is used.

This keeps local file policy checks consistent across host and sandbox access paths.

### 5) Subagent filesystem policy ceiling (spawn + runtime enforcement)

Added a ceiling + tightening model for spawned subagents:
- Global policy (`tools.fs`) sets the baseline.
- Agent policy (`agents.<id>.tools.fs`) can further restrict.
- Subagent defaults (`tools.subagents.fs`) can further restrict.
- Spawn-time overrides (`sessions_spawn.fsPolicy`) can further restrict per spawn.

Merge semantics:
- `workspaceOnly`: OR
- `denyPaths`: UNION
- `allowedPaths`: INTERSECTION across configured allowlists (undefined = no restriction, [] = deny all)

The effective policy is persisted on the spawned child session (`spawnedToolFsPolicy`) and plumbed end-to-end into the child run so the tool layer enforces it.

### 6) Tests and regression hardening

Added and/or extended tests for:
- traversal denial,
- symlink/junction escape denial,
- outside-workspace relative glob behavior,
- non-glob relative workspace anchoring,
- brace/extglob policy detection,
- sandbox image deny policy,
- sandbox pdf allow-only policy,
- sandbox deny-overrides-allow behavior for media paths.

Also fixed CI/typecheck issues surfaced during review (duplicate imports, parse errors, test typing).

## Security Semantics (Important)

### Filesystem-only scope

allowedPaths / denyPaths apply only to local filesystem paths.

They do not govern:
- http://...
- https://...
- data:...

If maintainers want policy for remote media sources, that should be implemented as a separate explicit source-governance layer, not overloaded into filesystem policy.

### Policy rules

- denyPaths always overrides allowedPaths.
- Relative policy entries are treated as workspace-anchored.
- Relative entries must not escape the workspace root.
- Absolute entries are canonicalized before comparison.
- Glob and non-glob policy entries follow the same workspace-anchored intent for relative paths.

## Files Touched (conceptual)

### Core security
- `src/security/path-guard.ts`
- `src/security/path-guard.test.ts`

### Tool integration
- `src/agents/tools/image-tool.ts`
- `src/agents/tools/pdf-tool.ts`
- `src/agents/tools/media-tool-shared.ts`
- `src/agents/pi-tools.ts`
- `src/agents/pi-tools.read.ts`
- `src/agents/tool-fs-policy.ts`
- `src/agents/tools/policy-denial.ts`

### Subagent ceiling / spawn plumbing
- `src/agents/subagent-spawn.ts`
- `src/agents/tools/sessions-spawn-tool.ts`
- `src/config/types.tools.ts`
- `src/config/sessions/types.ts`
- `src/gateway/protocol/schema/sessions.ts`
- `src/gateway/sessions-patch.ts`
- `src/gateway/server-methods/agent.ts`
- `src/agents/command/types.ts`
- `src/agents/pi-embedded-runner/run/params.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/spawned-context.ts`
- `src/auto-reply/reply/session.ts`

## Verification

### CI checks

- All tests and checks pass in CI (per latest run).

## Remaining Risk

### Low / acceptable residual risk

1. Remote media sources are intentionally out of scope.
2. Cross-platform path edge cases remain a watch area (Windows/POSIX normalization sensitivity).
3. Future sandbox/bridge refactors must preserve per-path enforcement invariants.

## Rollback / Recovery

- Disable restrictions by clearing allowedPaths / denyPaths and setting workspaceOnly: false.
- No data migration required.

## Reviewer Handoff Notes

If you revisit this area later, preserve these invariants:
- do not replace per-path enforcement with root-prefix approximation for glob policies,
- keep deny-overrides-allow behavior,
- keep relative workspace policy entries anchored to workspace,
- keep sandbox and host local-file enforcement aligned,
- keep local-FS policy and remote-source policy as separate concepts,
- keep subagent policy tightening monotonic (no privilege escalation relative to global ceiling).
