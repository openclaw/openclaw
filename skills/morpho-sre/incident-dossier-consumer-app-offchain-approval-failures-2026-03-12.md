# Consumer App Offchain Approval Failures - 2026-03-12

Use this dossier when a consumer-app report already narrows scope to wallet approval,
offchain signature, Permit2, allowance, or repay failures.

## Pattern

- User reports an in-app transaction failure.
- A workaround already exists:
  - disabling offchain approval/signature works
  - forcing onchain approval works
  - retrying directly on Etherscan behaves differently
- Secondary onchain symptoms can appear after the workaround:
  - later direct call reverts
  - balance is empty after successful partial txs
  - allowance resets changed the transfer path

Do not let the secondary symptom replace the original app bug.

## First Moves

1. Run the consolidated probe:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/consumer-bug-preflight.sh prd "USDT repay fails unless offchain approval is disabled"
```

2. Search the known issue family before inventing a new theory:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh probe-auth
gh search issues --repo morpho-org/consumer-monorepo --match title,body --limit 10 -- "permit2 nonce approval"
gh search prs --repo morpho-org/consumer-monorepo --match title,body --limit 10 -- "permit2 nonce approval"
```

3. Only after telemetry + issue search, do Tenderly / Foundry / onchain checks.

## Strong Signals

- If the user succeeds after disabling offchain approval or switching to onchain approval:
  - keep the offchain path as the primary failure domain
  - treat direct approval success as workaround evidence
- If the token is USDT-like:
  - check non-zero -> non-zero approval reset issues first
  - do not assume Permit2 is the only path
- If the error is allowance-like but follows a permit / signature flow:
  - check stale or incorrect nonce state before assuming missing balance
- If a later direct contract call fails:
  - explain it separately as a secondary symptom unless it reproduces the app path exactly

## Known Matches

- `API-900` (2025-06-17 to 2025-06-19)
  - USDT deposit failure after SDK update
  - `NonZeroAllowanceError`
- `VMV1-3435` (2025-08-27 to 2025-11-14)
  - USDT approval not working in main app
- `VMV1-4140` / `VMV1-4147` (2025-12-05 to 2025-12-11 / 2025-12-08 to 2025-12-10)
  - shipped toggle for offchain signature / approval flow
- `VMV1-4299` (2026-01-05 to 2026-01-23)
  - consumer app USDT approval issue
- `VMV1-4693` (opened 2026-02-19)
  - stale permit nonce failures across chains
- `VMV1-4719` (completed 2026-03-11)
  - stale EIP-2612 permit nonce in V1 Classic flows
- `VMV1-4786` (2026-02-26 analysis)
  - Permit2 `InvalidNonce()` + missing ERC20 allowance family
- `VMV1-4886` (2026-03-11 to 2026-03-12)
  - thread that exposed this investigation gap

## Investigation Contract

Report these separately:

1. Primary app bug
2. Secondary user-specific state
3. Workaround status
4. Matching issue ids / PRs / owner

Bad close-out:

- "root cause confirmed: user has 0 balance"

Good close-out:

- "primary bug still points to the offchain approval path; later zero balance only explains the direct fallback attempt"
