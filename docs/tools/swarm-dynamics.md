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

This uses the existing `agents.run` to `sessions_spawn` bridge. It does not install a
controller service, add a scheduler, change tool permissions, or add dependencies.
Calls without `dynamics` keep their existing behavior.

## Profiles

- `explorer`: broad search with an isolated handoff.
- `builder`: moderate exploration with summary-only handoff coordination.
- `critic`: evidence-oriented challenge.
- `independent-verifier`: artifact-only explicit handoff and a required sandbox.
- `glass-breaker`: a fresh trajectory intended for stalled search.

Effective temperature and mutation budget are search guidance, not model sampling
parameters or enforced filesystem permissions. Model and thinking overrides retain
their existing meanings.

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
Each reference is limited to 512 characters, each reference array to 32 entries,
and a supplied summary to 4096 characters.

The resolved profile, handoff, and host-derived run identities are serialized into
the prepared task before the existing launch fingerprint is computed. A changed
profile or candidate cannot reuse the same persisted launch payload. No new
persistent store or schema is introduced.

## Limits and trust

Handoff filtering is not a complete independence guarantee. It does not sanitize
the caller's original task, disable shared memory, mount candidate artifacts
read-only, or prove that another permitted tool cannot reach sibling data.
The verifier profile name describes its intended role, not an attestation. The
runtime and operator's existing policies must establish any stronger isolation.

The population, verification, and consolidation helpers in the dependent PRs are
experimental assessments; this spawn integration does not automatically execute
population recommendations, attest measurement receipts, approve effects, or
adopt a learned policy. Existing OpenClaw owners retain those responsibilities.

## Validation

The native bridge regression tests exercise profile dispatch, denied admission,
revoked execution, legacy calls, and sandbox errors with mocked execution services.
An isolated Node test harness also exercised unchanged replay and changed-profile
and changed-candidate rejection. These are boundary tests, not a live model or
sandbox qualification. Full repository CI and a live native Swarm run remain
required before claiming end-to-end readiness.
