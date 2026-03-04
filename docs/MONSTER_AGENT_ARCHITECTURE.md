# Monster Agent Architecture (Production Blueprint)

## Objective

Maximize capability while preserving safety, determinism, and operator control.

## Layered architecture

1. Orchestrator layer

- Agent `main` owns task decomposition, acceptance criteria, and final synthesis.
- It delegates to role-specialized subagents only when specialization improves outcome quality.

2. Specialist layer

- `researcher`: discovery and external synthesis, no write/exec.
- `builder`: implementation and fixes.
- `critic`: verification, test design, regression detection.

3. Memory layer

- Durable memory: markdown memory files + QMD index.
- Session memory: transcript-derived notes via `session-memory` hook.
- Retrieval: hybrid semantic/text with temporal decay and MMR.

4. Personality layer

- `SOUL.md`: invariant mission and quality doctrine.
- `IDENTITY.md`: communication protocol and decision style.
- `USER.md`: evolving preference profile.
- `HEARTBEAT.md`: autonomous maintenance loop instructions.

5. Governance layer

- Tool scopes by role.
- Loop detection + circuit breaker.
- Gateway denylist for high-risk HTTP-invoked tools.
- Plugin allowlist to reduce supply-chain surface.

## Reinforcement loop (practical, safe)

- Input signals: command logs, session-memory files, delivery/test outcomes.
- Reflection cadence: heartbeat cycle every 30m with lightweight context.
- Promotion rule: only repeated, high-signal patterns become durable preferences.
- Safety guard: no autonomous security/auth changes without explicit operator approval.

## Team execution protocol

1. `main` writes objective + acceptance criteria.
2. `main` spawns `researcher` and/or `builder` as needed.
3. `critic` validates against acceptance criteria.
4. `main` resolves conflicts and returns final answer with evidence.

## Why this works

- Maximizes parallel specialization without losing a single accountability owner.
- Keeps learning in auditable artifacts instead of hidden state.
- Improves over time through controlled reinforcement, not uncontrolled self-modification.
