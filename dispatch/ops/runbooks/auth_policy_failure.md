# Runbook: Auth Policy Failure Spike

Legacy ID retained for history; see `99-Appendix/legacy-id-mapping.md` for the current E/F/S mapping.

Alert code: `AUTH_POLICY_FAILURE_SPIKE`

## Signal

- `GET /ops/alerts` includes `AUTH_POLICY_FAILURE_SPIKE`.
- `signals.auth_policy_rejection_count >= thresholds.auth_policy_rejection_count`.
- Backing error codes include:
  - `FORBIDDEN`
  - `FORBIDDEN_SCOPE`
  - `TOOL_NOT_ALLOWED`
  - `AUTH_REQUIRED`
  - `INVALID_AUTH_TOKEN`
  - `INVALID_AUTH_CLAIMS`

## Triage

1. Confirm alert payload:
   - `curl -s http://127.0.0.1:8080/ops/alerts`
2. Inspect structured error logs for actor role/tool mismatches.
3. Validate JWT issuer/audience/scope claims (production path) or dev header policy in non-prod.

## Remediation

1. Correct actor role/tool usage for the endpoint.
2. Restore valid claim scopes (`account_ids`, `site_ids`) for affected actors.
3. Re-test with one allowed command and one allowed read call.

## Exit Criteria

- Auth policy alert clears.
- No ongoing `FORBIDDEN*`/`AUTH_*` rejection burst in metrics.
