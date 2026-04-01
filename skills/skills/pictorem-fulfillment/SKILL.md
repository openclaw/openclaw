---
name: pictorem-fulfillment
description: Manage the VividWalls Shopify → Pictorem print fulfillment pipeline via MABOS gateway tools.
---

# Pictorem Fulfillment

Manage the VividWalls order fulfillment pipeline: Shopify orders are automatically routed to Pictorem for printing via CDP browser automation on the Payment Bridge (port 3001). MABOS agents interact with the bridge through 5 tools.

## Tools

| Tool                           | Purpose                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `pictorem_pipeline_stats`      | Dashboard: total items, status breakdown, error rate, uptime |
| `pictorem_queue_list`          | List/filter queue items (use `status` param to filter)       |
| `pictorem_order_status`        | Detailed status for a specific order number                  |
| `pictorem_retry_fulfillment`   | Retry failed items (only retryable statuses)                 |
| `pictorem_trigger_fulfillment` | Manually trigger fulfillment for a Shopify order             |

## Status Flow

```
Shopify order paid
  → pending_fulfillment
    → submitted_to_pictorem  (success)
    → image_download_failed  (retryable)
    → automation_error       (retryable)
    → automation_partial     (retryable)
    → submission_failed      (retryable)
    → blocked_no_print_image (not retryable — needs manual upload)
```

## Error Triage

| Status                   | Cause                           | Action                                                   |
| ------------------------ | ------------------------------- | -------------------------------------------------------- |
| `image_download_failed`  | Image URL expired/unreachable   | Retry (usually transient)                                |
| `automation_error`       | Pictorem UI change or CDP crash | Retry once, then escalate to CTO                         |
| `automation_partial`     | Some CDP steps completed        | Check Pictorem manually, retry if needed                 |
| `submission_failed`      | Network/timeout                 | Retry (usually transient)                                |
| `blocked_no_print_image` | No print-ready file in DB       | Notify stakeholder to upload to Google Drive and re-sync |

## Common Workflows

### Daily Health Check

1. `pictorem_pipeline_stats` — review error_rate and uptime
2. If error_rate > 5%: `pictorem_queue_list` with status filter to identify failures
3. For each failure: assess and retry or escalate
4. Summarize for COO

### Investigate a Failed Order

1. `pictorem_order_status` with the order number
2. Review status, error details, retry count
3. If retryable and retries < 3: `pictorem_retry_fulfillment`
4. Check again after 2-3 minutes
5. If still failing: escalate to CTO

### Manually Fulfill a Missed Order

1. `pictorem_trigger_fulfillment` with the order number
2. Monitor with `pictorem_order_status`

## Guardrails

- **Max 3 retries** per order item — after that, escalate to CTO
- **Never retry** `blocked_no_print_image` — requires human action
- **Escalation path:** Fulfillment Manager → CTO (technical) or Stakeholder (business)
- Bridge is single-threaded for CDP — don't trigger multiple fulfillments simultaneously
