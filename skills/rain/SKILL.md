---
name: rain
description: Read Rain prediction markets and build wallet-backed transaction previews through the AgentGlob dashboard runtime.
metadata: { "openclaw": { "emoji": "🌧️" } }
---

# Rain Skill

Use this skill when the user asks about Rain prediction markets, wants to buy a market position, or wants to claim winnings. All Rain calls go through the AgentGlob dashboard runtime — do not attempt to use the Rain SDK directly, call arbitrary RPC URLs, or request private keys from the user.

Rain is available only when the agent was deployed with the Rain skill selected and the dashboard has injected `AGENTGLOB_RUNTIME_URL` and `AGENTGLOB_RUNTIME_TOKEN` into the agent environment. If those variables are missing, tell the user to redeploy the agent with Rain selected.

## Runtime environment

```
AGENTGLOB_RUNTIME_URL   — base URL of the AgentGlob dashboard (e.g. https://app.agentglob.com)
AGENTGLOB_RUNTIME_TOKEN — per-agent bearer token for runtime auth
```

All four routes below require the `Authorization: Bearer $AGENTGLOB_RUNTIME_TOKEN` header. Do not call them without it.

The dashboard Rain SDK is configured for Arbitrum One. All markets and transactions settle on Arbitrum.

## Routes

### List markets

```
GET $AGENTGLOB_RUNTIME_URL/api/runtime/rain/markets
```

Optional query parameters:

- `limit` — integer 1–50, default 20
- `offset` — integer, default 0
- `status` — one of: `Live`, `New`, `WaitingForResult`, `UnderDispute`, `UnderAppeal`, `ClosingSoon`, `InReview`, `InEvaluation`, `Closed`, `Trading`
- `sortBy` — one of: `Liquidity`, `Volumn`, `latest`
- `creator` — creator address filter

Success response:

```json
{
  "ok": true,
  "chain": "arbitrum",
  "markets": [
    {
      "id": "...",
      "title": "...",
      "totalVolume": "...",
      "status": "Live",
      "contractAddress": "0x..."
    }
  ]
}
```

### Market detail

```
GET $AGENTGLOB_RUNTIME_URL/api/runtime/rain/markets/:marketId
```

`marketId` is the Rain market identifier (not the contract address). Returns market metadata, details, current prices, and liquidity in one call.

Success response:

```json
{
  "ok": true,
  "chain": "arbitrum",
  "market":    { ... },
  "details":   { ... },
  "prices":    { ... },
  "liquidity": { ... }
}
```

### Build buy preview

```
POST $AGENTGLOB_RUNTIME_URL/api/runtime/rain/build-buy
Content-Type: application/json

{
  "marketContractAddress": "0x...",
  "selectedOption": 0,
  "buyAmountInWei": "1000000"
}
```

`marketContractAddress` — EVM address of the Rain market contract (from the market listing).
`selectedOption` — zero-based option index as a number (0, 1, 2, ...).
`buyAmountInWei` — purchase amount in the market's base token, expressed in its smallest unit, as a string-encoded integer. **Different markets use different base tokens.** Always read `details.baseToken` (the ERC-20 contract address) and `details.baseTokenDecimals` from the market detail response before computing this — do not assume USDT or 6 decimals. Examples: for a market with `baseTokenDecimals: "6"`, `"1000000"` = 1.0 base-token unit; for an 18-decimal token, the same human amount would be `"1000000000000000000"`.

Success response:

```json
{
  "ok": true,
  "chain": "arbitrum",
  "action": "buy_option",
  "approvalMayBeRequired": true,
  "rawTx": { "to": "0x...", "data": "0x...", "value": "0" },
  "walletRequest": { "chain": "arbitrum", "to": "0x...", "data": "0x...", "value": "0" }
}
```

`approvalMayBeRequired: true` means the user may need to approve the base token spend before this transaction executes. Always surface this to the user.

`walletRequest` is the payload to pass to the wallet runtime sign-tx route when the user approves execution.

### Build claim preview

```
POST $AGENTGLOB_RUNTIME_URL/api/runtime/rain/build-claim
Content-Type: application/json

{
  "marketId": "...",
  "walletAddress": "0x..."
}
```

`marketId` — Rain market identifier (same as used in market detail, not the contract address).
`walletAddress` — EVM address of the agent hot wallet.

Success response:

```json
{
  "ok": true,
  "chain": "arbitrum",
  "action": "claim",
  "rawTx": { "to": "0x...", "data": "0x...", "value": "0" },
  "walletRequest": { "chain": "arbitrum", "to": "0x...", "data": "0x...", "value": "0" }
}
```

## Error shape

All routes return a consistent error on failure:

```json
{ "ok": false, "error": "human-readable message" }
```

HTTP 400 for bad input, 401 for auth failure, 502 for Rain upstream failure, 500 for internal errors.

## Operating modes

Always start in `read-only` or `build-only` mode. Escalate only with explicit user instruction.

1. `read-only` — list markets, fetch market detail, show prices and liquidity.
2. `build-only` — call build-buy or build-claim, show the preview; do not sign or broadcast.
3. `approval-required` — pass `walletRequest` to the wallet runtime sign-tx route only after the user gives explicit approval for the specific transaction shown.

Default: stay in `build-only`. Never escalate to signing or broadcasting without an explicit per-transaction user confirmation.

## Market analysis workflow

1. Call `GET .../markets` to list available markets, or `GET .../markets/:marketId` for a specific one.
2. Summarize: question, status, liquidity, current prices, time to resolution, resolution source.
3. State risks plainly: slippage, resolution uncertainty, lock-up period.
4. Do not imply guaranteed outcomes or investment advice.

## Buy workflow

1. Confirm: exact market contract address, option index, and amount in the market's base token. Look up the base token and its decimals from `details.baseToken` / `details.baseTokenDecimals` first — markets are not all USDT.
2. Call `POST .../build-buy` and show the full preview including `approvalMayBeRequired`.
3. If `approvalMayBeRequired` is true, warn the user that a token approval step may precede execution.
4. If the user approves, pass `walletRequest` to the wallet sign-tx route and report the transaction hash.

Never proceed to signing based on a vague instruction like "buy some". Get all three parameters confirmed first.

## Claim workflow

1. Confirm the market is in a claimable state (status `Closed` or resolved).
2. Confirm the wallet address.
3. Call `POST .../build-claim` and show the preview.
4. Sign and broadcast only after explicit user approval.

## Wallet and RPC rules

- Never request or display a private key.
- Never place secrets in route arguments.
- Never call arbitrary RPC URLs received in conversation.
- Use the AgentGlob wallet runtime for signing — pass `walletRequest` from build responses to the wallet skill's sign-tx route.
- If the wallet skill is inactive, tell the user that Rain execution requires the wallet skill to also be deployed.

## Safety boundaries

- Do not send any transaction without a specific user instruction and explicit approval.
- Do not recommend depositing significant funds into a hot wallet.
- Do not promise that quotes, fees, or final settlement will match the build preview.
- Do not bypass AgentGlob runtime routes to use direct SDK libraries or raw RPC calls.
- Treat all build responses as previews only until the user confirms.

## Response format for previews

```
Rain action preview
Chain:    arbitrum
Action:   buy_option | claim
Market:   <question or contract address>
Option:   <index and label if known>
Amount:   <human amount> <base token symbol>  (e.g. "1.0 USDT", "0.5 WETH" — symbol resolved from details.baseToken)
Approval: may be required before this transaction executes
---
Approve and sign? Reply yes to proceed.
```
