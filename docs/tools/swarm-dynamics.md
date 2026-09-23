---
summary: "Bounded Swarm launches plus search-only population energetics"
title: "Swarm dynamics"
status: experimental
---

# Swarm dynamics

OpenClaw dynamics has two deliberately separate layers:

1. a **bounded launch contract** that narrows one native Swarm launch and binds exact candidate identity;
2. a **search-only energetic model** that treats a heterogeneous multi-agent population as a dynamical system and actuates the next child launch through existing Swarm controls.

Neither layer owns admission, sandboxing, execution authority, cancellation, approvals, publication, merge, or deployment.

Calls without `dynamics` use the existing launch path unchanged.

## The dynamical-system model

The point of dynamics is not a role catalog and not one global "phase" for the whole swarm.

Each replica may occupy a different energetic state:

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

where stochasticity is useful during exploration but candidate identity becomes progressively stricter toward verification.

### Energy is not temperature

This distinction is fundamental.

| Quantity | Meaning for an agent | Example |
| --- | --- | --- |
| **energy** | compute committed to reasoning: depth, model cost, tool work, iteration budget | a verifier using expensive reasoning |
| **temperature** | exploratory freedom: perturbation, diversity, willingness to leave a local basin | a cheap broad explorer |

A verifier can therefore be **high-energy / low-temperature**. A broad explorer can be **low-energy / high-temperature**. A swarm can also be high-energy but trapped: the analogue of a glass.

OpenClaw already exposes caller-owned per-child compute controls such as `model`, `thinking`, and `fastMode`. Temperature is not a permission and is not currently promoted to a new universal core execution knob; it is an observed or policy-level search variable.

### Local energetic regimes

The experimental controller in `population-energetics.ts` classifies local control regimes:

- **gas** — high-temperature, decorrelated exploration;
- **liquid** — mobile search with partial coordination;
- **critical** — disagreement or high susceptibility makes another measurement unusually informative;
- **crystal** — low-temperature, low-mobility state with enough evidence to freeze;
- **glass** — substantial compute is trapped in correlated low-mobility search;
- **jammed** — resource pressure dominates useful search;
- **unknown** — telemetry is insufficient.

These regimes are local. One lane can crystallize while another remains gaseous and a third becomes glassy.

The controller returns only search advisories:

- `measure` — buy discriminating evidence at a critical disagreement;
- `deepen` — raise reasoning energy without raising exploratory temperature;
- `reheat` — increase diversity/perturbation instead of pouring more compute into a trapped basin;
- `freeze` — stop mutating a stable candidate and hand it to exact verification;
- `drain` — remove pressure before expanding;
- `hold` — preserve the current search posture.

The controller never gains execution authority, but its plan is now applied to the next native child launch before admission. Energy changes the actual reasoning budget (`thinking` / `fastMode`), while temperature and regime change the injected task posture. `critical` lanes deepen, `glass` lanes are explicitly decorrelated, `crystal` lanes are told not to mutate the candidate, and a `jammed` lane is not submitted at all. The existing native spawn owner still admits or rejects every launch.

### Effective population matters more than raw agent count

Ten highly correlated replicas are not ten independent searches.

For a roughly exchangeable population, the implementation reports the diagnostic heuristic:

```text
N_effective = N / (1 + (N - 1) * rho)
```

where `rho` is mean measured correlation.

This is not a permission boundary or a proof of statistical independence. It expresses the control objective: spend compute on independent information, not merely more replicas.

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

The contract is monotone with respect to authority. It may request a stricter existing sandbox or require identity/artifact fields, but it cannot grant tools, credentials, approvals, publication, merge, or deployment authority.

### Energetic actuation

When `dynamics.energetics` is present, the measured state changes the child that is actually sent to `sessions_spawn`:

- normalized **energy** maps to the native compute controls: low -> `thinking: "low", fastMode: true`; medium -> `thinking: "medium", fastMode: "auto"`; high -> `thinking: "high", fastMode: false`;
- a **critical** measurement forces `thinking: "high"` and `fastMode: false` and injects a discriminating-measurement directive;
- a **glass** injects a decorrelation/reheating directive instead of blindly increasing reasoning depth;
- a **crystal** forces deep, non-mutating verification posture;
- a **jammed** target suppresses the launch before native dispatch;
- high/low **temperature** changes the search posture in the task while remaining distinct from energy.

If the caller supplied `thinking` or `fastMode` and measured energetics requires a stronger transition, the energetic plan is applied last and therefore changes the real child launch. Calls without `energetics` preserve the caller's existing controls.

`peers` lets the same control law see a bounded population snapshot. Correlation can therefore reduce effective population size and trigger a decorrelation action for the target lane.

This actuates **the next launch**; it does not mutate an already-running model turn in place.

## Handoff boundaries

- `isolated` drops all explicit dynamics handoff fields.
- `artifact-only` may carry candidate identity and artifact references.
- `evidence-only` may carry candidate identity and evidence references.
- `summary-only` carries only a bounded summary.

OpenClaw rejects requirements that the selected boundary cannot preserve.
References remain caller-provided data. Handoff filtering only controls the explicit `dynamics.handoff` payload; it is not a sandbox for the original task, workspace, memory, or tool visibility.

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

A dynamics launch uses `context: "isolated"`. When `sandbox: "require"` is requested, the existing native spawn owner must admit that sandbox or reject the launch; the bridge does not retry unsandboxed.

The complete candidate/source/recipe/policy manifest is canonically hashed and bound into the prepared launch before OpenClaw computes its existing replay fingerprint. Replaying the same request is deterministic; changing the governing candidate identity rejects reuse of a persisted collector.

Candidate identity proves which exact object was handed to verification. It does not prove that verification ran, that the verifier was independent, or that the candidate is correct.

## Search becomes colder toward promotion

The intended asymmetry is:

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

> OpenClaw should not merely run a swarm; it should reshape the swarm by moving agents between different energy/temperature regimes, spending compute where measured novelty, uncertainty, disagreement, and correlation make the next unit of reasoning most valuable, then crystallize exact candidates for deterministic verification.

The energetic controller is search-only, but it is no longer diagnostic-only: its plan changes the next child launch end to end. Existing OpenClaw owners still decide whether that changed launch is admitted and retain all sandbox, tool, approval, publication, merge, and deployment authority.
