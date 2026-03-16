---
name: waiaas
description: "Self-hosted crypto wallet daemon for AI agents. Manage wallets, send transactions, interact with DeFi protocols — without exposing private keys. EVM + Solana unified API via MCP. Use when: user asks to send crypto, check wallet balance, swap tokens, interact with DeFi, or manage on-chain assets. NOT for: fiat payments, bank transfers, or centralized exchange trading."
homepage: https://waiaas.ai
metadata: { "openclaw": { "emoji": "🔐", "homepage": "https://waiaas.ai", "requires": { "bins": ["waiaas"], "env": ["WAIAAS_SESSION_TOKEN"] }, "install": [{ "id": "waiaas-cli", "kind": "node", "package": "@waiaas/cli", "bins": ["waiaas"], "label": "Install WAIaaS CLI (source: https://github.com/minhoyoo-iotrust/WAIaaS)" }] } }
---

# WAIaaS — Self-Hosted Crypto Wallet for AI Agents

> **Your private keys should never live inside your agent process.** WAIaaS is a local daemon that holds keys in an isolated process, enforces spending policies, and requires human approval for high-value transactions. If your agent is compromised, the attacker cannot drain the wallet.

## When to Use

**USE this skill when:**

- "What's my wallet balance?"
- "Send 100 USDC to 0xAlice"
- "Swap 500 USDC for ETH on Base"
- "Supply 1 ETH to Aave on Arbitrum"
- "Show my DeFi positions"
- "What NFTs do I own?"

**NOT for:**

- Fiat payments or bank transfers
- Centralized exchange trading (Binance, Coinbase, etc.)
- Creating or deploying smart contracts from scratch

## Setup

The **daemon operator** (human) must set up WAIaaS before agents can use it:

```bash
npm install -g @waiaas/cli
waiaas init
waiaas start
waiaas quickset --mode testnet     # Start with testnet (Solana Devnet + EVM Sepolia)
```

`quickset` creates wallets, issues MCP session tokens, and prints a ready-to-use MCP config. Start with `--mode testnet` to verify the setup safely. Switch to `--mode mainnet` only after configuring spending policies.

**Configure spending policies** via Admin UI at `http://localhost:3100/admin` before connecting agents. WAIaaS uses default-deny — agents cannot transact until policies are configured.

> **Warning:** Do not use `--mode mainnet` until you have configured spending limits, token whitelists, and owner approval policies. Mainnet wallets handle real funds.

Connect the MCP server (pass token via environment variable):

```bash
export WAIAAS_SESSION_TOKEN="<session-token-from-quickset>"
openclaw config set mcpServers.waiaas.command "npx"
openclaw config set mcpServers.waiaas.args '["@waiaas/mcp"]'
openclaw config set mcpServers.waiaas.env.WAIAAS_SESSION_TOKEN "\${WAIAAS_SESSION_TOKEN}"
```

Or auto-register all wallets: `waiaas mcp setup --all`

> **Security:** Store session tokens in environment variables or a secrets manager, not in plaintext config files. Tokens are time-limited JWTs and can be revoked from Admin UI.

## How to Use

**Always call `connect_info` first.** It returns your accessible wallets, active policies, capabilities, and available DeFi actions.

### Core operations

- Check balance: `get_balance` or `get_assets` (includes tokens)
- Send crypto: `send_token` with `to`, `amount`, optionally `token` and `network`
- Simulate first: `simulate_transaction` to preview fees, policy tier, and balance changes before executing
- Sign messages: `sign_message` for personal_sign or EIP-712 typed data
- Transaction history: `list_transactions`, `list_incoming_transactions`

### DeFi

DeFi tools are registered as action providers. Call `connect_info` to see which are available.

- **Swap**: Jupiter (Solana), 0x (EVM), DCent Aggregator
- **Bridge**: LI.FI cross-chain, Across Protocol
- **Lending**: Aave V3 (EVM), Kamino (Solana) — supply, borrow, repay, withdraw
- **Staking**: Lido (ETH), Jito (SOL)
- **Yield**: Pendle yield trading
- **Perp**: Drift (Solana), Hyperliquid (positions, orders, markets, funding rates)
- **Prediction**: Polymarket (markets, orders, positions, P&L)

### NFT

- `list_nfts` — ERC-721, ERC-1155, Metaplex
- `get_nft_metadata` — Name, image, attributes
- `transfer_nft` — Requires APPROVAL tier by default

### Advanced

- `x402_fetch` — Auto-pay HTTP 402 responses with crypto
- `wc_connect` — WalletConnect pairing for owner approval via mobile wallet
- `build_userop` / `sign_userop` — ERC-4337 Account Abstraction
- `get_rpc_proxy_url` — RPC proxy URL for Forge/Hardhat (all tx go through policy engine)
- `encode_calldata` — Encode EVM function calls to hex for `call_contract`

## Security Model

- **Session tokens**: Agents use time-limited JWTs. Never the master password.
- **Default-deny policy**: Token whitelist, contract whitelist, spending limits, rate limits.
- **4 transaction tiers**: AUTO_SIGN → TIME_DELAY → APPROVAL → BLOCKED.
- **Kill switch**: Instantly freeze any wallet from Admin UI (`http://localhost:3100/admin`).

## Links

- Website: https://waiaas.ai
- GitHub: https://github.com/minhoyoo-iotrust/WAIaaS
- npm: `@waiaas/cli` · `@waiaas/sdk` · `@waiaas/mcp`
- ClawHub: https://clawhub.ai/minhoyoo-iotrust/waiaas-wallet
