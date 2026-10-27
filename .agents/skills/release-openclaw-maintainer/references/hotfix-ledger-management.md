# Hotfix ledger management

Prefer `https://hotfix-ledger.openclaw.ai` for shared candidates and per-release
assessments. Keep scan inventories, approvals, and validation receipts in existing
release evidence; link them rather than copying everything into the service.
No separate skill installation or additional release gate is needed.

## Access

Check secret metadata first; installing a skill does not provision credentials.
Managed bindings map to headers as follows:

| Binding                                 | Header                    |
| --------------------------------------- | ------------------------- |
| `HOTFIX_LEDGER_CF_ACCESS_CLIENT_ID`     | `CF-Access-Client-Id`     |
| `HOTFIX_LEDGER_CF_ACCESS_CLIENT_SECRET` | `CF-Access-Client-Secret` |

Use Gateway-hosted execution (`gateway_exec` in Codex), with protected egress
enabled and both bindings allowing `hotfix-ledger.openclaw.ai`. Its injected
variables are opaque sentinels, not plaintext; pass them unchanged in headers.
Native shell, sandbox, and remote-node commands do not inherit these bindings.
Without bindings, use hotfix ledger credentials from the local credential
manager. Keep values out of model context, logs, and artifacts. If stored as
`Header-Name: value`, strip the matching prefix and whitespace inside the loader;
do not alter managed sentinels. If credentials are unavailable, use the local
fallback.

Send `Accept: application/json` and an identifying User-Agent, e.g.
`OpenClaw-Release/1.0`. Authenticated `/v1/health`, `/v1/capabilities`, and
`/v1/openapi.json` provide availability, permissions, and the current contract.

## Recommended flow

1. **Resolve:** find the intended repository/release/branch before creating a
   release record; reuse it on resume. Record version, ref, and observed head.
   The API supports beta/stable channels: represent extended-stable as `stable`
   with its track explicit in `releaseKey`, `name`, and `gitRef`.
2. **Discover:** load candidates, target assessments, and blocked carry-forward
   work. Continue pinned-main, sibling-release, P0/P1, and authorized security
   discovery. Prior assessments and automation suggestions are evidence, not
   completeness or applicability proof for this baseline.
3. **Assess/select:** deduplicate by `sourceUnitKey` and source refs; record the
   smallest complete fix/group, impact, eligibility, dependencies, and evidence.
   Upsert its target-release assessment at the assessed SHA. Keep existing
   selection authority; eligibility or clean application is not approval.
4. **Apply/verify:** follow the approved backport flow; record destination commits
   and proof. Update the observed head and review stale assessments rather than
   merely replacing their SHA. Keep deferred/blocked work for the next owner.
5. **Handoff:** link the release ID, assessed SHA, scan/selection evidence, and any
   unsynced decisions. Archive inactive releases rather than deleting history.

### Per-release assessment fields

Keep source commits on the shared hotfix; update application details on its
assessment for the target release:

- `applicability`: `unknown`, `needed`, `already_present`, or `not_affected`.
- `handling`: `unknown`, `straightforward`, `adaptation_required`, or `blocked`.
- `notes`: proposed/approved/included/deferred/skipped disposition and why.
- `adaptationDetails`: conflicts, code changes, or deviations from the source fix.
- `destinationCommitRefs`: string array of actual release-branch commit refs.
- `supportingEvidence`: string array of validation results or proof links.
- `dependencies` / `exclusions`: string arrays of release-specific prerequisites
  or excluded parts, with reasons.
- `assessedSha`: release head actually assessed; refresh after reassessment,
  not just to clear a stale flag.

Deferral is not necessarily blocked; one release's exclusion does not make a fix
globally `not_a_hotfix`. Keep P0/P1 priority in rationale/evidence, separate from
API severity.

## API essentials

- GET/POST `/v1/hotfixes` and `/v1/releases`; GET/PATCH their `/{id}` routes.
- GET `/v1/assessments` or `/{id}`; PUT
  `/v1/releases/{releaseId}/hotfixes/{hotfixId}` to create/update a pair, or
  PATCH `/v1/assessments/{id}`.
- Filter by repository and assessment `releaseId`; follow `{items, next}` with
  `after=next` until null (`limit` ≤100). Consult OpenAPI for create fields/filters.
- Writes use JSON, `Content-Type: application/json`, `Idempotency-Key`, and
  `X-Change-Reason`. PATCH needs current `expectedRevision`; pair PUT uses 0
  for creation, current revision for updates. Replay uncertain writes with the
  exact key/body. Resolve 409s by reading/reconciling, not blind overwrites.
  Authentication supplies actor/assessor.
- Audit/diagnostics help investigation. Export, bulk, backup/restore, and deletion
  are documented administrative operations, not routine release steps.

## Fallback and privacy

If access, service availability, or required capabilities prevent use, note why
and continue local backport evidence. Keep pending updates there; reconcile with
current records at a useful recovery checkpoint, without delaying publication or
overwriting another owner. Request/revision errors normally need correction, not
fallback. Existing security reconciliation and release gates still apply.

Keep unpublished GHSA details/private refs in the approved security record unless
this ledger is approved for that audience and material. Public evidence gets only
the permitted opaque pending/cleared status. A public dashboard would need a
sanitized view, never raw records, exports, or audit history.
