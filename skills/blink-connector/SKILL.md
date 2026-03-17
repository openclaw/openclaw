---
name: blink-connector
description: >
  Call any linked Blink Connector via the Blink AI Gateway. Supports Notion,
  Slack, Discord, Google (Gmail, Drive, Calendar, Docs, Sheets, Slides),
  HubSpot, Airtable, Microsoft (Outlook, Teams, OneDrive), LinkedIn, Salesforce.
  Use when the user asks you to interact with a connected third-party service.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"] } }
---

# Blink Connector

Call any linked connector via the shared helper script.

## Usage
```bash
bash skills/blink-connector/scripts/call.sh PROVIDER /endpoint [METHOD] [JSON_PARAMS]
```

## Provider Keys
| Service | PROVIDER key |
|---------|-------------|
| Notion | `notion` |
| Slack | `slack` |
| Discord | `discord` |
| HubSpot | `hubspot` |
| Airtable | `airtable` |
| Microsoft (Outlook/Teams/OneDrive) | `microsoft` |
| LinkedIn | `linkedin` |
| Salesforce | `salesforce` |
| Gmail | `google_gmail` |
| Google Drive | `google_drive` |
| Google Calendar | `google_calendar` |
| Google Docs | `google_docs` |
| Google Sheets | `google_sheets` |
| Google Slides | `google_slides` |

## Examples

```bash
# Notion — search everything
bash skills/blink-connector/scripts/call.sh notion /search POST '{"query": "meeting notes"}'

# Slack — post a message
bash skills/blink-connector/scripts/call.sh slack /chat.postMessage POST '{"channel":"#general","text":"Hello!"}'

# Discord — list guilds
bash skills/blink-connector/scripts/call.sh discord /users/@me/guilds GET

# Google Calendar — list upcoming events
bash skills/blink-connector/scripts/call.sh google_calendar /calendars/primary/events GET '{"timeMin":"2026-03-15T00:00:00Z","maxResults":10,"singleEvents":true,"orderBy":"startTime"}'

# Gmail — list unread messages
bash skills/blink-connector/scripts/call.sh google_gmail /users/me/messages GET '{"labelIds":"INBOX","q":"is:unread","maxResults":10}'

# Google Drive — list files
bash skills/blink-connector/scripts/call.sh google_drive /files GET '{"pageSize":20,"fields":"files(id,name,modifiedTime)"}'

# Google Sheets — read a range
bash skills/blink-connector/scripts/call.sh google_sheets /spreadsheets/SPREADSHEET_ID/values/Sheet1!A1:Z100 GET

# Google Docs — get document content
bash skills/blink-connector/scripts/call.sh google_docs /documents/DOCUMENT_ID GET

# Google Slides — get presentation
bash skills/blink-connector/scripts/call.sh google_slides /presentations/PRESENTATION_ID GET

# HubSpot — search contacts
bash skills/blink-connector/scripts/call.sh hubspot /crm/v3/objects/contacts/search POST '{"filterGroups":[{"filters":[{"propertyName":"email","operator":"CONTAINS_TOKEN","value":"example.com"}]}],"limit":10}'

# Airtable — list bases
bash skills/blink-connector/scripts/call.sh airtable /meta/bases GET

# Airtable — list records
bash skills/blink-connector/scripts/call.sh airtable /BASE_ID/TABLE_NAME GET '{"maxRecords":50}'

# Microsoft — list Outlook emails
bash skills/blink-connector/scripts/call.sh microsoft /me/messages GET '{"$top":20,"$filter":"isRead eq false"}'

# Microsoft — send email
bash skills/blink-connector/scripts/call.sh microsoft /me/sendMail POST '{"message":{"subject":"Hello","body":{"contentType":"Text","content":"Hi!"},"toRecipients":[{"emailAddress":{"address":"user@example.com"}}]}}'

# LinkedIn — get profile
bash skills/blink-connector/scripts/call.sh linkedin /me GET

# Salesforce — SOQL query for contacts
bash skills/blink-connector/scripts/call.sh salesforce /services/data/v62.0/query GET '{"q":"SELECT Id,Name,Email FROM Contact LIMIT 20"}'
```

## Check which connectors are linked
```bash
curl -sf -H "Authorization: Bearer ${BLINK_API_KEY}" -H "x-blink-agent-id: ${BLINK_AGENT_ID}" \
  "${BLINK_APIS_URL:-https://core.blink.new}/v1/connectors/linked"
```
A 401 response means the connector is not linked — ask the user to connect it in the Agent Integrations tab.

For provider-specific documentation with more examples, see individual skills:
blink-notion, blink-slack, blink-discord, blink-hubspot, blink-airtable,
blink-microsoft, blink-linkedin, blink-salesforce,
blink-google-gmail, blink-google-drive, blink-google-calendar,
blink-google-docs, blink-google-sheets, blink-google-slides
