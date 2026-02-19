# Review: OpenClaw Messenger & Cloud.ru FM Documentation

> **Date:** 2026-02-16
> **Reviewer:** Claude (automated review)
> **Scope:** `docs/ccli-max-cloudru-fm/` — all docs including ADRs, research, architecture, platform docs, quality & planning
> **Branch:** `claude/review-openclaw-messenger-docs-Rwr8i`

---

## Summary

The documentation suite is comprehensive and well-structured, covering Cloud.ru FM proxy integration, MAX Messenger research, Architecture Decision Records (ADR-001..005), platform architecture, operational guides, and quality assurance artifacts. However, the review identified **12 issues** — 3 critical, 5 medium, and 4 low severity.

---

## Critical Issues

### CRIT-01: Filename collisions on case-insensitive filesystems

**Files affected:** 5 pairs in `docs/ccli-max-cloudru-fm/`

| Lowercase (platform docs)      | UPPERCASE (Cloud.ru FM docs)   |
| ------------------------------ | ------------------------------ |
| `architecture.md` (421 lines)  | `ARCHITECTURE.md` (260 lines)  |
| `functionality.md` (419 lines) | `FUNCTIONALITY.md` (158 lines) |
| `installation.md` (397 lines)  | `INSTALLATION.md` (224 lines)  |
| `operations.md` (374 lines)    | `OPERATIONS.md` (275 lines)    |
| `user-guide.md` (500 lines)    | `USER-GUIDE.md` (239 lines)    |

On **macOS (APFS default)** and **Windows (NTFS)**, these files collide — `git clone` will silently overwrite one with the other. Since OpenClaw targets self-hosted deployments on diverse platforms, this is a data-loss risk.

**Recommendation:** Rename UPPERCASE files to use a prefix, e.g.:

- `ARCHITECTURE.md` -> `cloudru-fm-architecture.md`
- `FUNCTIONALITY.md` -> `cloudru-fm-functionality.md`
- etc.

### CRIT-02: Node.js version mismatch between package.json and docs

`package.json` requires **`node >= 22.12.0`** with `pnpm@10.23.0`, but documentation states:

| Document                              | Stated version                        |
| ------------------------------------- | ------------------------------------- |
| `architecture.md` line 13             | "Node.js >=20"                        |
| `installation.md` line 8              | "Node.js >= 20.0.0"                   |
| `installation.md` Dockerfile line 277 | `FROM node:20-alpine`                 |
| `installation.md` line 269            | "`nvm install 20`" in troubleshooting |

Users following the installation guide will install Node.js 20, which will fail at runtime with ES2022+ features that require Node 22+.

**Recommendation:** Update all docs to reference `node >= 22.12.0` and `pnpm` (not `npm`).

### CRIT-03: Package manager mismatch — pnpm vs npm

`package.json` specifies `"packageManager": "pnpm@10.23.0"`, but all documentation exclusively uses `npm`:

- `installation.md`: `npm install`, `npm run build`, `npm test`
- `architecture.md`: `npm run build`, `npm test`, `npm run lint`
- `operations.md`: references npm commands

Using `npm` with a pnpm-managed monorepo will produce incorrect `node_modules` structure and break workspace resolution.

**Recommendation:** Replace all `npm` commands with `pnpm` equivalents across docs.

---

## Medium Issues

### MED-01: Test count inconsistency

| Document                   | Count                               |
| -------------------------- | ----------------------------------- |
| `architecture.md` line 18  | "793 unit-теста, 33 тестовых файла" |
| `installation.md` line 102 | "738 тестов, 33 тестовых файла"     |
| `installation.md` line 263 | "738 тестов"                        |

**Recommendation:** Run `pnpm test` and update all references to the actual count.

### MED-02: RESEARCH.md contradicts ADR-004 on Docker image tag

`RESEARCH.md` section 2.2 (line ~95):

```yaml
image: legard/claude-code-proxy:latest
```

ADR-004 (line 46) explicitly states:

```yaml
image: legard/claude-code-proxy:v1.0.0 # Pinned, not :latest
```

ADR-004 says "Image pinned to `v1.0.0` — no surprise updates", yet RESEARCH.md still shows `:latest`.

**Recommendation:** Update RESEARCH.md to use `:v1.0.0` for consistency with the accepted ADR.

### MED-03: Orphaned planning & quality docs referencing deleted ADRs

Commit `e54143f` deleted ADR-006 through ADR-013, but the following docs still reference them:

