# Single-Vault API / GraphQL Data Incidents

> Loaded on demand from morpho-sre skill. See SKILL.md for hard rules and routing.

Investigation guide for incidents where one vault, one market, or one address is broken while peers work, or where GraphQL field-level failures surface for specific entities.

## Triggers

- One vault / one market / one address broken while peers work
- GraphQL `INTERNAL_SERVER_ERROR`
- `sentryEventId` / `traceId` pasted by user
- APY nulls, missing realtime state, or field-level GraphQL failures

## Preferred Collector

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/single-vault-graphql-evidence.sh \
  --address 0xE18d7f0C6aaba1E600fF680459a357C3B3CfdB34 \
  --chain-id 999 \
  --query-file /tmp/vault.graphql \
  --variables-file /tmp/vault.variables.json \
  --control-address 0x03944a2c5B9FEE78855F99d6830061c45e3A7Bcd
```

## Mandatory Order

1. Replay the exact user query
2. Isolate the minimal failing field set
3. Compare against one healthy control vault on the same chain
4. Compare public surfaces for the same address:
   - `vaultV2ByAddress`
   - `vaultV2s` with `address_in`
   - `vaultV2transactions`
5. Verify direct onchain values for the same address
6. Only then rank causes or assign owners

## Investigation Guidelines

- Compare against one healthy control vault on the same chain before calling it chain-wide
- If same-factory controls are available, prefer them
- Do not jump from missing current state on one vault to "scheduler missing on the whole chain" if newer or peer controls materialize state
- Historical APY series can be a weak signal; prefer current-state fields plus direct RPC
- Do not reuse older APY, scheduler, RPC, or unsupported-vault theories unless the newest exact artifact and resolver family still match them
- Before naming an ingestion/provenance root cause, add one live DB row/provenance fact and one job-path or simulation fact for the affected entity

## Required Answer Shape

Reply with conclusions only in ALL communications — no investigation steps, intermediate reasoning, or tool output summaries.

- Exact query result
- Minimal failing fields
- Healthy control result
- Direct RPC fact
- Which public paths see the entity vs miss it
