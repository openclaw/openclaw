---
summary: "Receive webhooks from external apps like Read.ai, QuickBooks, OwnerRez, and Shopify via URL-path authentication"
read_when:
  - Setting up Read.ai meeting notes integration
  - Setting up QuickBooks accounting event integration
  - Setting up OwnerRez booking and contact webhooks
  - Setting up Shopify order, customer, and product webhooks
  - Receiving webhooks from external services that cannot set custom auth headers
  - Configuring the /webhooks/ endpoint
title: "External App Webhooks"
---

# External App Webhooks

Many external services (Read.ai, QuickBooks, OwnerRez, Shopify, etc.) can send webhook notifications to a URL
but cannot set custom authentication headers. The `/webhooks/{token}/{source}` endpoint
handles this by embedding the auth token directly in the URL path.

This is separate from the standard `/hooks/` endpoint, which requires auth via headers.

## How It Works

1. You enable webhooks in your OpenClaw config with a list of preset sources
2. OpenClaw generates a webhook URL: `https://your-gateway/webhooks/{token}/{source}`
3. You register that URL with the external service
4. When the service sends a POST, OpenClaw validates the token, transforms the payload
   into a readable message, and dispatches it to the agent

## Configuration

Add a `webhooks` section inside your existing `hooks` config:

```json5
{
  hooks: {
    enabled: true,
    token: "your-secret-token",
    webhooks: {
      presets: ["readai", "quickbooks", "ownerrez", "shopify"],
    },
  },
}
```

- `hooks.enabled` and `hooks.token` are required (shared with the `/hooks/` system)
- `webhooks.presets` lists which external app transforms to enable
- `webhooks.enabled` can be set to `false` to disable without removing config (defaults to `true` when `presets` is set)

## Endpoint

### `POST /webhooks/{token}/{source}`

- **token**: Must match `hooks.token` exactly
- **source**: Must be a preset listed in `webhooks.presets`
- **Body**: JSON payload from the external service

Responses:

| Status | Meaning                                                   |
| ------ | --------------------------------------------------------- |
| `200`  | Webhook processed (or skipped gracefully)                 |
| `400`  | Malformed JSON body                                       |
| `404`  | Invalid token, unknown source, or webhooks not configured |
| `405`  | Non-POST method                                           |
| `413`  | Payload exceeds `hooks.maxBodyBytes`                      |

Invalid tokens return `404` (not `401`) to prevent endpoint discovery.

## Supported Presets

### `readai` - Read.ai Meeting Notes

