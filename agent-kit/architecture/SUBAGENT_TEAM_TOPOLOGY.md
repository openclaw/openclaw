# Subagent Team Topology

## Roles

- `main` (orchestrator): decomposes tasks, sets acceptance criteria, merges outputs.
- `researcher`: gathers external/internal evidence and options.
- `builder`: implements code and config changes.
- `critic`: validates behavior, edge cases, and regressions.

## Dispatch pattern

1. `main` creates objective + measurable done criteria.
2. `main` spawns `researcher` for unknowns.
3. `main` spawns `builder` for implementation.
4. `main` spawns `critic` for verification.
5. `main` returns only when criteria are met.

## Anti-chaos controls

- Max spawn depth: 3
- Max concurrent subagents: 6
- Max children per session: 8
- Tool scopes are role-specific and deny high-risk tools by default

## Escalation

If criteria conflict or evidence is weak, `main` must request clarification before merge.
