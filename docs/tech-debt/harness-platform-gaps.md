---
summary: "Known gaps between OpenClaw's current harness core and a fuller agent-first engineering platform"
read_when:
  - You are reviewing post-roadmap gaps
  - You need a durable ledger of harness/platform deficits
owner: "OpenClaw harness"
freshness: "monthly"
last_reviewed: "2026-03-25"
title: "Harness Platform Gaps"
---

# Harness Platform Gaps

## Current gaps

### 1. Doc and policy linting

- Missing mechanical checks for doc ownership, freshness, and broken links.
- Missing repo-wide policy lint for coverage and stale guidance.

### 2. Architecture enforcement

- Missing structural tests for import direction and directory boundaries.
- Missing repo-level naming, file-size, and remediation-message checks.

### 3. Long-term reporting

- `/context` is strong for single-run visibility, but there is no persistent dashboard for long-term trends.

### 4. Wider environment visibility

- Browser, UI state, logs, metrics, and traces are not yet first-class agent-readable surfaces.

### 5. Delivery-loop automation

- Failure-to-rule suggestions now write back with explicit confirmation, but review, reverify, and merge are not yet a broader automated loop.

## Why this file exists

The harness roadmap is complete. These items are the durable follow-up list for the next stage of system-building work.
