---
name: blink-hubspot
description: >
  Read and manage HubSpot CRM — contacts, companies, deals, tasks, notes.
  Use when asked to check leads, update CRM records, create deals, look up
  contacts, or manage sales pipeline.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "hubspot" } }
---

# Blink HubSpot CRM

Read and manage HubSpot CRM data. Provider key: `hubspot`.

## Search contacts
```bash
bash scripts/call.sh hubspot /crm/v3/objects/contacts/search POST '{
  "filterGroups": [{"filters": [{"propertyName": "email", "operator": "CONTAINS_TOKEN", "value": "example.com"}]}],
  "properties": ["email", "firstname", "lastname", "phone", "company"],
  "limit": 20
}'
```

## Get a contact by ID
```bash
bash scripts/call.sh hubspot /crm/v3/objects/contacts/CONTACT_ID GET \
  '{"properties": "email,firstname,lastname,phone,company,lifecyclestage,hs_lead_status"}'
```

## Create a contact
```bash
bash scripts/call.sh hubspot /crm/v3/objects/contacts POST '{
  "properties": {
    "email": "new@example.com",
    "firstname": "John",
    "lastname": "Doe",
    "phone": "+1234567890",
    "company": "Acme Corp"
  }
}'
```

## Update a contact
```bash
bash scripts/call.sh hubspot /crm/v3/objects/contacts/CONTACT_ID PATCH '{
  "properties": {"lifecyclestage": "customer", "hs_lead_status": "CONNECTED"}
}'
```

## List recent deals
```bash
bash scripts/call.sh hubspot /crm/v3/objects/deals GET \
  '{"limit": 20, "properties": "dealname,amount,dealstage,closedate,hubspot_owner_id"}'
```

## Search deals in a stage
```bash
bash scripts/call.sh hubspot /crm/v3/objects/deals/search POST '{
  "filterGroups": [{"filters": [{"propertyName": "dealstage", "operator": "EQ", "value": "appointmentscheduled"}]}],
  "properties": ["dealname", "amount", "closedate"],
  "limit": 20
}'
```

## Create a deal
```bash
bash scripts/call.sh hubspot /crm/v3/objects/deals POST '{
  "properties": {
    "dealname": "New Enterprise Deal",
    "amount": "50000",
    "dealstage": "appointmentscheduled",
    "closedate": "2026-06-30"
  }
}'
```

## Create a note on a contact
```bash
bash scripts/call.sh hubspot /crm/v3/objects/notes POST '{
  "properties": {
    "hs_note_body": "Called contact, interested in Pro plan",
    "hs_timestamp": "2026-03-14T10:00:00Z"
  }
}'
# Then associate with contact:
bash scripts/call.sh hubspot /crm/v3/objects/notes/NOTE_ID/associations/contacts/CONTACT_ID/202 PUT '{}'
```

## List companies
```bash
bash scripts/call.sh hubspot /crm/v3/objects/companies GET \
  '{"limit": 20, "properties": "name,domain,industry,numberofemployees,annualrevenue"}'
```

## Common use cases
- "Find all contacts from Acme Corp" → search contacts by company
- "What's the status of the Acme deal?" → search deals, filter by name
- "Create a note on John Doe's contact: demo went well" → create note + associate
- "Move the TechCorp deal to Proposal stage" → update deal stage
- "How many open deals do we have?" → list deals, filter by stage
- "Add a new lead: Sarah from StartupCo" → create contact
- "What leads came in this week?" → search contacts by createdate
