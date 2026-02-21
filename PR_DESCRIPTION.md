## Summary

- **Problem:** 17 files under `src/agents/` bypass the project's structured logging system and write directly to `console.warn` / `console.error` / `console.info`. These messages ignore log-level configuration, are invisible to the file logger, and cannot be filtered by subsystem.
- **Why it matters:** Operators lose the ability to control agent-subsystem log verbosity at runtime; file-based log aggregation misses these warnings entirely; console output style is inconsistent with the rest of the gateway.
- **What changed:** Each affected file now creates a `createSubsystemLogger(…)` instance and routes every former `console.*` call through it. Multi-argument calls were converted to template literals to match the `SubsystemLogger` API, and redundant `[subsystem]` prefixes were stripped (the logger tags output automatically).
- **What did NOT change (scope boundary):** Test files, CLI entry-points (`entry.ts`, `index.ts`, `cli/run-main.ts`), the `runtime.ts` console wrapper, and ACP interactive-CLI output are intentionally left as-is—they either run before the logger is initialised or produce user-facing terminal output that must go through `console` directly.

## Change Type (select all)

- [ ] Bug fix
- [ ] Feature
- [x] Refactor
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [x] Gateway / orchestration
- [x] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [ ] Integrations
- [ ] API / contracts
- [ ] UI / DX
- [ ] CI/CD / infra

## Linked Issue/PR

N/A — opportunistic housekeeping; no open issue.

## User-visible / Behavior Changes

None. Log messages still reach the console at the same severity; the only observable difference is that they now carry a coloured `[subsystem]` prefix and are also written to the file logger.

## Security Impact (required)

- New permissions/capabilities? `No`
- Secrets/tokens handling changed? `No`
- New/changed network calls? `No`
- Command/tool execution surface changed? `No`
- Data access scope changed? `No`

## Repro + Verification

### Environment

- OS: any (Linux / macOS / Windows)
- Runtime/container: Node ≥ 20
- Model/provider: any configured provider (Ollama, vLLM, Venice, HuggingFace, Bedrock, etc.)
- Integration/channel: N/A
- Relevant config: default

### Steps

1. Configure an Ollama / vLLM / Venice provider with an unreachable endpoint (or stop the local service).
2. Start the gateway: `pnpm gateway:watch`
3. Trigger model discovery (e.g. send a message that invokes model selection).

### Expected

- Warning appears in the console **with** a coloured `[model-providers]` / `[venice-models]` / etc. subsystem tag.
- The same warning line appears in the file log (e.g. `~/.openclaw/logs/…`).

### Actual

Before this PR: bare `console.warn` output, no subsystem tag, no file log entry.

## Evidence

```diff
# Before (models-config.providers.ts)
-      console.warn(`Failed to discover Ollama models: ${response.status}`);

# After
+      log.warn(`Failed to discover Ollama models: ${response.status}`);
```

```diff
# Before — multi-arg call (sandbox/docker.ts)
-    console.warn(
-      "[Security] Blocked sensitive environment variables:",
-      envSanitization.blocked.join(", "),
-    );

# After — single template-literal string, redundant prefix removed
+    log.warn(
+      `Blocked sensitive environment variables: ${envSanitization.blocked.join(", ")}`,
+    );
```

## Human Verification (required)

- **Verified scenarios:** TypeScript compiles without new errors (`npx tsc --noEmit` — all errors are pre-existing missing-dep issues in extensions/).
- **Edge cases checked:** multi-argument `console.warn` calls correctly converted to template literals; `skills/workspace.ts` reuses the existing `skillsLogger` instead of creating a duplicate; `session-write-lock.ts` no-console eslint comment removed.
- **What I did not verify:** full `pnpm build && pnpm check && pnpm test` (requires `pnpm` + full dependency install); runtime log output in a live gateway instance.

## Compatibility / Migration

- Backward compatible? `Yes`
- Config/env changes? `No`
- Migration needed? `No`

## Failure Recovery (if this breaks)

- How to disable/revert this change quickly: `git revert <sha>`
- Files/config to restore: none
- Known bad symptoms reviewers should watch for: missing warning messages in console during model discovery failures; import resolution errors if `../logging/subsystem.js` path is wrong for a specific file.

## Risks and Mitigations

- **Risk:** A subsystem logger created at module scope could fire before the logging subsystem is fully initialised (e.g. during very early import-time side effects).
  - **Mitigation:** `createSubsystemLogger` is already used at module scope in 30+ other files across the codebase (e.g. `heartbeat-runner.ts`, `fetch-guard.ts`); the logging subsystem is designed for lazy initialisation.
