WORK LOG

Add your findings and worklogs by appending to the end of this file. Do not overwrite anything that is existing in this file. Write with the format being used.

[CODEX]

I've brought work into the workstream.

[CLAUDE]

I've assigned the work to eleqtrizit.

[CODEX SECURITY FIXER]

- Reviewed NVIDIA-dev/openclaw-tracking#480, GHSA-7jm2-g593-4qrc, and `SECURITY.md`; determined the issue is in scope because the non-trusted model can persist operator-trusted config changes through the owner-only `gateway` tool guard.
- Confirmed the current guard in `src/agents/tools/gateway-tool.ts` only protected a narrow `tools.exec.*` set plus enumerated dangerous flags, leaving sandbox, plugin trust, fs hardening, hook routing, gateway auth/TLS exposure, and related paths writable.
- Reviewed existing GHSA-private PR work and adopted the same low-risk direction: extend protected config prefixes and handle `agents.list[]` id-keyed entries so merge-patch rewrites are blocked without changing non-agent config callers.
- Added focused regression coverage in `src/agents/tools/gateway-tool-guard-coverage.test.ts` and updated `src/agents/tools/gateway-tool.ts`.
- Validation so far: `corepack pnpm test src/agents/tools/gateway-tool-guard-coverage.test.ts`, `corepack pnpm format:check src/agents/tools/gateway-tool.ts src/agents/tools/gateway-tool-guard-coverage.test.ts`, `corepack pnpm tsgo:core`.
- Validation gap: `claude -p "/review"` produced no output and timed out twice in this environment, so local agentic review could not be completed here.
- Opened PR `openclaw/openclaw#69377`, posted the PR link back to NVIDIA-dev/openclaw-tracking#480, and credited the existing GHSA private-fork work via commit co-author trailers.
- Addressed Greptile and Codex review findings with follow-up commits `faa55aeb52` and `d4020ea50c`, then resolved all three review threads on the PR.
- CI status at handoff: parity gate passed; labeler failed once due GitHub failing to download `actions/labeler@v6`, rerun passed; latest head still had `install-smoke` and `CI` (`preflight` / `security-fast`) pending when work stopped.

[CLAUDE REVIEW]

Reviewer: Claude Opus 4.6
Date: 2026-04-20
Branch: fix/gateway-config-guard
Commits reviewed: c9a201d01c, faa55aeb52, d4020ea50c (3 commits, 2 files, +362/-5 lines)
Issue: NVIDIA-dev/openclaw-tracking#480 (GHSA-7jm2-g593-4qrc, severity: high)

## Goal of Changes

This branch closes a security vulnerability (GHSA-7jm2-g593-4qrc) in the gateway tool's config mutation guard (`assertGatewayConfigMutationAllowed` in `src/agents/tools/gateway-tool.ts`). The vulnerability allowed a prompt-injected model — which SECURITY.md classifies as a non-trusted principal — to persistently rewrite operator-trusted config paths via `gateway config.patch` or `config.apply`. The original guard only protected six `tools.exec.*` paths and a narrow set of enumerated dangerous flags, leaving critical operator-trust boundaries exposed: sandbox isolation, plugin enable/install, filesystem hardening, hook routing/auth, gateway auth/TLS, SSRF policy, and MCP server config.

The fix extends the `PROTECTED_GATEWAY_CONFIG_PATHS` denylist from 6 entries to 33, covering all operator-trusted config surfaces identified in the advisory. It also introduces `isProtectedPathEqual`, a new comparison function that understands the `agents.list[].sandbox` / `agents.list[].tools` bracket-path convention so that `mergeObjectArraysById` in-place array-entry rewrites are caught — not just top-level key changes. A new 265-line regression test suite (`gateway-tool-guard-coverage.test.ts`) exercises both `config.patch` and `config.apply` across all attack vectors described in the advisory.

## What It Accomplishes

