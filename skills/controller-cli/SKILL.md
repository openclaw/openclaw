---
name: controller-cli
description: Install and operate the Cartridge Controller CLI (`controller`) for human-approved sessions and Starknet transaction execution (JSON-only, explicit network, least-privilege policies, paymaster control, error recovery).
homepage: https://github.com/cartridge-gg/controller-cli
metadata: { "openclaw": { "emoji": "🎮", "requires": { "bins": ["controller"] } } }
user-invocable: true
---

# Cartridge Controller CLI

Use this skill when you need to run the Cartridge Controller CLI (`controller-cli`) to create a scoped session (human-approved) and then execute Starknet transactions via that session.

## Non-Negotiable Rules

- Always pass `--json` and treat outputs as JSON.
- Always be explicit about network. Never rely on defaults:
  - `--chain-id SN_MAIN|SN_SEPOLIA`, or
  - `--rpc-url <explicit url>`.
- `controller register` requires human browser authorization. Do not automate/bypass it.
- Use least-privilege policies only. Do not add token transfer permissions unless explicitly requested.
- Transaction links: use Voyager only:
  - Mainnet: `https://voyager.online/tx/0x...`
  - Sepolia: `https://sepolia.voyager.online/tx/0x...`

## Quick Start (Install)

```bash
curl -fsSL https://raw.githubusercontent.com/cartridge-gg/controller-cli/main/install.sh -o /tmp/controller-cli-install.sh
# Review the script before running it (it installs the `controller` binary).
# For reproducibility, consider pinning to a tag/commit SHA instead of `main`.
bash /tmp/controller-cli-install.sh
export PATH="$PATH:$HOME/.local/bin"
controller --version
```

## Safer Wrapper (Recommended)

This skill includes a small wrapper that enforces the rules above and normalizes output:

```bash
python3 {baseDir}/scripts/controller_safe.py status
python3 {baseDir}/scripts/controller_safe.py register --preset loot-survivor --chain-id SN_MAIN
python3 {baseDir}/scripts/controller_safe.py execute 0xCONTRACT entrypoint 0xCALLDATA --rpc-url https://api.cartridge.gg/x/starknet/sepolia
```

Behavior:

- Adds `--json` if missing.
- Refuses to run `call|execute|register|transaction` without `--chain-id` or `--rpc-url`.
- Times out after 900 seconds by default (override with `CONTROLLER_SAFE_TIMEOUT_SECONDS`; set to `0` to disable).
- Parses stdout as JSON.
- If `.status == "error"`, prints `error_code`, `message`, `recovery_hint` and exits non-zero.

## Deterministic Workflow

### 1) Generate Keypair

```bash
controller generate --json
```

The private key is stored locally (typically `~/.config/controller-cli/`).

### 2) Check Session Status

```bash
controller status --json
```

Common states:

- `no_session` (no keypair)
- `keypair_only` (needs registration)
- `active` (registered and not expired)

### 3) Register Session (Human Approval Required)

Requirement: a human must approve in a browser.

Option A (preferred): preset policies:

```bash
controller register --preset loot-survivor --chain-id SN_MAIN --json
```

Option B: least-privilege policy file:

```bash
controller register --file policy.json --rpc-url https://api.cartridge.gg/x/starknet/sepolia --json
```

Authorization output includes `short_url` and/or `authorization_url`:

- Display `short_url` if present; otherwise display `authorization_url`.
- Ask the user to open it and approve.
- The CLI blocks until approved or timeout (typically ~6 minutes).

### 4) Execute Transaction

Single call (positional args: contract, entrypoint, calldata):

```bash
controller execute 0xCONTRACT transfer 0xRECIPIENT,0xAMOUNT_LOW,0xAMOUNT_HIGH \
  --rpc-url https://api.cartridge.gg/x/starknet/sepolia \
  --json
```

Multiple calls from file:

```bash
controller execute --file calls.json --rpc-url https://api.cartridge.gg/x/starknet/sepolia --json
```

Optional confirmation wait:

```bash
controller execute --file calls.json --rpc-url https://api.cartridge.gg/x/starknet/sepolia --wait --timeout 300 --json
```

### 5) Read-Only Call (No Session Needed)

```bash
controller call 0xCONTRACT balance_of 0xADDRESS --chain-id SN_SEPOLIA --json
```

### 6) Transaction Status

```bash
controller transaction 0xTX_HASH --chain-id SN_SEPOLIA --wait --timeout 300 --json
```

### 7) Lookup Usernames / Addresses

```bash
controller lookup --usernames alice,bob --json
controller lookup --addresses 0x123...,0x456... --json
```

## Network Selection

Always be explicit about network.

Supported networks:

| Chain ID     | RPC URL                                       |
| ------------ | --------------------------------------------- |
| `SN_MAIN`    | `https://api.cartridge.gg/x/starknet/mainnet` |
| `SN_SEPOLIA` | `https://api.cartridge.gg/x/starknet/sepolia` |

Priority order:

1. `--rpc-url` flag
2. Stored session RPC URL (from registration)
3. Config default (lowest)

If network is ambiguous:

1. Run `controller status --json`
2. Match the session `chain_id`, or ask the user

## Paymaster Control

Default behavior uses the paymaster (free execution). If the paymaster is unavailable, the transaction fails (no silent fallback).

To self-pay with user funds:

```bash
controller execute ... --no-paymaster --json
```

## Amount Encoding (u256)

Many ERC20-style amounts are `u256` split into `(low, high)` u128 limbs.

For values that fit in u128 (most cases): set `high = 0x0`.

Example calldata:
`0xRECIPIENT,0x64,0x0`

## Error Handling

Errors are JSON:

```json
{
  "status": "error",
  "error_code": "ErrorType",
  "message": "...",
  "recovery_hint": "..."
}
```

Always branch on `error_code` and follow `recovery_hint`.

Common recoveries:

- `NoSession`: run `controller generate --json`
- `SessionExpired`: re-run `controller register ... --json`
- `ManualExecutionRequired`: policy does not authorize the call; tighten/adjust policy and re-register
- `CallbackTimeout`: user did not approve quickly enough; re-run `register` and retry

## Input Validation

Addresses must be `0x`-prefixed hex (up to 64 hex chars after `0x`; leading zeros may be omitted).
If you require a canonical `0x` + 64-hex format, use `--strict-64`.

```bash
python3 {baseDir}/scripts/validate_hex_address.py 0xabc...
python3 {baseDir}/scripts/validate_hex_address.py --strict-64 0x00...01
```
