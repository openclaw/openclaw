# Resumable Handoff Packet (v1)

## Purpose
Allow model/agent/plugin swap mid-run without continuity loss.

## Core fields
- `runId`
- `goalId`
- `currentStep`
- `acceptance`
- `artifacts[]`
- `status`
- `updatedAt`
