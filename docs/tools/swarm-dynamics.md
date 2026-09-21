---
summary: "Experimental opt-in cognitive profiles for native Swarm collectors"
title: "Swarm cognitive dynamics"
status: experimental
---

# Swarm cognitive dynamics

OpenClaw Code Mode can prepare a native collector with a versioned cognitive profile:

```javascript
const result = await agents.run("Explore alternate explanations for this failure.", {
  dynamics: { profile: "explorer" },
});
```

This uses the existing `agents.run` to `sessions_spawn` bridge. It does not
install a controller service, add a scheduler, change tool permissions, or add
dependencies. Calls without `dynamics` keep their existing behavior.

## Profiles

- `explorer`: broad search with an isolated handoff.
- `builder`: moderate exploration with summary-only handoff coordination.
- `critic`: evidence-oriented challenge.
- `independent-verifier`: artifact-only explicit handoff and a required sandbox.
- `glass-breaker`: a fresh trajectory intended for stalled search.

Effective temperature and mutation budget are search guidance, not model sampling
parameters or enforced filesystem permissions.

Profiles are **execution trajectories, not permissions**. Their native value is
that OpenClaw can bind the chosen trajectory into the prepared launch, constrain
the explicit handoff, and require the existing sandbox owner for the verifier path.

## The Liquid invariant

The search side is allowed to be heterogeneous and nondeterministic:

```text
explorer -> builder -> critic
    \          |         /
     \      competing   /
      +---- candidates -+
               |
               v
        exact candidate
               |
               v
     independent verifier
```

As work approaches convergence, ambiguity must decrease. Search may be stochastic;
launch identity, replay, sandbox requirements, and eventual effect authority must
not be.

## Verifier handoff

```javascript
const review = await agents.run("Check this candidate against the stated acceptance criteria.", {
  dynamics: {
    profile: "independent-verifier",
    handoff: {
      candidateDigest: "the-candidate-digest",
      artifactRefs: ["the-available-artifact-reference"],
    },
  },
});
```

The bridge filters the explicit handoff, uses `context: "isolated"`, and derives
sandbox/evidence enforcement from the resolved profile requirements. For the
verifier preset those requirements pass `sandbox: "require"` to the existing
native spawn owner and require candidate/artifact handoff. Missing sandbox support
is an error; it never silently retries without a sandbox.

References are caller-provided data, not fetched automatically or treated as authority.

## Trust boundary

Handoff filtering is not a complete independence guarantee. It does not sanitize
the caller's original task, disable shared memory, mount candidate artifacts
read-only, or prove that another permitted tool cannot reach sibling data.

The verifier profile name describes its intended role, not an attestation. Existing
OpenClaw admission, sandbox, policy, cancellation, and approval owners remain
authoritative.

The current layer does not attest measurements, approve effects, merge code,
publish artifacts, or adopt policy.

## Validation

Repository tests cover deterministic profile resolution, bounded handoff filtering,
replay/source-revocation behavior, unchanged legacy calls, and refusal to downgrade
a sandbox-required verifier.

A real native collector transcript remains the strongest missing end-to-end proof.

## Related

- [Liquid Software Factory PR stack](/concepts/liquid-software-factory-stack) for the four-layer review topology.