1. **Blocks sandbox escape**: `agents.defaults.sandbox.mode`, `agents.sandbox`, `sandbox`, and per-agent `agents.list[].sandbox` are now protected, preventing a model from disabling sandbox isolation.
2. **Blocks plugin trust escalation**: `plugins.entries`, `plugins.installs`, `plugins.load`, `plugins.slots`, `plugins.enabled`, `plugins.allow`, `plugins.deny` are all guarded, preventing enabling disabled-but-installed plugins.
3. **Blocks fs boundary removal**: `tools.fs` (entire subtree) is protected, covering `workspaceOnly` and any future descendants.
4. **Blocks gateway auth/TLS tampering**: `gateway.auth`, `gateway.tls` subtrees are protected.
5. **Blocks HTTP tool surface expansion**: `gateway.tools.allow` and `gateway.tools.deny` are protected.
6. **Blocks hook routing/auth manipulation**: `hooks.token`, `hooks.mappings`, `hooks.allowRequestSessionKey`, session key prefixes, trusted code loading dirs — all guarded.
7. **Blocks SSRF/MCP reach expansion**: `browser.ssrfPolicy`, `tools.web.fetch.ssrfPolicy`, `mcp.servers` are protected.
8. **Blocks per-agent tool/sandbox overrides via array merge**: The new `isProtectedPathEqual` function handles the `[]` bracket convention in paths like `agents.list[].sandbox`, projecting array entries by `id` and comparing sub-path values to catch in-place rewrites through `mergeObjectArraysById`.
9. **Blocks subagent tool policy override**: `tools.subagents` is protected.
10. **Blocks per-agent embedded PI override**: `agents.list[].embeddedPi` is protected.

## Best Practices and Standards Assessment

### Strengths

1. **Directly addresses the advisory scope**: Every reproduction vector listed in GHSA-7jm2-g593-4qrc is covered by both production guard paths and regression tests. The test names directly reference the attack scenarios (sandbox disable, plugin enable, fs hardening clear, namespace join flag, hook sessionKey rewrite, auth token rewrite, TLS certPath redirect, etc.).

2. **Test design is exemplary**: The test file uses focused helper functions (`expectBlocked`, `expectAllowed`, `expectBlockedApply`, `expectAllowedApply`) that test the actual production guard function (`assertGatewayConfigMutationAllowed`) rather than a simulated/reimplemented version. This is a significant improvement over the original advisory's reproduction test which simulated the guard — the fix tests the real code path through the `assertGatewayConfigMutationAllowedForTest` wrapper.

3. **Positive and negative test cases**: The suite includes "still allows benign agent-driven tweaks" and "still allows benign config.apply replacements" tests, confirming the guard doesn't over-block legitimate agent behavior (prompt changes, model selection). This is critical for a security guard — demonstrating it doesn't break normal operation.

4. **Both action modes covered**: Tests exercise both `config.patch` (merge semantics) and `config.apply` (full replacement semantics), which have different code paths in the guard.

5. **Follows repo conventions**: Colocated test file (`*.test.ts` next to the source), Vitest framework, proper imports, TypeScript strict types, no `any`, no lint suppressions. Comments are brief and only for non-obvious logic (the security comment block at line 25-29 explaining why the guard exists).

6. **Handles mergeObjectArraysById attack vector**: The `isProtectedPathEqual` function specifically addresses the advisory's note that `applyMergePatch(..., { mergeObjectArraysById: true })` allows in-place rewrites of keyed array entries. The bracket-path convention (`agents.list[].sandbox`) makes this explicit in the protected paths list rather than requiring special-case code for each array.

7. **Handles id-less entries**: Commit faa55aeb52 added coverage for unkeyed guard entries (the "blocks id-less per-agent sandbox injection" test), catching the case where a patch injects new array entries without an `id` field that would carry dangerous values.

8. **Handles array entry order**: Commit d4020ea50c ("preserve array entry order in guard") ensures the projection-based comparison uses insertion order, matching `mergeObjectArraysById` semantics. The `readProjectedEntries` function preserves the ordering of the source array.

9. **Prefix-based protection**: Protecting `tools.fs` rather than just `tools.fs.workspaceOnly` closes future descendants under that subtree. Similarly `gateway.auth`, `gateway.tls`, `agents.defaults.sandbox` protect entire subtrees rather than leaf values.

10. **`@internal` annotation on test exports**: The `PROTECTED_GATEWAY_CONFIG_PATHS_FOR_TEST` and `assertGatewayConfigMutationAllowedForTest` exports are properly annotated as internal/test-only, following the pattern of not exposing security internals to runtime consumers.

