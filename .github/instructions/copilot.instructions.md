# OpenClaw Copilot Instructions

> OpenClaw is a **self-hosted AI agent gateway** (Node 22+, TypeScript ESM).
> It is an orchestration platform, not a chatbot wrapper.
> Every suggestion must be production-grade, security-conscious, and aligned with the architecture below.
> For repo structure, build commands, commit conventions, and ops — see `AGENTS.md` (loaded alongside this file).

---

## 1. Architecture Mental Model

```
Messaging Platforms (WhatsApp / Telegram / LINE / Discord / Slack / Signal / ...)
        ↓
  Gateway (WS control plane, ws://127.0.0.1:18789, REST /api)
    → Channel Layer (normalize platform messages)
    → Session Manager (per-agent, serial execution)
    → Agent Runtime (LLM + Tools)
    → Pi RPC · CLI · WebChat UI · macOS/iOS
        ↓
  External APIs · Filesystem · Browser (CDP) · ClawHub Skills
```

| Subsystem           | Critical Constraint                                                   |
| ------------------- | --------------------------------------------------------------------- |
| **Gateway**         | One per host; sessions serialized per lane                            |
| **Channel Layer**   | Platform-agnostic internal struct; never leak platform types upstream |
| **Agent Runtime**   | Idempotency keys required on all side-effecting calls                 |
| **Session Manager** | Serial execution per session — never parallelize within a session     |
| **Skills**          | Loaded from `~/clawd/skills/<name>/SKILL.md`; no restart required     |
| **Command Queue**   | Serializes agent work; do not bypass                                  |

---

## 2. Tech Stack

- **Runtime**: Node 22+ (Bun for dev/scripts). Never suggest Node < 22.
- **Package manager**: pnpm exclusively (keep `pnpm-lock.yaml` in sync).
- **Language**: TypeScript (strict mode, ESM). All new files `.ts`.
- **Lint/Format**: Oxlint + Oxfmt (`pnpm check`). Never disable rules inline without a comment.
- **Tests**: Vitest + V8 coverage (`pnpm test`).
- **CLI**: Commander + clack/prompts.
- **Build**: tsdown → `dist/`. Never commit compiled output to `src/`.
- **Shell**: Always use **bash** as first priority when running terminal commands. Fall back to PowerShell only if bash is unavailable.

---

## 3. Anti-Redundancy Rules

**Always reuse existing code — no redundancy!**

- Never create re-export wrapper files. Import directly from the source.
- Before creating any utility/helper/formatter, search for existing implementations first.
- If a function exists, import it — do NOT duplicate.

### Source of Truth Locations

| What              | Where                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Time formatting   | `src/infra/format-time` — never create local `formatAge`/`formatDuration`/`formatElapsedTime` |
| Tables            | `src/terminal/table.ts` (`renderTable`)                                                       |
| Themes/colors     | `src/terminal/theme.ts` (`theme.success`, `theme.muted`, etc.)                                |
| Color palette     | `src/terminal/palette.ts` (no hardcoded colors)                                               |
| Progress/spinners | `src/cli/progress.ts`                                                                         |
| CLI wiring        | `src/cli/`                                                                                    |
| Commands          | `src/commands/`                                                                               |
| DI                | `createDefaultDeps` pattern                                                                   |

---

## 4. Import & Naming Conventions

- Use `.js` extension for cross-package imports (ESM).
- Direct imports only — no re-export wrappers.
- Types: `import type { X }` for type-only imports.
- Explicit types on all function signatures; no implicit `any`.

| Context              | Convention               | Example                             |
| -------------------- | ------------------------ | ----------------------------------- |
| TS source files      | `camelCase`              | `sessionManager.ts`                 |
| Config / YAML / docs | `kebab-case`             | `gateway-config.yaml`               |
| Root meta files      | `UPPERCASE.md`           | `CHANGELOG.md`                      |
| Migration files      | `YYYYMMDDHHMMSS_desc.ts` | `20250228120000_add_session_ttl.ts` |
| Branches             | `type/short-desc`        | `feat/line-channel-adapter`         |

---

## 5. Gateway & Session Protocol

