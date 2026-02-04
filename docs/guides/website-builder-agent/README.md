# Website Builder Agent

Create professional websites through WhatsApp conversations using OpenClaw + Lovable + Stripe.

## Overview

This guide shows how to set up an AI agent that:
- Collects project briefings via WhatsApp
- Shows design references from ThemeForest/Dribbble
- Creates websites using Lovable.dev
- Handles payments via Stripe
- Delivers finished sites to clients

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    CLIENT (WhatsApp)                         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    OPENCLAW GATEWAY                          │
│  - Session management per phone number                      │
│  - WhatsApp Web integration                                 │
│  - Skill orchestration                                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ DESIGN       │  │ LOVABLE      │  │ STRIPE       │
│ REFERENCES   │  │ CREATOR      │  │ PAYMENTS     │
│              │  │              │  │              │
│ Screenshots  │  │ Create sites │  │ Payment      │
│ from web     │  │ via API      │  │ links        │
└──────────────┘  └──────────────┘  └──────────────┘
```

## Prerequisites

- Node.js 22+
- OpenClaw installed (`npm install -g openclaw@latest`)
- WhatsApp account for the bot
- Lovable.dev account with API access
- Stripe account with API keys

## Quick Start

### 1. Install OpenClaw

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

### 2. Set up WhatsApp

```bash
openclaw channels login
# Scan QR code with WhatsApp on your phone
```

### 3. Copy workspace files

```bash
# Create workspace directory
mkdir -p ~/.openclaw/workspaces/website-builder

# Copy bootstrap files
cp workspace/SOUL.md ~/.openclaw/workspaces/website-builder/
cp workspace/AGENTS.md ~/.openclaw/workspaces/website-builder/
cp workspace/IDENTITY.md ~/.openclaw/workspaces/website-builder/
```

### 4. Configure OpenClaw

Edit `~/.openclaw/openclaw.json`:

```json5
{
  agents: {
    list: [
      {
        id: "website-builder",
        workspace: "~/.openclaw/workspaces/website-builder",
        identity: {
          name: "Site Builder",
          emoji: "🌐"
        }
      }
    ]
  },
  bindings: [
    {
      agentId: "website-builder",
      match: { channel: "whatsapp" }
    }
  ],
  channels: {
    whatsapp: {
      dmPolicy: "pairing"
    }
  }
}
```

### 5. Set environment variables

```bash
export LOVABLE_API_KEY="your-lovable-api-key"
export STRIPE_SECRET_KEY="sk_live_your-stripe-key"
export STRIPE_WEBHOOK_SECRET="whsec_your-webhook-secret"
```

### 6. Start the gateway

```bash
openclaw gateway run
```

## Skills Included

### website-builder

Main orchestration skill that defines the workflow and guardrails.

Location: `skills/website-builder/SKILL.md`

### lovable-creator

Creates websites using Lovable.dev's Build with URL API.

Location: `skills/lovable-creator/SKILL.md`

### stripe-payments

Creates payment links and handles Stripe webhooks.

Location: `skills/stripe-payments/SKILL.md`

### design-references

Searches and captures design references from template marketplaces.

Location: `skills/design-references/SKILL.md`

## Workflow

1. **BRIEFING** - Collect business info, objectives, preferences
2. **REFERENCES** - Show design templates for inspiration
3. **APPROVAL** - Get explicit client approval
4. **CREATION** - Generate site via Lovable
5. **REVISIONS** - Up to 3 rounds of changes
6. **PAYMENT** - Send Stripe payment link
7. **DELIVERY** - Deliver final site URL

## Configuration Reference

See `config-example.json5` for full configuration options.

### Key Settings

| Setting | Description |
|---------|-------------|
| `agents.list[].workspace` | Path to workspace with bootstrap files |
| `bindings` | Route WhatsApp to specific agent |
| `channels.whatsapp.dmPolicy` | `pairing`, `allowlist`, or `open` |
| `browser.enabled` | Enable for design references |

## Pricing Configuration

Edit the pricing in `skills/website-builder/SKILL.md`:

```markdown
## PRICING
- Site One Page: R$ 500
- Site Institucional: R$ 1.000
- Loja Virtual: R$ 2.000
- Manutenção: R$ 100/mês
```

## Production Deployment

### Using Docker

```bash
docker build -t website-builder-agent .
docker run -d \
  -e LOVABLE_API_KEY=xxx \
  -e STRIPE_SECRET_KEY=xxx \
  -v ~/.openclaw:/root/.openclaw \
  website-builder-agent
```

### Using Coolify

1. Connect GitHub repo to Coolify
2. Configure environment variables in Coolify UI
3. Deploy with auto-deploy on push

### Using Fly.io

```bash
fly launch
fly secrets set LOVABLE_API_KEY=xxx STRIPE_SECRET_KEY=xxx
fly deploy
```

## Troubleshooting

### WhatsApp not receiving messages

```bash
openclaw channels status --probe
```

### Agent not responding

```bash
openclaw doctor
tail -f /tmp/openclaw/openclaw-*.log
```

### Stripe webhooks not working

```bash
stripe listen --forward-to localhost:3000/webhook/stripe
```

## Cost Estimation

| Component | Monthly Cost |
|-----------|-------------|
| Claude API | $100-200 |
| VPS/Server | $20-40 |
| Lovable Pro | $25-50 |
| Stripe | 2.9% + $0.30/tx |
| **Total** | ~$145-290 |

## Support

- OpenClaw Docs: https://docs.openclaw.ai
- Lovable Docs: https://docs.lovable.dev
- Stripe Docs: https://stripe.com/docs
