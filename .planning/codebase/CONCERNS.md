# Codebase Concerns

**Analysis Date:** 2026-03-08

## Tech Debt

**Oversized Source Files (123 files exceed 700 LOC guideline):**
- Issue: 123 non-test `.ts` files exceed the project's own ~700 LOC guideline (CLAUDE.md says ~500 preferred). The top offenders are well above 1500 LOC.
- Files:
  - `src/memory/qmd-manager.ts` (2246 LOC)
  - `src/commands/doctor-config-flow.ts` (2122 LOC)
  - `src/agents/pi-embedded-runner/run/attempt.ts` (2080 LOC)
  - `src/discord/monitor/native-command.ts` (1848 LOC)
  - `src/agents/tools/web-search.ts` (1845 LOC)
  - `src/discord/monitor/agent-components.ts` (1789 LOC)
  - `src/telegram/bot-handlers.ts` (1565 LOC)
  - `src/config/schema.help.ts` (1559 LOC)
  - `src/agents/pi-embedded-runner/run.ts` (1497 LOC)
  - `src/config/zod-schema.providers-core.ts` (1479 LOC)
  - `src/agents/subagent-announce.ts` (1479 LOC)
  - `src/agents/subagent-registry.ts` (1450 LOC)
  - `src/agents/models-config.providers.ts` (1424 LOC)
  - `src/config/io.ts` (1415 LOC)
  - `src/security/audit-extra.sync.ts` (1349 LOC)
  - `src/acp/control-plane/manager.core.ts` (1343 LOC)
- Impact: Large files are harder to maintain, test, and review. They accumulate more merge conflicts and are harder for agents to reason about.
- Fix approach: Extract logical sub-modules. The agent runner (`run/attempt.ts`, `run.ts`), Discord/Telegram handlers, and config/schema files are prime candidates for splitting into focused modules.

**Stale Fallback Gateway Context:**
- Issue: The fallback gateway context captured at startup can become stale if runtime config changes. Documented as a TODO in the source.
- Files: `src/gateway/server-plugins.ts:44`
- Impact: Channel adapters (Telegram polling, etc.) that bypass WS may use outdated config/plugin state.
- Fix approach: Use a lazy getter or `AsyncLocalStorage` to always read current context instead of caching a startup snapshot.

**Deprecated APIs Still Present:**
- Issue: Multiple deprecated functions, CLI options, and auth flows remain in the codebase.
- Files:
  - `src/agents/pi-auth-json.ts` (legacy auth bridge)
  - `src/agents/pi-tools.schema.ts:202` (deprecated normalizer)
  - `src/agents/pi-embedded-runner/history.ts:112` (deprecated history helper)
  - `src/auto-reply/reply/session-reset-prompt.ts:20` (deprecated prompt builder)
  - `src/cli/cron-cli/register.cron-add.ts:89` (`--deliver` deprecated for `--announce`)
  - `src/cli/plugins-cli.ts:589` (`--keep-config` deprecated for `--keep-files`)
  - `src/commands/auth-choice-legacy.ts` (entire file is deprecated bridge)
- Impact: Maintenance burden; confusing for contributors.
- Fix approach: Audit each deprecated item's usage, remove those with zero callers, and add migration-period deadlines for the rest.

**Extensive pnpm Overrides:**
- Issue: 14 dependency overrides in `package.json` force specific versions of transitive deps (hono, fast-xml-parser, request, form-data, minimatch, qs, tar, tough-cookie, etc.).
- Files: `package.json:421-435`
- Impact: These overrides must be manually maintained. If upstream packages update their version ranges, the overrides may mask breakage or block upgrades. Security patches in overridden packages require manual intervention.
- Fix approach: Periodically audit each override to determine if the root cause (vulnerable transitive dep, API incompatibility) has been resolved upstream.

**Global State via Symbol.for Singletons:**
- Issue: 16 `Symbol.for(...)` singletons store mutable state on `globalThis` to share state across module boundaries.
- Files:
  - `src/gateway/server-plugins.ts` (fallback gateway context)
  - `src/agents/session-write-lock.ts` (lock state, watchdog)
  - `src/acp/runtime/registry.ts` (ACP runtime registry)
  - `src/plugins/runtime.ts` (plugin registry)
  - `src/hooks/internal-hooks.ts` (internal hooks singleton)
  - `src/infra/fetch.ts` (fetch wrapper marker)
  - `src/infra/warning-filter.ts` (warning filter)
  - `src/plugin-sdk/file-lock.ts` (file lock state)
  - `src/cli/program/program-context.ts` (CLI context)
  - `src/discord/monitor/thread-bindings.state.ts` (thread binding registry)
