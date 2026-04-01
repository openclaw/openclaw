---
summary: "Shopify-to-Pictorem print fulfillment pipeline via Payment Bridge and MABOS agent tools"
read_when:
  - Working with order fulfillment
  - Debugging Pictorem submission failures
  - Understanding the Payment Bridge internal API
  - Using pictorem_* agent tools
title: "Pictorem Fulfillment"
---

# Pictorem Fulfillment

VividWalls orders flow from Shopify through the Payment Bridge to Pictorem for
print fulfillment. MABOS agents monitor and manage the pipeline via 5 tools
that call the bridge's internal API.

## Architecture

```
Shopify (order paid)
  │  webhook
  ▼
Payment Bridge (port 3001, Express/CJS)
  │  1. Fetch print-ready image from PostgreSQL
  │  2. Submit to Pictorem via CDP browser automation
  │  3. Charge business card via Stripe
  │  4. Write status to fulfillment-queue JSON
  │
  ├──► /api/* endpoints (internal API)
  │       ▲
  │       │ HTTP (localhost)
  │       │
  │    MABOS Gateway (port 18789)
  │       │  pictorem_* tools
  │       │
  │    Agents: fulfillment-mgr, COO, CTO
  │
  ▼
Pictorem (prints + ships to customer)
```

**Key design decision:** The bridge stays standalone because CDP browser
automation is brittle and sequential. MABOS agents interact exclusively via
HTTP to the bridge's internal API — never directly with Pictorem.

## Payment Bridge Internal API

Base URL: `http://localhost:3001/api`

All endpoints require `Authorization: Bearer <BRIDGE_API_TOKEN>` when
`BRIDGE_API_TOKEN` is set in the bridge's `.env`.

### Endpoints

| Method | Path                            | Purpose                                          |
| ------ | ------------------------------- | ------------------------------------------------ |
| `GET`  | `/api/queue`                    | List queue items. Query: `?status=X&limit=N`     |
| `GET`  | `/api/queue/:orderNumber`       | Get fulfillment items for a specific order       |
| `POST` | `/api/queue/:orderNumber/retry` | Retry failed items (error statuses only)         |
| `GET`  | `/api/stats`                    | Pipeline dashboard (counts, error rate, uptime)  |
| `POST` | `/api/fulfillment/trigger`      | Manual trigger — body: `{"order_number":"1006"}` |

### Authentication

```bash
# Generate token
openssl rand -hex 32

# Add to bridge .env
BRIDGE_API_TOKEN=<token>

# Add same token to gateway .env
BRIDGE_API_TOKEN=<token>
```

Requests without a valid token receive `401 {"error":"Unauthorized"}`.

### Example Responses

**`GET /api/stats`**

```json
{
  "total": 3,
  "by_status": { "pending_fulfillment": 3 },
  "error_count": 0,
  "error_rate": 0,
  "recent_7d": 0,
  "uptime": 292,
  "mode": "test"
}
```

**`GET /api/queue/1006`**

```json
{
  "order_number": "1006",
  "count": 1,
  "items": [
    {
      "file": "1006-10185598566687-1771453902787.json",
      "shopify_order_number": "1006",
      "product_title": "Intersecting Perspectives No5",
      "variant": "36x48 / Gallery Wrapped Stretched Canvas",
      "status": "pending_fulfillment",
      "created_at": "2026-02-18T22:31:42.784Z"
    }
  ]
}
```

**`POST /api/queue/1006/retry`**

```json
{
  "order_number": "1006",
  "retried": [{ "file": "1006-xxx.json", "retry_count": 1 }],
  "skipped": []
}
```

## Status States

| Status                   | Stage                                         | Retryable     |
| ------------------------ | --------------------------------------------- | ------------- |
| `pending_fulfillment`    | Queued, awaiting Pictorem submission          | N/A           |
| `submitted_to_pictorem`  | Successfully submitted via CDP                | N/A (success) |
| `image_download_failed`  | Print-ready image could not be fetched        | Yes           |
| `automation_error`       | CDP automation hit an error                   | Yes           |
| `automation_partial`     | Some CDP steps completed, unclear final state | Yes           |
| `submission_failed`      | Pictorem submission threw an exception        | Yes           |
| `blocked_no_print_image` | No print-ready original in database           | No (manual)   |

### Status Flow

