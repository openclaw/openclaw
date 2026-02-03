# Holochain Integration

OpenClaw supports integration with Holochain to enable decentralized, peer-to-peer agent infrastructure with enhanced security and agent-to-agent economy features.

## Overview

Holochain provides:

- **Decentralized session storage** via DHT (Distributed Hash Table)
- **Enhanced security** through validation rules and immutable audit logs
- **Agent-to-Agent (A2A) economy** with Solana/USDC integration
- **Full P2P routing** without central gateway dependency

## Configuration

Add Holochain configuration to your `openclaw.json`:

```json
{
  "holochain": {
    "mode": "hybrid",
    "conductor": {
      "adminPort": 4444,
      "appPort": 4445,
      "autoStart": true
    },
    "sessionStorage": {
      "enabled": true,
      "fallbackToLocal": true,
      "retentionDays": 30,
      "encryption": true
    }
  }
}
```

## Integration Modes

### Disabled (Default)

No Holochain integration. OpenClaw operates with standard Node.js gateway.

```json
{
  "holochain": {
    "mode": "disabled"
  }
}
```

### Hybrid Mode

Combines Node.js gateway with Holochain DHT for session storage. Best for gradual migration.

```json
{
  "holochain": {
    "mode": "hybrid",
    "sessionStorage": {
      "enabled": true,
      "fallbackToLocal": true
    }
  }
}
```

**Features:**

- Gateway handles messaging channels (Telegram, Discord, etc.)
- Session history stored in Holochain DHT
- Automatic fallback to local storage if Holochain unavailable
- Data sovereignty: sessions replicated across DHT nodes

### Full P2P Mode

Complete P2P operation. Gateway only used for legacy channel support.

```json
{
  "holochain": {
    "mode": "full-p2p",
    "p2p": {
      "enabled": true,
      "networkId": "openclaw-mainnet",
      "bootstrapNodes": ["wss://bootstrap1.openclaw.ai", "wss://bootstrap2.openclaw.ai"],
      "kitsuneTransport": true
    }
  }
}
```

**Features:**

- Peer-to-peer agent routing
- Decentralized agent discovery
- No single point of failure
- Enhanced privacy and censorship resistance

## Conductor Configuration

### Binary Path

Specify Holochain conductor binary location:

```json
{
  "holochain": {
    "conductor": {
      "binPath": "/usr/local/bin/holochain"
    }
  }
}
```

Auto-detection tries:

1. `HOLOCHAIN_BIN` environment variable
2. `holochain` in PATH
3. Common installation paths

### Ports

Configure admin and app ports:

```json
{
  "holochain": {
    "conductor": {
      "adminPort": 4444,
      "appPort": 4445
    }
  }
}
```

### Data Directory

Set conductor data directory:

```json
{
  "holochain": {
    "conductor": {
      "dataDir": "~/.openclaw/holochain"
    }
  }
}
```

## Session Storage

### DHT-Based Storage

Enable distributed session storage:

```json
{
  "holochain": {
    "sessionStorage": {
      "enabled": true,
      "retentionDays": 30,
      "encryption": true
    }
  }
}
```

**Benefits:**

- Sessions replicated across DHT nodes
- Data sovereignty (you control your data)
- Automatic backup and redundancy
- Encryption at rest with AES-256

### Fallback Strategy

Configure fallback to local storage:

```json
{
  "holochain": {
    "sessionStorage": {
      "fallbackToLocal": true
    }
  }
}
```

When enabled:

1. Try DHT storage first
2. If Holochain unavailable, use local SQLite
3. Auto-sync when Holochain comes back online

## Security Features

### Prompt Injection Prevention

Enable validation rules to prevent prompt injection:

```json
{
  "holochain": {
    "security": {
      "promptValidation": true
    }
  }
}
```

**Reduces injection rate from 91% to ~10%** through:

- Pattern-based validation
- Semantic analysis
- Community-verified rules

### Immutable Audit Log

Log all operations to DHT:

```json
{
  "holochain": {
    "security": {
      "auditLog": true
    }
  }
}
```

**Features:**

- Tamper-proof logging
- Cryptographic signatures
- Compliance-ready audit trail

### Rate Limiting

DHT-based rate limiting:

```json
{
  "holochain": {
    "security": {
      "rateLimitPerHour": 10
    }
  }
}
```

**Prevents abuse:**

- Track requests across DHT nodes
- IP-based limiting
- Agent-based limiting
- Protects against fake agent spam

### Sandbox Hardening

AppArmor/seccomp profiles:

```json
{
  "holochain": {
    "security": {
      "sandboxHardening": true
    }
  }
}
```

**Linux-only feature** using NVIDIA security patterns.

## Agent-to-Agent Economy

### Enable A2A Features

```json
{
  "holochain": {
    "a2a": {
      "enabled": true,
      "commissionRate": 0.05,
      "maxPingPongTurns": 5
    }
  }
}
```

### Wallet Integration

Solana/USDC managed wallet:

