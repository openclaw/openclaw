---
name: gohighlevel
description: Use when you need to interact with GoHighLevel CRM — look up contacts, manage conversations, book appointments, and manage pipeline opportunities.
metadata: { "openclaw": { "emoji": "📊", "requires": { "config": ["channels.gohighlevel"] } } }
---

# GoHighLevel CRM

## Overview

Use curl-based API calls to interact with GoHighLevel's REST API for CRM operations: contact lookup, conversation management, calendar/appointment booking, and pipeline/opportunity management.

## Authentication

All requests require:

- `Authorization: Bearer <GHL_API_KEY>` header
- `Version: 2021-07-28` header
- Base URL: `https://services.leadconnectorhq.com`

The API key is the Private Integration Token configured in GHL Settings > Integrations.

## Contact Management

### Get a contact

```bash
curl -s "https://services.leadconnectorhq.com/contacts/{contactId}" \
  -H "Authorization: Bearer $GHL_API_KEY" \
  -H "Version: 2021-07-28"
```

### Search contacts

```bash
curl -s "https://services.leadconnectorhq.com/contacts/search" \
  -X POST \
  -H "Authorization: Bearer $GHL_API_KEY" \
  -H "Version: 2021-07-28" \
  -H "Content-Type: application/json" \
  -d '{"locationId": "LOCATION_ID", "query": "John Doe", "limit": 10}'
```

### Create a contact

```bash
curl -s "https://services.leadconnectorhq.com/contacts/" \
  -X POST \
  -H "Authorization: Bearer $GHL_API_KEY" \
  -H "Version: 2021-07-28" \
  -H "Content-Type: application/json" \
  -d '{
    "locationId": "LOCATION_ID",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "+15551234567",
    "tags": ["new-lead"]
  }'
```

### Update a contact

```bash
curl -s "https://services.leadconnectorhq.com/contacts/{contactId}" \
  -X PUT \
  -H "Authorization: Bearer $GHL_API_KEY" \
  -H "Version: 2021-07-28" \
  -H "Content-Type: application/json" \
  -d '{"firstName": "Jane", "tags": ["updated"]}'
```

### Add tags to a contact

```bash
curl -s "https://services.leadconnectorhq.com/contacts/{contactId}/tags" \
  -X POST \
  -H "Authorization: Bearer $GHL_API_KEY" \
  -H "Version: 2021-07-28" \
  -H "Content-Type: application/json" \
  -d '{"tags": ["hot-lead", "follow-up"]}'
```

## Conversations

### Send a message

```bash
curl -s "https://services.leadconnectorhq.com/conversations/messages" \
  -X POST \
  -H "Authorization: Bearer $GHL_API_KEY" \
  -H "Version: 2021-07-28" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "SMS",
    "contactId": "CONTACT_ID",
    "message": "Hello from OpenClaw!"
  }'
```

Message types: `SMS`, `Email`, `WhatsApp`, `GMB`, `IG`, `FB`, `Custom`, `Live_Chat`.

### Get conversation messages

```bash
curl -s "https://services.leadconnectorhq.com/conversations/{conversationId}/messages" \
  -H "Authorization: Bearer $GHL_API_KEY" \
  -H "Version: 2021-07-28"
```

## Calendar & Appointments

### List calendars

```bash
curl -s "https://services.leadconnectorhq.com/calendars/?locationId=LOCATION_ID" \
  -H "Authorization: Bearer $GHL_API_KEY" \
  -H "Version: 2021-07-28"
```

### Get free slots

```bash
curl -s "https://services.leadconnectorhq.com/calendars/{calendarId}/free-slots?startDate=2026-03-01&endDate=2026-03-07" \
  -H "Authorization: Bearer $GHL_API_KEY" \
  -H "Version: 2021-07-28"
```

### Book an appointment

```bash
curl -s "https://services.leadconnectorhq.com/calendars/events/appointments" \
  -X POST \
  -H "Authorization: Bearer $GHL_API_KEY" \
  -H "Version: 2021-07-28" \
  -H "Content-Type: application/json" \
  -d '{
    "calendarId": "CALENDAR_ID",
    "locationId": "LOCATION_ID",
    "contactId": "CONTACT_ID",
    "startTime": "2026-03-05T10:00:00-08:00",
    "endTime": "2026-03-05T11:00:00-08:00",
    "title": "Consultation",
    "appointmentStatus": "confirmed"
  }'
```

## Pipeline & Opportunities

### List pipelines

```bash
curl -s "https://services.leadconnectorhq.com/opportunities/pipelines?locationId=LOCATION_ID" \
  -H "Authorization: Bearer $GHL_API_KEY" \
  -H "Version: 2021-07-28"
```

### Create an opportunity

```bash
curl -s "https://services.leadconnectorhq.com/opportunities/" \
  -X POST \
  -H "Authorization: Bearer $GHL_API_KEY" \
  -H "Version: 2021-07-28" \
  -H "Content-Type: application/json" \
  -d '{
    "pipelineId": "PIPELINE_ID",
    "locationId": "LOCATION_ID",
    "name": "New Deal",
    "pipelineStageId": "STAGE_ID",
    "contactId": "CONTACT_ID",
    "monetaryValue": 5000,
    "status": "open"
  }'
```

### Update an opportunity

```bash
curl -s "https://services.leadconnectorhq.com/opportunities/{opportunityId}" \
  -X PUT \
  -H "Authorization: Bearer $GHL_API_KEY" \
  -H "Version: 2021-07-28" \
  -H "Content-Type: application/json" \
  -d '{"pipelineStageId": "NEW_STAGE_ID", "status": "won", "monetaryValue": 7500}'
```

## Important Notes

- All IDs (locationId, contactId, calendarId, pipelineId) are GHL-internal identifiers.
- The `contactId` from an inbound webhook payload maps directly to the GHL contact record.
- SMS character limit is ~1600 characters; longer messages may be split.
- Rate limits apply; space bulk operations with reasonable delays.
