---
name: blink-salesforce
description: >
  Access Salesforce CRM data: contacts, leads, accounts, opportunities, and
  activities. Use when asked to look up customers, update deals, log calls,
  or manage sales pipeline in Salesforce. Requires a linked Salesforce connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "salesforce" } }
---

# Blink Salesforce

Access the user's Salesforce CRM. Provider key: `salesforce`.

Note: Salesforce API paths use `/services/data/v62.0/` prefix.

## Get current user info
```bash
bash scripts/call.sh salesforce /services/data/v62.0/chatter/users/me GET
```

## Search for contacts (SOQL)
```bash
bash scripts/call.sh salesforce /services/data/v62.0/query GET \
  '{"q": "SELECT Id,Name,Email,Phone,Account.Name FROM Contact WHERE Email LIKE '"'"'%example.com'"'"' LIMIT 20"}'
```

## Get a contact by ID
```bash
bash scripts/call.sh salesforce /services/data/v62.0/sobjects/Contact/CONTACT_ID GET
```

## Create a contact
```bash
bash scripts/call.sh salesforce /services/data/v62.0/sobjects/Contact POST '{
  "FirstName": "John",
  "LastName": "Doe",
  "Email": "john.doe@example.com",
  "Phone": "+1234567890",
  "AccountId": "ACCOUNT_ID"
}'
```

## Update a record
```bash
bash scripts/call.sh salesforce /services/data/v62.0/sobjects/Contact/CONTACT_ID PATCH '{
  "Title": "VP of Engineering",
  "Phone": "+1987654321"
}'
```

## List open opportunities
```bash
bash scripts/call.sh salesforce /services/data/v62.0/query GET \
  '{"q": "SELECT Id,Name,Amount,StageName,CloseDate,AccountId FROM Opportunity WHERE IsClosed=false ORDER BY CloseDate ASC LIMIT 20"}'
```

## Create an opportunity
```bash
bash scripts/call.sh salesforce /services/data/v62.0/sobjects/Opportunity POST '{
  "Name": "New Enterprise Deal",
  "AccountId": "ACCOUNT_ID",
  "StageName": "Prospecting",
  "CloseDate": "2026-06-30",
  "Amount": 50000
}'
```

## Log an activity (task)
```bash
bash scripts/call.sh salesforce /services/data/v62.0/sobjects/Task POST '{
  "Subject": "Follow-up call",
  "Status": "Completed",
  "ActivityDate": "2026-03-15",
  "WhoId": "CONTACT_ID",
  "Description": "Discussed Q2 roadmap"
}'
```

## Search accounts
```bash
bash scripts/call.sh salesforce /services/data/v62.0/query GET \
  '{"q": "SELECT Id,Name,Industry,AnnualRevenue,NumberOfEmployees FROM Account WHERE Name LIKE '"'"'%Acme%'"'"' LIMIT 10"}'
```

## Common use cases
- "Find all contacts from TechCorp" → SOQL query on Contact with AccountId
- "What are my open deals this quarter?" → query Opportunity with StageName filter
- "Log a call with Jane from Acme" → create Task linked to Contact
- "Update the deal amount for the Acme opportunity" → PATCH Opportunity
- "Create a new lead from the conference" → POST to sobjects/Lead