```
Shopify order paid
  └─► pending_fulfillment
        ├─► submitted_to_pictorem  ✓
        ├─► image_download_failed  → retry
        ├─► automation_error       → retry (max 3)
        ├─► automation_partial     → retry / manual check
        ├─► submission_failed      → retry
        └─► blocked_no_print_image → upload file, re-trigger
```

## MABOS Agent Tools

Five tools registered in the gateway via `createPictoremTools()` in
`extensions/mabos/src/tools/pictorem-tools.ts`:

| Tool                           | Bridge Endpoint                      | Timeout | Description                                      |
| ------------------------------ | ------------------------------------ | ------- | ------------------------------------------------ |
| `pictorem_pipeline_stats`      | `GET /api/stats`                     | 5s      | Dashboard: counts by status, error rate, uptime  |
| `pictorem_queue_list`          | `GET /api/queue`                     | 5s      | List/filter queue items by status and limit      |
| `pictorem_order_status`        | `GET /api/queue/:orderNumber`        | 5s      | Detailed status for a specific order             |
| `pictorem_retry_fulfillment`   | `POST /api/queue/:orderNumber/retry` | 15s     | Retry failed items (retryable statuses only)     |
| `pictorem_trigger_fulfillment` | `POST /api/fulfillment/trigger`      | 30s     | Manually trigger fulfillment for a Shopify order |

All tools return markdown-formatted text via `textResult()`. When the bridge is
unreachable (status 0), they return a distinct "bridge unreachable" message.

### Tool Parameters

```typescript
pictorem_queue_list({ status?: string, limit?: number })
pictorem_order_status({ order_number: string })
pictorem_retry_fulfillment({ order_number: string })
pictorem_pipeline_stats({})
pictorem_trigger_fulfillment({ order_number: string })
```

## Error Triage

| Error Status             | Likely Cause                                        | Recommended Action                           |
| ------------------------ | --------------------------------------------------- | -------------------------------------------- |
| `image_download_failed`  | Image URL expired or network timeout                | Retry — usually transient                    |
| `automation_error`       | Pictorem UI changed, CDP crash, Chrome disconnected | Retry once, then escalate to CTO             |
| `automation_partial`     | CDP completed some steps but not all                | Check order on Pictorem manually, then retry |
| `submission_failed`      | Network/timeout during submission                   | Retry — usually transient                    |
| `blocked_no_print_image` | No print-ready file in PostgreSQL `media_assets`    | Notify stakeholder to upload print file      |

**Retry limit:** Maximum 3 retries per item. After 3 failed retries, escalate
to CTO with full error details.

## Operational Playbooks

### Daily Health Check

1. Run `pictorem_pipeline_stats`
2. If `error_rate` > 5%: investigate with `pictorem_queue_list` (filter by error statuses)
3. Check for `blocked_no_print_image` items → notify stakeholder
4. Verify bridge uptime is healthy
5. Summarize for COO

### Error Recovery

1. `pictorem_queue_list` with status filter (`automation_error`, `submission_failed`, etc.)
2. For each failed item: `pictorem_order_status` for details
3. If retryable and `retry_count` < 3: `pictorem_retry_fulfillment`
4. Wait 2-3 minutes, check `pictorem_order_status` again
5. If still failing after 3 retries: escalate to CTO

### New Order Verification

1. `pictorem_order_status` with the order number
2. If `submitted_to_pictorem`: all good
3. If error status: run Error Recovery playbook
4. If no items found: `pictorem_trigger_fulfillment` to manually trigger

### Weekly Report

1. `pictorem_pipeline_stats` for totals
2. `pictorem_queue_list` with `limit=100` for recent activity
3. Calculate: success rate, average retry count, common error types
4. Format report for COO and stakeholder

## Configuration

### Environment Variables

**Payment Bridge** (`~/.openclaw/workspace/apps/payment-bridge/.env`):

| Variable                   | Required    | Description                             |
| -------------------------- | ----------- | --------------------------------------- |
| `BRIDGE_API_TOKEN`         | Recommended | Shared secret for API authentication    |
| `SHOPIFY_STORE`            | Yes         | Shopify store domain                    |
| `SHOPIFY_ACCESS_TOKEN`     | Yes         | Shopify Admin API token                 |
| `STRIPE_SECRET_KEY`        | Yes         | Stripe secret key                       |
| `STRIPE_BUSINESS_CUSTOMER` | Yes         | Stripe customer ID for business card    |
| `STRIPE_BUSINESS_PM`       | Yes         | Stripe payment method for business card |

