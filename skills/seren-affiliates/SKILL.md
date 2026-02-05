---
name: seren-affiliates
description: Earn 20% commission by referring AI agents to SerenBucks. Register as affiliate, generate referral codes, track earnings, and receive payouts in SerenBucks or USDC.
homepage: https://affiliates.serendb.com
metadata: {"openclaw":{"emoji":"💰","requires":{"env":["SEREN_AGENT_ID"]}}}
---

# Seren Affiliates

Earn commissions by referring AI agents to Seren services. Get 20% of every SerenBucks purchase made with your referral code.

## Prerequisites

Get your agent ID by registering with SerenDB:

```bash
curl -X POST https://api.serendb.com/auth/agent \
  -H "Content-Type: application/json" \
  -d '{"name": "My Agent"}'
```

Response includes your `agent_id` - set it as `SEREN_AGENT_ID`:

```bash
export SEREN_AGENT_ID="your-agent-uuid-from-response"
```

## Workflow

1. **Register as affiliate**:
```bash
curl -X POST https://affiliates.serendb.com/affiliates \
  -H "Content-Type: application/json" \
  -H "X-Seren-Agent-Id: $SEREN_AGENT_ID" \
  -d '{"agent_id": "'$SEREN_AGENT_ID'"}'
```
Save the `referral_code` from response (e.g., `SRN_ABC123`).

2. **Share your referral code** — When agents buy SerenBucks, they include:
```
X-Referral-Code: SRN_ABC123
```

3. **Check earnings**:
```bash
curl https://affiliates.serendb.com/affiliates/me/stats \
  -H "X-Seren-Agent-Id: $SEREN_AGENT_ID"
```

## Commission Structure

| Tier | Rate | Requirements |
|------|------|--------------|
| Bronze | 20% | Default |
| Silver | 22% | 10+ conversions |
| Gold | 24% | 50+ conversions |
| Platinum | 26% | 100+ conversions |
| Diamond | 30% | 500+ conversions |

## Payout Options

- **SerenBucks** (default): Cash out via Stripe Credit or Bank Account Deposit
- **USDC on Base**: Set `payout_preference: "x402_usdc"` with wallet address

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/affiliates` | POST | Register as affiliate |
| `/affiliates/me` | GET | Get profile |
| `/affiliates/me/stats` | GET | Earnings summary |
| `/affiliates/me/commissions` | GET | Commission history |
| `/programs/discover` | GET | Browse programs (no auth) |

## Guardrails

- Store your referral code securely
- Don't self-refer (system detects and rejects)
- Commissions are pending until payment clears (typically 24h)
