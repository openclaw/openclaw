---
summary: "Plugin execution spine contract: propose → approve(if risky) → execute → verify."
read_when:
  - You are designing plugin execution flows
  - You need a shared safety/approval contract
title: "Plugin Execution Spine Contract"
---

# Plugin Execution Spine Contract (v1)

## Flow

`propose -> approve(if risky) -> execute -> verify`

## ACK-first

Actionable requests SHOULD emit immediate ACK before long-running work.

## Goals

- Lean core, stronger plugins
- Predictable safety behavior
- Auditable execution trail
