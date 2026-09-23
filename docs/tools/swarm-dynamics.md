---
summary: "Bounded Swarm launches plus search-only population energetics"
title: "Swarm dynamics"
status: experimental
---

# Swarm dynamics

OpenClaw dynamics has two deliberately separate layers:

1. A **bounded launch contract** narrows one native Swarm launch and binds exact candidate identity.
2. A **search-only energetic model** treats a heterogeneous multi-agent population as a dynamical system and actuates the next child launch through existing Swarm controls.

Neither layer owns admission, sandboxing, execution authority, cancellation, approvals, publication, merge, or deployment.

Calls without `dynamics` use the existing launch path unchanged.

## The dynamical-system model

Dynamics is not a role catalog and not one global phase for the whole swarm. Each replica can occupy a different energetic state:

```text
x_i(t) = {
  E_i,   compute energy / reasoning intensity
  T_i,   exploratory temperature
  m_i,   mobility
  n_i,   novelty rate
  e_i,   evidence completeness
  d_i,   verifier disagreement
  rho_i, correlation
  chi_i, perturbation susceptibility
  p_i    resource pressure
}
```

The population evolves through measured feedback:

```text
X_t --measure--> M(X_t) --search-only control--> a_t --existing owners--> X_(t+1)
```

Conceptually:

```text
X_(t+1) = F(X_t, a_t, noise_t)
```

Stochasticity is useful during exploration, while candidate identity becomes progressively stricter toward verification.

### Energy is not temperature

**Energy** is compute committed to reasoning: depth, model cost, tool work, and iteration budget.

**Temperature** is exploratory freedom: perturbation, diversity, and willingness to leave a local basin.

A verifier can therefore be **high-energy / low-temperature**. A broad explorer can be **low-energy / high-temperature**. A swarm can also be high-energy but trapped: the analogue of a glass.

OpenClaw already exposes per-child compute controls such as `model`, `thinking`, and `fastMode`. Temperature is not a permission and is not a new universal sampling control. It is an observed search variable that changes the next child's task posture.

### Local energetic regimes

The controller in `population-energetics.ts` classifies local control regimes:

- **gas** — high-temperature, decorrelated exploration
- **liquid** — mobile search with partial coordination
- **critical** — disagreement or high susceptibility makes another measurement unusually informative
- **crystal** — low-temperature, low-mobility state with enough evidence to freeze
- **glass** — substantial compute is trapped in correlated low-mobility search
- **jammed** — resource pressure dominates useful search
- **unknown** — telemetry is insufficient

These regimes are local. One lane can crystallize while another remains gaseous and a third becomes glassy.

The control law can recommend:

- `measure` — buy discriminating evidence at a critical disagreement
- `deepen` — raise reasoning energy without raising exploratory temperature
- `reheat` — increase diversity instead of pouring more compute into a trapped basin
- `freeze` — stop mutating a stable candidate and hand it to exact verification
- `drain` — remove pressure before expanding
- `hold` — preserve the current search posture

The controller never gains independent execution authority. Its plan is applied to the next native child launch before admission. Energy changes the actual reasoning budget through `thinking` and `fastMode`; temperature and regime change the injected task posture. Critical lanes deepen, glassy lanes are explicitly decorrelated, crystalline lanes are told not to mutate the candidate, and jammed lanes are not submitted. The existing native spawn owner still admits or rejects every launch.

### Effective population matters more than raw agent count

Ten highly correlated replicas are not ten independent searches. For a roughly exchangeable population, the implementation reports this diagnostic heuristic:

```text
N_effective = N / (1 + (N - 1) * rho)
```

Here `rho` is mean measured correlation. This is not a permission boundary or proof of statistical independence. It expresses the control objective: spend compute on independent information, not merely more replicas.

## Bounded launch contract

The optional `agents.run(..., { dynamics })` contract narrows a native Swarm launch. It does not create another scheduler.

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
  energetics?: {
    energy?: number | null;
    temperature?: number | null;
    mobility?: number | null;
    noveltyRate?: number | null;
    evidenceCompleteness?: number | null;
    verifierDisagreement?: number | null;
    correlation?: number | null;
    susceptibility?: number | null;
    resourcePressure?: number | null;
    peers?: Array<{
      replicaId: string;
      energy?: number | null;
      temperature?: number | null;
      mobility?: number | null;
      noveltyRate?: number | null;
      evidenceCompleteness?: number | null;
      verifierDisagreement?: number | null;
      correlation?: number | null;
      susceptibility?: number | null;
      resourcePressure?: number | null;
    }>;
  };
};
```

The contract is monotone with respect to authority. It may request a stricter existing sandbox or require identity or artifact fields, but it cannot grant tools, credentials, approvals, publication, merge, or deployment authority.

### Energetic actuation

When `dynamics.energetics` is present, measured state changes the child sent to `sessions_spawn`:

- low energy maps to `thinking: "low"` and `fastMode: true`
- medium energy maps to `thinking: "medium"` and `fastMode: "auto"`
- high energy maps to `thinking: "high"` and `fastMode: false`
- critical state forces deep reasoning and a discriminating-measurement directive
- glass state injects a decorrelation and reheating directive instead of blindly increasing reasoning depth
- crystal state forces a deep, non-mutating verification posture
- jammed state suppresses the launch before native dispatch
- high or low temperature changes search posture while remaining distinct from energy

If the caller supplies `thinking` or `fastMode` and measured energetics requires a stronger transition, the energetic plan is applied last and changes the real child launch. Calls without `energetics` preserve the caller's existing controls.

The optional `peers` array supplies a bounded population snapshot. Correlation can therefore reduce effective population size and trigger a decorrelation action for the target lane.

This actuates **the next launch**. It does not mutate an already-running model turn in place.

## Handoff boundaries

- `isolated` drops all explicit dynamics handoff fields
- `artifact-only` may carry candidate identity and artifact references
- `evidence-only` may carry candidate identity and evidence references
- `summary-only` carries only a bounded summary

OpenClaw rejects requirements that the selected boundary cannot preserve. References remain caller-provided data. Handoff filtering only controls the explicit `dynamics.handoff` payload; it is not a sandbox for the original task, workspace, memory, or tool visibility.

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

A dynamics launch uses `context: "isolated"`. When `sandbox: "require"` is requested, the existing native spawn owner must admit that sandbox or reject the launch. The bridge does not retry unsandboxed.

The complete candidate, source, recipe, and policy manifest is canonically hashed and bound into the prepared launch before OpenClaw computes its existing replay fingerprint. Replaying the same request is deterministic; changing the governing candidate identity rejects reuse of a persisted collector.

Candidate identity proves which exact object was handed to verification. It does not prove that verification ran, that the verifier was independent, or that the candidate is correct.

## Search becomes colder toward promotion

```text
many cheap hot trajectories
        |
        v
local measurements and interactions
        |
        v
critical disagreements get expensive reasoning
        |
        v
promising states cool and crystallize
        |
        v
exact candidate identity
        |
        v
independent deterministic verification
```

In short:

> OpenClaw should not merely run a swarm; it should reshape the swarm by moving agents between different energy and temperature regimes, spending compute where measured novelty, uncertainty, disagreement, and correlation make the next unit of reasoning most valuable, then crystallize exact candidates for deterministic verification.

The energetic controller is search-only, but it is no longer diagnostic-only: its plan changes the next child launch end to end. Existing OpenClaw owners still decide whether that changed launch is admitted and retain all sandbox, tool, approval, publication, merge, and deployment authority.
