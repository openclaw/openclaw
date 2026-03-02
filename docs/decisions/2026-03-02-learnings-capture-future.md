# ADR: Learnings Capture — Future Work

**Date:** 2026-03-02

## Context

We want agents to capture non-trivial solutions after completing work, building a searchable knowledge base that compounds over time. The `/ce:compound` skill (from the compound-docs skill) implements this well — structured YAML frontmatter, category-based organisation, promotion path to critical patterns.

## Decision

Defer `/ce:compound` integration for Nova until skill access is figured out. Coding agents (Claude Code, opencode) spawned by Nova don't have the compound-docs skill in scope by default.

In the interim, agents should manually write solutions to `docs/solutions/[category]/filename.md` when they encounter non-trivial problems worth capturing.

## Future State

When `/ce:compound` is available to Nova agents:

1. Add AGENTS.md instruction: "run `/ce:compound` after completing non-trivial work"
2. Point `critical-patterns.md` as required reading before starting work
3. Remove this ADR's "defer" note

## Consequences

- Learnings accumulate slowly until skill access is resolved
- Manual capture is better than nothing — document it in AGENTS.md
