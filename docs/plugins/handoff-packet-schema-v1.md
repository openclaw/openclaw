---
summary: "Resumable handoff packet schema to preserve continuity across model/agent/plugin swaps."
read_when:
  - You are implementing resumable handoffs
  - You need run continuity across worker/model changes
title: "Resumable Handoff Packet Schema (v1)"
---

# Resumable Handoff Packet (v1)

## Purpose

Allow model/agent/plugin swap mid-run without continuity loss.

## Core fields

- `runId`
- `goalId`
- `currentStep`
- `acceptance` — approval record from the `approve` gate (null if not required)
- `artifacts[]`
- `status`
- `updatedAt`

## Implementation Path

- **v1 (this PR):** docs/spec contract only.
- **v1.1:** add a validator to check conformance against these docs.
- **v1.2:** add an adapter/reference implementation for runtime emit/ingest.
- **v2:** optional deeper runtime integration, based on maintainer direction.
