# Aillium OpenClaw module inventory

This inventory classifies current modules for upstream sync safety and Aillium boundary placement.

## Classification legend

- `upstream-owned`: keep closely synced with upstream OpenClaw
- `aillium-adapter`: fork-only boundary surface for Aillium integration
- `deprecated-risk`: local docs/patterns that can cause drift if expanded

## Module classification (structured)

```json
[
  {
    "module": "src/aillium",
    "classification": "aillium-adapter",
    "sync": "fork-owned",
    "tarsOverlap": "Aillium bridge only"
  },
  {
    "module": "src/acp",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "session runtime control"
  },
  {
    "module": "src/agents",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "agent orchestration"
  },
  {
    "module": "src/browser",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "UI automation substrate"
  },
  {
    "module": "src/channels",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "delivery/routing"
  },
  {
    "module": "src/cli",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "operator runtime controls"
  },
  {
    "module": "src/commands",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "run lifecycle commands"
  },
  {
    "module": "src/context-engine",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "tool/context registration"
  },
  {
    "module": "src/cron",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "scheduled execution"
  },
  {
    "module": "src/gateway",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "runtime gateway"
  },
  {
    "module": "src/hooks",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "evidence/event hooks"
  },
  {
    "module": "src/plugins",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "execution adapters"
  },
  {
    "module": "src/process",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "process supervision"
  },
  {
    "module": "src/providers",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "model/provider dispatch"
  },
  {
    "module": "src/routing",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "decision routing"
  },
  {
    "module": "src/sessions",
    "classification": "upstream-owned",
    "sync": "track upstream closely",
    "tarsOverlap": "session lifecycle"
  },
  {
    "module": "README.AILLIUM.md",
    "classification": "deprecated-risk",
    "sync": "fork-owned docs only",
    "tarsOverlap": "architecture policy narrative"
  },
  {
    "module": "docs/aillium-sync-plan.md",
    "classification": "deprecated-risk",
    "sync": "fork-owned docs only",
    "tarsOverlap": "migration planning"
  },
  {
    "module": "docs/aillium-module-inventory.md",
    "classification": "aillium-adapter",
    "sync": "fork-owned docs only",
    "tarsOverlap": "inventory source"
  }
]
```

## High-confidence sync zones

Safest to keep upstream-first with minimal local edits:

- `src/acp`, `src/agents`, `src/browser`, `src/channels`, `src/cli`, `src/commands`
- `src/context-engine`, `src/cron`, `src/gateway`, `src/hooks`
- `src/plugins`, `src/process`, `src/providers`, `src/routing`, `src/sessions`

## Aillium-wrapped zones

Keep local customization constrained to:

- `src/aillium/*` (adapter contracts/default implementations)
- fork governance/legal docs (`README.AILLIUM.md`, `NOTICE`, `SECURITY.AILLIUM.md`, `AI_GUARDRAILS.AILLIUM.md`, `CODEOWNERS`)

## Fork-drift hotspots

- Cross-cutting edits in `src/commands/*` and `src/gateway/*` for Aillium-specific workflows.
- Embedding tenancy or policy decisions in `src/routing/*`, `src/channels/*`, or `src/sessions/*`.
- Runtime payload shape changes made outside `src/aillium/contracts.ts`.

## TARS and TARS-desktop replacement map

### Mostly redundant now (covered by OpenClaw)

- Runtime command orchestration and CLI-driven execution flow (`src/commands`, `src/cli`).
- Agent and ACP run/session control plane primitives (`src/agents`, `src/acp`, `src/sessions`).
- Gateway lifecycle and status plumbing (`src/gateway`).
- Hook/event infrastructure for post-run evidence signals (`src/hooks`).
- Channel routing and delivery adapters (`src/channels`, `src/routing`, `src/plugins`).

### Still unique or temporarily necessary outside OpenClaw

- Enterprise tenancy ownership and policy authority (Aillium Core only).
- Approval governance and exception workflows (Aillium Core only).
- MeshCentral-specific remote-support ownership/inventory semantics.
- Enterprise evidence retention/compliance controls beyond hook emission.

## Notes

- `src/UNKNOWN.egg-info/` is present but untracked and not part of this inventory.
