---
name: veil
description: Privacy and shielded transactions on Base via Veil Cash (veil.cash). Deposit ETH into a private pool, withdraw/transfer privately using ZK proofs. Manage Veil keypairs, check private/queue balances, and submit deposits via Bankr. Use when the user wants anonymous or private transactions, shielded transfers, or ZK-based privacy on Base.
metadata: {"openclaw": {"emoji": "🌪️", "homepage": "https://veil.cash", "requires": {"bins": ["node", "curl", "jq"]}}}
---

# Veil

This skill wraps the `@veil-cash/sdk` CLI to make Veil operations agent-friendly.

## What it does

- **Key management**: generate and store a Veil keypair locally
- **Status check**: verify configuration, registration, and relay health
- **Balances**: combined `balance`, `queue-balance`, `private-balance`
- **Deposits via Bankr**: build a **Bankr-compatible unsigned transaction** and ask Bankr to sign & submit it
- **Private actions**: `withdraw`, `transfer`, `merge` are executed locally using `VEIL_KEY` (ZK/proof flow)

## File locations (recommended)

- Veil keys: `~/.clawdbot/skills/veil/.env.veil` *(chmod 600)*
- Bankr API key: `~/.clawdbot/skills/bankr/config.json`

## Quick start

### 1) Install the Veil SDK

**Option A: Global npm install (recommended)**
```bash
npm install -g @veil-cash/sdk
```

**Option B: Clone from GitHub**
```bash
mkdir -p ~/.openclaw/workspace/repos
cd ~/.openclaw/workspace/repos
git clone https://github.com/veildotcash/veildotcash-sdk.git
cd veildotcash-sdk
npm ci && npm run build
```

### 2) Configure Base RPC (recommended)

Veil queries a lot of blockchain data (UTXOs, merkle proofs, etc.), so public RPCs will likely hit rate limits. A dedicated RPC from [Alchemy](https://www.alchemy.com/), [Infura](https://www.infura.io/), or similar is recommended.

Put `RPC_URL=...` in **one** of these:

- `~/.clawdbot/skills/veil/.env` *(preferred)*
- or the SDK repo `.env` (less ideal)

Example:
```bash
mkdir -p ~/.clawdbot/skills/veil
cat > ~/.clawdbot/skills/veil/.env << 'EOF'
RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
EOF
chmod 600 ~/.clawdbot/skills/veil/.env
```

### 3) Make scripts executable

```bash
chmod +x scripts/*.sh
```

### 4) Generate your Veil keypair

```bash
scripts/veil-init.sh
scripts/veil-keypair.sh
```

### 5) Check your setup

```bash
scripts/veil-status.sh
```

### 6) Find your Bankr Base address

```bash
scripts/veil-bankr-prompt.sh "What is my Base wallet address? Respond with just the address."
```

### 7) Check balances

```bash
scripts/veil-balance.sh --address 0xYOUR_BANKR_ADDRESS
```

### 8) Deposit via Bankr (sign & submit)

```bash
scripts/veil-deposit-via-bankr.sh 0.011 --address 0xYOUR_BANKR_ADDRESS
```

### 9) Withdraw (private → public)

```bash
scripts/veil-withdraw.sh 0.007 0xYOUR_BANKR_ADDRESS
```

## References

- [SDK Reference](references/sdk-reference.md) — CLI commands, environment variables, error codes
- [Troubleshooting](references/troubleshooting.md) — Common issues and debugging tips

## Notes

- For **Bankr signing**, this skill uses Bankr’s Agent API via your local `~/.clawdbot/skills/bankr/config.json`.
- For privacy safety: never commit `.env.veil` or `.env` files to git.
