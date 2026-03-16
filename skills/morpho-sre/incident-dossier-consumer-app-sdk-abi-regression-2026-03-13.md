# Consumer App SDK ABI Regression - 2026-03-13

Use this dossier when a consumer-app Sentry issue traces to an SDK interface
change causing ABI decoding reverts on-chain.

## Title

- Service: consumer-app, blue-sdk-viem
- Date: 2026-03-13
- Env: mainnet (all chains with EIP-5267 tokens)
- Severity: high (929 users, ~16k Sentry events since 2026-03-03)

## Summary

- What broke: `/ethereum/migrate` RPC calls revert for tokens implementing EIP-5267 `eip712Domain()`
- Customer impact: ~929 users unable to complete migrations for affected tokens (USDe, sUSDe, others)
- Detection: Sentry issue MORPHO-CONSUMER-4F7
- Resolution: pending verification — revert `IERC20Permit.sol` interface change from commit `bb68ca4`

## Fingerprints

- Alerts: Sentry `RpcRequestError: RPC Request failed.` on `/ethereum/migrate`
- Log lines: ABI decoding revert in multicall when target token implements `eip712Domain()`
- Metrics: ~16k Sentry events since 2026-03-03
- Traces: revert occurs in caller-side ABI decoding (not in the external call itself)
- Data / DB evidence: n/a — on-chain ABI mismatch
- Argo / deploy signals: commit `bb68ca4` in `@morpho-org/blue-sdk-viem`

## Scope

- Services: consumer-app `/ethereum/migrate` flow
- Namespaces: n/a (client-side / SDK)
- Workloads: `GetToken.sol` multicall in `@morpho-org/blue-sdk-viem`
- Dependencies: `IERC20Permit.sol` interface definition, EIP-5267 on-chain implementations

## Likely Cause

- Primary: commit `bb68ca4` changed `eip712Domain()` return type in `IERC20Permit.sol` from 7 individual values to a single `Eip5267Domain` struct. The struct contains dynamic types (`string memory`, `uint256[] memory`), which changes ABI encoding layout vs flat returns. On-chain implementations return flat-encoded values, causing the caller-side ABI decoder to misinterpret the data and revert. The revert happens in the caller's decoding, so `catch {}` does not catch it.
- Contributing: unverified — domain expert challenged the offset-pointer explanation; the dynamic-type angle was not addressed by either party
- Ruled out: tokens without `eip712Domain()` (WETH, USDC, DAI) — these revert at the call level and are caught by `catch {}`
- Disproved theories: none yet (investigation incomplete)

## Fix

- Immediate mitigation: revert `IERC20Permit.sol` interface to return 7 individual values (as in commit `530301a`)
- Rollback: revert commit `bb68ca4` in `@morpho-org/blue-sdk-viem`
- Permanent fix: keep flat return type for `eip712Domain()` to match EIP-5267 standard ABI

## Validation

- Checks:
  1. `cast call <GetToken_address> "eip712Domain()" --rpc-url <mainnet>` on a USDe/sUSDe token
  2. Foundry test: call `eip712Domain()` via the reverted interface and verify decode succeeds
  3. Sentry event rate drops for MORPHO-CONSUMER-4F7 after fix deploy
- Expected recovery signal: zero new Sentry events for `RpcRequestError` on `/ethereum/migrate` for EIP-5267 tokens

## Prevention

- Missing alerts: no SDK-level ABI compatibility check in CI
- Missing guardrails: interface changes to standard EIP functions should require ABI encoding compatibility test
- Needed runbook/checklist: "Sentry RPC revert → ABI encoding mismatch" investigation playbook (verify with `cast call` before theorizing)

## References

- PRs: pending
- Linear: pending
- Slack thread: https://morpholabs.slack.com/archives/C08AAMKH524/p1773398130482519
- Source docs/postmortem: Sentry MORPHO-CONSUMER-4F7
