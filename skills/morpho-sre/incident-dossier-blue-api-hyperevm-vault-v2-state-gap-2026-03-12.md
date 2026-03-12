# Incident Dossier: Blue API HyperEVM Vault V2 State Gap (2026-03-12)

## Summary

- Service: blue-api / vault-v2 public GraphQL
- Date: 2026-03-12
- Env: prod
- Severity: medium
- What broke: one HyperEVM vault V2 returned null APY fields and state-field GraphQL errors while peers on the same chain still worked.
- Customer impact: confirmed. The broken vault page and public API response were incomplete.
- Detection: Slack bug-report thread, exact public GraphQL query, live public API checks, direct HyperEVM RPC checks.
- Resolution status: unresolved in this repo. Root cause should be handed to blue-api owners after public-path localization.

## Fingerprints

- Vault: `0xE18d...dB34`
- Chain: `999` (HyperEVM)
- Exact query path: `vaultV2ByAddress`
- Query shape:
  - `apy`, `netApy`, `avgNetApy(...)` -> `null`
  - `totalAssets`, `totalAssetsUsd` -> partial ISE
  - `totalSupply`, `sharePrice` -> harder ISE / nullified response
  - `maxApy`, `maxRate` -> still present
- Public-path split:
  - `vaultV2ByAddress` -> sees vault metadata
  - `vaultV2transactions` -> sees at least one deposit
  - `vaultV2s` with `address_in` -> missing this vault entirely
- Direct RPC:
  - `totalAssets()` -> non-null
  - `totalSupply()` -> non-null

## Scope

- Services: blue-api public GraphQL, vault-v2 realtime state path
- Namespace / workload: likely indexer-backed state materialization path for one vault, not chain-wide scheduler failure
- Comparable healthy control:
  - `0x0394...7Bcd` (`GOAT USDH`) on the same chain and same factory
- Time facts:
  - broken vault creation block: `29432545`
  - broken vault creation timestamp: `2026-03-11 04:47:00 UTC`
  - newer chain-999 vaults were already materialized, so this is not just “vault too new”

## Public Evidence

- `vaultV2ByAddress` metadata path works for the broken vault: address, name, chain, factory metadata resolve.
- `vaultV2transactions` shows at least one deposit for the broken vault, so the transaction ingestion path saw it.
- `vaultV2s` does not return the broken vault even with `address_in`, while a healthy same-chain control vault does appear there.
- Direct HyperEVM RPC returns valid `totalAssets` and `totalSupply` for the broken vault, so onchain state exists.
- A healthy same-chain control vault resolves `totalAssets`, `totalSupply`, `sharePrice`, `apy`, and `netApy` fine.

## Likely Cause

- Primary: vault-specific current-state materialization or persistence failure after metadata / transaction ingestion.
- Strong hint: list/state-backed surfaces miss the vault while metadata and transaction surfaces still see it.
- Needed internal confirmation:
  - DB row diff for broken vault vs healthy control
  - processor/job logs around block `29432545`
  - replay / backfill of current-state materialization for this address

## Ruled Out

- `factory.chain` / V1 resolver bug:
  - wrong resolver family
  - same factory metadata resolves for both broken and healthy vaults
- chain-wide missing scheduler on chain `999`:
  - healthy peers and newer vaults already have current state
- generic “vault too new” explanation:
  - newer chain-999 vaults exist with materialized state
- “onchain contract broken”:
  - direct RPC returns valid totals

## Validation Recipe

1. Replay the exact user query first.
2. Isolate the minimal failing field set.
3. Compare with one healthy same-chain control vault.
4. Compare `vaultV2ByAddress`, `vaultV2s`, and `vaultV2transactions` for the same address.
5. Verify direct onchain `totalAssets()` and `totalSupply()`.
6. Only then name the likely broken internal path.

## Prevention / Guardrails

- Do not jump from a single broken vault to a chain-wide scheduler theory without a same-chain control.
- Do not reuse an older APY incident unless resolver family, failing fields, and entity shape match.
- Treat exact user-supplied queries, event IDs, and trace IDs as mandatory replay artifacts.
- For single-vault public-data incidents, use public-path split plus direct RPC before deeper repo/code theories.
