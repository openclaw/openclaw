---
name: blink-mailchimp
description: >
  Manage Mailchimp email lists, campaigns, and subscribers. Use when asked to
  check subscriber counts, create campaigns, or view email analytics. Requires
  a linked Mailchimp connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "mailchimp" } }
---

# Blink Mailchimp

Access the user's linked Mailchimp account. Provider key: `mailchimp`.

## List all audiences (lists)
```bash
bash scripts/call.sh mailchimp /lists GET '{"count":20}'
```

## Get audience details
```bash
bash scripts/call.sh mailchimp /lists/{list_id} GET
```

## Get subscribers in an audience
```bash
bash scripts/call.sh mailchimp /lists/{list_id}/members GET '{"count":20,"status":"subscribed"}'
```

## Add a subscriber
```bash
bash scripts/call.sh mailchimp /lists/{list_id}/members POST '{"email_address":"user@example.com","status":"subscribed","merge_fields":{"FNAME":"John","LNAME":"Doe"}}'
```

## Get campaigns
```bash
bash scripts/call.sh mailchimp /campaigns GET '{"count":10,"sort_field":"send_time","sort_dir":"DESC"}'
```

## Get campaign report
```bash
bash scripts/call.sh mailchimp /reports/{campaign_id} GET
```

## Send a campaign
```bash
bash scripts/call.sh mailchimp /campaigns/{campaign_id}/actions/send POST
```

## Search members
```bash
bash scripts/call.sh mailchimp /search-members GET '{"query":"john@example.com"}'
```

## Common use cases
- "How many subscribers do we have?" → GET /lists/{id} (stats.member_count)
- "Add john@example.com to our newsletter" → POST /lists/{id}/members
- "What was the open rate for last campaign?" → GET /reports/{campaign_id}
- "List our recent email campaigns" → GET /campaigns
- "Unsubscribe user X from the list" → PATCH /lists/{id}/members/{hash}