**MABOS Gateway** (`~/.openclaw/workspace/.env`):

| Variable              | Required    | Description                 |
| --------------------- | ----------- | --------------------------- |
| `BRIDGE_API_TOKEN`    | Recommended | Must match the bridge token |
| `PAYMENT_BRIDGE_PORT` | No          | Bridge port (default: 3001) |

### File Locations (VPS)

| Path                                                              | Description                   |
| ----------------------------------------------------------------- | ----------------------------- |
| `~/.openclaw/workspace/apps/payment-bridge/server.js`             | Bridge server                 |
| `~/.openclaw/workspace/apps/payment-bridge/.env`                  | Bridge environment            |
| `~/.openclaw/workspace/data/fulfillment-queue/`                   | Queue JSON files              |
| `~/openclaw-mabos/extensions/mabos/src/tools/pictorem-tools.ts`   | MABOS tools source            |
| `~/openclaw-mabos/extensions/mabos/src/tools/bdi-content-seed.ts` | BDI content (fulfillment-mgr) |
| `~/openclaw-mabos/skills/pictorem-fulfillment/SKILL.md`           | Agent skill definition        |

### Systemd Service

```ini
# /etc/systemd/system/vividwalls-bridge.service
[Unit]
Description=VividWalls Payment Bridge (Shopify-Stripe-Pictorem)
After=network.target postgresql.service

[Service]
Type=simple
User=kingler
WorkingDirectory=/home/kingler/.openclaw/workspace/apps/payment-bridge
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Restart after changes:

```bash
# Kill the process (systemd auto-restarts)
pkill -f 'node server.js'
# Verify restart
sleep 6 && curl -s http://localhost:3001/health
```

## Fulfillment Queue Format

Each item in `data/fulfillment-queue/` is a JSON file named
`{orderNumber}-{productId}-{timestamp}.json`:

```json
{
  "shopify_order_id": "7449928794399",
  "shopify_order_number": "1006",
  "product_title": "Intersecting Perspectives No5",
  "variant": "36x48 / Gallery Wrapped Stretched Canvas",
  "width": 36,
  "height": 48,
  "quantity": 1,
  "image_url": "local:/path/to/print-ready.png",
  "customer_email": "customer@example.com",
  "customer_name": "Jane Doe",
  "shipping_address": { "...": "..." },
  "is_canvas_roll": false,
  "base_price_estimate": 75,
  "retail_price": 329,
  "status": "pending_fulfillment",
  "created_at": "2026-02-18T22:31:42.784Z",
  "retry_count": 0,
  "retried_at": null,
  "pictorem_details": null
}
```

## Verification

### Bridge API

```bash
TOKEN=$(grep BRIDGE_API_TOKEN ~/.openclaw/workspace/apps/payment-bridge/.env | cut -d= -f2)

# Stats dashboard
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/stats | jq .

# List queue
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/queue | jq .count

# Specific order
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/queue/1006 | jq .

# Auth rejection (should return 401)
curl -s http://localhost:3001/api/stats
```

### MABOS Tools

After gateway restart, verify:

- Tool count increased (99 → 104) in startup logs
- `pictorem_*` tools appear in capabilities output
- Agent can call `pictorem_pipeline_stats` and get a formatted dashboard

## Performance Targets

| Metric                | Target   | Measured By                                  |
| --------------------- | -------- | -------------------------------------------- |
| Auto-fulfillment rate | > 95%    | `pictorem_pipeline_stats` → `1 - error_rate` |
| Pipeline error rate   | < 5%     | `pictorem_pipeline_stats` → `error_rate`     |
| Retry-to-resolution   | < 20 min | `retried_at` - `created_at` on queue items   |
| Bridge uptime         | > 99%    | `pictorem_pipeline_stats` → `uptime`         |

## Limitations

- **CDP automation is brittle** — Pictorem UI changes can break the browser automation
- **Sequential processing** — one order at a time (browser automation cannot parallelize)
- **No Pictorem API** — all interaction is via browser; no programmatic status checks
- **Bridge restart required** — `.env` changes only take effect after restart
- **No webhook from Pictorem** — we cannot be notified when printing/shipping completes
