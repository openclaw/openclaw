# Veil SDK Reference

Full documentation: https://github.com/veildotcash/veildotcash-sdk

## Installation

```bash
npm install -g @veil-cash/sdk
```

## CLI Commands

### `veil init`

Generate a new Veil keypair.

```bash
veil init              # Interactive, saves to .env.veil
veil init --force      # Overwrite existing without prompting
veil init --json       # Output as JSON (no prompts, no file save)
veil init --out path   # Save to custom path
veil init --no-save    # Print keypair without saving
```

### `veil keypair`

Show current Veil keypair as JSON (from VEIL_KEY env).

```bash
veil keypair
# {"veilPrivateKey":"0x...","depositKey":"0x..."}
```

### `veil status`

Check configuration and service status.

```bash
veil status
```

Output:
```json
{
  "walletKey": { "found": true, "address": "0x..." },
  "veilKey": { "found": true },
  "depositKey": { "found": true, "key": "0x1234...abcd" },
  "rpcUrl": { "found": false, "url": "https://mainnet.base.org" },
  "registration": {
    "checked": true,
    "registered": true,
    "matches": true,
    "onChainKey": "0x..."
  },
  "relay": {
    "checked": true,
    "healthy": true,
    "status": "ok",
    "network": "mainnet"
  }
}
```

### `veil register`

Register your deposit key on-chain (one-time per address).

```bash
veil register                              # Signs & sends
veil register --json                       # JSON output
veil register --unsigned --address 0x...   # Unsigned payload for agents
```

### `veil deposit ETH <amount>`

Deposit ETH into the privacy pool.

```bash
veil deposit ETH 0.1                    # Signs & sends (JSON output)
veil deposit ETH 0.1 --unsigned         # Unsigned payload for agents
veil deposit ETH 0.1 --quiet            # Suppress progress output
```

Output:
```json
{
  "success": true,
  "hash": "0x...",
  "amount": "0.1",
  "blockNumber": "12345678",
  "gasUsed": "150000"
}
```

### `veil balance`

Show both queue and private balances.

```bash
veil balance                        # Show all balances
veil balance --quiet                # Suppress progress output
```

Output:
```json
{
  "address": "0x...",
  "depositKey": "0x...",
  "totalBalance": "0.15",
  "totalBalanceWei": "150000000000000000",
  "private": {
    "balance": "0.10",
    "balanceWei": "100000000000000000",
    "utxoCount": 2,
    "utxos": [
      { "index": 5, "amount": "0.05" },
      { "index": 8, "amount": "0.05" }
    ]
  },
  "queue": {
    "balance": "0.05",
    "balanceWei": "50000000000000000",
    "count": 1,
    "deposits": [
      { "nonce": 42, "amount": "0.05", "status": "pending" }
    ]
  }
}
```

### `veil withdraw ETH <amount> <recipient>`

Withdraw from the privacy pool to any public address.

```bash
veil withdraw ETH 0.05 0xRecipientAddress
veil withdraw ETH 0.05 0xRecipientAddress --quiet
```

### `veil transfer ETH <amount> <recipient>`

Transfer privately to another registered Veil user.

```bash
veil transfer ETH 0.02 0xRecipientAddress
veil transfer ETH 0.02 0xRecipientAddress --quiet
```

### `veil merge ETH <amount>`

Consolidate multiple small UTXOs into one (self-transfer).

```bash
veil merge ETH 0.1                      # Merge UTXOs totaling 0.1 ETH
veil merge ETH 0.1 --quiet
```

## Environment Variables

| Variable     | Description                                                   |
| ------------ | ------------------------------------------------------------- |
| VEIL_KEY     | Your Veil private key (for ZK proofs, withdrawals, transfers) |
| DEPOSIT_KEY  | Your Veil deposit key (public, for register/deposit)          |
| WALLET_KEY   | Ethereum wallet private key (for signing transactions)        |
| RPC_URL      | Base RPC URL (optional, defaults to public RPC)               |

## Error Codes

| Code                  | Description                      |
| --------------------- | -------------------------------- |
| VEIL_KEY_MISSING      | VEIL_KEY not provided            |
| WALLET_KEY_MISSING    | WALLET_KEY not provided          |
| DEPOSIT_KEY_MISSING   | DEPOSIT_KEY not provided         |
| INVALID_ADDRESS       | Invalid Ethereum address format  |
| INVALID_AMOUNT        | Invalid or below minimum amount  |
| INSUFFICIENT_BALANCE  | Not enough ETH balance           |
| USER_NOT_REGISTERED   | Recipient not registered in Veil |
| NO_UTXOS              | No unspent UTXOs available       |
| RELAY_ERROR           | Error from relayer service       |
| RPC_ERROR             | RPC/network error                |
| CONTRACT_ERROR        | Smart contract reverted          |
| UNKNOWN_ERROR         | Unexpected error                 |

## For AI Agents

Use `--unsigned` to get Bankr-compatible transaction payloads:

```bash
veil deposit ETH 0.1 --unsigned
# {"to":"0x...","data":"0x...","value":"100000000000000000","chainId":8453}
```

The `--unsigned` flag outputs the Bankr arbitrary transaction format for agent signing.
