---
# ── Dart AI metadata ──────────────────────────────────────────────────────────
title: "Feature Name"
description: "One-line summary shown in the Dart project card"
dartboard: "Operator1/Tasks"
type: Project
status: "To-do"
priority: high # critical | high | medium | low
assignee: "rohit sharma"
tags: [] # e.g. [feature, backend, ui, api, migration]
startAt: "YYYY-MM-DD"
dueAt: "YYYY-MM-DD"
dart_project_id: # filled by Claude after first Dart sync — do not edit manually
# ──────────────────────────────────────────────────────────────────────────────
---

# Feature Name

**Created:** YYYY-MM-DD
**Status:** Planning
**Depends on:** (list any prerequisite features or phases)

---

## 1. Overview

2–3 sentences. What is being built, why, and what problem it solves.

---

## 2. Goals

- Goal 1
- Goal 2
- Goal 3

## 3. Out of Scope

- What this explicitly does NOT include
- Defer to future phases where applicable

---

## 4. Design Decisions

Key architectural or UX decisions with rationale. This section is spec-only —
not synced to Dart tasks but referenced by them.

| Decision   | Options Considered | Chosen   | Reason |
| ---------- | ------------------ | -------- | ------ |
| Decision 1 | Option A, Option B | Option A | Reason |

---

## 5. Technical Spec

Rich content lives here: SQL schemas, TypeScript types, API contracts,
file structures, code snippets, architecture diagrams. This is the source
of truth for implementation — Dart task descriptions reference sections
here rather than duplicate them.

### 5.1 Section Title

...

### 5.2 Section Title

...

---

## 6. Implementation Plan

> **Sync rules:**
>
> - Each `### Task` heading = one Dart Task (child of the Project)
> - Each `- [ ]` checkbox = one Dart Subtask (child of its Task)
> - `**Status:**` on line 1 of each task syncs with Dart status field
> - Task titles and subtask text must match Dart exactly (used for sync matching)
> - `dart_project_id` in frontmatter is filled after first sync
> - **Dates:** `dueAt` and per-task `**Due:**` dates must be confirmed with the user before syncing to Dart — never auto-generate from estimates
> - **Estimates:** use hours (`**Est:** Xh`), not days — AI-assisted implementation is much faster than manual dev
> - **Subtasks:** every `- [ ]` item must include a brief inline description after `—` so it is self-contained when read in Dart without the MD file

### Task 1: Phase 1 — Title

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** YYYY-MM-DD | **Est:** Xh

Brief description of this phase — becomes the Dart task description.
Reference spec section if relevant: see §5.1.

- [ ] 1.1 Short title — brief description of what this involves and any key detail
- [ ] 1.2 Short title — brief description of what this involves and any key detail
- [ ] 1.3 Short title — brief description of what this involves and any key detail

### Task 2: Phase 2 — Title

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** YYYY-MM-DD | **Est:** Xh

Brief description.

- [ ] 2.1 Short title — brief description of what this involves and any key detail
- [ ] 2.2 Short title — brief description of what this involves and any key detail

### Task 3: Phase 3 — Title

**Status:** To-do | **Priority:** Medium | **Assignee:** rohit sharma | **Due:** YYYY-MM-DD | **Est:** Xh

Brief description.

- [ ] 3.1 Short title — brief description of what this involves and any key detail
- [ ] 3.2 Short title — brief description of what this involves and any key detail

---

## 7. References

- Related spec: `Project-tasks/other-feature.md`
- Key source files:
  - `src/path/to/file.ts`
  - `src/path/to/other.ts`
- Dart project: _(filled after first sync)_

---

_Template version: 1.0 — do not remove the frontmatter or alter heading levels_
