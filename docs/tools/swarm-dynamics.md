---
summary: "Bounded handoff and exact candidate identity for native Swarm launches"
title: "Swarm dynamics"
status: experimental
---

# Swarm dynamics

The optional `agents.run(..., { dynamics })` contract narrows a native Swarm
launch. It does not allocate agents or add a second scheduler. Existing Swarm
owners still decide admission, sandboxing, execution, cancellation, and replay.

Calls without `dynamics` use the existing path unchanged.

## Contract

```typescript
type DynamicsBoundary = "isolated" | "artifact-only" | "evidence-only" | "summary-only";

type DynamicsOptions = {
  boundary: DynamicsBoundary;
  requirements?: {
    sandbox?: "inherit" | "require";
    candidateDigest?: "optional" | "required";
    artifactRefs?: "optional" | "required";
  };
  handoff?: {
    candidateDigest?: string;
    artifactRefs?: string[];
    evidenceRefs?: string[];
    summary?: string;
  };
  candidate?: {
    version: 1;
    candidateDigest: string;
    sourceDigest: string;
    recipeDigest: string;
    policyDigest: string;
  };
};
```

The contract is monotone with respect to authority. It may request a stricter
existing sandbox or require identity/artifact fields, but it cannot grant tools,
credentials, approvals, publication, merge, or deployment authority.

## Handoff boundaries

- `isolated` drops all explicit dynamics handoff fields.
- `artifact-only` may carry candidate identity and artifact references.
- `evidence-only` may carry candidate identity and evidence references.
- `summary-only` carries only a bounded summary.

OpenClaw rejects requirements that the selected boundary cannot preserve.
References remain caller-provided data. Handoff filtering only controls the
explicit `dynamics.handoff` payload; it is not a sandbox for the original task,
workspace, memory, or tool visibility.

## Exact verifier launch

```javascript
await agents.run("Verify this exact candidate.", {
  thinking: "high",
  dynamics: {
    boundary: "artifact-only",
    requirements: {
      sandbox: "require",
      candidateDigest: "required",
      artifactRefs: "required",
    },
    candidate: {
      version: 1,
      candidateDigest: "candidate:sha256:...",
      sourceDigest: "source:sha256:...",
      recipeDigest: "recipe:sha256:...",
      policyDigest: "policy:sha256:...",
    },
    handoff: {
      artifactRefs: ["artifact:candidate"],
    },
  },
});
```

A dynamics launch uses `context: "isolated"`. When `sandbox: "require"` is
requested, the existing native spawn owner must admit that sandbox or reject the
launch; the bridge does not retry unsandboxed.

The complete candidate/source/recipe/policy manifest is canonically hashed and
bound into the prepared launch before OpenClaw computes its existing replay
fingerprint. Replaying the same request is deterministic; changing the governing
candidate identity rejects reuse of a persisted collector.

Candidate identity proves which exact object was handed to verification. It does
not prove that verification ran, that the verifier was independent, or that the
candidate is correct.

## Per-child compute stays caller-owned

Swarm already supports `model`, `thinking`, and `fastMode` per child. Callers
can combine those existing controls with a dynamics boundary without introducing
a core allocation policy. Role names, search heuristics, and adaptive-budget
controllers belong outside this generic launch contract.
