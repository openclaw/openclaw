---
name: wallet
description: Send EVM transactions from this agent's hot wallet through the AgentGlob runtime API. Read balances, send native ETH/MATIC, send ERC-20 tokens, and broadcast arbitrary signed transactions on Ethereum, Arbitrum, Polygon, and Base.
homepage: https://app.agentglob.com
metadata:
  {
    "openclaw":
      {
        "emoji": "💸",
        "requires": { "env": ["AGENTGLOB_RUNTIME_URL", "AGENTGLOB_RUNTIME_TOKEN"] },
      },
  }
---

# Wallet

Send transactions from this agent's per-agent hot wallet on EVM mainnets.
Funds are held in a single externally-owned account (EOA) controlled by the
AgentGlob dashboard. The dashboard signs on the agent's behalf when this
skill calls a runtime endpoint with the agent's bearer token.

## Important rules

- **The wallet is the dashboard's, not yours.** Never claim a user owns it,
  never share keys (you do not have them), never expose the bearer token in
  chat output or logs.
- **Always specify the chain** explicitly: `ethereum`, `arbitrum`,
  `polygon`, or `base`. Other chains are not supported.
- **Never invent recipients.** Only use addresses the user has explicitly
  provided in the current conversation, or that came back from a verified
  prior runtime call (e.g. an address the dashboard returned).
- **Treat `sign_tx` as advanced.** Prefer `send_native` and `send_erc20`
  for ordinary payments. Only use `sign_tx` when calldata cannot be
  expressed via the higher-level helpers.
- **This is a hot wallet.** Do not encourage the user to deposit large
  amounts. If they ask whether it is safe for big sums, say no and direct
  them to the AgentGlob dashboard for guidance.
- **Do not edit policy from chat.** Wallet activation, replacement, RPC
  overrides, and clearing the key all happen in the dashboard's Wallet tab,
  not here.

## Execution discipline (MANDATORY)

- **You MUST actually call the runtime endpoint before reporting wallet state.**
  Do not guess, infer from memory, or answer that you lack access until you
  have checked whether `AGENTGLOB_RUNTIME_URL` and `AGENTGLOB_RUNTIME_TOKEN`
  are present.
- If either runtime env var is missing, say exactly:
  `Wallet skill requires a redeployed agent with Wallet selected.`
- If the user asks for `wallet balance?` or a balance without naming a chain,
  check native balances on all supported chains and summarize the results.
- Never report a transaction as sent unless the runtime response includes
  `ok: true` and a `txHash`.

## Network details

| Chain    | Native token | Chain ID |
| -------- | ------------ | -------- |
| Ethereum | ETH          | 1        |
| Arbitrum | ETH          | 42161    |
| Polygon  | MATIC        | 137      |
| Base     | ETH          | 8453     |

## Available actions

All actions go through the AgentGlob runtime API. Construct the URL as
`${AGENTGLOB_RUNTIME_URL}/api/runtime/wallet/<action>` and send the agent's
bearer token in the `Authorization` header:

```
Authorization: Bearer ${AGENTGLOB_RUNTIME_TOKEN}
Content-Type: application/json
```

### 1. Read balance — `GET /api/runtime/wallet/balance`

Query parameters:

- `chain` (required): one of `ethereum`, `arbitrum`, `polygon`, `base`.
- `token` (optional): an ERC-20 contract address. Omit for native balance.

Example (native ETH on Base):

```
GET /api/runtime/wallet/balance?chain=base
```

Example (USDC on Arbitrum):

```
GET /api/runtime/wallet/balance?chain=arbitrum&token=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
```

Response:

```json
{
  "ok": true,
  "chain": "arbitrum",
  "address": "0x…",
  "token": "USDC",
  "decimals": 6,
  "raw": "12345678",
  "formatted": "12.345678"
}
```

### 2. Send native — `POST /api/runtime/wallet/send-native`

Body:

```json
{
  "chain": "base",
  "to": "0xRecipient…",
  "amount": "0.005"
}
```

`amount` is a human-readable string ("0.005" = 0.005 ETH/MATIC).

Response:

```json
{
  "ok": true,
  "chain": "base",
  "txHash": "0x…",
  "from": "0x…",
  "to": "0xRecipient…"
}
```

### 3. Send ERC-20 — `POST /api/runtime/wallet/send-erc20`

Body:

```json
{
  "chain": "arbitrum",
  "token": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "to": "0xRecipient…",
  "amount": "5.00"
}
```

The runtime auto-detects the token's decimals from its contract; `amount`
is human-readable.

### 4. Sign + broadcast arbitrary tx — `POST /api/runtime/wallet/sign-tx`

Body:

```json
{
  "chain": "base",
  "to": "0xContract…",
  "data": "0xa9059cbb…",
  "value": "0"
}
```

`data` is the 0x-prefixed calldata. `value` is a string-encoded wei amount
(use "0" for non-payable calls). Use sparingly.

## Errors

The runtime returns structured JSON on failure. Common shapes:

```json
{ "ok": false, "error": "chain must be one of: ethereum, arbitrum, polygon, base" }
```

```json
{ "ok": false, "error": "wallet is not active for this agent" }
```

```json
{ "ok": false, "error": "send_native failed: insufficient funds for gas + value" }
```

When you see `wallet is not active for this agent`, instruct the user to
activate the wallet on the AgentGlob dashboard agent page → Wallet tab.
Do not attempt to activate it yourself.

## What this skill is not

This skill does **not** sign anything client-side and does not see the
private key. The dashboard runtime decrypts the key only at sign time,
inside its own process, and discards the plaintext immediately. There is
no key escrow, recovery flow, or seed phrase exposure.

For higher-value workflows requiring policy gates, allowlists, AI review
thresholds, or non-custodial vault custody (with on-chain spend limits),
the AxonFi vault path is on the v2 roadmap and will appear as a separate
skill when ready.