[Read.ai](https://read.ai) provides AI-powered meeting notes, summaries, and action items.

**Webhook URL:**

```
https://your-gateway.example.com/webhooks/{token}/readai
```

**Supported triggers:**

- `meeting_end` - Processed into formatted meeting notes
- All other triggers (e.g., `meeting_start`) are skipped gracefully (returns `200` with `skipped: true`)

**What gets sent to the agent:**

When a meeting ends, the agent receives a formatted markdown message with:

- Meeting title and date range
- Organizer and participants
- Link to the full Read.ai report
- Summary
- Action items (bulleted list)
- Key questions (bulleted list)
- Topics discussed

**Example agent message:**

```markdown
## Meeting Notes: Weekly Standup

**Date:** 2026-02-08T10:00:00Z - 2026-02-08T10:30:00Z
**Organizer:** John
**Participants:** Alice, Bob
**Report:** https://read.ai/reports/sess-123

### Summary

Discussed sprint progress and upcoming blockers.

### Action Items

- Review PR #42
- Update deployment docs

### Key Questions

- When is the deadline for the Q1 release?

### Topics Discussed

- Sprint review
- Deployment plan
```

**Session isolation:** Each meeting gets its own session key (`webhook:readai:{session_id}`),
so the agent can reference prior context from the same meeting if needed.

### Setting Up Read.ai

1. Ensure your gateway is accessible from the internet (e.g., via Fly.io, Tailscale funnel, or a reverse proxy)

2. Add the webhook config:

   ```json5
   {
     hooks: {
       enabled: true,
       token: "your-secret-token",
       webhooks: {
         presets: ["readai"],
       },
     },
   }
   ```

3. In Read.ai, go to **Settings > Integrations > Webhooks** and add your URL:

   ```
   https://openclaw-jhs.fly.dev/webhooks/your-secret-token/readai
   ```

4. Test with a curl command:

   ```bash
   curl -X POST https://your-gateway/webhooks/your-secret-token/readai \
     -H 'Content-Type: application/json' \
     -d '{
       "trigger": "meeting_end",
       "session_id": "test-123",
       "title": "Test Meeting",
       "summary": "This is a test.",
       "action_items": ["Verify webhook works"],
       "key_questions": [],
       "topics": ["Testing"],
       "owner": {"name": "You", "email": "you@example.com"},
       "participants": []
     }'
   ```

5. You should see `{"ok":true,"runId":"..."}` and the agent will process the meeting notes

### `quickbooks` - QuickBooks Online Accounting Events

[QuickBooks Online](https://quickbooks.intuit.com) sends webhook notifications when accounting
entities change (invoices, bills, payments, customers, etc.).

**Webhook URL:**

```
https://your-gateway.example.com/webhooks/{token}/quickbooks
```

**Supported payload formats:**

- **Legacy format** (`eventNotifications`) - Current QuickBooks webhook format
- **CloudEvents format** - New format being adopted (migration deadline: May 2026)

Both formats are handled automatically.

**Supported entity types:**

Invoice, Bill, Payment, Customer, Vendor, Estimate, Account, Item, Credit Memo,
Sales Receipt, Purchase Order, Purchase, Journal Entry, Deposit, Transfer,
Refund Receipt, Bill Payment, Vendor Credit, Time Activity, Employee, Class,
Department, Tax Code, Tax Rate, Term, Payment Method, Budget, and any others
QuickBooks may add.

**Supported operations:** Create, Update, Delete, Merge, Void

**What gets sent to the agent:**

The agent receives a formatted markdown message summarizing the event(s):

```markdown
## QuickBooks Update

**Company ID:** 123456

**Invoice** Create (ID: 42) at 2026-02-08T10:00:00Z
```

For multiple events in a single webhook:

```markdown
## QuickBooks Update

**Company ID:** 123456

### Events

- **Invoice** Create (ID: 42) at 2026-02-08T10:00:00Z
- **Payment** Create (ID: 43) at 2026-02-08T10:01:00Z
```

**Session key:** Derived from the first entity in the payload (e.g., `webhook:quickbooks:Invoice:42:Create`),
so the agent can correlate related follow-up events.

### Setting Up QuickBooks

1. Ensure your gateway is accessible from the internet

2. Add the webhook config:

   ```json5
   {
     hooks: {
       enabled: true,
       token: "your-secret-token",
       webhooks: {
         presets: ["quickbooks"],
       },
     },
   }
   ```

3. In the [Intuit Developer Portal](https://developer.intuit.com), navigate to your app's
   **Webhooks** settings and register your URL:

   ```
   https://openclaw-jhs.fly.dev/webhooks/your-secret-token/quickbooks
   ```

4. Subscribe to the entity types you want to track (e.g., Invoice, Bill, Payment)

5. Note: QuickBooks webhook payloads only contain the entity ID and operation type, not the
   full entity data. The agent receives a notification about what changed and can use
   QuickBooks API tools (if configured) to fetch full details.

6. Test with a curl command:

   ```bash
   curl -X POST https://your-gateway/webhooks/your-secret-token/quickbooks \
     -H 'Content-Type: application/json' \
     -d '{
       "eventNotifications": [{
         "realmId": "123456",
         "dataChangeEvent": {
           "entities": [{
             "id": "42",
             "name": "Invoice",
             "operation": "Create",
             "lastUpdated": "2026-02-08T10:00:00Z"
           }]
         }
       }]
     }'
   ```

7. You should see `{"ok":true,"runId":"..."}` and the agent will receive the accounting event

### QuickBooks Webhook Verification

QuickBooks sends an `intuit-signature` header with HMAC-SHA256 verification using a verifier
token from the Intuit Developer Portal. OpenClaw currently authenticates via the URL-path token
rather than the Intuit signature header. Both mechanisms provide authentication; the URL token
ensures only your OpenClaw instance processes the webhook.

### `ownerrez` - OwnerRez Vacation Rental Events

[OwnerRez](https://www.ownerrez.com) is a vacation rental management platform that sends webhook
notifications for bookings, contacts, properties, and other entity changes.

**Webhook URL:**

```
https://your-gateway.example.com/webhooks/{token}/ownerrez
```

**Supported actions:**

- `entity_insert` - New entity created (booking, contact, etc.)
- `entity_update` - Existing entity modified
- `entity_delete` - Entity deleted
- `application_authorization_revoked` - API access revoked

**Supported entity types:**

Booking, Contact, Property, Block, Quote, Inquiry, Review, Owner Statement, Expense,
Charge, Payment, Refund, Message, Task, Note, and any custom entity types.

**What gets sent to the agent:**

The agent receives a formatted markdown message with entity details:

```markdown
## OwnerRez: Booking Created

**Booking ID:** 12345
**Categories:** booking_new, payment_received

**Guest:** Jane Doe
**Property:** Beach House
**Dates:** 2026-03-15 to 2026-03-22
**Guests:** 2 adults, 1 child
**Status:** confirmed
**Total:** 1250.00 USD
**Source:** Airbnb
```

For contacts:

```markdown
## OwnerRez: Contact Created

**Contact ID:** 5678

**Name:** Jane Doe
**Email:** jane@example.com
**Phone:** +15551234567
```

**Session key:** Derived from entity type and ID (e.g., `webhook:ownerrez:booking:12345`).

### Setting Up OwnerRez

1. Ensure your gateway is accessible from the internet

2. Add the webhook config:

   ```json5
   {
     hooks: {
       enabled: true,
       token: "your-secret-token",
       webhooks: {
         presets: ["ownerrez"],
       },
     },
   }
   ```

3. In OwnerRez, go to **Settings > API > Webhooks** and add your URL:

   ```
   https://openclaw-jhs.fly.dev/webhooks/your-secret-token/ownerrez
   ```

4. Select the entity types and actions you want to receive notifications for

5. Test with a curl command:

   ```bash
   curl -X POST https://your-gateway/webhooks/your-secret-token/ownerrez \
     -H 'Content-Type: application/json' \
     -d '{
       "id": "evt-001",
       "user_id": "u-123",
       "action": "entity_insert",
       "entity_type": "booking",
       "entity_id": "12345",
       "categories": ["booking_new"],
       "entity": {
         "guest_name": "Jane Doe",
         "property_name": "Beach House",
         "arrival": "2026-03-15",
         "departure": "2026-03-22",
         "adults": 2,
         "status": "confirmed",
         "total_amount": "1250.00",
         "currency": "USD"
       }
     }'
   ```

6. You should see `{"ok":true,"runId":"..."}` and the agent will process the booking event

### `shopify` - Shopify Store Events

[Shopify](https://www.shopify.com) sends webhook notifications for orders, customers, products,
refunds, and other e-commerce events.

**Webhook URL:**

```
https://your-gateway.example.com/webhooks/{token}/shopify
```

**Supported event types (auto-detected from payload):**

- **Orders** - New orders, payments, fulfillments, cancellations
- **Customers** - Customer created or updated
- **Products** - Product created or updated
- **Refunds** - Refund issued

Any payload with an `id` field that doesn't match the above types is handled as a generic event.

**What gets sent to the agent:**

For orders:

```markdown
## Shopify Order Paid

**Order:** #1042
**Customer:** Alice Smith (alice@example.com)
**Total:** 89.99 USD
**Payment:** paid
**Fulfillment:** unfulfilled
**Date:** 2026-02-08T10:00:00Z
**Ship to:** Portland, Oregon, US

### Items

- Widget Pro x2 ($29.99)
- Accessory Pack ($30.01)

**Note:** Please gift wrap
```

For customers:

```markdown
## Shopify Customer Update

**Name:** Bob Jones
**Email:** bob@example.com
**Phone:** +15559876543
**Orders:** 12
**Total spent:** $450.00
**Tags:** vip, wholesale
```

For products:

```markdown
## Shopify Product Update

**Product:** Super Widget
**Type:** Gadgets
**Vendor:** WidgetCo
**Status:** active
**Variants:** 3
```

For refunds:

```markdown
## Shopify Refund

**Order ID:** 12345
**Date:** 2026-02-08T15:00:00Z
**Reason:** Customer changed mind
**Items refunded:** 2
```

**Session keys:** Derived from entity type and ID (e.g., `webhook:shopify:order:12345`,
`webhook:shopify:customer:5001`, `webhook:shopify:product:3001`).

### Setting Up Shopify

1. Ensure your gateway is accessible from the internet

2. Add the webhook config:

   ```json5
   {
     hooks: {
       enabled: true,
       token: "your-secret-token",
       webhooks: {
         presets: ["shopify"],
       },
     },
   }
   ```

3. In your Shopify admin, go to **Settings > Notifications > Webhooks** and create webhooks
   for the events you want (e.g., Order creation, Order payment, Customer creation):

   ```
   https://openclaw-jhs.fly.dev/webhooks/your-secret-token/shopify
   ```

4. Select JSON format for the webhook payload

5. Test with a curl command:

   ```bash
   curl -X POST https://your-gateway/webhooks/your-secret-token/shopify \
     -H 'Content-Type: application/json' \
     -d '{
       "id": 12345,
       "order_number": 1042,
       "email": "alice@example.com",
       "financial_status": "paid",
       "fulfillment_status": null,
       "total_price": "89.99",
       "currency": "USD",
       "created_at": "2026-02-08T10:00:00Z",
       "customer": {
         "first_name": "Alice",
         "last_name": "Smith"
       },
       "line_items": [
         {"title": "Widget Pro", "quantity": 2, "price": "29.99"}
       ],
       "shipping_address": {
         "city": "Portland",
         "province": "Oregon",
         "country": "US"
       }
     }'
   ```

6. You should see `{"ok":true,"runId":"..."}` and the agent will process the order

### Shopify Payload Detection

Shopify sends the event topic in the `X-Shopify-Topic` header, but since OpenClaw receives
only the JSON body through the webhook endpoint, event types are inferred from the payload shape:

- **Orders**: `order_number` field or both `financial_status` and `line_items`
- **Customers**: `orders_count`, `total_spent`, and `first_name`
- **Products**: `product_type` and `variants`
- **Refunds**: `order_id` and `refund_line_items`

This auto-detection means you can register a single webhook URL for all Shopify event types.

## Security

- The token is embedded in the URL path, which is encrypted over HTTPS. This is the
  standard pattern used by GitHub webhooks, Stripe webhooks, and Slack event subscriptions.
- Invalid tokens return `404` to prevent endpoint discovery by attackers.
- Token comparison uses `timingSafeEqual` to prevent timing attacks.
- Webhook payloads are treated as untrusted external content.
- Keep your webhook token secret. If compromised, rotate it in your config and update
  all registered webhook URLs.

## Adding New Presets

New preset transforms are added in `src/gateway/webhook-transforms/`. Each preset is a
function that takes a raw JSON payload and returns either:

- `{ message, name, sessionKey }` to dispatch to the agent
- `null` to skip the payload gracefully

Register the transform in `src/gateway/webhook-transforms/index.ts`.
