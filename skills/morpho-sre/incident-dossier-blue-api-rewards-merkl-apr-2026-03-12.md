# Incident Dossier: Blue API Rewards APR Merkl Stacked Cause (2026-03-12)

## Summary

- Service: blue-api rewards and vault APY surfaces
- Date: 2026-03-12
- Severity: high
- What broke: rewards APR and vault APY values were wrong for affected vaults and markets
- Customer impact: confirmed. Public API consumers and UI surfaces saw impossible reward-driven APR values
- Detection: Slack bug-report thread, campaign links, Merkl escalation

## Fingerprints

- rewards APR off on USDT and USDC vaults
- Base `superOETHb/USDC` showed phantom OP `supplyApr` while Merkl exposed borrow-only OP campaigns for the same market
- campaign TVL looked suspicious in linked opportunity pages
- stale market materialized view was present but did not fully explain the reward anomaly

## Stacked Cause Pattern

- Primary trigger: upstream provider campaign TVL/APR anomaly
- Local amplifier: consumer code path fans a campaign-level APR across a broader scope than intended
- Data contributor: stale materialized view or timeout keeps bad data visible longer

## Investigation Order

- DB evidence first
- then provider/API response
- then artifact/workflow output
- then exact consuming code path

## Prevention

- treat prior APY incidents as priors only
- do not name DB pressure as the root cause without checking the provider
- do not name stale-row cleanup as root cause until the live DB row/provenance fact matches the theory
- do not open blacklist/config PRs until the live failing path is proven to consume them
