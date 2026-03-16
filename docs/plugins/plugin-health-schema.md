---
summary: "Standard plugin health schema for operator visibility and recovery handoffs."
read_when:
  - You are exposing plugin runtime health
  - You need a consistent healthy/degraded/blocked status model
title: "Plugin Health Schema"
---

# Plugin Health Schema (v1)

## Status enum

- `healthy`
- `degraded`
- `blocked`

## Required fields

- `status`
- `lastError` (nullable)
- `nextAction` (nullable)
- `updatedAt`
- `runId` (nullable if idle)
- `goalId` (nullable if idle)
- `sourceOfTruth` (canonical state path/identifier)

## Consistency rule

Health output MUST be computed from canonical run/state records (single source of truth), not from ad-hoc in-memory counters alone.

## Implementation Path

- **v1 (this PR):** docs/spec contract only.
- **v1.1:** add a validator to check conformance against these docs.
- **v1.2:** add an adapter/reference implementation for runtime emit/ingest.
- **v2:** optional deeper runtime integration, based on maintainer direction.
