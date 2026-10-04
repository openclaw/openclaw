---
summary: "Bounded Swarm launches for exact candidate verification"
title: "Swarm bounded launches"
status: experimental
---

# Swarm bounded launches

The optional `agents.run(..., { boundedLaunch })` contract makes one Swarm launch
**stricter** than an ordinary collector. It does not create a scheduler or grant
new authority.

Use it when a verification lane must:

- receive only an explicit bounded handoff;
- require the existing sandbox admission path; and/or
- bind an exact candidate binding into the existing replay fingerprint.

Calls without `boundedLaunch` use the existing launch path unchanged.

## Contract

```typescript
type BoundedLaunchBoundary = "isolated" | "artifact-only" | "evidence-only" | "summary-only";

type BoundedLaunchOptions = {
  boundary: BoundedLaunchBoundary;
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
  candidateBinding?: {
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
- `artifact-only` may carry candidate binding and artifact references.
- `evidence-only` may carry candidate binding and evidence references.
- `summary-only` carries only a bounded summary.

OpenClaw rejects requirements that the selected boundary cannot preserve.
References remain caller-provided data. Handoff filtering controls only the
explicit `boundedLaunch.handoff` payload; it is not a sandbox for the original task,
workspace, memory, or tool visibility.

## Exact verifier launch

```javascript
await agents.run("Verify this exact candidate.", {
  thinking: "high",
  boundedLaunch: {
    boundary: "artifact-only",
    requirements: {
      sandbox: "require",
      candidateDigest: "required",
      artifactRefs: "required",
    },
    candidateBinding: {
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

A bounded launch uses `context: "isolated"`. When `sandbox: "require"` is
requested, the existing native spawn owner must admit that sandbox or reject the
launch. The bridge does not retry unsandboxed.

The complete candidate/source/recipe/policy binding is canonically hashed and
included in the prepared launch before OpenClaw computes its existing replay
fingerprint. Replaying the same request is deterministic; changing governing
candidate binding rejects reuse of a persisted collector.

Candidate binding proves which object was handed to verification. It does not
prove that verification ran, that the verifier was independent, or that the
candidate is correct.

## Architecture boundary

`boundedLaunch` is the freeze/seal measurement seam, not a population
controller:

`explore -> select -> freeze/seal exact candidate -> bounded launch -> verify`

Caller or plugin policy may adapt model, thinking level, fast mode, search width,
or verification intensity from novelty, disagreement, correlation, and resource
pressure. Core does not own that policy. One conservation rule holds: compute may
vary; authority may not increase.

## Ownership

Existing OpenClaw owners remain authoritative:

- native `sessions_spawn` owns admission and execution;
- the existing sandbox path owns `sandbox: "require"`;
- the existing registry owns replay/idempotency;
- existing tool policy and source-execution guards are unchanged;
- approval, publish, merge, and deploy remain external.

This feature is intentionally only the generic bounded-launch primitive.
Adaptive population/search policy is a separate concern and is not part of this
contract. In statistical-physics terms, search may stay high-entropy while policy
changes compute budget or sampling temperature; this contract begins only after
one candidate is frozen/sealed for measurement. Those control variables remain
caller/plugin policy, not launch authority.
