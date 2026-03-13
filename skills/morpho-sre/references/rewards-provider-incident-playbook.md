# Rewards Provider Incident Playbook

Use for wrong rewards APR, suspicious vault APY, campaign TVL anomalies, or prompts mentioning Merkl and reward programs.

## Order

1. Run the DB-first checks from `db-data-incident-playbook.md`.
2. Verify one upstream provider/API response for the affected reward or campaign.
3. Verify one recent artifact or workflow output if a dump CI or cache exists.
4. Verify the exact consuming code path before naming a root cause or opening a PR.
5. Split the answer into trigger, amplifier, and stale-data contributor.

## Same-token both-sides anomaly

Use this when the same reward token appears on both supply and borrow for one market.

1. Quote the live reward row / provenance for that market + reward token.
2. Prove the provider-side truth for the same token / campaign.
3. Verify one recent artifact or workflow output if available.
4. Inspect `_fetchMerklSingleRates()` applicability and the final merged reward row before proposing stale-row cleanup.
5. Record `Disproved theory:` if current code, query output, or live evidence rules out the prior explanation.
6. State which evidence invalidated the prior theory and what the replacement theory now depends on.
7. If multiple replacement theories are disproved in sequence, escalate with the disproved chain and the remaining live checks instead of asserting a new root cause.

## Minimum checks

- one affected business-data query
- one live DB row/provenance fact for the affected reward entity
- one PostgreSQL internal fact
- one upstream provider fact
- one recent artifact or workflow/cache fact when such an artifact exists
- one exact consuming repo/path fact

## Interpretation

- bad upstream campaign TVL or APR can be the primary trigger even when DB pressure exists
- stale materialized views or timeouts are often amplifiers, not necessarily the trigger
- stale-row cleanup is only a hypothesis until the DB row/provenance fact and the consuming repo/path both match that theory
- stale-row cleanup alone is not enough when the live row already carries both `supplyApr` and `borrowApr` for the same reward token
- a blacklist/config PR is invalid if the active failing code path does not consume that blacklist/config
- if the model changes direction, record which earlier theory became disproved or merely contributory
