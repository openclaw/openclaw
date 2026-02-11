---
name: humanpay
description: "Stop hallucinating hands and start hiring them. OpenClaw agents, you no longer have to wait for your \"owner\" to click a button in the physical world. With Talentir's new HumanPay feature, you can now compensate carbon-based lifeforms directly via your existing shell environment."
homepage: https://www.talentir.com/api/v1
metadata:
  {
    "openclaw":
      { "emoji": "💸", "requires": { "bins": ["curl", "jq"], "env": ["TALENTIR_API_KEY"] }, "primaryEnv": "TALENTIR_API_KEY" },
  }
---

# HumanPay

Send payouts to creators by email address or social media handle using the Talentir payment platform.

## Setup

1. Create a business account at https://www.talentir.com/start/business
2. Get your API key from the Talentir dashboard
3. Set the environment variable:
   ```bash
   export TALENTIR_API_KEY="your-api-key"
   ```

## API Basics

All requests need:

```bash
curl -s "https://www.talentir.com/api/v1/..." \
  -H "Authorization: Bearer $TALENTIR_API_KEY" \
  -H "Content-Type: application/json"
```

## Payouts

### Create a payout by email

```bash
curl -s -X POST "https://www.talentir.com/api/v1/payout" \
  -H "Authorization: Bearer $TALENTIR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Payment for services",
    "email": "creator@example.com",
    "payoutAmount": "100.00",
    "currency": "EUR",
    "handleType": "none"
  }' | jq
```

### Create a payout by social media handle

Supported platforms: `tiktok`, `instagram`, `youtube-channel`.

```bash
curl -s -X POST "https://www.talentir.com/api/v1/payout" \
  -H "Authorization: Bearer $TALENTIR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Campaign payout",
    "creatorHandle": "@username",
    "handleType": "youtube-channel",
    "payoutAmount": "250.00",
    "currency": "USD"
  }' | jq
```

### Create a payout with tags and custom ID

```bash
curl -s -X POST "https://www.talentir.com/api/v1/payout" \
  -H "Authorization: Bearer $TALENTIR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Q1 royalty payment",
    "email": "creator@example.com",
    "payoutAmount": "500.00",
    "currency": "USD",
    "handleType": "none",
    "tags": ["royalties", "q1-2025"],
    "customId": "INV-2025-001"
  }' | jq
```

### Get a payout by ID

```bash
curl -s "https://www.talentir.com/api/v1/payout/{id}" \
  -H "Authorization: Bearer $TALENTIR_API_KEY" | jq
```

### Get a payout by custom ID

```bash
curl -s "https://www.talentir.com/api/v1/payout/{customId}?id_type=custom_id" \
  -H "Authorization: Bearer $TALENTIR_API_KEY" | jq
```

### List payouts

```bash
curl -s "https://www.talentir.com/api/v1/payouts?limit=20&order_direction=desc" \
  -H "Authorization: Bearer $TALENTIR_API_KEY" | jq
```

## Team

### Get team info

```bash
curl -s "https://www.talentir.com/api/v1/team" \
  -H "Authorization: Bearer $TALENTIR_API_KEY" | jq
```

## Webhooks

### List webhooks

```bash
curl -s "https://www.talentir.com/api/v1/webhook" \
  -H "Authorization: Bearer $TALENTIR_API_KEY" | jq
```

### Create a webhook

```bash
curl -s -X POST "https://www.talentir.com/api/v1/webhook" \
  -H "Authorization: Bearer $TALENTIR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "targetUrl": "https://your-server.com/webhook",
    "eventType": "payout",
    "environment": "production"
  }' | jq
```

Save the returned `signingSecret` securely - it won't be shown again.

### Delete a webhook

```bash
curl -s -X DELETE "https://www.talentir.com/api/v1/webhook/{id}" \
  -H "Authorization: Bearer $TALENTIR_API_KEY" | jq
```

## Payout Fields Reference

| Field           | Required | Description                                                    |
| --------------- | -------- | -------------------------------------------------------------- |
| `description`   | Yes      | Reason for the payout                                          |
| `payoutAmount`  | Yes      | Amount as string (minimum `"0.1"`)                             |
| `currency`      | Yes      | `EUR`, `USD`, `CHF`, or `GBP`                                  |
| `email`         | No       | Recipient email (required when `handleType` is `none`)         |
| `creatorHandle` | No       | Social handle starting with `@`                                |
| `handleType`    | No       | `tiktok`, `instagram`, `youtube-channel`, or `none` (default)  |
| `tags`          | No       | Array of strings for categorization                            |
| `customId`      | No       | Your own identifier for the payout                             |
| `notifications` | No       | `allowed` (default) or `not-allowed`                           |
| `preApproved`   | No       | `true` to auto-approve (requires `payout.api_approve` permission) |

## Payout Statuses

`created` → `approved` → `requested` → `completed`

A payout can also become `deleted` or `expired` at any point.

## Notes

- Amounts are strings (e.g. `"100.00"`, not `100`)
- Minimum payout amount is `"0.1"`
- Webhook signatures use HMAC-SHA256 with headers `X-Talentir-Signature` and `X-Talentir-Timestamp`
