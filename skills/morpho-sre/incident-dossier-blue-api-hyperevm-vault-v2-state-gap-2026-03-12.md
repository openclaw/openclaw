# Incident Dossier: Blue API HyperEVM Vault V2 State Gap (2026-03-12)

## Summary

- Service: blue-api / vault-v2 public GraphQL
- Date: 2026-03-12
- Env: prod
- Severity: high
- What broke: one HyperEVM vault V2 returned null APY fields and state-field GraphQL errors while peers on the same chain still worked.
- Customer impact: confirmed. The broken vault page and public API response were incomplete.
- Detection: Slack bug-report thread, exact public GraphQL query, live public API checks, direct HyperEVM RPC checks.
- Resolution: fixed. The indexer filtered HyperEVM adapter-v2 factory events with the wrong hardcoded address, so adapter provenance rows never landed in the DB. Tactical SQL inserts restored the reported vault immediately; permanent fix was code + backfill from the factory deployment block.

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

- Primary: the indexer overrode the SDK's HyperEVM `morphoMarketV1AdapterV2Factory` address with the wrong hardcoded address, so `CreateMorphoMarketV1AdapterV2` events from the real factory were skipped.
- Contributing:
  - metadata and transaction paths still worked, which made the incident look like a generic current-state gap at first
  - the vault-level sync job logged `unknown adapter or Morpho Vault V1 not found` because the adapter provenance table was empty for the affected adapter
- Provenance facts:
  - SDK/correct factory: `0xaEff6Ef4B7bbfbAadB18b634A8F11392CBeB72Be`
  - stale hardcoded override: `0x6d6A3ba62836d6B40277767dCAc8fd390d4BcedC`
  - missed event blocks: `21460330`, `22076552`, `29432606`, `29515505`

## Fix

- Immediate mitigation:
  - insert the missing `indexer.create_morpho_market_v1_adapter_v2` rows with an idempotent SQL workaround
  - rerun or wait for the next vault-v2 sync cycle
- Permanent fix:
  - update the HyperEVM hardcoded factory override to match the SDK / onchain factory
  - redeploy the affected indexer/image
  - backfill from block `21460330` so every missed adapter-v2 event lands in the DB
- Job-path lesson:
  - for adapter-v2 incidents, probe the adapter address against the factory, not the parent vault address

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
- generic RPC/provider failure:
  - the decisive skip was deterministic provenance filtering, not random empty-chain reads
- unsupported third-party vault theory:
  - the vault's adapter is a valid adapter-v2 instance; the missing provenance row made it look unsupported

## Validation Recipe

1. Replay the exact user query first.
2. Isolate the minimal failing field set.
3. Compare with one healthy same-chain control vault.
4. Compare `vaultV2ByAddress`, `vaultV2s`, and `vaultV2transactions` for the same address.
5. Verify direct onchain `totalAssets()` and `totalSupply()`.
6. Add one DB row/provenance fact and one job-path/simulation fact before naming an ingestion root cause.
7. Only then name the likely broken internal path.

## Prevention / Guardrails

- Do not jump from a single broken vault to a chain-wide scheduler theory without a same-chain control.
- Do not reuse an older APY incident unless resolver family, failing fields, and entity shape match.
- Treat exact user-supplied queries, event IDs, and trace IDs as mandatory replay artifacts.
- For single-vault public-data incidents, use public-path split plus direct RPC before deeper repo/code theories.
- Before naming a provenance/internal-ingestion root cause, require one live DB row/provenance fact and one job-path/simulation fact.
- If the latest evidence disproves the current theory, retract it explicitly instead of layering the new evidence under the old claim.
