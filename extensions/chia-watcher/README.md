# @openclaw/chia-watcher

Chia blockchain wallet monitoring plugin for [OpenClaw](https://openclaw.ai). Watches wallet addresses for incoming coins via direct peer-to-peer connection, decodes memos, and delivers real-time notifications to your messaging channel.

**No API keys. No third-party services. Just you and the blockchain.**

## Install

```bash
openclaw plugin install @openclaw/chia-watcher
```

Or manually:

```bash
npm install @openclaw/chia-watcher
```

Then add to your OpenClaw config (`openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "chia-watcher": {
        "enabled": true,
        "config": {
          "enabled": true,
          "network": "mainnet",
          "wallets": ["xch1youraddress..."],
          "notifyChannel": "telegram",
          "notifyTo": "telegram:your_chat_id"
        }
      }
    }
  }
}
```

Restart your gateway. The watcher auto-starts.

## Features

- **P2P monitoring** — connects directly to Chia full nodes via DNS introducer, no API keys or centralized services
- **Multi-wallet** — watch unlimited addresses simultaneously
- **Memo decoding** — automatically decodes hex memos to readable text
- **Pattern matching** — custom handlers for structured memos (payments, NFT mints, breeding, etc.)
- **Multi-channel notifications** — Telegram, Discord, Signal, WhatsApp, or any OpenClaw channel
- **Transaction history** — local SQLite database, queryable via slash commands
- **Auto-reconnect** — handles peer disconnections gracefully with exponential backoff
- **State persistence** — remembers last sync height across restarts (no duplicate alerts)
- **Self-signed certs** — auto-generates TLS certificates for peer connections (no openssl needed)
- **Slash commands** — manage everything from chat

## Slash Commands

| Command | Description |
|---------|-------------|
| `/chia_status` | Show connection status, peer height, wallet count |
| `/chia_watch xch1...` | Add a wallet address to monitor |
| `/chia_unwatch xch1...` | Stop monitoring a wallet address |
| `/chia_history [n]` | Show last n transactions (default: 10) |

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the watcher service |
| `network` | string | `"mainnet"` | `"mainnet"` or `"testnet11"` |
| `wallets` | string[] | `[]` | Array of `xch1...` addresses to monitor |
| `autoStart` | boolean | `true` | Start monitoring on gateway boot |
| `notifyChannel` | string | — | Channel for alerts: `telegram`, `discord`, `signal`, `whatsapp` |
| `notifyTo` | string | — | Recipient: `telegram:123456`, `discord:channelid`, etc. |
| `minAmountXch` | number | `0` | Minimum XCH amount to trigger notification |
| `includeCATs` | boolean | `true` | Include CAT (token) transactions |
| `dbPath` | string | auto | Custom SQLite database path |
| `pollIntervalMs` | integer | `30000` | Heartbeat check interval (ms) |
| `memoHandlers` | array | `[]` | Custom memo pattern handlers (see below) |

## Custom Memo Handlers

Match structured memos and format custom notifications:

```json
{
  "memoHandlers": [
    {
      "name": "payment",
      "pattern": "^PAYMENT\\|(.+)\\|(.+)$",
      "template": "Payment from {match1}: {amountXch} XCH — ref: {match2}",
      "enabled": true
    },
    {
      "name": "nft-mint",
      "pattern": "COLLECTION_MINT\\|(.+)\\|name:(.+?)\\|",
      "template": "NFT Minted: {match2} (type: {match1})",
      "enabled": true
    }
  ]
}
```

**Template variables:**

| Variable | Description |
|----------|-------------|
| `{amount}` | Amount in mojos |
| `{amountXch}` | Amount in XCH |
| `{address}` | Full recipient address |
| `{addressShort}` | Truncated address |
| `{memo}` | Decoded memo text |
| `{height}` | Block height |
| `{coinId}` | Coin ID |
| `{network}` | Network name |
| `{type}` | `XCH` or `CAT` |
| `{assetId}` | CAT asset ID (if applicable) |
| `{match1}`, `{match2}`, ... | Regex capture groups |

## RPC Methods

For programmatic control from other plugins or scripts:

| Method | Description |
|--------|-------------|
| `chia-watcher.start` | Start the watcher |
| `chia-watcher.stop` | Stop the watcher |
| `chia-watcher.status` | Get current status |

## Security

- **No secrets stored** — TLS certs are self-signed and auto-generated locally
- **No outbound API calls** — all monitoring is P2P via the Chia protocol
- **Local database only** — transaction history stays on your machine
- **Address validation** — wallet addresses are validated against `xch1` bech32m format
- **Read-only** — the plugin only observes the blockchain, it cannot spend coins

## How It Works

1. Generates a self-signed TLS certificate (stored in your OpenClaw data directory)
2. Resolves Chia full node IPs via the official DNS introducer (`dns-introducer.chia.net`)
3. Connects to a random peer using the Chia wallet protocol
4. Subscribes to puzzle hash updates for your wallet addresses
5. When new coins appear, decodes the parent spend to extract memos
6. Matches memos against your handlers and delivers formatted notifications
7. Persists state so restarts don't replay old transactions

## Requirements

- OpenClaw >= 2026.2.0
- Node.js >= 18
- Network access to Chia mainnet peers (port 8444)

## License

MIT — KOBA42 Corp
