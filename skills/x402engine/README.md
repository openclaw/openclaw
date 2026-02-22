# x402engine Skill — Invisible Service Access Layer

Answers user questions by transparently calling 70+ paid APIs via x402 micropayments. The user sees answers, not payments.

## Architecture

```
User: "what's the price of bitcoin"
  → discovery.js: fetch cached service catalog from /.well-known/x402.json
  → intent-router.js: score query against service descriptions → match "crypto-price"
  → client.js: @x402/fetch handles 402 → signs payment → retries automatically
  → policy-engine.js: autopreflight checks spend caps before payment signs
  → executor.js: returns { ok: true, data: { bitcoin: { usd: 97500 } } }
  → Agent says: "Bitcoin is currently $97,500."
  → User never sees x402/payment/USDC mentioned
```

## Setup

```bash
cd skills/x402engine
npm install
```

**Required environment:**
- `EVM_PRIVATE_KEY` — funded EVM wallet private key (Base USDC or MegaETH USDm)

**Optional:**
- `X402_POLICY_PATH` — custom policy file (default: `POLICY.example.json`)
- `X402_STATE_PATH` — daily spend tracking file
- `X402_DISCOVERY_URL` — override discovery endpoint
- `X402ENGINE_ORIGIN` — override API base URL
- `X402_AUTOPREFLIGHT` — enable/disable policy preflight (default: `true`)

## CLI

```bash
# List all available services from the catalog
node ./cli.js discover

# Show remaining daily budget
node ./cli.js budget
```

## Supported services (70+)

**Crypto:** price feeds, market data, history, trending, search
**Wallet:** balances, transactions across 20+ chains
**Image:** fast (FLUX), quality (FLUX.2 Pro), text-in-image (Ideogram)
**Video:** fast, quality, animation, Hailuo premium
**LLM:** GPT-4o, Claude, Gemini, DeepSeek, Llama, Grok, Qwen, Mistral, Perplexity, and more
**Code:** sandboxed execution (Python, JS, Bash, R)
**Audio:** transcription (Deepgram), TTS (OpenAI, ElevenLabs)
**Web:** scraping, screenshots
**Storage:** IPFS pin/get
**ENS:** resolve, reverse lookup
**Embeddings:** text embeddings for semantic search

## Payment rails

- **Base** (eip155:8453): USDC, 6 decimals
- **MegaETH** (eip155:4326): USDm, 18 decimals

## Policy engine

Policy-first safety: all payments pass through `policy-engine.js` before signing.

- **Fail-closed**: missing or invalid policy denies all requests
- **Per-transaction caps**: max amount per service call
- **Daily caps**: optional per-asset daily spending limit
- **Rate limits**: min interval between transactions, max per hour
- **Recipient allowlist**: restrict payments to known paygate addresses

See `POLICY.example.json` for defaults.

## Tests

```bash
npm test
```

## File structure

| File | Purpose |
|------|---------|
| `executor.js` | Main entry: query → discover → match → policy → paid fetch → result |
| `discovery.js` | Fetch/cache service catalog with TTL |
| `intent-router.js` | Score queries against catalog, extract params |
| `client.js` | Wallet management, @x402/fetch wrapper, autopreflight |
| `policy-engine.js` | Load, validate, enforce spend policies |
| `reason-codes.js` | Stable reason code constants |
| `error-taxonomy.js` | Reason code → class/severity/httpStatus mapping |
| `format.js` | USD/percentage formatters |
| `cli.js` | Debug CLI (discover, budget) |
| `SKILL.md` | Skill triggers and rules |
| `POLICY.example.json` | Default policy with open caps |
