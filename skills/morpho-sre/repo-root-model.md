# Repo Root Model

Treat the runtime as a shared repo root with sibling checkouts.

## Rule

- Do not reason from literal `/srv/openclaw/repos/...` paths alone.
- Do not reason from literal developer-specific host paths alone.
- First resolve the merged repo root and per-repo env vars.
- In the container, both local dev and seeded skill logic expect sibling repos
  under one root.

## Canonical Env Vars

- `OPENCLAW_SRE_REPO_ROOT`
  shared parent dir for repo checkouts
- `OPENCLAW_SRE_REPO_DIR`
  runtime repo checkout
  `seed-state.sh` also accepts legacy `OPENCLAW_SRE_RUNTIME_REPO_DIR`
- `MORPHO_INFRA_DIR`
  infra docs / Terraform / service metadata
- `MORPHO_INFRA_HELM_DIR`
  Helm charts / values / Argo-facing config

## Mental Model

- Runtime behavior, agent code, memory code:
  `${OPENCLAW_SRE_REPO_DIR}`
- Infra architecture and operations docs:
  `${MORPHO_INFRA_DIR}/docs`
- Helm source of truth for Kubernetes app config:
  `${MORPHO_INFRA_HELM_DIR}/charts`

## Practical Resolution

When a doc, script, or config mentions a literal host path:

1. reinterpret it as `${OPENCLAW_SRE_REPO_ROOT}/...`
2. prefer the explicit per-repo env var if available
3. only fall back to the literal host path when running on the same machine or
   environment that originally used that path

## Common Cases

- OpenClaw docs:
  `${OPENCLAW_SRE_REPO_DIR}/docs`
- Morpho infra docs:
  `${MORPHO_INFRA_DIR}/docs`
- OpenClaw SRE chart:
  `${MORPHO_INFRA_HELM_DIR}/charts/openclaw-sre`
- Seed skill docs:
  `${OPENCLAW_SRE_REPO_DIR}/skills/morpho-sre`
- Prime frontend apps (curator, delegate, liquidation, markets):
  `${OPENCLAW_SRE_REPO_ROOT}/morpho-org/prime-monorepo` or `gh repo view morpho-org/prime-monorepo`
  Apps: `apps/curator-app`, `apps/curator-v2-app`, `apps/curator-rpc-api`, `apps/delegate-app`, `apps/liquidation-app`, `apps/markets-v2-app`, `apps/ui-app`
  Shared packages: `packages/web3`, `packages/ui`, `packages/utils`, `packages/hooks`, `packages/abis`

## Failure Mode

Bad assumption:

- "that path does not exist, so the knowledge is stale"

Better assumption:

- "the runtime is using a relocated shared repo root; derive the sibling path
  from env before concluding anything is missing"
