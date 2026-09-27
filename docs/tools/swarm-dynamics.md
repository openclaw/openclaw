---
summary: "Bounded Swarm launches for exact candidate verification"
title: "Swarm bounded launches"
status: experimental
---

# Swarm bounded launches

The optional `agents.run(..., { dynamics })` contract makes one Swarm launch
**stricter** than an ordinary collector. It does not create a scheduler or grant
new authority.

Use it when a verification lane must:

- receive only an explicit bounded handoff;
- require the existing sandbox admission path; and/or
- bind an exact candidate identity into the existing replay fingerprint.

Calls without `dynamics` use the existing launch path unchanged.

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

The contract is monotone with respect to authority. It can drop information or
request stricter admission, but it cannot grant tools, credentials, approval,
publication, merge, or deployment authority.

## Handoff boundaries

- `isolated` drops every explicit handoff field.
- `artifact-only` may carry candidate identity and artifact references.
- `evidence-only` may carry candidate identity and evidence references.
- `summary-only` carries only a bounded summary.

OpenClaw rejects requirements that the selected boundary cannot preserve.
References remain caller-provided data. Handoff filtering controls only the
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
launch. The bridge does not retry unsandboxed.

The complete candidate/source/recipe/policy manifest is canonically hashed and
included in the prepared launch before OpenClaw computes its existing replay
fingerprint. Replaying the same request is deterministic; changing governing
candidate identity rejects reuse of a persisted collector.

Candidate identity proves which object was handed to verification. It does not
prove that verification ran, that the verifier was independent, or that the
candidate is correct.

## Ownership

Existing OpenClaw owners remain authoritative:

- native `sessions_spawn` owns admission and execution;
- the existing sandbox path owns `sandbox: "require"`;
- the existing registry owns replay/idempotency;
- existing tool policy and source-execution guards are unchanged;
- approval, publish, merge, and deploy remain external.

This feature is intentionally only the generic bounded-launch primitive.
Adaptive population/search policy is a separate concern and is not part of this
contract.
