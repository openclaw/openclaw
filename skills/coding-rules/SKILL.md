---
name: coding-rules
description: "HH's 90 Golden Rules for TypeScript, testing, APIs, security, performance, containers, and observability. Use when writing production code, reviewing PRs, or setting up new projects."
---

# Coding Rules Skill

HH's comprehensive coding standards for production-quality development.

## Quick Reference

See `references/FULL_RULES.md` for the complete 90 rules.

## Core Principles

1. **TypeScript:** `strict: true`, no `any`, explicit exports
2. **Functions:** Max 20 lines, single responsibility, early returns
3. **Files:** Max 200-300 lines, black box interfaces
4. **Testing:** AAA pattern, 80% coverage, `.test.ts`/`.spec.ts`/`.e2e.ts`
5. **APIs:** RESTful, Zod validation, consistent `{ data, meta, error }`
6. **Security:** Least privilege, parameterized queries, bcrypt ≥12
7. **Performance:** Indexes, no N+1, lazy load, bundle limits
8. **Containers:** Multi-stage, non-root, health checks, resource limits
9. **Observability:** Structured JSON logs, OpenTelemetry, `/health` + `/ready`

## 2026 Stack

| Layer     | Choice                  |
| --------- | ----------------------- |
| Frontend  | React 19 / Svelte 5     |
| Framework | Next.js 15+ / Astro     |
| CSS       | Tailwind v4 + shadcn/ui |
| Runtime   | Node 24 LTS / Bun       |
| ORM       | Drizzle / Prisma        |
| Build     | Vite                    |
| Lint      | Biome                   |

## Key Anti-Patterns

**UX:** No scroll-jacking, carousels, hamburger on desktop, full-screen modals on entry
**Tech:** No CRA, manual Webpack, Redux for simple apps, class components, JPG/PNG

## Resilience

- Error boundaries, graceful degradation
- Exponential backoff (1s, 2s, 4s, 8s)
- Timeouts on all network calls (5s default)
- Circuit breakers for external services

## Usage

Reference this skill before any development work. For specific rule details, consult `references/FULL_RULES.md`.
