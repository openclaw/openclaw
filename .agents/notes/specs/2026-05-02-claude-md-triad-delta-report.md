# CLAUDE.md / AGENTS.md Triad Split — Delta Report

**Date:** 2026-05-02
**Spec:** `.agents/notes/specs/2026-05-01-claude-md-triad-design.md`
**Plan:** `.agents/notes/plans/2026-05-02-claude-md-triad-split.md`

## Final state

> **Amendment (post-ship):** The shipped layout is **4+1**, not the 3+1 in the design spec. `OPS.md` was added as a fourth companion pillar to absorb apps/platform, Mac gateway, GitHub/CI wait matrix, Testbox/Blacksmith routing, Gates, Footguns, ClawSweeper, Memory/wiki, Remote install, and Security pointers — material that the original plan had either kept inline in `AGENTS.md` or pushed to `.agents/notes/local-platform.md`. Rule-relocation rows below that read "kept in `AGENTS.md`" or "moved to `local-platform.md`" for those topics should be read as "moved to `OPS.md`" instead. The Pointers table in the shipped `AGENTS.md` is the authoritative map.

| File | Before | After | Delta |
|---|---|---|---|
| `AGENTS.md` (= `CLAUDE.md` symlink target) | 345 lines / 42K | 185 lines / 15K | **−46%** |
| `CHARTER.md` | — | 85 lines / 7.3K | NEW |
| `CHITTY.md` | — | 95 lines / 4.9K | NEW |
| `OPS.md` | — | 154 lines / ~9K | NEW (fourth pillar, not in original spec) |
| `SECURITY.md` | 323 lines / 26K | 353 lines / 28K | +9% (append-only) |
| `.agents/notes/exe-dev.md` | — | 32 lines / 822B | NEW |
| `.agents/notes/local-platform.md` | — | 116 lines / 5.7K | NEW |
| `~/.claude/CLAUDE.md` | 171 lines / 9.4K | 78 lines / 4.1K | **−54%** |
| `~/.claude/CLAUDE.md.pre-triad-backup` | — | 171 lines / 9.4K | NEW (defensive backup) |

**Per-session loaded content** (files Claude/Codex auto-read at session start):
- Project: `AGENTS.md` 345 → 185 lines (**−46%**)
- Global: `~/.claude/CLAUDE.md` 171 → 78 lines (**−54%**)
- **Combined: 516 → 263 lines (−49%)**

The triad files (CHARTER.md, CHITTY.md, SECURITY.md) and notes are read on demand via the pointer table in AGENTS.md.

## Rule relocation map

