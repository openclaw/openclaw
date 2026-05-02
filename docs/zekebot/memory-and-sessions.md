---
summary: "State boundaries for ZekeBot sessions, memory, and ZekeFlow-owned context."
read_when:
  - Troubleshooting memory behavior
  - Reviewing where Zeke state is stored
title: "Memory and sessions"
---

# Memory And Sessions

ZekeBot uses OpenClaw session state for the runtime conversation and gateway history. Zeke knowledge, signal state, approvals, and context policy remain owned by ZekeFlow.

## Runtime state

OpenClaw runtime state lives under `/home/node/.openclaw` inside the container. The ZekeBot Docker image declares that path as a volume so replacing the container does not discard runtime state by accident.

## Zeke state

ZekeFlow owns:

- context broker evidence and source policy,
- pending signal proposals,
- event and audit writes,
- durable memory and Cognee-backed retrieval,
- signal ingestion and lifecycle state.

The native Zeke plugin must call ZekeFlow for these operations. It must not import ZekeFlow internals or write databases directly.

## Session boundaries

Profiles define which session tools are visible. Sprout may use bounded session read and investigator spawn primitives. Rambo receives session read primitives only. External-client starts with no internal Zeke session authority.
