# Change Checklist: Vault Auth / Secret Wiring

Use before changing Vault role names, auth paths, secret paths, or chart
`job-vault*.yaml` behavior.

## Pre-Change

- Identify affected service, namespace, chart, and secret path.
- Read:
  - `morpho-infra/docs/architecture/vault.md`
  - `morpho-infra/docs/guides/vault-user-guide.md`
  - `morpho-infra/docs/operations/vault-admin-guide.md`
- Inspect chart templates:
  - `rbac-vault.yaml`
  - `job-vault*.yaml`
  - service account annotations / role wiring

## Hard Gates

- No secret path rename without consumer inventory.
- No role rename without verifying service account mapping.
- No auth-path change without proving login still works.
- Never expose raw secret values in logs, comments, or replies.

## Rollout

1. Render helm locally.
2. Verify Vault annotations and target secret names.
3. Validate auth/login path and metadata only.
4. Deploy one env first when possible.
5. Watch job-vault pod completion and dependent workload startup.

## Validation

- Vault login/auth succeeds
- secret materialization job completes
- expected Kubernetes Secret exists
- app pods stop failing on missing env/config
- no restart loop from auth or secret load failures

## Rollback

- revert chart/auth-path/role change
- rerun secret creation job if needed
- keep last known-good secret path and role mapping documented

## Evidence To Save

- rendered annotations
- role name
- secret path metadata
- job logs with values redacted
- app recovery timestamp