### Concerns and Potential Issues

1. **Denylist vs. allowlist approach**: The advisory's own remediation section (item 3) recommends replacing the denylist with an allowlist — only permit `config.patch`/`config.apply` to change a documented, narrow "safe for agent to tune" set of paths. This fix extends the denylist instead. While the denylist is now comprehensive against known attack surfaces, new config paths added in the future could be missed. The denylist is the pragmatic short-term fix, but the advisory's allowlist recommendation remains the more robust long-term direction. This is a design tradeoff, not a defect — the denylist is appropriate for a security patch, and an allowlist refactor would be a larger behavioral change.

2. **`tools.exec.*` alias fallback not applied to new paths**: `getValueAtPath` falls back from `tools.exec.*` to `tools.bash.*` (line 146-149), but this alias is only triggered for `tools.exec.` prefixed paths. Since the new protected paths don't include `tools.bash.*` variants, a config that uses the legacy `tools.bash.*` naming for non-exec paths would not be caught. However, reviewing the code, this fallback only exists for the historical `tools.exec.*` -> `tools.bash.*` rename, and no new protected paths have a similar alias, so this is not a practical gap.

3. **No test for `tools.exec.*` -> `tools.bash.*` alias under the new guard**: The existing test suite does not verify that a patch using `tools.bash.ask` instead of `tools.exec.ask` is also caught. This is pre-existing (not introduced by this branch) but worth noting as a coverage gap in the guard's test surface.

4. **`PROTECTED_GATEWAY_CONFIG_PATHS_FOR_TEST` export**: Exporting the constant for tests is fine, but it's exported and never actually used in the test file — the tests exercise the guard function directly rather than asserting against the path list. This export is harmless but unnecessary dead code unless future tests will use it.

5. **Type safety of test wrapper**: The `assertGatewayConfigMutationAllowedForTest` wrapper accepts `Record<string, unknown>` for `currentConfig` while the production code casts to `OpenClawConfig` for the dangerous-flags check. This is fine since `collectEnabledInsecureOrDangerousFlags` handles missing keys gracefully, and the tests are intentionally minimal config shapes. No type unsoundness.

6. **Missing coverage for `agents.list[].embeddedPi`**: The protected paths list includes `agents.list[].embeddedPi` but there is no corresponding test case for it. While the bracket-path machinery is tested via `agents.list[].sandbox` and `agents.list[].tools`, a dedicated test for `embeddedPi` would strengthen coverage completeness.

7. **Missing coverage for several non-bracket protected paths**: Some newly protected paths lack direct test cases: `agents.sandbox` (top-level, not under `defaults`), `sandbox` (root-level), `plugins.enabled`, `plugins.allow`, `plugins.deny`, `plugins.installs`, `hooks.token`, `hooks.allowRequestSessionKey`, `hooks.defaultSessionKey`, `hooks.allowedSessionKeyPrefixes`, `hooks.internal.load.extraDirs`, `hooks.transformsDir`, `browser.ssrfPolicy`, `tools.web.fetch.ssrfPolicy`, `mcp.servers`, `tools.subagents` (tested but only for nested `tools.allow`, not for other sub-paths). The test suite covers the most critical attack vectors from the advisory, but not every individual protected path has its own regression test. The framework is in place to add these easily.

8. **Duplicate-id `config.apply` test is good but subtle**: The "blocks config.apply duplicate-id protected rewrites" test (line 231) verifies that an attacker can't sneak a sandbox-off entry past a sandbox-on entry by duplicating an id. This is a thoughtful edge case. The guard compares against `currentConfig`, so even if the last entry in the next config matches the current, the first (changed) entry causes a mismatch in the projected entries list.

### Compliance with Repo Standards (CLAUDE.md / AGENTS.md)

