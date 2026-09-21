---
summary: "How the four Liquid Software Factory Swarm PRs fit together"
title: "Liquid Software Factory PR stack"
status: experimental
---

# Liquid Software Factory PR stack

This experiment is intentionally split into four reviewable layers. Each layer
adds one boundary and does not widen effect authority.

> Search can be stochastic. Promotion cannot be accidental.

```text
Layer 1                  Layer 2                   Layer 3                    Layer 4
#153625                  #153627                   #153628                    #153629

trajectory presets  ->   mixed local phases  ->   exact candidate      ->   diagnostics +
bounded handoff          search-only advisory     identity/replay binding   lifecycle/folding
verifier sandbox         gas/liquid/critical      source/recipe/policy      integration view

high search entropy -----------------------------------------------------> low ambiguity

search-only ------------------------------------------------------------> existing authority
```

## The four PRs

1. **#153625 — cognitive trajectories**
   - generic internal `DynamicsProfile` contract
   - deliberately small preset catalog
   - bounded information handoff
   - verifier requests the existing sandbox owner with `sandbox: "require"`
   - no unsandboxed downgrade

2. **#153627 — population thermodynamics**
   - local gas/liquid/critical/crystal/glass/jammed/unknown classification
   - conservative pressure handling
   - search-only spawn/measure/freeze/perturb/drain/hold recommendations
   - parent-owned observer lifetime

3. **#153628 — deterministic convergence identity**
   - candidate + source + recipe + policy manifest
   - canonical candidate identity
   - identity participates in native replay fingerprint
   - identity is not proof of correctness or authority

4. **#153629 — integration and diagnostics**
   - one production diagnostic path
   - lifecycle-owned cleanup
   - deterministic folding regression
   - full science/engineering model and research frontier

## Cross-layer invariants

All four PRs share the same constraints:

- profiles and phases are search semantics, not permissions
- unknown telemetry stays unknown
- local saturation is not averaged away
- disagreement creates measurement demand
- candidate identity gets stricter toward convergence
- replay is identity-bound and idempotent
- every retained state has a lifecycle owner
- verifier isolation fails closed
- diagnostics and control recommendations remain search-only
- existing OpenClaw owners retain approval and effect authority

## Review order

Reviewing in stack order gives the smallest reasoning surface:

```text
#153625 -> #153627 -> #153628 -> #153629
```

This branch is **Layer 1 / 4**.

The final integration branch (#153629) contains the deeper
`docs/concepts/liquid-software-factory.md` discussion of the scientific analogy,
control loop, time-scale separation, diversity/correlation, lineage, candidate
capsules, and deferred research ideas.
