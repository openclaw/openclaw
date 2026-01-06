---
summary: "Pairing overview: approve who can DM you + which nodes can join"
read_when:
  - Setting up DM access control
  - Pairing a new iOS/Android node
  - Reviewing Clawdbot security posture
---

# Pairing

“Pairing” is Clawdbot’s explicit **owner approval** step.
It is used in two places:

1) **DM pairing** (who is allowed to talk to the bot)
2) **Node pairing** (which devices/nodes are allowed to join the gateway network)

Security context: https://docs.clawd.bot/security

## 1) DM pairing (inbound chat access)

When a provider is configured with DM policy `pairing`, unknown senders get a short code and their message is **not processed** until you approve.

Default DM policies are documented in: https://docs.clawd.bot/security

### Approve a sender

```bash
clawdbot pairing list --provider telegram
clawdbot pairing approve --provider telegram <CODE>
```

Supported providers: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### Where the state lives

Stored under `~/.clawdbot/credentials/`:
- Pending requests: `<provider>-pairing.json`
- Approved allowlist store: `<provider>-allowFrom.json`

Treat these as sensitive (they gate access to your assistant).

### Source of truth (code)

- DM pairing storage + code generation: [`src/pairing/pairing-store.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/pairing/pairing-store.ts)
- CLI commands: [`src/cli/pairing-cli.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/cli/pairing-cli.ts)

## 2) Node pairing (iOS/Android nodes joining the gateway)

Nodes (iOS/Android, future hardware, etc.) connect to the Gateway and request to join.
The Gateway keeps an authoritative allowlist; new nodes require explicit approve/reject.

### Approve a node

```bash
clawdbot nodes pending
clawdbot nodes approve <requestId>
```

### Where the state lives

Stored under `~/.clawdbot/nodes/`:
- `pending.json` (short-lived; pending requests expire)
- `paired.json` (paired nodes + tokens)

### Details

Full protocol + design notes: https://docs.clawd.bot/gateway/pairing

### Source of truth (code)

- Node pairing store (pending/paired + token issuance): [`src/infra/node-pairing.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/infra/node-pairing.ts)
- Gateway methods/events (`node.pair.*`): [`src/gateway/server-methods/nodes.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/gateway/server-methods/nodes.ts)
- CLI: [`src/cli/nodes-cli.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/cli/nodes-cli.ts)

## Related docs

- Security model + prompt injection: https://docs.clawd.bot/security
- Updating safely (run doctor): https://docs.clawd.bot/updating
- Provider configs:
  - Telegram: https://docs.clawd.bot/telegram
  - WhatsApp: https://docs.clawd.bot/whatsapp
  - Signal: https://docs.clawd.bot/signal
  - iMessage: https://docs.clawd.bot/imessage
  - Discord: https://docs.clawd.bot/discord
  - Slack: https://docs.clawd.bot/slack