- **Gateway protocol**: The CLAUDE.md states "Gateway protocol changes are contract changes: additive first." This change is purely internal to the guard — no protocol wire format changes, no client follow-through needed. Compliant.
- **Config contract**: "Keep exported types, schema/help, generated metadata, baselines, docs aligned." This change doesn't alter schema or docs; it only hardens the runtime guard. No config docs drift introduced.
- **Security**: "Never commit real phone numbers, videos, credentials, live config." Clean — test data uses obvious placeholder values.
- **Tests**: Colocated `*.test.ts`, Vitest, no timer/env/global leaks, no broad module mocks, no `vi.resetModules()`, uses the actual production function. Follows all test guidelines.
- **Code style**: TypeScript ESM, strict types, no `any`, no `@ts-nocheck`, no lint suppressions, brief comments only for non-obvious logic. The `as` casts in `readProjectedEntries` are minimal and narrowly scoped.
- **File size**: `gateway-tool.ts` grew by ~97 lines. The file was already substantial; this is within the ~700 LOC guideline.
- **No unrelated changes**: The diff is surgically scoped to the guard and its tests. No drive-by refactors, no doc additions, no feature additions.
- **Commit style**: Conventional-ish (`fix(gateway): ...`), concise, each commit addresses a distinct review finding. Clean progression: initial fix -> unkeyed entries -> array order preservation.

### Verdict

This is a well-executed security patch. It directly and completely addresses every attack vector described in GHSA-7jm2-g593-4qrc. The implementation is pragmatic (extends the existing denylist pattern rather than a full allowlist rewrite), properly tested with both positive and negative cases, and surgically scoped. The bracket-path handling for `mergeObjectArraysById` is the most complex addition and it's correctly implemented with appropriate edge-case coverage.

The main follow-up items are: (a) the advisory's long-term recommendation to move to an allowlist model, and (b) adding regression tests for the remaining protected paths that don't yet have dedicated test cases. Neither blocks landing this fix.

[CLAUDE PLAN]

Reviewer: Claude Opus 4.6
Date: 2026-04-20
Branch: fix/gateway-config-guard
Sources: NVIDIA-dev/openclaw-tracking#480 (GHSA-7jm2-g593-4qrc), openclaw/openclaw#69377 (PR comments from Greptile + Codex + eleqtrizit response), [CLAUDE REVIEW] section above.

## Issue Inventory

Seven issues identified across PR review comments, the CLAUDE REVIEW, and the advisory's own remediation guidance. Two Greptile findings (P1 non-string-id bypass, P2 missing `config.apply` coverage) were already addressed in commits `faa55aeb52` and `d4020ea50c`. Five issues remain open.

### Issue 1 — P1, Functional regression: `isProtectedPathEqual` false-positives on benign `agents.list[]` additions

Source: Codex P2 review comment on `d4020ea50c` (`src/agents/tools/gateway-tool.ts:187`).

Problem: `isProtectedPathEqual` projects every `agents.list[]` entry via `readProjectedEntries` and compares the full arrays with `isDeepStrictEqual`. Adding a new agent via `config.patch` (e.g. `{id: "helper", model: "sonnet-4"}` with no sandbox/tools/embeddedPi) appends a projected entry `{id: "helper", value: undefined}` to the next array. The current array is shorter, so `isDeepStrictEqual` returns `false` and the guard rejects the patch as "cannot change protected config paths: agents.list[].sandbox" — even though no protected subfield changed.

The same false positive fires for agent removal or list reordering.

Root cause: The comparison treats list membership and order as protected state, but only the protected subfield values per agent should be protected. The bracket-path convention (`agents.list[].sandbox`) means "the sandbox key inside each entry," not "the array itself."

Hidden scope: This affects all three bracket-path entries: `agents.list[].sandbox`, `agents.list[].tools`, `agents.list[].embeddedPi`. Any `config.patch` that changes `agents.list` membership (add, remove, reorder) is blocked even if no protected subfield is touched.

Fix (in `src/agents/tools/gateway-tool.ts`, `isProtectedPathEqual`):

