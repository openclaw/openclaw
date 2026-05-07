# CLAUDE.md / AGENTS.md Triad Split — Design

**Date:** 2026-05-01
**Author:** nb (with Claude)
**Status:** approved for implementation

## Goal

Reduce per-session token cost of the agent-instruction files at
`/Users/nb/Applications/openclaw-2026.4.7/` and `/Users/nb/.claude/`,
without losing any rule that actively shapes Claude/Codex behavior.

## Inputs (current state)

- `AGENTS.md` (42K, ~620 lines) — symlinked from `CLAUDE.md`. Single
  monolith mixing identity, contracts, architecture, code rules,
  workflow rules, ops trivia, multi-agent safety, mobile, release flow.
- `SECURITY.md` (26K) — coherent, well-organized vulnerability policy
  + out-of-scope rules. Append-only.
- `~/.claude/CLAUDE.md` (~150 lines) — global ChittyOS-developer config,
  some derivable content.
- No `CHARTER.md`. No `CHITTY.md`.

## Decision

Apply the ChittyOS Compliance Triad pattern at the OpenClaw repo root,
with `SECURITY.md` as a fourth pillar.

| Doc | Role | Owns |
|---|---|---|
| `CHARTER.md` (NEW) | Contracts | Plugin SDK / channel / provider / gateway-protocol / config contract surfaces, architecture-boundary *rules* ("must cross only via SDK"), versioning + compatibility commitments, prompt-cache stability contract, public-vs-internal scope |
| `CHITTY.md` (NEW) | Architecture | Repo map, monorepo layout, stack (Node 22 / Bun / pnpm / Vitest), runtime/deployment notes, channel + provider topology, consumers (Mac/iOS/Android/web), references to per-package `AGENTS.md` boundary guides |
| `SECURITY.md` (existing, append-only) | Trust model | Existing reporting + out-of-scope (untouched), plus relocations: mobile-pairing trust boundary, `op run` credential flow, CODEOWNERS restricted-surface rule |
| `AGENTS.md` ↔ `CLAUDE.md` (slim) | Dev rules + pointers | Identity (3 lines), output rules for replies, code/test rules (imperative only), workflow rules, multi-agent safety (deduped), pointer table to triad + skills + notes |

`CLAUDE.md` remains a symlink to `AGENTS.md` (Claude Code reads via
`CLAUDE.md`, Codex via `AGENTS.md`).

## Relocations out of `AGENTS.md`

| Source section | Target |
|---|---|
| What is OpenClaw / repo URL / Node baseline | `CHITTY.md` |
| Project Structure & Module Organization | `CHITTY.md` |
| Architecture Boundaries — *topology* | `CHITTY.md` (compressed; details remain in per-package `AGENTS.md`) |
| Architecture Boundaries — *rules* | `CHARTER.md` |
| Plugin/extension boundary rules | `CHARTER.md` |
| Channel / provider / gateway protocol contracts | `CHARTER.md` |
| Config contract boundary | `CHARTER.md` |
| Prompt Cache Stability | `CHARTER.md` |
| Quick Reference (commands) | `CLAUDE.md` |
| Build/Test/Dev Commands | `CLAUDE.md` (deduped, imperative) |
| Coding Style & Naming | `CLAUDE.md` |
| Testing Guidelines (8+ duplicate guardrails) | `CLAUDE.md` (collapsed to ~6 imperative bullets + 1 pointer) |
| Commit & PR Guidelines | `CLAUDE.md` (skill pointer) |
| Git Notes / Multi-agent safety (8 bullets) | `CLAUDE.md` (4 imperative bullets) |
| Docs Linking (Mintlify) / Docs i18n / Control UI i18n | `CLAUDE.md` (1 line each → existing READMEs) |
| Release / Advisory Workflows | `CLAUDE.md` (skill pointer) |
| Mobile pairing trust boundary | `SECURITY.md` |
| CODEOWNERS rule | `SECURITY.md` |
| `op run` credential flow note | `SECURITY.md` |
| exe.dev VM ops | `.agents/notes/exe-dev.md` (NEW) |
| Local Runtime / macOS / Parallels / Voice wake / iOS Team ID / A2UI hash / Lobster palette / Signal-fly / clawlog | `.agents/notes/local-platform.md` (NEW) |
| Mac packaging (`scripts/package-mac-app.sh`) | `.agents/notes/local-platform.md` |
| Bug-investigation depth note | `CLAUDE.md` |
| File LOC guidance (resolve 700 vs 500 conflict → keep 700) | `CLAUDE.md` |

## Drops (not relocated, judged derivable or stale)

- "Vocabulary: makeup = mac app" — keep (it's a personal lexicon Claude
  needs); moves to `.agents/notes/local-platform.md`.
- Generic Mintlify pointer that just links to skill — drop, the skill
  is auto-discovered.
- "Repository Guidelines" intro line ("Repo: ...github.com/openclaw")
  — moves to `CHITTY.md` intro, dropped from `AGENTS.md`.
- Duplicate restatements of same rule across Testing Guidelines —
  collapse to one canonical statement.

## Global `~/.claude/CLAUDE.md`

Smaller scope, no triad. Keep:
- Ecosystem Discovery (MANDATORY) — load-bearing
- Canonical Governance (BINDING, P/L/T/E/A) — load-bearing
- Permission Model
- Branch Completion Policy
- Pointers (registry, repos, hooks, skills)

Drop:
- "What This Is" intro
- Common Commands (derivable from Makefile)
- Full architecture overview tables (Claude can `ls ~/.claude/skills`)
- ChittyOS service tier table (live at `registry.chitty.cc`)

## Targets

| File | Before | After |
|---|---|---|
| `AGENTS.md` | 42K / ~620 lines | ~8K / ~180 lines |
| `CHARTER.md` | — | ~6K / ~140 lines |
| `CHITTY.md` | — | ~5K / ~110 lines |
| `SECURITY.md` | 26K | ~28K |
| `.agents/notes/exe-dev.md` | — | ~1.5K |
| `.agents/notes/local-platform.md` | — | ~4K |
| `~/.claude/CLAUDE.md` | ~150 lines | ~75 lines |

Net per-session reduction: AGENTS.md drops ~80% in size; the
relocated content remains discoverable via the pointer table and is
loaded only when relevant.

## Risk mitigations

1. **No deletions on first pass.** Every line either survives in
   `AGENTS.md` or is relocated to a specific named file.
2. **Final delta report.** Implementation must produce a list of every
   rule moved, with old-section → new-file mapping, so the user can
   verify nothing load-bearing was lost.
3. **Symlink preservation.** `CLAUDE.md → AGENTS.md` symlink stays.
4. **Per-file write.** Each new/edited file is a discrete step the
   user can sanity-check.

## Out of scope

- Editing any per-package `AGENTS.md` under `src/**` or
  `extensions/**` (those are boundary-owned, untouched).
- Editing `SECURITY.md` existing content (append-only).
- Modifying skills, hooks, or settings.
- Changing the `CLAUDE.md → AGENTS.md` symlink direction.

## Implementation plan handoff

Next step: invoke `superpowers:writing-plans` to produce an ordered
step-by-step plan with verification checkpoints.
