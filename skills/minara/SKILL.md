---
name: minara
description: Minara API: crypto trading, swap intent, perp, prediction (API Key or x402).
homepage: https://minara.ai
metadata:
  { "openclaw": { "always": true, "primaryEnv": "MINARA_API_KEY", "emoji": "👩" } }
---

# Minara API

Call the [Minara Agent API](https://api.minara.ai) for crypto trading assistance. Two auth options:

| Method      | Base URL                 | Requires                        |
| ----------- | ------------------------ | ------------------------------- |
| **API Key** | `https://api.minara.ai`  | `MINARA_API_KEY` (Pro/Partner)  |
| **x402**    | `https://x402.minara.ai` | `EVM_PRIVATE_KEY` + USDC wallet |

Use API Key when `MINARA_API_KEY` is set; otherwise use x402 when `EVM_PRIVATE_KEY` is available.

## Endpoints

### 1. Chat

`POST https://api.minara.ai/v1/developer/chat`

General-purpose chat for trading analysis, market insights, and questions.

| Param   | Type    | Required | Description                            |
| ------- | ------- | -------- | -------------------------------------- |
| mode    | string  | Yes      | `"fast"` or `"expert"`                 |
| stream  | boolean | Yes      | `false` for JSON, `true` for SSE       |
| message | object  | Yes      | `{ "role": "user", "content": "..." }` |
| chatId  | string  | No       | Continue existing conversation         |

Response: `{ chatId, messageId, content, usage }`

### 2. Intent to Swap Transaction

`POST https://api.minara.ai/v1/developer/intent-to-swap-tx`

Convert natural language swap intent to an executable transaction payload (OKX DEX compatible).

| Param         | Type   | Required | Description                                                 |
| ------------- | ------ | -------- | ----------------------------------------------------------- |
| intent        | string | Yes      | e.g. `"swap 0.1 ETH to USDC"`                               |
| walletAddress | string | Yes      | 0x... address                                               |
| chain         | string | No       | `"base"`, `"ethereum"`, `"bsc"`, `"arbitrum"`, `"optimism"` |

Response: `{ transaction: { chain, inputTokenAddress, inputTokenSymbol,
  outputTokenAddress, outputTokenSymbol, amount, amountPercentage,
  slippagePercent } }`

### 3. Perpetual Trading Suggestion

`POST https://api.minara.ai/v1/developer/perp-trading-suggestion`

Get perp trading suggestions: side, entry, stop loss, take profit, confidence.

| Param     | Type   | Required | Description                            |
| --------- | ------ | -------- | -------------------------------------- |
| symbol    | string | Yes      | e.g. `"BTC"`, `"ETH"`, `"SOL"`         |
| style     | string | No       | scalping / day-trading / swing-trading |
| marginUSD | number | No       | Default 1000                           |
| leverage  | number | No       | 1–40, default 10                       |
| strategy  | string | No       | Default `"max-profit"`                 |

Response: `{ entryPrice, side, stopLossPrice, takeProfitPrice, confidence, reasons, risks }`

### 4. Prediction Market Analysis

`POST https://api.minara.ai/v1/developer/prediction-market-ask`

Analyze prediction market events (e.g. Polymarket) and get probability estimates.

| Param        | Type    | Required | Description                               |
| ------------ | ------- | -------- | ----------------------------------------- |
| link         | string  | Yes      | Event URL (e.g. Polymarket)               |
| mode         | string  | Yes      | `"fast"` or `"expert"`                    |
| only_result  | boolean | No       | `true` = probabilities only, no reasoning |
| customPrompt | string  | No       | Custom analysis instructions              |

Response: `{ predictions: [{ outcome, yesProb, noProb }], reasoning }`

## Usage

### API Key (api.minara.ai)

Use `fetch` or HTTP client:

- URL: endpoint above
- Method: `POST`
- Headers: `Authorization: Bearer ${process.env.MINARA_API_KEY}`,
  `Content-Type: application/json`
- Body: JSON object per endpoint spec

### x402 (x402.minara.ai)

Pay-per-use with USDC. No subscription. See [Getting Started by
x402](https://minara.ai/docs/ecosystem/agent-api/getting-started-by-x402).

**Option A: x402 SDK (recommended)**

Node.js example—SDK handles payment challenges automatically:

```typescript
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const client = new x402Client();
registerExactEvmScheme(client, { signer });
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const res = await fetchWithPayment("https://x402.minara.ai/x402/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ userQuery: "What is the current price of BTC?" }),
});
const data = await res.json();
```

Dependencies: `@x402/fetch`, `@x402/evm`, `viem`. Solana: add `@x402/svm`.

**x402 Chat endpoint** (differs from API Key):

- `POST https://x402.minara.ai/x402/chat`
- Body: `{ "userQuery": "..." }` (no mode/stream/message/chatId)
- Response: `{ content }`

Chain-specific:
`https://x402.minara.ai/x402/solana/chat`,
`https://x402.minara.ai/x402/polygon/chat`

**Option B: Manual 402 flow**

1. Request → 402 with payment instructions (amount, recipient, chain)
2. Send USDC to recipient
3. Retry with `x-payment-response` header containing payment proof

## Config

`~/.openclaw/openclaw.json`:

```json
{
  "skills": {
    "entries": {
      "minara": {
        "enabled": true,
        "apiKey": "YOUR_MINARA_API_KEY",
        "env": { "EVM_PRIVATE_KEY": "0x..." }
      }
    }
  }
}
```

- **API Key**: set `apiKey` or `MINARA_API_KEY` in env.
- **x402**: set `env.EVM_PRIVATE_KEY` or `EVM_PRIVATE_KEY` in env. Wallet must hold USDC.
  Sandboxed: use `agents.defaults.sandbox.docker.env`.