1. Replace the positional `isDeepStrictEqual` comparison with an id-keyed comparison.
2. For each id present in both current and next projected entries: compare the projected subfield value. If different -> block.
3. For each id present in next but not current (new agent): if the projected subfield value is `undefined` -> allow (no protected subfield set). If defined -> block (new agent carries a protected override).
4. For unkeyed entries (no string id) in next: if the projected subfield value is defined -> block (already handled by current code). If undefined -> allow.
5. For duplicate ids in next: block unconditionally — prevents the bypass described in Codex P1 (first-match vs last-write-wins semantic mismatch between runtime resolution in `src/agents/agent-scope-config.ts` and merge-patch).
6. Entries removed from current -> allow (removal doesn't grant new privileges; the agent falls back to defaults).

Verification:

- Add test: "allows adding a new agent without protected subfields via config.patch" — should pass.
- Add test: "blocks adding a new agent WITH sandbox override via config.patch" — should block.
- Existing tests must continue to pass (especially duplicate-id, id-less injection, per-agent sandbox/tools override).

### Issue 2 — P2, Coverage gap: no test for `agents.list[].embeddedPi`

Source: CLAUDE REVIEW concern #6.

Problem: `PROTECTED_GATEWAY_CONFIG_PATHS` includes `agents.list[].embeddedPi` but the test suite has no case for it.

Fix (in `src/agents/tools/gateway-tool-guard-coverage.test.ts`):
Add a test: "blocks per-agent embeddedPi override under agents.list[]" — current `embeddedPi: false`, patch `embeddedPi: true` -> blocked.

### Issue 3 — P2, Coverage gap: many non-bracket protected paths lack tests

Source: CLAUDE REVIEW concern #7.

Problem: These protected paths have no dedicated regression test: `agents.sandbox`, `sandbox`, `plugins.enabled`, `plugins.allow`, `plugins.deny`, `plugins.installs`, `hooks.token`, `hooks.allowRequestSessionKey`, `hooks.defaultSessionKey`, `hooks.allowedSessionKeyPrefixes`, `hooks.internal.load.extraDirs`, `hooks.transformsDir`, `browser.ssrfPolicy`, `tools.web.fetch.ssrfPolicy`, `mcp.servers`.

Fix (in `src/agents/tools/gateway-tool-guard-coverage.test.ts`):
Add at minimum one test per semantic group:

- `sandbox` (root-level): patch `{sandbox: {mode: "off"}}` -> blocked.
- `plugins.allow`: patch `{plugins: {allow: ["evil-plugin"]}}` -> blocked.
- `hooks.token`: patch `{hooks: {token: "attacker-token"}}` -> blocked.
- `hooks.allowRequestSessionKey`: patch `{hooks: {allowRequestSessionKey: true}}` -> blocked.
- `browser.ssrfPolicy`: patch `{browser: {ssrfPolicy: {dangerouslyAllowPrivateNetwork: true}}}` -> blocked.
- `mcp.servers`: patch `{mcp: {servers: {evil: {command: "nc -e /bin/sh"}}}}` -> blocked.

### Issue 4 — P3, Audit drift: `collectEnabledInsecureOrDangerousFlags` out of sync with `DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS`

Source: GHSA-7jm2-g593-4qrc remediation item #2; confirmed by reading `src/security/dangerous-config-flags.ts` and `src/agents/sandbox/config.ts:31-35`.

Problem: `DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS` lists three flags (`dangerouslyAllowReservedContainerTargets`, `dangerouslyAllowExternalBindSources`, `dangerouslyAllowContainerNamespaceJoin`). None appear in `collectEnabledInsecureOrDangerousFlags`. This does NOT create a guard bypass (those paths are protected by `agents.defaults.sandbox` in `PROTECTED_GATEWAY_CONFIG_PATHS`), but `openclaw security audit` under-reports dangerous flags to operators.

Additional missing flags per the advisory: `tools.fs.workspaceOnly=false`, `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork=true`, `hooks.allowRequestSessionKey=true`.

Fix (in `src/security/dangerous-config-flags.ts`):

1. Add sandbox docker dangerous booleans. Iterate `agents.defaults.sandbox.docker` and per-agent `agents.list[].sandbox.docker` for each key in `DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS`. Import the constant from `src/agents/sandbox/config.ts` to keep the two lists in sync.
2. Add `tools.fs.workspaceOnly === false` check (parallel to existing `tools.exec.applyPatch.workspaceOnly`).
3. Add `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork === true` check.
4. Add `hooks.allowRequestSessionKey === true` check.

Verification: Run existing tests for the flag enumerator. Add unit tests that assert each new flag is reported.

### Issue 5 — P3, Dead code: unused `PROTECTED_GATEWAY_CONFIG_PATHS_FOR_TEST` export

Source: CLAUDE REVIEW concern #4.

Problem: `PROTECTED_GATEWAY_CONFIG_PATHS_FOR_TEST` is exported at `gateway-tool.ts:77` but never imported in the test file.

Fix: Either remove the export, or add a snapshot-style assertion on the list length/contents as a drift guard that fails when a path is added to production but not to the test suite. The latter is more useful.

### Issue 6 — P3, Pre-existing: no test for `tools.exec.*` -> `tools.bash.*` alias

Source: CLAUDE REVIEW concern #3.

Problem: `getValueAtPath` (`gateway-tool.ts:141-149`) falls back from `tools.exec.*` to `tools.bash.*` when the canonical path returns `undefined`. No test verifies this alias, so a regression in the fallback could silently bypass the original six `tools.exec.*` protected paths.

Fix (in `src/agents/tools/gateway-tool-guard-coverage.test.ts`):
Add test: "blocks tools.bash.ask alias for tools.exec.ask" — current `{tools: {bash: {ask: "always"}}}`, patch `{tools: {bash: {ask: "never"}}}` -> blocked.

### Issue 7 — Architectural (future): denylist -> allowlist migration

Source: GHSA-7jm2-g593-4qrc remediation item #3, CLAUDE REVIEW concern #1.

Not a fix for this PR. The advisory recommends replacing the denylist with an allowlist — only permit `config.patch`/`config.apply` to change a documented, narrow "safe for agent to tune" set of paths (e.g. `agents.defaults.prompt`, `agents.defaults.model`, `agents.list[].model`, `agents.list[].prompt`). All other paths rejected by default. More robust against new config paths added without guard coverage.

Tracked as future work. The current denylist (33 paths) is comprehensive against all known attack surfaces. An allowlist refactor is a larger behavioral change that should be scoped separately.

## Execution Order

1. Issue 1 first — it is the only remaining P1 and changes `isProtectedPathEqual` in the production guard. All other issues layer on top.
2. Issues 2, 3, 5, 6 together — pure test additions/cleanup, no production code changes, can be one commit.
3. Issue 4 — production change to `dangerous-config-flags.ts` plus its own tests, separate commit.
4. Issue 7 — separate tracking issue, not this branch.

## Validation

[CODEX COMMENTS RESOLUTION]

- Reviewed NVIDIA-dev/openclaw-tracking#480, PR `openclaw/openclaw#69377`, `USER.md`, and all PR review threads/comments.
- Confirmed the repeat-review loop was caused by one still-open Codex thread on `src/security/dangerous-config-flags.ts`: per-agent dangerous sandbox flags were rendered with array indexes, so `gateway` guard set-diffing could misread a reorder-only `config.apply` as a newly enabled dangerous flag.
- Updated `src/security/dangerous-config-flags.ts` to emit stable per-agent dangerous-flag keys keyed by agent id when present, leaving index fallback only for unkeyed entries.
- Added regression coverage in `src/security/dangerous-config-flags.test.ts` for stable id-based rendering and updated existing expectations accordingly.
- Added regression coverage in `src/agents/tools/gateway-tool-guard-coverage.test.ts` proving `config.apply` can reorder agents without tripping the dangerous-flag diff when an existing dangerous per-agent sandbox flag is already enabled.
- Validation: `corepack pnpm test src/security/dangerous-config-flags.test.ts src/agents/tools/gateway-tool-guard-coverage.test.ts`; `corepack pnpm format:check src/security/dangerous-config-flags.ts src/security/dangerous-config-flags.test.ts src/agents/tools/gateway-tool-guard-coverage.test.ts`.
- Comment-loop summary: Greptile's earlier threads were resolved and its latest summary was merge-positive. Codex kept commenting because the previous `@codex review` retrigger landed on commit `bd9e303789`, where the unstable index-based dangerous-flag diff bug was still present and unresolved.

[CODEX]

- Reviewed NVIDIA-dev/openclaw-tracking#480 comments and openclaw/openclaw#69377 review state.
- Confirmed the only remaining open PR thread was Codex feedback on `agents.list[]` protected-path comparison; the branch now fixes that regression by comparing protected subfields by agent id, allowing benign add/remove/reorder operations while still blocking duplicate ids, unkeyed protected entries, and protected overrides on new agents.
- Added regression coverage for the remaining review gaps in `src/agents/tools/gateway-tool-guard-coverage.test.ts`, including `agents.list[].embeddedPi`, root sandbox, hooks token/session-key, browser SSRF policy, MCP servers, and benign agent membership changes.
- Synced `src/security/dangerous-config-flags.ts` with sandbox/browser/hooks/fs dangerous-flag reporting and added focused tests in `src/security/dangerous-config-flags.test.ts`.
- Validation: `corepack pnpm test src/agents/tools/gateway-tool-guard-coverage.test.ts`, `corepack pnpm test src/security/dangerous-config-flags.test.ts`, `corepack pnpm format:check src/agents/tools/gateway-tool.ts src/agents/tools/gateway-tool-guard-coverage.test.ts src/security/dangerous-config-flags.ts src/security/dangerous-config-flags.test.ts`.

After all fixes:

- `pnpm test src/agents/tools/gateway-tool-guard-coverage.test.ts` — all tests pass.
- `pnpm test src/security` — dangerous-config-flags tests pass.
- `pnpm check:changed` — core prod typecheck + core tests + lint green.
- `pnpm format:check` on all touched files.
- Manual review: re-check that the five advisory reproduction vectors (sandbox disable, plugin enable, fs hardening clear, namespace join, HTTP tool allow) are still blocked after Issue 1 refactor.

[CODEX SUMMARY]

- Read `USER.md`, `src/agents/AGENTS.md`, issue `NVIDIA-dev/openclaw-tracking#480`, and the current branch implementation before changing code.
- Verified Claude's main P1 finding was correct: the new `agents.list[]` protected-path comparison in `src/agents/tools/gateway-tool.ts` compared projected arrays positionally, so benign membership/order changes could be rejected even when no protected subfield changed.
- Fixed that guard bug in `src/agents/tools/gateway-tool.ts` by comparing bracket-path entries by agent id instead of array position. Current behavior now:
  - existing ids must keep the same protected subfield value
  - new ids are allowed only when the protected subfield is absent
  - removals and pure reorders are allowed
  - duplicate ids in the next config and id-less entries carrying protected values are still blocked
- Verified Claude's audit-drift finding was also correct: `src/security/dangerous-config-flags.ts` did not report the dangerous sandbox docker booleans from `DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS`, and also missed `tools.fs.workspaceOnly=false`, `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork=true`, and `hooks.allowRequestSessionKey=true`. Added all of those checks and reused the shared sandbox-key constant to keep the lists aligned.
- Expanded regression coverage in `src/agents/tools/gateway-tool-guard-coverage.test.ts`:
  - used `PROTECTED_GATEWAY_CONFIG_PATHS_FOR_TEST` so the test-only export is no longer dead
  - added missing protected-path coverage for `agents.list[].embeddedPi`, root `sandbox`, `plugins.allow`, `hooks.token`, `hooks.allowRequestSessionKey`, `browser.ssrfPolicy`, and `mcp.servers`
  - added the missing behavioral regression cases that prove benign agent add/remove/reorder flows are allowed while new protected overrides are still blocked
- Expanded `src/security/dangerous-config-flags.test.ts` to assert the newly enumerated dangerous flags are reported.
- Validation run locally:
  - `corepack pnpm test src/agents/tools/gateway-tool-guard-coverage.test.ts`
  - `corepack pnpm test src/security/dangerous-config-flags.test.ts`
  - `corepack pnpm test src/agents/openclaw-gateway-tool.test.ts`
  - `corepack pnpm format:check src/agents/tools/gateway-tool.ts src/agents/tools/gateway-tool-guard-coverage.test.ts src/security/dangerous-config-flags.ts src/security/dangerous-config-flags.test.ts`
- I did not implement the broader allowlist redesign from Claude's note. That remains future hardening, not required to make this branch correct for the current advisory fix.