- All WS clients must complete handshake: `connect` → `challenge` → `connect.params.auth`.
- Non-JSON or non-`connect` first frames → hard close.
- Side-effecting methods (`send`, `agent`) **require** idempotency keys. Always generate them.
- Gateway token: read from `OPENCLAW_GATEWAY_TOKEN` env var. Never hardcode.
- Sessions are **serialized per lane** — never use `Promise.all()` within a single session.
- Session IDs are opaque strings — never parse or construct them manually.
- Unknown `sessionId` → return `SessionNotFoundError`; never silently create.

---

## 6. Channel Layer Patterns

Every channel adapter implements: `connect`, `disconnect`, `normalize` (platform→internal), `send` (internal→platform), `onMessage`.

**Normalization rules:**

- `normalize()` produces a platform-agnostic `NormalizedMessage`. Zero platform types leak upstream.
- Handle: `text`, `image`, `audio`, `document`, `video`, `location`, `sticker`.
- Unrecognized types → log warning, return `type: 'unsupported'`. Never throw.
- Mentions → normalize to `@<userId>` regardless of platform syntax.

**Adding a new channel:** create adapter in `src/channels/<platform>/`, register in registry, add config schema, add integration tests, update docs & onboarding. See `AGENTS.md` for labeler/label updates.

---

## 7. Security Hard Limits

| Category   | Prohibited Pattern                                                    |
| ---------- | --------------------------------------------------------------------- |
| Secrets    | Hardcoded tokens, API keys, passwords in code                         |
| Sessions   | Concurrent execution within a single session                          |
| Gateway    | Binding to `0.0.0.0` without auth token set                           |
| Logs       | Logging response bodies, auth headers, or user PII                    |
| Migrations | Modifying or deleting existing migration files                        |
| Control UI | Exposing dashboard to public internet                                 |
| Skills     | Bypassing tool approval for dangerous operations (shell, file delete) |
| Docker     | Committing `.env` or secrets into image layers                        |
| Sandbox    | Setting full-access mode as default; only explicit opt-in             |

- Credentials: always read from env vars. If missing, throw `ConfigurationError`.
- Before any remote-access suggestion, recommend `openclaw security audit --deep`.
- `allowFrom` allowlists are required for production deployments.

---

## 8. Logging Standards

Use structured JSON logging. Log at stage boundaries, never log response bodies.

| Level   | Use for                                                |
| ------- | ------------------------------------------------------ |
| `error` | Unrecoverable failures, circuit breakers               |
| `warn`  | Recoverable issues, rate limits, unknown message types |
| `info`  | Stage boundaries, session lifecycle events             |
| `debug` | Internal state (never in production)                   |

---

## 9. Debugging & Fixing Issues

**Before investigating any bug:**

1. Read `docs/debug/tiered-debug-sop.md` — the full tiered debugging SOP.
2. Check §7 (Known Issues Pattern Database) for a matching pattern before diagnostics.
3. Follow the Tier-1 triage checklist (§2) before escalating.
4. Produce a structured investigation log (§4 schema) for non-trivial issues.

**Before applying any fix:**

1. Read `docs/CI-CD-WORKFLOW.md` — branching strategy, pipeline stages, deployment gates, rollback.
2. Apply fix on the correct branch per CI/CD workflow.
3. Verify fix passes all CI checks before considering resolved.

---

## 10. Code Quality Checklist

- TypeScript (ESM), strict typing, avoid `any`. Never add `@ts-nocheck`.
- Keep files under ~700 LOC — extract helpers when larger.
- Colocated tests: `*.test.ts` next to source.
- Run `pnpm check` (lint+format) and `pnpm tsgo` (type-check) before commits.
- Add brief comments for tricky/non-obvious logic.
- All pipeline stages: idempotent and independently testable.
- Automation scripts: must have `--dry-run` flag.
- Transformation logic: pure functions only — zero I/O in `src/utils/`.
- **Post-deployment sequence** (mandatory after every deploy):
  1. Run `docker/scripts/clear-sessions.sh` to clear stale LINE sessions (prevents LLM "learned helplessness" from old history).
  2. Run regression tests (`pnpm test`). Never skip either step.

**When coding with a human:** use git directly (not `scripts/committer`) and run quality commands manually.