| File                                               | References       |
| -------------------------------------------------- | ---------------- |
| `planning/milestones-ADR-006-007.md`               | ADR-006, ADR-007 |
| `planning/milestones-ADR-008-009.md`               | ADR-008, ADR-009 |
| `planning/milestones-ADR-010-011.md`               | ADR-010, ADR-011 |
| `planning/milestones-ADR-012-013.md`               | ADR-012, ADR-013 |
| `quality/qcsd-ideation-ADR-006-009.md`             | ADR-006..009     |
| `quality/qcsd-ideation-ADR-010-013.md`             | ADR-010..013     |
| `quality/shift-left-testing-report-ADR-006-007.md` | ADR-006, ADR-007 |
| `quality/shift-left-testing-report-ADR-008-009.md` | ADR-008, ADR-009 |
| `quality/shift-left-testing-report-ADR-010-011.md` | ADR-010, ADR-011 |
| `quality/shift-left-testing-report-ADR-012-013.md` | ADR-012, ADR-013 |

These docs are now orphaned — they describe milestones and quality tests for non-existent ADRs.

**Recommendation:** Either delete the orphaned files or add a header noting the referenced ADRs were superseded by the v2 ADR rewrite.

### MED-04: Docker Compose `version` key is deprecated

`installation.md` line 311:

```yaml
version: "3.9"
```

Docker Compose v2 (the current default) ignores the `version` key entirely. Including it triggers a deprecation warning.

**Recommendation:** Remove the `version` field from docker-compose examples.

### MED-05: Outdated business recommendation in MAX research doc

`max-messenger-integration.md` section 5.3 (line 827):

> "Рекомендация: Зарегистрировать бизнес-аккаунт и опубликовать бота **в 2025 году**, пока действует бесплатный тариф."

The document date is **2026-02-13** — this recommendation is 2+ months past the deadline.

**Recommendation:** Update to reflect 2026 status — either note the free period has ended, or confirm it was extended.

---

## Low Issues

### LOW-01: Inconsistent `maxMessageLength` for MAX platform

`functionality.md` (platform) line 105 and `operations.md` line 88 list MAX messenger rate limit as `20 rps / burstSize 20` and `maxMessageLength: 4096`. However, the MAX Bot API docs in `max-messenger-integration.md` don't confirm a 4096 character limit — this appears to be inherited from Telegram's limit.

**Recommendation:** Verify MAX's actual message length limit from `dev.max.ru` API docs and update if different.

### LOW-02: `installation.md` references `@openclaw/platform` package import

Lines 157-171 show importing from `@openclaw/platform`, but this package isn't published to npm based on the repo structure. This is internal API and should be documented as such.

**Recommendation:** Add a note that `@openclaw/platform` is the local package, not an npm-published module.

### LOW-03: `max-messenger-integration.md` uses `axios` in examples

Section 8.3 (line ~1403) uses `axios` for HTTP client examples, but the OpenClaw platform uses its own `IHttpClient` port pattern (as documented in `architecture.md` and `functionality.md`). This creates an inconsistency between the integration research doc and the platform architecture.

**Recommendation:** Either note that the examples are standalone (outside OpenClaw core), or use `IHttpClient` for consistency.

### LOW-04: pm2 example in research doc includes token in config

`max-messenger-integration.md` section 4.1.6 (line ~698) shows:

```javascript
env: {
  MAX_BOT_TOKEN: "your-token-here";
}
```

While this is a placeholder, the ecosystem.config.js pattern encourages hardcoding tokens in committed config files. The doc should recommend using `.env` files or environment variables instead.

**Recommendation:** Replace with `MAX_BOT_TOKEN: process.env.MAX_BOT_TOKEN` and note that tokens should come from environment.

---

## Positive Observations

1. **ADR quality is excellent** — ADR-001..005 follow a consistent format with bounded contexts (DDD), explicit consequences, security considerations, and research references.

2. **MAX Messenger research is thorough** — Covers platform overview, Bot API, SDK options (TS/Python/Java/Go/PHP), business requirements, 4 integration variants, detailed architecture, and code examples.

3. **Security considerations are well-documented** — Localhost-only port binding, `cap_drop: ALL`, `read_only: true`, `.env` file management, webhook signature verification, and FSTEC compliance.

4. **GLM behavioral issues are cataloged** — Known issues with tool calling, XML parsing, RLHF refusals, and system prompt attention loss are all documented with mitigations.

5. **Platform architecture docs** (`architecture.md`, `functionality.md`, `operations.md`) provide a complete reference for the DDD bounded contexts, event bus, DI container, and all 42 domain events.
