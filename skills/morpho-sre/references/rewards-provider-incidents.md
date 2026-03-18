# Rewards / Provider Incidents

> Loaded on demand from morpho-sre skill. See SKILL.md for hard rules and routing.

Investigation guide for rewards APR discrepancies, campaign TVL issues, and upstream provider data incidents. These incidents typically involve Merkl, reward programs, or campaign data flowing through the blue-api pipeline.

## Triggers

- Rewards APR off
- Vault APY off with campaign or provider hints
- Prompts mentioning `Merkl`, campaign TVL, reward programs, `yearly_supply_tokens`, `campaigns.morpho.org`, or campaign blacklist

## Mandatory Order

After completing the DB-first checks (see `db-first-incidents.md`):

1. Verify one upstream provider/API response
2. Verify one recent artifact or workflow output if such a collector exists
3. Verify the exact consuming code path before naming a root cause or proposing a PR

## Additional Stale-Row / Write-Path Gate

- Before naming a stale-row/write-path cause or opening a PR, include one live DB row/provenance fact for the affected reward entity
- The reply must also name the exact consuming repo/path that would change the active code path
- Until dedicated collectors exist, these rewards/provider evidence gates are satisfied only from explicit live probe outputs; if those outputs are absent, keep the gate closed and say so

## Same-Token Both-Sides Anomaly

When the same reward token appears on both supply and borrow for one market:

1. First quote the live reward row/provenance
2. Then prove the provider-side truth for that token/campaign
3. Then inspect `_fetchMerklSingleRates()` applicability and the final merged reward row before stale-row cleanup theories or PRs
4. Keep unrelated dbt/job failures under `*Also watching:*` unless they explain the bad reward row

## Required Answer Shape

Reply with conclusions only in ALL communications — no investigation steps, intermediate reasoning, or tool output summaries.

- `primary trigger`
- `local amplifier`
- `stale-data contributor` when present
- One disproved or partial prior theory if the investigation changed direction

## Auto-PR Gate

- Do not open a PR unless the reply names the repo/path that changes the active code path
- Do not open a PR for a stale-row/write-path theory unless the reply includes one live DB row/provenance fact for that entity
- Blacklist/config-only PRs are not valid if the live failing path does not consume that blacklist/config
