# @openclaw/spixi

OpenClaw extension for [Spixi](https://spixi.io) messaging via [QuIXI](https://github.com/ixian-platform/QuIXI).

> **Note:** Spixi is a decentralized P2P messenger built on the Ixian blockchain. This integration uses the QuIXI bridge for REST API and MQTT connectivity.

## Features

- **Decentralized Messaging**: P2P communication with no central server
- **Channel Plugin Integration**: Appears in onboarding wizard
- **Gateway Integration**: Real-time message listening via MQTT
- **QuIXI API**: Outbound messaging through REST endpoints
- **Agent Tool**: `spixi_add_contact` for automated contact management
- **Cryptographic Identity**: Wallet address-based authentication

## Prerequisites

1. **QuIXI Node** - Running instance of [QuIXI](https://github.com/ixian-platform/QuIXI)
2. **MQTT Broker** - For real-time message delivery (QuIXI publishes to MQTT)
3. **Ixian Wallet** - Your wallet address for identity

### QuIXI Quick Start

```bash
# Clone and build QuIXI
git clone https://github.com/ixian-platform/QuIXI
cd QuIXI
dotnet build

# Configure and run
dotnet run
```

See [QuIXI README](https://github.com/ixian-platform/QuIXI) for full setup instructions.

## Quick Start

### Option 1: Onboarding Wizard (Recommended)

```bash
openclaw onboard
# Select "Spixi" from channel list
# Enter MQTT broker host/port
# Enter QuIXI API URL
# Enter your wallet address
```

### Option 2: Manual Configuration

Add to your `config.yaml`:

```yaml
channels:
  spixi:
    enabled: true
    mqttHost: "127.0.0.1"
    mqttPort: 1883
    quixiApiUrl: "http://localhost:8001"
    myWalletAddress: "your-ixian-wallet-address"
    dmPolicy: pairing # pairing | allowlist | open | disabled
```

## Configuration Options

| Option            | Type    | Default                 | Description                               |
| ----------------- | ------- | ----------------------- | ----------------------------------------- |
| `enabled`         | boolean | `false`                 | Enable/disable the channel                |
| `mqttHost`        | string  | `127.0.0.1`             | MQTT broker hostname                      |
| `mqttPort`        | number  | `1883`                  | MQTT broker port                          |
| `quixiApiUrl`     | string  | `http://localhost:8001` | QuIXI REST API URL                        |
| `myWalletAddress` | string  | -                       | Your Ixian wallet (filters self-messages) |
| `dmPolicy`        | string  | `pairing`               | DM access policy                          |
| `allowFrom`       | array   | `[]`                    | Allowed sender addresses                  |

## Commands

### Send a Message

```bash
openclaw message send --channel spixi --target <wallet-address> --message "Hello!"
```

### Check Status

```bash
openclaw channels status --probe
```

## QuIXI API Reference

The extension uses these QuIXI endpoints:

| Endpoint                                      | Method | Description       |
| --------------------------------------------- | ------ | ----------------- |
| `/sendChatMessage?address=&message=&channel=` | GET    | Send text message |
| `/addContact?address=`                        | GET    | Add contact       |
| `/contacts`                                   | GET    | List contacts     |

MQTT Topics subscribed:

- `Chat` - Incoming chat messages

## Agent Tool

The extension registers a `spixi_add_contact` tool for AI agents:

```json
{
  "address": "ixian-wallet-address-to-add"
}
```

## Architecture

```
┌─────────────┐     MQTT      ┌─────────────┐     Ixian S2    ┌─────────────┐
│  OpenClaw   │ ◄──────────── │    QuIXI    │ ◄─────────────► │   Spixi     │
│   Gateway   │ ─────────────►│   Bridge    │                 │   Network   │
└─────────────┘   REST API    └─────────────┘                 └─────────────┘
```

## Why Spixi?

- **True P2P**: No central servers, every user is a node
- **Cryptographic Identity**: Wallet addresses, no phone numbers
- **Post-Quantum Security**: RSA + ECDH + ML-KEM cryptography
- **Censorship Resistant**: Ixian S2 overlay network
- **Built-in Payments**: Native IXI wallet for micro-transactions

## Troubleshooting

- **Connection Issues**: Verify QuIXI is running and MQTT broker is accessible
- **No Messages**: Check `myWalletAddress` is set to filter self-messages
- **API Errors**: Ensure QuIXI API URL is correct (default: `http://localhost:8001`)

## Links

- [Spixi](https://spixi.io) - Decentralized messenger
- [QuIXI](https://github.com/ixian-platform/QuIXI) - Integration bridge
- [Ixian](https://ixian.io) - Blockchain platform
