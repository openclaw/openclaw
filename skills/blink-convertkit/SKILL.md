---
name: blink-convertkit
description: >
  Manage ConvertKit/Kit email subscribers, sequences, and broadcasts. Use when
  asked about email list growth, subscriber tags, or sending newsletters.
  Requires a linked ConvertKit connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "convertkit" } }
---

# Blink ConvertKit

Access the user's linked ConvertKit (Kit) account. Provider key: `convertkit`.

## Get account info
```bash
bash scripts/call.sh /account GET
```

## List subscribers
```bash
bash scripts/call.sh /subscribers GET '{"page":1}'
```

## Get subscriber by email
```bash
bash scripts/call.sh /subscribers GET '{"email_address":"user@example.com"}'
```

## List forms
```bash
bash scripts/call.sh /forms GET
```

## List sequences (automations)
```bash
bash scripts/call.sh /sequences GET
```

## List tags
```bash
bash scripts/call.sh /tags GET
```

## List broadcasts
```bash
bash scripts/call.sh /broadcasts GET
```

## Tag a subscriber
```bash
bash scripts/call.sh /tags/{tag_id}/subscribe POST '{"email":"user@example.com"}'
```

## Add subscriber to a form
```bash
bash scripts/call.sh /forms/{form_id}/subscribe POST '{"email":"user@example.com","first_name":"John"}'
```

## Common use cases
- "How many subscribers do I have?" → GET /subscribers (check total_subscribers)
- "List all my email sequences" → GET /sequences
- "Add john@example.com to my newsletter" → POST /forms/{id}/subscribe
- "Tag subscriber X with 'customer'" → POST /tags/{id}/subscribe
- "What broadcasts have I sent?" → GET /broadcasts