| Original AGENTS.md section | Status | New location |
|---|---|---|
| Quick Reference (commands) | kept | `AGENTS.md` (compressed) |
| Repository Guidelines — repo URL | moved | `CHITTY.md` (intro) |
| Repository Guidelines — repo-relative paths | kept | `AGENTS.md` (Output rules) |
| Repository Guidelines — CODEOWNERS | moved | `SECURITY.md` (Restricted surfaces) |
| Project Structure & Module Organization | moved | `CHITTY.md` (Repo layout, Channels, Bundled plugin naming) |
| Architecture Boundaries — *rules* ("must cross only via SDK", core extension-agnostic, channel/provider/gateway boundaries, config contract) | moved | `CHARTER.md` |
| Architecture Boundaries — *topology* (repo map, definition file paths) | moved | `CHITTY.md` (Repo layout + Boundary guides) |
| Architecture Boundaries — per-package detail | unchanged | existing per-package `AGENTS.md` files |
| Docs Linking (Mintlify) | kept | `AGENTS.md` (Output rules + Doc pipelines) |
| Docs i18n | compressed | `AGENTS.md` (Doc pipelines, 1 paragraph) + existing `docs/.i18n/README.md` |
| Control UI i18n | compressed | `AGENTS.md` (Doc pipelines, 1 paragraph) |
| exe.dev VM ops (whole section) | moved | `.agents/notes/exe-dev.md` |
| Build, Test, Dev Commands | compressed | `AGENTS.md` (Workflow > 7 sub-sections) |
| Prompt Cache Stability | moved | `CHARTER.md` (correctness contract) |
| Coding Style & Naming | kept | `AGENTS.md` (Code style + Dynamic-import guardrail + Import-boundary cheat sheet) |
| Release / Advisory Workflows | compressed | `AGENTS.md` Pointers table + `SECURITY.md` (Release authorization) |
| Testing Guidelines (8 perf guardrails) | deduped | `AGENTS.md` Testing (collapsed to one paragraph) |
| Commit & PR Guidelines (incl. duplicate $openclaw-pr-maintainer mention) | compressed | `AGENTS.md` (Commits / PRs); duplicate dropped |
| Git Notes | merged | `AGENTS.md` (Multi-agent safety) |
| Security & Configuration Tips | split | dev-time bits → `AGENTS.md`; secrets/release → `SECURITY.md` |
| Local Runtime / Platform Notes | mostly moved | `.agents/notes/local-platform.md` (skill pointers also surfaced in AGENTS.md Pointers) |
| Collaboration / Safety — Multi-agent safety (8 bullets) | deduped | `AGENTS.md` (4 bullets) |
| Collaboration / Safety — Tool schema guardrails (google-antigravity) | moved | `.agents/notes/local-platform.md` |
| Collaboration / Safety — Streaming reply rule | moved | `.agents/notes/local-platform.md` |
| Collaboration / Safety — Carbon | kept | `AGENTS.md` (Misc) |
| Collaboration / Safety — Bug investigations / High-confidence answers | kept | `AGENTS.md` (Output rules) |
| Collaboration / Safety — Release/version/beta-tag rules | moved | `SECURITY.md` (Release authorization + Dependency patching) |
| Collaboration / Safety — Lint/format churn | kept | `AGENTS.md` (Pre-commit / formatting) |
| `~/.claude/CLAUDE.md` — What This Is | dropped | derivable from directory layout |
| `~/.claude/CLAUDE.md` — Common Commands | dropped | derivable from per-project Makefile |
| `~/.claude/CLAUDE.md` — Architecture Overview (MCP/Hooks/Skills/Agents/Plugins/Context tables) | dropped | derivable: `ls ~/.claude/{skills,hooks,agents}/`; pointers retained |
| `~/.claude/CLAUDE.md` — ChittyOS Ecosystem tier table | dropped | live at `https://registry.chitty.cc/api/services` |
| `~/.claude/CLAUDE.md` — Ecosystem Discovery (MANDATORY) | kept verbatim | global `CLAUDE.md` |
| `~/.claude/CLAUDE.md` — Canonical Governance (BINDING, P/L/T/E/A) | kept verbatim | global `CLAUDE.md` |
| `~/.claude/CLAUDE.md` — Permission Model | kept | global `CLAUDE.md` |
| `~/.claude/CLAUDE.md` — Branch Completion Policy | kept | global `CLAUDE.md` |
| `~/.claude/CLAUDE.md` — Key Patterns | kept | global `CLAUDE.md` |

## Resolved contradictions

- **File-size guideline:** the original AGENTS.md said both "files under ~700 LOC" (line 218) and "files under ~500 LOC" (line 339). Kept the 700-LOC figure (more recent guidance from the Code Style section); the 500-LOC reference was dropped.

## Duplicates removed

- `$openclaw-pr-maintainer` skill pointer appeared three times in the original Commit & PR Guidelines section (lines 261-263). Now appears once in the Pointers table.
- "Use the `<skill>` skill" prose paragraphs across Release / Advisory / PR / Parallels sections — collapsed into single rows of the Pointers table.

## Verification

All 8 spot-checks passed (every relocated rule lives in exactly the expected file):

| Probe | Expected location | Found |
|---|---|---|
| Cleartext `ws://` mobile pairing rule | `SECURITY.md` | ✓ |
| Prompt-cache stability contract | `CHARTER.md` | ✓ |
| Multi-agent safety bullets | `AGENTS.md` | ✓ |
| exe.dev VM gateway ops | `.agents/notes/exe-dev.md` | ✓ |
| `VoiceWakeForwarder` notes | `.agents/notes/local-platform.md` | ✓ |
| P/L/T/E/A canonical types | `~/.claude/CLAUDE.md` | ✓ |
| "Core stays extension-agnostic" rule | `CHARTER.md` | ✓ |
| "Repo layout" topology | `CHITTY.md` | ✓ |

Symlink: `CLAUDE.md → AGENTS.md` intact (resolved via `readlink`).

## Backups / rollback

- `~/.claude/CLAUDE.md.pre-triad-backup` — pre-change copy of the global file. Delete after the new layout is confirmed working in a few sessions.
- Drafts at `.agents/notes/specs/drafts/` — keep for reference; delete when no longer useful.
- The original 345-line `AGENTS.md` is **not** backed up to a separate file (drafts directory + git history if/when this tree is committed both serve as recovery sources). If the user wants a defensive snapshot, copy `.agents/notes/specs/drafts/` aside.

## What's next (suggested follow-ups)

- Read `CHARTER.md`, `CHITTY.md`, and the new `AGENTS.md` end-to-end once and confirm tone and grouping match preference. Easiest place to find drift: the Pointers table.
- After 2-3 sessions with the new layout, delete `~/.claude/CLAUDE.md.pre-triad-backup`.
- If any rule turns out to be missing from agent behavior, restore it from the matching draft or the original `git show` (when this tree is in git) into the most appropriate of the four documents — not back into a single monolith.
