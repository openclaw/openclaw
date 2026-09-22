---
summary: "Experimental generic dynamics contract for native Swarm collectors"
title: "Swarm dynamics"
status: experimental
---

# Swarm dynamics

OpenClaw Code Mode can prepare a native collector with a generic dynamics contract:

```javascript
const result = await agents.run("Explore alternate explanations for this failure.", {
  dynamics: { boundary: "isolated" },
});
```

This uses the existing `agents.run` to `sessions_spawn` bridge. Core does not
own names such as explorer, builder, critic, verifier, or glass-breaker. Those are
recipes a caller may choose to build outside the native contract.

The native contract owns only mechanics that need a trusted host boundary:

- which explicit handoff fields survive
- whether existing sandbox admission must be stricter
- whether a candidate digest is required
- whether artifact references are required
- exact launch bytes for replay identity

Calls without `dynamics` keep their existing behavior.

## Contract

```typescript
type DynamicsBoundary = "isolated" | "artifact-only" | "evidence-only" | "summary-only";

type DynamicsRequirement = "optional" | "required";

type DynamicsOptions = {
  boundary: DynamicsBoundary;
  requirements?: {
    sandbox?: "inherit" | "require";
    candidateDigest?: DynamicsRequirement;
    artifactRefs?: DynamicsRequirement;
  };
  handoff?: {
    candidateDigest?: string;
    artifactRefs?: string[];
    evidenceRefs?: string[];
    summary?: string;
  };
};
```

The contract is intentionally monotone with respect to authority: a caller may
ask the existing owner for a stricter sandbox or require more evidence to be
present, but the contract cannot grant tools, credentials, approvals, publication,
merge, or deployment authority.

## Liquid recipes live outside core

The Liquid Software Factory philosophy still uses named trajectories, but they are
ordinary caller-side recipes rather than permanent OpenClaw product vocabulary:

```javascript
const trajectories = {
  explorer: {
    boundary: "isolated",
  },
  builder: {
    boundary: "summary-only",
  },
  critic: {
    boundary: "evidence-only",
  },
  independentVerifier: {
    boundary: "artifact-only",
    requirements: {
      sandbox: "require",
      candidateDigest: "required",
      artifactRefs: "required",
    },
  },
  glassBreaker: {
    boundary: "isolated",
  },
};

const result = await agents.run(
  "Explore a substantially different hypothesis and report uncertainty.",
  { dynamics: trajectories.explorer },
);
```

The role lives in the task and orchestration policy. Core only enforces the
transport/admission contract.

This is the architectural rule:

> The physics is core; the personalities are recipes.

## Artifact-only verification

```javascript
const review = await agents.run("Check this frozen candidate against the acceptance criteria.", {
  dynamics: {
    boundary: "artifact-only",
    requirements: {
      sandbox: "require",
      candidateDigest: "required",
      artifactRefs: "required",
    },
    handoff: {
      candidateDigest: "the-candidate-digest",
      artifactRefs: ["the-available-artifact-reference"],
    },
  },
});
```

The bridge filters the explicit handoff, uses `context: "isolated"`, and passes
`sandbox: "require"` to the existing native spawn owner. Missing sandbox support
is an error; there is no unsandboxed retry.

References are caller-provided data, not fetched automatically or treated as
authority.

## Liquid invariant

Search policy may be heterogeneous and stochastic:

```text
many caller-defined trajectories
          |
          v
   competing candidates
          |
          v
     exact candidate
          |
          v
 generic verification contract
          |
          v
 existing effect authority
```

As work approaches convergence, ambiguity must decrease. Search may be stochastic;
launch identity, replay, sandbox requirements, and eventual effect authority must
not be.

## Trust boundary

Handoff filtering is not a complete independence guarantee. It does not sanitize
the caller's original task, disable shared memory, mount candidate artifacts
read-only, or prove that another permitted tool cannot reach sibling data.

A caller-side recipe describes intent, not an attestation. Existing OpenClaw
admission, sandbox, policy, cancellation, and approval owners remain authoritative.

## Validation

Repository tests cover:

- unchanged calls without dynamics
- generic boundary validation
- boundary/requirement compatibility
- bounded handoff filtering
- exact launch-byte changes when the contract changes
- required-sandbox rejection with no downgrade
- the real `spawnSubagentDirect` admission path with substituted final dispatch

A model-backed collector transcript remains the strongest missing end-to-end proof.

## Related

- [Liquid Software Factory PR stack](/concepts/liquid-software-factory-stack) for the four-layer review topology.
