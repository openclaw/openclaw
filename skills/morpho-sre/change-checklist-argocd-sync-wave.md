# Change Checklist: ArgoCD Sync Wave / Ordering

Use before changing sync waves, hook annotations, or resource ordering in helm
templates.

## Pre-Change

- Identify all ordered resources:
  service accounts, RBAC, secrets, vault jobs, migrations, deployments, HPA,
  ingress, DB objects.
- Read:
  - `morpho-infra/docs/operations/ci-cd-workflow.md`
  - `morpho-infra/docs/operations/incident-response.md`
- Inspect current chart annotations:
  - `argocd.argoproj.io/sync-wave`
  - `helm.sh/hook*`
  - `argocd.argoproj.io/sync-options`

## Hard Gates

- Do not move secret/materialization resources after consumers.
- Do not move migration jobs after app rollout when schema compatibility is not guaranteed.
- Do not change multiple ordering layers blindly (`sync-wave` + hooks + replace/force).

## Rollout

1. Render helm before/after.
2. Produce Argo diff.
3. Confirm dependency order explicitly:
   RBAC -> secret job -> migrations -> deployments/services.
4. Watch first sync in target env.

## Validation

- Argo sync completes without ordering-related failure
- migration jobs run before app pods need new schema
- secret jobs finish before dependent deployments start
- no crash loops from missing secret/config/schema

## Rollback

- revert annotation/order change
- resync app
- if partial rollout happened, restart only after prerequisites are healthy

## Evidence To Save

- before/after rendered annotations
- Argo diff excerpt
- sync timeline
- first failing resource, if any
