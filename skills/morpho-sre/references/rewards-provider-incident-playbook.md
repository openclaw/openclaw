# Rewards Provider Incident Playbook

Use for wrong rewards APR, suspicious vault APY, campaign TVL anomalies, or prompts mentioning Merkl and reward programs.

## Order

1. Run the DB-first checks from `db-data-incident-playbook.md`.
2. Verify one upstream provider/API response for the affected reward or campaign.
3. Verify one recent artifact or workflow output if a dump CI or cache exists.
4. Verify the exact consuming code path before naming a root cause or opening a PR.
5. Split the answer into trigger, amplifier, and stale-data contributor.

## Minimum checks

- one affected business-data query
- one PostgreSQL internal fact
- one upstream provider fact
- one exact consuming code-path fact

## Interpretation

- bad upstream campaign TVL or APR can be the primary trigger even when DB pressure exists
- stale materialized views or timeouts are often amplifiers, not necessarily the trigger
- a blacklist/config PR is invalid if the active failing code path does not consume that blacklist/config
- if the model changes direction, record which earlier theory became disproved or merely contributory
