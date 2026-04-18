# Codebase Concerns

**Analysis Date:** 2026-04-18

This audit focuses on structural risk, fragile coupling, and missing guardrails. The repo is unusually well-instrumented (82 vitest configs, ~2,700 src tests, strict boundary lints, drift hashes for every contract surface), so most "concerns" are systemic — tradeoffs inherent to the scale — rather than acute bugs.

## Oversized Files (LOC guideline breaches)

The `.claude/rules/coding-style.md` guideline is "~700 LOC per file". The following production files are 2–3× over budget and concentrate a lot of behavior that is hard to test in isolation:

| File                                             |   LOC | Risk                                                                                                                                                                                  |
| ------------------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/pi-embedded-runner/run/attempt.ts`   | 2,421 | Core agent-attempt loop; compaction + provider call + retry logic fused.                                                                                                              |
| `src/gateway/server-methods/chat.ts`             | 2,384 | WS `chat` method. Many branches (abort, directive-tags, parent-id, attachments). Already split into helpers (`chat.abort-*`, `chat.inject.parentid.test.ts`) but the hub stays large. |
| `src/acp/control-plane/manager.core.ts`          | 2,221 | ACP control-plane state machine.                                                                                                                                                      |
| `src/plugins/loader.ts`                          | 2,212 | Plugin discovery + activation + install orchestration.                                                                                                                                |
| `src/plugins/types.ts`                           | 2,020 | Central type catalog; changes ripple everywhere.                                                                                                                                      |
| `src/tasks/task-registry.ts`                     | 2,017 | Task registry + executor coordination.                                                                                                                                                |
| `src/cli/capability-cli.ts`                      | 1,874 | Capability subcommand surface.                                                                                                                                                        |
| `src/config/io.ts`                               | 1,813 | Config load/save/migrate.                                                                                                                                                             |
| `src/agents/bash-tools.exec.ts`                  | 1,786 | Bash tool execution + sandbox integration.                                                                                                                                            |
| `src/agents/pi-embedded-runner/run.ts`           | 1,779 | Agent run orchestration.                                                                                                                                                              |
| `src/gateway/server-methods/sessions.ts`         | 1,656 | WS `sessions` method.                                                                                                                                                                 |
| `src/config/zod-schema.providers-core.ts`        | 1,631 | Provider schema fan-out.                                                                                                                                                              |
| `src/channels/plugins/setup-wizard-helpers.ts`   | 1,627 | Channel wizard logic.                                                                                                                                                                 |
| `src/auto-reply/reply/agent-runner-execution.ts` | 1,572 | Reply delivery orchestration.                                                                                                                                                         |

Impact: each file touches many subsystems, so even targeted refactors trigger broad test reruns and increase merge-conflict surface across concurrent agents.

Fix approach: keep splitting into narrower `*.helper.ts` + `*.runtime.ts` files (same pattern already used for chat abort helpers). Land behind the existing drift-hash gates so public contracts remain stable.

## Generated Config Schemas Shipped in `src/`

- `src/config/schema.base.generated.ts` — 27,264 LOC.
- `src/config/bundled-channel-config-metadata.generated.ts` — 16,106 LOC.

These are authoritatively regenerated by `pnpm config:schema:gen` / `pnpm config:channels:gen`, but because they live under `src/` they are still type-checked and imported by production code. Risk: drift between the `.generated.ts` file and the `.sha256` hash is caught by CI, but a forgotten `--write` locally means large diff-noise PRs. Fix approach is already in place via `check:base-config-schema` and `check:bundled-channel-config-metadata` in `pnpm check`; keep those wired into `release:check`.

## Gateway Protocol Is a Wide, Load-Bearing Contract

`src/gateway/protocol/` defines the wire format between every client (CLI, macOS app, iOS, Android, WebChat) and the daemon. The schema spans 21 files in `src/gateway/protocol/schema/` plus `src/gateway/protocol/schema.ts` + `index.ts`. Every method gets an Ajv validator (`src/gateway/protocol/index.ts:1-50`) and a matching Swift codegen output at `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift` + `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`.

Risks:

- Any additive change must roundtrip `pnpm protocol:gen` + `pnpm protocol:gen:swift` and keep tests green in three repos' worth of clients.
- Incompatible changes require explicit versioning (documented in `src/gateway/protocol/CLAUDE.md`).
- Swift codegen runs in node/tsx — if the script breaks, iOS/macOS clients silently fall out of sync until `pnpm protocol:check` fails on the next PR.

Fix approach: treat protocol edits as contract edits, not refactors. `.claude/rules/architecture-boundaries.md` covers this; the risk is discipline, not tooling.

## Bundled Plugin Fan-Out

`extensions/` contains ~95 bundled packages, each with its own `package.json`, `openclaw.plugin.json`, local `api.ts` / `runtime-api.ts` barrels, and per-package Vitest config (`test/vitest/vitest.extension-<id>.config.ts` — there are 25+ of these). Concerns:

- **Dependency sprawl.** Each plugin brings its own deps. `pnpm install` manages this via `pnpm-workspace.yaml:1-5`, but audit surface is large. Mitigation: `lint:plugins:no-monolithic-plugin-sdk-entry-imports` and `minimumReleaseAge: 2880` with a tight allowlist (`pnpm-workspace.yaml:7-29`).
- **Boundary drift.** Without the `pnpm check:*` + `check-additional` CI lanes, it is easy to reach into `src/**` from a plugin. Currently policed by `lint:extensions:no-plugin-sdk-internal`, `lint:extensions:no-relative-outside-package`, `lint:extensions:no-src-outside-plugin-sdk`.
- **Per-plugin Vitest configs duplicate glob/pool logic.** A helper (`test/vitest/vitest.bundled-plugin-paths.ts`) exists but each plugin still has its own config.

## Auth / Secrets Fragility

- `src/entry.ts:22-30` flips `OPENCLAW_AUTH_STORE_READONLY=1` based on `argv.includes("secrets audit")`. Control-flow-by-argv-sniffing is fragile; a subcommand rename or aliasing would silently lose the read-only guarantee. Safer approach: plumb through the command-registration pipeline in `src/cli/program.ts`.
- Secret resolution lives under `src/secrets/` with a lot of runtime-auth glue (`runtime-auth-collectors.ts`, `runtime-auth-store-inline-refs.test.ts`, `runtime-auth-refresh-failure.test.ts`). Historic failures captured in `MEMORY.md` include token refresh regressions, Vertex OAuth vs. API-key confusion, and stale `ya29` tokens. Coverage is now strong, but the auth surface is inherently multi-provider and multi-auth-type (`reference_openclaw_api_type_auth_matrix.md`).
- `Never commit or publish real phone numbers, videos, or live configuration values` (`.claude/rules/security-config.md`). Enforced by reviewer discipline, not by tooling — a potential leak vector if contributor follows a bad example.

## Gateway Runtime Hotspots

From `MEMORY.md` + recent history on branch `fix/gateway-agent-run-starts-prune`:

- **`agentRunStarts` listener leak** — fixed on current branch (`cffca85d98 Gateway: prune orphaned agentRunStarts entries`) but the broader pattern of "map-of-listeners keyed by runId" exists in several gateway server-methods. Any handler that adds to a shared map without a finally-cleanup risks the same drift.
- **Heartbeat overlay guidance** (`f5447aab88 OpenAI: strengthen heartbeat overlay guidance`) — overlay/heartbeat fragility is a recurring theme in WS clients. Rule: inbound debounce + typing-start guard + status reactions must all agree on the same lifecycle (`src/channels/inbound-debounce-policy.ts`, `src/channels/typing-start-guard.ts`, `src/channels/status-reactions.ts`).
- **Streaming to external channels** — `.claude/rules/collaboration-safety.md` forbids streaming partial replies to WhatsApp/Telegram. This is policed manually; a check-lint (like `lint:tmp:no-raw-channel-fetch`) that grepped for `stream:true` into external channels would harden it.

## Complex Exec Surface

`src/agents/bash-tools.exec.ts:1786` + `src/process/exec*.ts` + `src/cli/container-target.ts` + `src/daemon/schtasks.ts` + `src/daemon/launchd.*` form a multi-platform exec surface spanning macOS, Linux, Windows (via WSL2), and containers. Risks:

- 20+ files in `src/` directly use `execSync` / `spawnSync` / `shell:true` — concentrated in infra/process code but the blast radius is broad.
- Windows/macOS/Linux-specific branches are multiplied by the launchd / schtasks / brew / build-stamp glue.
- Sandbox vs. non-sandbox semantics for non-main agents are policy-driven (`project_sandbox_workspace_access_2026_04_17.md`: "non-main sandbox was RO by default; flipped to rw so Gemini can create new skills"). Setting regressions here are user-visible and hard to catch in unit tests.

Mitigation: heavy integration coverage (`src/docker-setup.e2e.test.ts`, `src/infra/run-node.test.ts`, `src/daemon/launchd.integration.e2e.test.ts`, VM smoke via `test:parallels:*`). Missing: static policy check for new `shell:true` usages outside approved modules.

## Swift / macOS / iOS / Android Surface

- The macOS app has a separate Swift codebase (`apps/macos/`, `apps/shared/OpenClawKit/`) that consumes codegen from `pnpm protocol:gen:swift`. If codegen diverges, the Swift build breaks but not TS CI. `.github/workflows/macos-release.yml` handles CI there.
- `.claude/rules/local-runtime-platform.md` notes "SwiftUI: prefer Observation over ObservableObject" and "don't rebuild the macOS app over SSH" — platform rules that aren't lintable.
- iOS signing / notary keys live outside the repo (private maintainer docs); agent-safe but adds onboarding friction.
- Android has two flavors (Play, ThirdParty) with different Gradle targets; easy to forget the third-party build.

## Patch Surface

- `patches/` is empty except `.gitkeep`. `pnpm.patchedDependencies` requires exact versions with no `^`/`~` (`.claude/rules/collaboration-safety.md`), and patches need explicit approval. This is good hygiene but means any future patch reintroduces a maintenance burden (the axios pin override at `package.json:1458-1460` is the current global pin).

## Release / Publish Footguns

Captured in `.claude/rules/collaboration-safety.md` and `.claude/rules/security-config.md`:

- `@buape/carbon` pin is owner-only (verified via `gh` against Shadow/@thewilloftheshadow).
- Beta npm publish must match beta git tag suffix or npm "consumes" the plain version.
- Version bump touches many places: `package.json`, three `Info.plist`, `build.gradle.kts`, `docs/install/updating.md`, Peekaboo projects.
- `appcast.xml:1` only changes on a real macOS Sparkle release.
- `ios:version:check` / `ios:version:sync` exist precisely because this used to drift.

Risk: a partial bump ships inconsistent versions. Mitigation: the release playbook in `$openclaw-release-maintainer` skill.

## Sandbox Dockerfiles

Three separate Dockerfiles (`Dockerfile`, `Dockerfile.sandbox`, `Dockerfile.sandbox-browser`, `Dockerfile.sandbox-common`). `docker-compose.yml:1` references them. Risks:

- Duplicate base-image setup across files (partially mitigated by `Dockerfile.sandbox-common`).
- Browser sandbox (Playwright) image is large and slow to rebuild; `test:docker:*` suites rely on prebuilt images.
- `setup-podman.sh:1` adds another container runtime path — easy to drift between Docker and Podman semantics.

## Documentation Dual-Surface

- `docs/` in this repo is the Mintlify source of truth for English.
- Translated docs live in a sibling repo `openclaw/docs` (per `docs/CLAUDE.md`).
- Glossary + `docs/.i18n/*.tm.jsonl` translation memory live in the publish repo, not here.

Risk: doc edits here can land without the sibling i18n pipeline being regenerated. `pnpm docs:check-i18n-glossary` catches missing glossary terms in this repo, but the publish-repo step is out of band.

## Multi-Agent Working Tree Hazards

`.claude/rules/collaboration-safety.md` explicitly assumes multiple AI agents may be editing simultaneously. Rules: no `git stash`, no worktree changes, no unsolicited branch switches. Risk is procedural — not codified in hooks — and depends on each agent respecting the rules.

## Test Execution Fragility

- `.claude/rules/testing-guidelines.md` lists the trap of `vi.resetModules()` + `await import(…)` in `beforeEach` creating 10x slowdowns. Enforced by review only.
- Vitest worker count is host-aware by default but still bounded at 16. Memory pressure can force `OPENCLAW_VITEST_MAX_WORKERS=1`.
- `--isolate=false` is the fast default; any test that leaks timers / env / mocks / sockets / temp dirs / module state will make the whole suite flaky.

## Missing Static Guards (gap analysis)

Areas that have a documented rule but no corresponding automated check in `pnpm check` (candidates for future lint scripts):

- **No streaming to external messaging channels** (`.claude/rules/collaboration-safety.md` "Messaging & Release Safety"). Could be a grep-lint for `reply*(...stream*)` → known channel ids.
- **No freeform-string runtime branches** (`.claude/rules/coding-style.md`). Enforcing this globally is hard, but a local ESLint/Oxlint rule for `switch (error.reason)` on a `reason: string` would help.
- **No prototype mutation in production code** outside approved files. Could grep for `.prototype.` assignments in `src/**/*.ts` excluding test files.
- **Prompt-cache determinism** — there is a rule (`.claude/rules/prompt-cache-stability.md`) but no automated invariant test beyond per-change regression tests. A property-based test over the payload assembler would catch silent re-ordering regressions.

## Known-Good Protections Worth Keeping

To put the above in context, these guardrails are already strong and should not regress:

- `pnpm check` + `check-additional` pipeline with ~20 custom lints.
- 70% coverage floor with V8 coverage in `test:coverage`.
- Drift hashes (`.sha256`) for protocol, config schema, plugin SDK API, bundled channel config, runtime sidecars, tool-display.
- `pnpm.overrides`, `pnpm-workspace.yaml:minimumReleaseAge`, `onlyBuiltDependencies` allowlist — supply-chain hygiene.
- `prek` pre-commit + `FAST_COMMIT=1` escape hatch with explicit guidance on when to use it.
- Scoped `AGENTS.md` + `CLAUDE.md` per boundary directory (gateway/protocol, plugin-sdk, channels, plugins, extensions, test helpers, docs, ui, scripts).

---

_Concerns audit: 2026-04-18_
