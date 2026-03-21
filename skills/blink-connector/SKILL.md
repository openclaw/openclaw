---
name: blink-connector
description: >
  Call any linked Blink Connector via the Blink CLI. Supports Notion,
  Slack, Discord, Google (Gmail, Drive, Calendar, Docs, Sheets, Slides),
  HubSpot, Airtable, Microsoft (Outlook, Teams, OneDrive, Calendar), LinkedIn,
  Salesforce, GitHub, Jira, Asana, Linear, Attio, Pipedrive, Zoom, Stripe,
  Shopify, Figma, Twitter, Instagram, TikTok, YouTube, Loom, Mailchimp,
  Typeform, Calendly, Etsy, Vercel, Reddit.
  Use when the user asks you to interact with a connected third-party service.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"] } }
---

# Blink Connector

Call any linked connector via the `blink connector exec` CLI command.

## Usage
```bash
blink connector exec <provider> <endpoint> [GET|POST|PUT|PATCH|DELETE] [json-params]
```

## Check which connectors are linked
```bash
blink connector status
```
A missing provider means it's not linked — ask the user to connect it in the Agent Integrations tab.

## Provider Keys
| Service | PROVIDER key |
|---------|-------------|
| Notion | `notion` |
| Slack | `slack` |
| Discord | `discord` |
| HubSpot | `hubspot` |
| Airtable | `airtable` |
| Microsoft Outlook | `microsoft_outlook` |
| Microsoft Calendar | `microsoft_calendar` |
| Microsoft OneDrive | `microsoft_onedrive` |
| Microsoft Teams | `microsoft_teams` |
| LinkedIn | `linkedin` |
| Salesforce | `salesforce` |
| Gmail | `google_gmail` |
| Google Drive | `google_drive` |
| Google Calendar | `google_calendar` |
| Google Docs | `google_docs` |
| Google Sheets | `google_sheets` |
| Google Slides | `google_slides` |
| GitHub | `github` |
| Jira | `jira` |
| Asana | `asana` |
| Linear | `linear` |
| Attio | `attio` |
| Pipedrive | `pipedrive` |
| Zoom | `zoom` |
| Stripe | `stripe` |
| Shopify | `shopify` |
| Figma | `figma` |
| Twitter | `twitter` |
| Instagram | `instagram` |
| TikTok | `tiktok` |
| YouTube | `youtube` |
| Loom | `loom` |
| Mailchimp | `mailchimp` |
| Typeform | `typeform` |
| Calendly | `calendly` |
| Etsy | `etsy` |
| Vercel | `vercel` |
| Reddit | `reddit` |

## Examples

```bash
# Notion — search everything
blink connector exec notion /search POST '{"query": "meeting notes"}'

# Slack — post a message
blink connector exec slack /chat.postMessage POST '{"channel":"#general","text":"Hello!"}'

# Discord — list guilds
blink connector exec discord /users/@me/guilds GET

# Google Calendar — list upcoming events
blink connector exec google_calendar /calendars/primary/events GET '{"timeMin":"2026-03-15T00:00:00Z","maxResults":10,"singleEvents":true,"orderBy":"startTime"}'

# Gmail — list unread messages
blink connector exec google_gmail /users/me/messages GET '{"labelIds":"INBOX","q":"is:unread","maxResults":10}'

# Google Drive — list files
blink connector exec google_drive /files GET '{"pageSize":20,"fields":"files(id,name,modifiedTime)"}'

# Google Sheets — read a range
blink connector exec google_sheets /spreadsheets/SPREADSHEET_ID/values/Sheet1!A1:Z100 GET

# Google Docs — get document content
blink connector exec google_docs /documents/DOCUMENT_ID GET

# Google Slides — get presentation
blink connector exec google_slides /presentations/PRESENTATION_ID GET

# HubSpot — search contacts
blink connector exec hubspot /crm/v3/objects/contacts/search POST '{"filterGroups":[{"filters":[{"propertyName":"email","operator":"CONTAINS_TOKEN","value":"example.com"}]}],"limit":10}'

# Airtable — list bases
blink connector exec airtable /meta/bases GET

# Airtable — list records in a table
blink connector exec airtable /BASE_ID/TABLE_NAME GET '{"maxRecords":50}'

# Microsoft Outlook — list inbox
blink connector exec microsoft_outlook /me/messages GET '{"$top":"20","$select":"subject,from,receivedDateTime,isRead","$orderby":"receivedDateTime desc"}'

# Microsoft Outlook — send email
blink connector exec microsoft_outlook /me/sendMail POST '{"message":{"subject":"Hello","body":{"contentType":"Text","content":"Hi!"},"toRecipients":[{"emailAddress":{"address":"user@example.com"}}]}}'

# LinkedIn — get profile
blink connector exec linkedin userinfo GET

# Salesforce — SOQL query
blink connector exec salesforce /services/data/v62.0/query GET '{"q":"SELECT Id,Name,Email FROM Contact LIMIT 20"}'

# GitHub — list repos
blink connector exec github /user/repos GET

# Jira — search issues
blink connector exec jira /search GET '{"jql":"assignee=currentUser()","maxResults":20}'

# Linear — GraphQL query
blink connector exec linear '{ viewer { id name email teams { nodes { id name } } } }' POST

# Stripe — list customers
blink connector exec stripe /customers GET '{"limit":10}'

# Zoom — list meetings
blink connector exec zoom /users/me/meetings GET

# Reddit — search posts
blink connector exec reddit /search GET '{"q":"OpenClaw","sort":"new","limit":10}'
```

## Scripting — capture output
```bash
# Get a value from JSON response
RESULT=$(blink connector exec github /user/repos GET --json)
echo "$RESULT" | python3 -c "import json,sys; repos=json.load(sys.stdin)['data']; [print(r['full_name']) for r in repos[:5]]"
```

## Multiple accounts
```bash
blink connector exec github /user/repos GET --account acct_xxx
```