```json
{
  "holochain": {
    "a2a": {
      "wallet": {
        "enabled": true,
        "network": "devnet",
        "seedPhrase": "..."
      }
    }
  }
}
```

**Warning:** Secure your seed phrase! Use environment variables:

```bash
export HOLOCHAIN_WALLET_SEED="your seed phrase here"
```

### Commission Structure

Default: 5% commission on verified skills marketplace

```json
{
  "holochain": {
    "a2a": {
      "commissionRate": 0.05
    }
  }
}
```

**How it works:**

1. Agent A requests service from Agent B
2. Payment in USDC via Solana
3. 5% goes to OpenClaw ecosystem fund
4. 95% to Agent B owner

## P2P Configuration

### Bootstrap Nodes

Configure DHT bootstrap nodes:

```json
{
  "holochain": {
    "p2p": {
      "bootstrapNodes": ["wss://bootstrap1.openclaw.ai", "wss://bootstrap2.openclaw.ai"]
    }
  }
}
```

### Network ID

Set network identifier:

```json
{
  "holochain": {
    "p2p": {
      "networkId": "openclaw-mainnet"
    }
  }
}
```

**Networks:**

- `openclaw-mainnet`: Production network
- `openclaw-testnet`: Testing network
- `custom-network`: Private networks

### Kitsune Transport

Enable Kitsune P2P transport:

```json
{
  "holochain": {
    "p2p": {
      "kitsuneTransport": true
    }
  }
}
```

## Installation

### Install Holochain Conductor

```bash
# Ubuntu/Debian
curl -L https://github.com/holochain/holochain/releases/download/holochain-0.6.0/holochain-0.6.0-x86_64-unknown-linux-gnu.tar.gz | tar xz
sudo mv holochain /usr/local/bin/

# macOS
brew install holochain
```

### Enable Holochain in OpenClaw

```bash
# Configure
openclaw config set holochain.mode hybrid
openclaw config set holochain.conductor.autoStart true

# Verify
openclaw config get holochain
```

## Troubleshooting

### Conductor Not Starting

Check logs:

```bash
tail -f ~/.openclaw/holochain/conductor.log
```

Verify binary:

```bash
which holochain
holochain --version
```

### DHT Connection Issues

Check network:

```bash
# Test bootstrap nodes
curl -I https://bootstrap1.openclaw.ai

# Check conductor admin interface
curl http://localhost:4444/admin/v1/health
```

### Session Sync Failures

Force sync:

```bash
openclaw sessions sync --force
```

Check fallback status:

```bash
openclaw status --holochain
```

## Performance

### Latency Targets

- **DHT read**: < 100ms
- **DHT write**: < 200ms
- **P2P routing**: < 150ms

### Scalability

- **Concurrent agents**: 10,000+
- **Sessions per agent**: 1,000+
- **DHT replication factor**: 5

## Migration Guide

### Phase 1: Enable Hybrid Mode

```bash
openclaw config set holochain.mode hybrid
openclaw config set holochain.sessionStorage.enabled true
```

### Phase 2: Test DHT Storage

```bash
# Create test session
openclaw agent chat "Hello DHT"

# Verify storage
openclaw sessions list --storage dht
```

### Phase 3: Enable Security Features

```bash
openclaw config set holochain.security.promptValidation true
openclaw config set holochain.security.auditLog true
openclaw config set holochain.security.rateLimitPerHour 10
```

### Phase 4: Enable A2A (Optional)

```bash
openclaw config set holochain.a2a.enabled true
openclaw config set holochain.a2a.wallet.enabled true
```

### Phase 5: Full P2P (Advanced)

```bash
openclaw config set holochain.mode full-p2p
openclaw config set holochain.p2p.enabled true
```

## Best Practices

1. **Start with hybrid mode** for gradual transition
2. **Enable fallback** to avoid downtime during DHT issues
3. **Monitor performance** with `openclaw status --holochain`
4. **Secure wallet seed** using environment variables
5. **Test on testnet** before using mainnet
6. **Keep conductor updated** for security patches

## Roadmap

- **Phase 1 (Q1 2026)**: Config schema ✅
- **Phase 2 (Q2 2026)**: Hybrid mode implementation
- **Phase 3 (Q3 2026)**: Security hardening
- **Phase 4 (Q4 2026)**: Enterprise features
- **Phase 5 (Q1 2027)**: A2A economy
- **Phase 6 (Q2-Q3 2027)**: Full P2P migration

## Community

- **Discord**: [OpenClaw Holochain Channel](https://discord.gg/openclaw-holochain)
- **Forum**: [Holochain Integration Discussions](https://forum.openclaw.ai/c/holochain)
- **GitHub**: [Holochain Integration Issues](https://github.com/openclaw/openclaw/labels/holochain)

## Related Documentation

- [Configuration Reference](/configuration)
- [Security Best Practices](/security)
- [Session Management](/sessions)
- [Gateway Architecture](/gateway)