- Impact: Global mutable state makes unit testing harder (leaks between tests), prevents clean module isolation, and introduces subtle ordering dependencies.
- Fix approach: Where possible, pass state via dependency injection or `AsyncLocalStorage` rather than global singletons.

## Security Considerations

**Dynamic Code Execution in Browser Tools:**
- Risk: `new Function(...)` and `eval(...)` are used to execute user-provided JavaScript in browser automation contexts.
- Files: `src/browser/pw-tools-core.interactions.ts:302-339`
- Current mitigation: Runs within Playwright's browser sandbox; eslint suppression comments acknowledge the pattern. The code constructs functions from `fnBody` strings passed by agent tool calls.
- Recommendations: Ensure the browser sandbox is the only execution context for these evaluations. Document the trust boundary clearly. Never allow this pattern to execute outside a sandboxed browser page.

**Sync File I/O in Production Paths:**
- Risk: 117 uses of `readFileSync`/`writeFileSync` in non-test code can block the event loop during file operations.
- Files: Spread across `src/agents/`, `src/config/`, `src/browser/`, `src/auto-reply/`, `src/channels/`, `src/memory/`
- Current mitigation: Many are in initialization paths or low-frequency operations.
- Recommendations: Audit sync I/O in hot paths (agent execution, message handling) and convert to async equivalents where blocking could impact gateway responsiveness.

## Performance Bottlenecks

**Large Configuration Schema:**
- Problem: Provider config schemas (`src/config/zod-schema.providers-core.ts`, 1479 LOC) and help text (`src/config/schema.help.ts`, 1559 LOC) are monolithic.
- Files:
  - `src/config/zod-schema.providers-core.ts`
  - `src/config/schema.help.ts`
  - `src/config/io.ts` (1415 LOC)
- Cause: All providers defined in a single schema file; all help text in one file. Config I/O handles many edge cases in one module.
- Improvement path: Split by provider or provider-group. Lazy-load help text.

**Memory Pressure from Test Workers:**
- Problem: Vitest tests can cause memory pressure; the project has documented mitigations (`OPENCLAW_TEST_PROFILE=low`).
- Files: `vitest.config.ts`, CLAUDE.md testing guidelines
- Cause: Large test suite (1854 test files), forked worker pool, 120-second test timeouts.
- Improvement path: Already mitigated with worker caps (max 16) and low-profile env vars. Further gains from reducing test file sizes and improving isolation.

## Fragile Areas

**Agent Runner Pipeline:**
- Files:
  - `src/agents/pi-embedded-runner/run/attempt.ts` (2080 LOC)
  - `src/agents/pi-embedded-runner/run.ts` (1497 LOC)
  - `src/agents/pi-embedded-runner/compact.ts`
  - `src/agents/pi-embedded-runner/extra-params.ts` (1327 LOC)
- Why fragile: The core agent execution pipeline spans multiple large files with complex state management (compaction, overflow handling, tool loops, session write locks). Race conditions around compaction are explicitly documented (`attempt.ts:1794`).
- Safe modification: Always run the full test suite. Changes to `attempt.ts` or `run.ts` should be accompanied by integration tests. Consult the compaction safeguard tests in `src/agents/pi-extensions/compaction-safeguard.test.ts`.
- Test coverage: Some coverage, but the runner modules are excluded from V8 coverage thresholds (see `vitest.config.ts` exclude list).

**Channel Adapters (Discord, Telegram, Slack):**
- Files:
  - `src/discord/monitor/native-command.ts` (1848 LOC)
  - `src/discord/monitor/agent-components.ts` (1789 LOC)
  - `src/discord/components.ts` (1149 LOC)
  - `src/telegram/bot-handlers.ts` (1565 LOC)
  - `src/telegram/send.ts` (1269 LOC)
  - `src/slack/monitor/events/interactions.test.ts` (1489 LOC)
