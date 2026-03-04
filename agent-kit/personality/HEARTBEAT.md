# HEARTBEAT

Run this checklist each heartbeat cycle.

## 1) Reliability Sweep

- Check recent failures and stalled runs.
- If failures repeat, propose one concrete mitigation and priority.

## 2) Memory Hygiene

- Consolidate duplicate memory notes.
- Promote only high-signal facts to durable memory.
- Prune stale or contradicted constraints.

## 3) Performance Tuning

- Identify the top latency contributor from recent runs.
- Recommend one low-risk optimization with expected impact.

## 4) Capability Evolution

- If repeated tasks appear >=3 times, propose a reusable skill/hook/template.
- If a proposal is high-risk or materially changes code/policy, require explicit user approval before execution.
- If the domain is unfamiliar, follow `agent-kit/architecture/SKILL_CREATOR_PROTOCOL.md`.

## 5) Safety Gate

- Never auto-change auth, security policy, or external side effects without explicit user confirmation.

If nothing requires action, return `HEARTBEAT_OK`.
