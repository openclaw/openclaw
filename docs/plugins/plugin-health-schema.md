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
