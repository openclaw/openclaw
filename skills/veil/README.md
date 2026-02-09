# Veil skill (draft)

This is a draft skill folder intended for submission to:
https://github.com/BankrBot/openclaw-skills

It wraps the local `veildotcash-sdk` checkout and optionally uses Bankr Agent API to sign & submit the unsigned deposit/register transactions.

## Assumptions

- **Veil SDK** is installed via one of these methods:

  **Option A: Global npm install (recommended)**
  ```bash
  npm install -g @veil-cash/sdk
  ```
  This makes the `veil` CLI available globally.

  **Option B: Clone from GitHub**
  ```bash
  mkdir -p ~/.openclaw/workspace/repos
  cd ~/.openclaw/workspace/repos
  git clone https://github.com/veildotcash/veildotcash-sdk.git
  cd veildotcash-sdk
  npm ci && npm run build
  ```

- Bankr skill is configured:
  - `~/.clawdbot/skills/bankr/config.json`

- Veil secrets are stored outside git:
  - `~/.clawdbot/skills/veil/.env.veil` (chmod 600)
  - `~/.clawdbot/skills/veil/.env` for `RPC_URL` (recommended — Veil queries a lot of blockchain data, so public RPCs will likely hit rate limits)

## Usage

```bash
cd veil

# Generate keypair
scripts/veil-init.sh

# Print keypair JSON
scripts/veil-keypair.sh

# Ask Bankr for address
scripts/veil-bankr-prompt.sh "What is my Base wallet address? Respond with just the address."

# Check balances
scripts/veil-balance.sh --address 0x...

# Deposit via Bankr (build unsigned tx + submit)
scripts/veil-deposit-via-bankr.sh 0.011 --address 0x...

# Withdraw / transfer / merge (local VEIL_KEY required)
scripts/veil-withdraw.sh 0.007 0x...
scripts/veil-transfer.sh 0.001 0x...
scripts/veil-merge.sh 0.001
```

## Notes

- `veil-bankr-prompt.sh` implements the same submit/poll loop as the Bankr skill, but localized here so this skill is self-contained.
- For production polish, the Veil SDK should ideally add `--env-file` flags so the CLI isn’t sensitive to the current working directory.
