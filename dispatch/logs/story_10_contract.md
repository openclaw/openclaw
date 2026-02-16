# STORY-10 Implementation Contract

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Timestamp baseline: 2026-02-14 PST
Story: `STORY-10: Dispatcher queue view spec + tech job packet`

## Goal

Publish the minimum v0 UX specification package for dispatcher operations and technician execution handoff.

## Required Artifacts

- `dispatch/ux/dispatcher_cockpit_v0.md`
- `dispatch/ux/technician_job_packet_v0.md`
- `dispatch/ux/README.md`

## Dispatcher Cockpit Spec Requirements

- Queue view includes state, priority, SLA timer visibility, and escalation indicators.
- Assignment override workflow is explicitly defined (operator intent + audit reason).
- Timeline panel behavior is defined for audit/event inspection.
- Includes at least one wireframe representation (ASCII or equivalent).

## Technician Job Packet Requirements

- Defines required packet fields for field execution.
- Defines evidence requirements and checklist mapping for closeout readiness.
- Includes signature/no-signature requirement handling.
- Defines timeline/update expectations from tech perspective.

## Deterministic Validation

- Node-native test asserts each artifact exists and contains required section markers.
- Validation command: `node --test dispatch/tests/story_10_ux_spec.node.test.mjs`

## Acceptance Coverage

- UX specs are published and discoverable in-repo.
- Dispatcher spec includes SLA timers, assignment override, timeline view.
- Tech job packet requirements are documented for operational handoff.
