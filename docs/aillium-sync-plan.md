# Aillium OpenClaw sync and boundary plan

## Current fork state

This fork is already close to upstream OpenClaw in executable code paths.

- The latest merge commit is `919f1c5` (`Merge branch 'openclaw:main' into main`).
- Comparing the upstream-merge parent to current `HEAD` shows local deltas only in fork identity/legal docs:
  - `AI_GUARDRAILS.AILLIUM.md`
  - `CODEOWNERS`
  - `LICENSE`
  - `NOTICE`
  - `README.AILLIUM.md`
  - `README.md`
  - `SECURITY.AILLIUM.md`

No runtime `src/` divergence is currently detected from that upstream merge baseline.

## Upstream capabilities already present

Because runtime code is effectively upstream-aligned at this baseline, the fork already has OpenClaw capabilities in place for:

- agent runtime and orchestration flow
- gateway lifecycle/status surfaces
- hooks framework (including bundled hooks)
- context engine and registration model
- plugin channel architecture

## Missing vs current upstream (practical gap list)

Given no direct network fetch to GitHub in this environment, treat this as an operational process gap rather than an identified code gap:

1. Add/restore a durable `upstream` remote and automate periodic fetch/rebase windows.
2. Run regular compatibility checks (`pnpm build`, `pnpm test`) after each upstream sync.
3. Track fork-only files in a dedicated `src/aillium/` boundary area to prevent future deep edits across core modules.

## Aillium integration boundaries

Introduce thin adapters only:

- contract adapters: map payloads between OpenClaw runtime contracts and Aillium Core contracts
- evidence callback hooks: relay auditable execution evidence externally
- tenant/session metadata passthrough: pass metadata through without owning tenancy semantics
- runtime registration adapter: register runtime identity/capabilities with Aillium Core

Do not move tenancy, policy ownership, or approvals into OpenClaw.

## TARS or TARS-desktop scope reduction with OpenClaw

OpenClaw can replace prior orchestration responsibilities with built-in features:

- runtime command orchestration and model-provider dispatch
- hooks and event surfaces for evidence emission
- gateway process/health/status plumbing
- extensible channels/plugins for execution surfaces

Keep outside OpenClaw:

- enterprise tenancy ownership
- policy decision authority
- approval workflows and governance

## Patch plan

1. Keep core OpenClaw modules upstream-clean.
2. Isolate Aillium code under `src/aillium/`.
3. Wire adapters at composition boundaries only (CLI/bootstrap startup deps), avoiding direct edits in command logic whenever possible.
4. Add integration tests around adapter contracts (not policy behavior).
5. Enforce this separation in code review: reject deep Aillium edits in core runtime paths.

## Reusable upstream-aligned files

- Most files under `src/`, `docs/`, and test suites remain reusable as upstream-aligned.

## Local Aillium-specific files to isolate

- `src/aillium/contracts.ts`
- `src/aillium/defaults.ts`
- `src/aillium/index.ts`
- Existing legal/identity files (`README.AILLIUM.md`, `NOTICE`, `SECURITY.AILLIUM.md`, `AI_GUARDRAILS.AILLIUM.md`, `CODEOWNERS`)

## Obsolete or redundant local code

As of this snapshot, there is no extra deep runtime fork code to retire.

If future Aillium logic appears in core modules, migrate it into `src/aillium/` adapters and remove embedded copies.

## Risks and upgrade notes

- Remote availability risk: inability to fetch upstream blocks precise ahead/behind accounting.
- Drift risk grows if Aillium behavior is added directly to core command/router modules.
- Contract risk: adapter contract changes should be versioned and tested to avoid breaking Aillium Core integration.

## Concrete module overlap and sync impact

For concrete classification and sync ownership, see `docs/aillium-module-inventory.md`.

Operational rule:

1. Keep upstream updates flowing into `upstream-owned` modules with minimal fork edits.
2. Keep Aillium-specific behavior restricted to `src/aillium/*` and composition entry points.
3. Treat `deprecated-risk` files as planning/docs only; do not expand them into runtime forks.
