---
summary: "Why OpenClaw Swarm can use different cognitive regimes at the same time"
title: "Mixed-phase cognition"
status: experimental
---

# Mixed-phase cognition

A Swarm group does not need one global cognitive phase.

The useful mental model is a material with local phases rather than a meeting
where every agent is told to "think harder" in the same way.

Different replicas can simultaneously occupy different observed regimes:

- **gas** — broad, weakly coordinated exploration
- **liquid** — productive mobility with rising coherence
- **critical** — disagreement or sensitivity that should trigger measurement
- **crystal** — a local candidate stable enough to freeze for verification
- **glass** — low mobility and low progress without enough evidence
- **jammed** — resource, context, or cleanup pressure dominates
- **unknown** — telemetry is insufficient to classify safely

The important word is **local**. A crystal in one lane does not require the
whole Swarm to stop. A jammed lane should not be averaged away by nine healthy
ones. A critical disagreement should not be mislabeled as generic failure.

## The Liquid Software Factory invariant

The system intentionally changes character as work moves from search to effect:

```text
high entropy                                      low ambiguity
     |                                                 |
     v                                                 v
gas -> liquid -> critical -> local crystal -> verification -> effect owner
 ^         ^           ^             ^             ^              ^
 |         |           |             |             |              |
diverse   combine     measure       freeze       exact identity   existing
search    useful      disagreement  candidate    + replay         authority
```

Exploration may be nondeterministic.

Convergence should become progressively more deterministic.

Authority should remain deterministic and external to the search controller.

> Search can be stochastic. Promotion cannot be accidental.

## Profiles are trajectories, not permissions

The profiles describe intentionally different trajectories through the search
space. They are not security principals and do not grant tools, credentials,
sandbox exemptions, approvals, or effect authority.

This is more than prompt wording because the native bridge can bind trajectory
identity into replay, constrain explicit handoff data, and require the existing
sandbox owner for an independent verifier.

## Search-only controller

The controller may recommend bounded spawn, measure, freeze, perturb, drain, or
hold actions. Those are advisories only.

Existing OpenClaw admission, policy, cancellation, sandbox, and approval owners
still decide what can actually execute.

A phase is descriptive telemetry. A control action is a recommendation. Neither
is authority.
