---
name: blink-typeform
description: >
  Access Typeform forms and responses. Use when asked to list forms, fetch survey
  responses, or analyze form submission data. Requires a linked Typeform
  connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "typeform" } }
---

# Blink Typeform

Access the user's linked Typeform account. Provider key: `typeform`.

## List all forms
```bash
bash scripts/call.sh /forms GET
```

## Get a specific form
```bash
bash scripts/call.sh /forms/{form_id} GET
```

## Get form responses
```bash
bash scripts/call.sh /forms/{form_id}/responses GET '{"page_size":20}'
```

## Get responses with filters
```bash
bash scripts/call.sh /forms/{form_id}/responses GET '{"page_size":20,"since":"2024-01-01T00:00:00Z","sort":"submitted_at,desc"}'
```

## Get response count
```bash
bash scripts/call.sh /forms/{form_id}/responses GET '{"page_size":1}'
```

## Get form insights
```bash
bash scripts/call.sh /insights/{form_id}/summary GET
```

## Common use cases
- "List all my Typeform surveys" → GET /forms
- "Show me the last 20 responses to my feedback form" → GET /forms/{id}/responses
- "How many people completed the onboarding survey?" → GET /forms/{id}/responses (check total_items)
- "Get responses from this week" → GET /forms/{id}/responses?since={date}
- "What answers did people give to question X?" → GET /forms/{id}/responses, parse answers
