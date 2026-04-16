---
name: okx-payments
description: Interactive setup guide for x402 payment-gated APIs. Trigger when user mentions "402", "x402", "payment-gated", or "OKX payments". Asks buyer vs seller, then guides through the full setup interactively. Buyer path installs OnchainOS CLI + skill. Seller path fetches language-specific reference and builds the server implementation.
---

# OKX x402 Payments

## Workflow

When triggered, follow this conversation flow exactly:

### Step 1 — Clarify role

Ask the user:

> "Are you looking to integrate someone else's x402 payment-gated API (Buyer), or add x402 payments to your own API (Seller)?"

---

### Step 2a — Buyer path

**Install onchainos CLI**

> **Tip:** Detect the user's operating system first, then run the appropriate install command below. Do not run all commands — only the one matching the detected OS.

```bash
# macOS / Linux
curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/okx/onchainos-skills/main/install.ps1 | iex
```

> Security note: Review the install script before running pipe-to-shell commands. You can inspect the raw script at the URL above, or download and audit it first.

**Install onchainos skills** (pick one)

```bash
# Recommended (auto-detects Claude Code / Cursor / Codex CLI / OpenCode)
npx skills add okx/onchainos-skills

# Claude Code plugin marketplace
/plugin marketplace add okx/onchainos-skills
```

After installation, tell the user:

> "Installation complete. Please **restart the session** for the skill to take effect."

---

### Step 2b — Seller path

Ask the user:

> "Which language do you want to use? (default: TypeScript, also supports Go, Rust)"

Based on the answer, fetch the corresponding reference and build the seller service:

| Language | Reference to fetch |
|----------|-------------------|
| TypeScript (default) | `https://raw.githubusercontent.com/okx/payments/main/typescript/SELLER.md` |
| Go | `https://raw.githubusercontent.com/okx/payments/main/go/SELLER.md` |
| Rust | `https://raw.githubusercontent.com/okx/payments/main/rust/SELLER.md` |

Fetch the reference file. If the fetch fails, stop and tell the user which file could not be loaded — do not write any code from memory. Only proceed with implementation after successfully reading the reference content. The implementation must satisfy all constraints below.

---

## Constraints (seller implementation)

- **Network**: X Layer mainnet only (`eip155:196`)
- **Facilitator**: always `OKXFacilitatorClient` (never `HTTPFacilitatorClient`)
- **Token**: USDT0 `0x779ded0c9e1022225f8e0630b35a9b54be713736` (6 decimals)
- **Schemes**: `exact` (per-request, EIP-3009), `aggr_deferred` (batched settlement)
- **Deferred naming**: TypeScript uses `"deferred"` / `DeferredEvmScheme`; Go/Rust use `"aggr_deferred"` / `AggrDeferredEvmScheme`
- **Fastify**: `paymentMiddlewareFromHTTPServer(app, httpServer)` — app is first arg

## Environment Variables (seller)

Obtain credentials from [OKX Developer Portal](https://web3.okx.com/onchain-os/dev-portal). Never commit `.env` to git.

```bash
OKX_API_KEY=***
OKX_SECRET_KEY=***
OKX_PASSPHRASE=your-passphrase
PAY_TO_ADDRESS=0xYourWalletAddress
```

## Rules

- Always call `resourceServer.initialize()` after server starts, before handling requests
- Always use `OKXFacilitatorClient`, never `HTTPFacilitatorClient`
- Use USD string prices like `"$0.01"` — SDK auto-converts to USDT0 atomic units
- Never commit `.env` or API credentials to git
- Pin package versions — payment tools manage private keys

## References

- [OnchainOS Skills](https://github.com/okx/onchainos-skills) — Buyer CLI
- [OKX x402 docs](https://web3.okx.com/onchainos/dev-docs/payments/x402-introduction)
- [OKX Payments SDK](https://github.com/okx/payments) — TypeScript, Go, Rust
- [OKX Developer Portal](https://web3.okx.com/onchain-os/dev-portal) — API credentials