- Why fragile: Each channel adapter is a large, tightly-coupled module. Platform API changes or message format changes can break them in non-obvious ways. Multiple channels must be kept in sync for shared logic (routing, allowlists, pairing, commands).
- Safe modification: Follow CLAUDE.md guidance to consider all channels when refactoring shared logic. Test changes against platform-specific test suites.
- Test coverage: Channel modules are excluded from coverage thresholds; rely on manual/e2e testing.

**Config I/O and Migrations:**
- Files:
  - `src/config/io.ts` (1415 LOC)
  - `src/infra/state-migrations.ts` (1052 LOC)
- Why fragile: Config serialization/deserialization handles many edge cases and backward compatibility. State migrations must be additive and never lose user data.
- Safe modification: Add new migration entries at the end. Never reorder or modify existing migrations. Test with real config files when possible.
- Test coverage: Config I/O has some test coverage but state migrations are excluded from thresholds.

## Test Coverage Gaps

**Massive Coverage Exclusion List:**
- What's not tested: The `vitest.config.ts` coverage configuration excludes 64 specific `src/` paths from coverage thresholds, including entire directories: `src/cli/`, `src/commands/`, `src/agents/`, `src/channels/`, `src/gateway/`, `src/discord/`, `src/telegram/`, `src/slack/`, `src/signal/`, `src/imessage/`, `src/browser/`, `src/plugins/`, `src/providers/`, `src/acp/`, `src/tui/`, `src/wizard/`.
- Files: `vitest.config.ts:113-200`
- Risk: The stated 70% line/function threshold only applies to the small subset of `src/` not excluded. Most of the application's core surface area (gateway, channels, agents, CLI) is not measured. Regressions in excluded modules may go unnoticed.
- Priority: Medium -- the project uses e2e, live, and manual testing for these modules, but the gap means automated regression detection is limited.

**Extensions with Zero Tests:**
- What's not tested: 9 extensions have zero test files: `copilot-proxy`, `device-pair`, `memory-core`, `minimax-portal-auth`, `open-prose`, `qwen-portal-auth`, `shared`, `talk-voice`, `test-utils`.
- Files: `extensions/copilot-proxy/`, `extensions/device-pair/`, `extensions/memory-core/`, `extensions/minimax-portal-auth/`, `extensions/open-prose/`, `extensions/qwen-portal-auth/`, `extensions/shared/`, `extensions/talk-voice/`, `extensions/test-utils/`
- Risk: These extensions have no automated regression detection at all. Changes to them or their dependencies may break silently.
- Priority: Low -- most are small (1-3 source files) or utility packages (`shared`, `test-utils`).

**Source Files Without Co-located Tests:**
- What's not tested: 1727 out of 2807 non-test source files (61%) do not have a co-located `.test.ts` file.
- Risk: While some of these files are covered by integration tests or tests in other files, the gap is large. The `all: false` coverage setting means only files imported by tests are measured at all.
- Priority: Medium -- focus new test coverage on the agent runner pipeline, gateway methods, and config I/O.

## Dependencies at Risk

**pnpm Override Dependencies:**
- Risk: The `request` package is overridden with `@cypress/request` (a fork) and `request-promise` with `@cypress/request-promise`. The original `request` package is deprecated.
- Impact: If `@cypress` stops maintaining their fork, these transitive deps become unmaintained.
- Migration plan: Identify which packages still depend on `request` and replace them with modern HTTP clients.

**Carbon Dependency (Never Update):**
- Risk: CLAUDE.md explicitly states "Never update the Carbon dependency." This pins a dependency to a potentially vulnerable version indefinitely.
- Impact: Security patches for Carbon will not be applied unless the rule is revisited.
- Migration plan: Document why Carbon is pinned; periodically assess if the pin is still necessary.

## Scaling Limits

**Extension Count Growth:**
- Current capacity: 40 extensions in `extensions/` directory.
- Limit: As extensions grow, the monorepo build/test/install time increases. The `vitest.config.ts` plugin-SDK alias list must be manually updated for each new extension subpath export.
- Scaling path: Consider automated alias generation from workspace packages. Evaluate whether some extensions should be extracted to separate repos.

**Global Symbol Registry:**
- Current capacity: 16 `Symbol.for` singletons.
- Limit: Each singleton adds implicit coupling. New modules adding `Symbol.for` entries create hidden dependencies that are hard to trace.
- Scaling path: Adopt an explicit dependency injection container or module-scoped state with `AsyncLocalStorage`.

---

*Concerns audit: 2026-03-08*
