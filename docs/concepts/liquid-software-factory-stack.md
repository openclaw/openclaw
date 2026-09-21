---
summary: "How the four Liquid Software Factory Swarm PRs fit together"
title: "Liquid Software Factory PR stack"
status: experimental
---

# Liquid Software Factory PR stack

This experiment is split into four reviewable layers. Each layer adds one
mechanical boundary while existing OpenClaw owners retain effect authority.

> Search can be stochastic. Promotion cannot be accidental.

```text
Layer 1                    Layer 2                  Layer 3                 Layer 4
#153625                    #153627                  #153628                 #153629

generic dynamics      ->   mixed local phases  ->   exact candidate   ->   diagnostics +
handoff/admission          search-only advisory     identity/replay        lifecycle/folding
contract                    host observations        binding                integration view

high search entropy ----------------------------------------------------> low ambiguity
search-only -----------------------------------------------------------> existing authority
```

## The four PRs

1. **#153625 — generic launch contract**
   - bounded explicit handoff
   - information boundary selection
   - monotone requirements for sandbox, candidate identity, and artifact references
   - required sandbox delegates to the existing native sandbox owner
   - no role/personality vocabulary in core
   - no unsandboxed downgrade

2. **#153627 — host-observed population dynamics**
   - local gas/liquid/critical/crystal/glass/jammed/unknown assessment
   - conservative pressure handling
   - search-only spawn/measure/freeze/perturb/drain/hold recommendations
   - parent-owned observer lifetime
   - phase vocabulary is experimental search policy, not permission

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

## Caller-side Liquid recipes

Liquid trajectories such as explorer, builder, critic, independent verifier, and
glass breaker are **recipes outside the core API**. They can be expressed by task
prompts plus the generic dynamics contract.

The architectural rule is:

> The physics is core; the personalities are recipes.

For example, an independent-verification recipe can choose an artifact-only
boundary and require the existing sandbox owner, a candidate digest, and artifact
references. OpenClaw enforces those mechanics without adopting the recipe name as
product vocabulary.

## Cross-layer invariants

All four layers share the same constraints:

- search policy never grants effect authority
- the generic contract can only preserve or tighten existing admission requirements
- caller-side recipe names are not principals, permissions, or attestations
- unknown telemetry stays unknown
- local saturation is not averaged away
- disagreement creates measurement demand
- candidate identity becomes stricter toward convergence
- replay is identity-bound and idempotent
- every retained state has a lifecycle owner
- required verifier isolation fails closed
- diagnostics and controller outputs remain search-only
- existing OpenClaw owners retain tools, credentials, approval, merge, publish, and deployment authority

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
