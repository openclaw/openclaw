---

## name: blink-connector
description: >
  Call any linked Blink Connector via the Blink CLI. Three layers, use the
  most specific one for your task:
  (1) Ergonomic wrappers for heavy-use platforms: `blink twitter` (post with
  images/video, reply, quote, like, retweet, delete) and `blink linkedin`.
  (2) Raw HTTP proxy for everything else: `blink connector exec <provider>
  <endpoint> <method> <args>` — covers Notion, Slack, Discord, Google
  (Gmail, Drive, Calendar, Docs, Sheets, Slides), HubSpot, Airtable,
  Microsoft (Outlook, Teams, OneDrive, Calendar), Salesforce, GitHub, Jira,
  Asana, Linear, Attio, Pipedrive, Zoom, Stripe, Shopify, Figma, Instagram,
  TikTok, YouTube, Mailchimp, Typeform, Calendly, Etsy, Vercel,
  Reddit, Facebook, Monday, Amplitude, Google Analytics, Zendesk, Apollo,
  Datagma, Mixpanel, PeopleDataLabs, Google BigQuery, Supabase, QuickBooks,
  Brex, Google Ads, Intercom, ZoomInfo, Gong, DocuSign, Box, Todoist, Ashby,
  Basecamp.
  (3) Native Composio tool catalog (file uploads, attachments, complex
  writes): `blink connector tool-execute <composio_provider> <TOOL_SLUG>
  '<json>'` — unlocks 1000+ Composio tools, auto-uploads URL/path file
  arguments to S3.
  Use when the user asks you to interact with a connected third-party service.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"] } }

# Blink Connector

Call any linked connector via the `blink connector exec` CLI command.

## Usage

```bash
blink connector exec <provider> <endpoint> [GET|POST|PUT|PATCH|DELETE] [json-params]
```

**IMPORTANT**: `<endpoint>` is a path RELATIVE to the provider's base URL (see table below).
Do NOT include the API version prefix — it's already in the base URL.
For example, Attio's base is `https://api.attio.com/v2/` so use `objects`, NOT `/v2/objects`.

## Check which connectors are linked

```bash
blink connector status
```

A missing provider means it's not linked — ask the user to connect it in the Agent Integrations tab.

## Provider Keys & Base URLs
| Service | PROVIDER key | Base URL |
|---------|-------------|----------|
| Notion | `notion` | `https://api.notion.com/v1/` |
| Slack | `slack` | `https://slack.com/api/` |
| Discord | `discord` | `https://discord.com/api/v10/` |
| HubSpot | `hubspot` | `https://api.hubapi.com/` |
| Airtable | `airtable` | `https://api.airtable.com/v0/` |
| Microsoft Outlook | `microsoft_outlook` | `https://graph.microsoft.com/v1.0/` |
| Microsoft Calendar | `microsoft_calendar` | `https://graph.microsoft.com/v1.0/` |
| Microsoft OneDrive | `microsoft_onedrive` | `https://graph.microsoft.com/v1.0/` |
| Microsoft Teams | `microsoft_teams` | `https://graph.microsoft.com/v1.0/` |
| LinkedIn | `linkedin` | `https://api.linkedin.com/v2/` |
| Salesforce | `salesforce` | `https://{instance}.salesforce.com/` |
| Gmail | `google_gmail` | `https://gmail.googleapis.com/gmail/v1/` |
| Google Drive | `google_drive` | `https://www.googleapis.com/drive/v3/` |
| Google Calendar | `google_calendar` | `https://www.googleapis.com/calendar/v3/` |
| Google Docs | `google_docs` | `https://docs.googleapis.com/v1/` |
| Google Sheets | `google_sheets` | `https://sheets.googleapis.com/v4/` |
| Google Slides | `google_slides` | `https://slides.googleapis.com/v1/` |
| GitHub | `github` | `https://api.github.com/` |
| Jira | `jira` | `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/` |
| Asana | `asana` | `https://app.asana.com/api/1.0/` |
| Linear | `linear` | GraphQL: `https://api.linear.app/graphql` |
| Attio | `attio` | `https://api.attio.com/v2/` |
| Pipedrive | `pipedrive` | `https://{company}.pipedrive.com/api/v1/` |
| Zoom | `zoom` | `https://api.zoom.us/v2/` |
| Stripe | `stripe` | `https://api.stripe.com/v1/` |
| Shopify | `shopify` | `https://{shop}.myshopify.com/admin/api/2024-10/` |
| Figma | `figma` | `https://api.figma.com/v1/` |
| Twitter | `twitter` | `https://api.twitter.com/2/` |
| Instagram | `instagram` | `https://graph.instagram.com/v22.0/` |
| TikTok | `tiktok` | `https://open.tiktokapis.com/v2/` |
| YouTube | `youtube` | `https://www.googleapis.com/youtube/v3/` |
| Mailchimp | `mailchimp` | `https://{dc}.api.mailchimp.com/3.0/` |
| Typeform | `typeform` | `https://api.typeform.com/` |
| Calendly | `calendly` | `https://api.calendly.com/` |
| ConvertKit | `convertkit` | `https://api.kit.com/v4/` |
| Etsy | `etsy` | `https://openapi.etsy.com/v3/` |
| Vercel | `vercel` | `https://api.vercel.com/` |
| Reddit | `reddit` | `https://oauth.reddit.com/` |
| ClickUp | `clickup` | `https://api.clickup.com/api/v2/` |
| **Composio connectors** — same APIs, different auth. Use the `composio_*` key shown by `blink connector status`. ||
| Gmail (Composio) | `composio_gmail` | `https://gmail.googleapis.com/gmail/v1/` |
| Google Drive (Composio) | `composio_drive` | `https://www.googleapis.com/drive/v3/` |
| Google Calendar (Composio) | `composio_calendar` | `https://www.googleapis.com/calendar/v3/` |
| YouTube (Composio) | `composio_youtube` | `https://www.googleapis.com/youtube/v3/` |
| Figma (Composio) | `composio_figma` | `https://api.figma.com/v1/` |
| Stripe (Composio) | `composio_stripe` | `https://api.stripe.com/v1/` |
| Instagram (Composio) | `composio_instagram` | `https://graph.instagram.com/v22.0/` |
| Reddit (Composio) | `composio_reddit` | `https://oauth.reddit.com/` |
| Facebook | `composio_facebook` | `https://graph.facebook.com/v19.0/` |
| Monday | `composio_monday` | `https://api.monday.com/v2/` |
| Amplitude | `composio_amplitude` | `https://amplitude.com/api/` |
| Google Analytics | `composio_googleanalytics` | `https://analyticsadmin.googleapis.com/v1beta/` |
| Zendesk | `composio_zendesk` | `https://api.zendesk.com/api/v2/` |
| Apollo | `composio_apollo` | `https://api.apollo.io/v1/` |
| Datagma | `composio_datagma` | `https://gateway.datagma.net/api/ingestion/v2/` |
| Mixpanel | `composio_mixpanel` | `https://mixpanel.com/api/` |
| PeopleDataLabs | `composio_peopledatalabs` | `https://api.peopledatalabs.com/v5/` |
| Google BigQuery | `composio_bigquery` | `https://bigquery.googleapis.com/bigquery/v2/` |
| Supabase | `composio_supabase` | `https://api.supabase.com/v1/` |
| Twitter / X | `composio_twitter` | `https://api.twitter.com/2/` |
| QuickBooks | `composio_quickbooks` | `https://quickbooks.api.intuit.com/` (path: `v3/company/{realmId}/...`) |
| Brex | `composio_brex` | `https://platform.brexapis.com/v2/` |
| Google Ads | `composio_googleads` | `https://googleads.googleapis.com/` (path: `v21/customers/...`, v18 sunset) |
| Intercom | `composio_intercom` | `https://api.intercom.io/` |
| ZoomInfo | `composio_zoominfo` | `https://api.zoominfo.com/` |
| Gong | `composio_gong` | `https://api.gong.io/v2/` |
| DocuSign | `composio_docusign` | account-specific (e.g. `https://na3.docusign.net/restapi/`); resolved from `metadata.docusign_base_uri` (path: `v2.1/accounts/{accountId}/...`) |
| Box | `composio_box` | `https://api.box.com/2.0/` |
| Todoist | `composio_todoist` | `https://api.todoist.com/api/v1/` |
| Ashby | `composio_ashby` | `https://api.ashbyhq.com/` |
| Basecamp | `composio_basecamp` | `https://3.basecampapi.com/` (path: `{accountId}/projects.json`) |

## Examples by Provider

### Notion

```bash
# Note: Notion's integration must be manually added to each page/database via
# "Connections" in the Notion UI. If a specific DB returns "object_not_found",
# the user hasn't shared it with the integration yet — ask them to connect it.

# Search all pages and databases
blink connector exec notion search POST '{"query":"meeting notes","page_size":10}'

# List all databases (use search with filter — the `/databases GET` endpoint is deprecated)
blink connector exec notion search POST '{"filter":{"property":"object","value":"database"},"page_size":20}'

# Query a database
blink connector exec notion databases/DATABASE_ID/query POST '{"page_size":10}'

# Get a page
blink connector exec notion pages/PAGE_ID GET

# Create a page in a database
blink connector exec notion pages POST '{"parent":{"database_id":"DB_ID"},"properties":{"Name":{"title":[{"text":{"content":"New Page"}}]}}}'
```

### Slack

```bash
# Post a message
blink connector exec slack chat.postMessage POST '{"channel":"#general","text":"Hello!"}'

# List channels
blink connector exec slack conversations.list GET '{"limit":"20"}'

# Get channel history
blink connector exec slack conversations.history POST '{"channel":"C123456","limit":"10"}'
```

### Discord

```bash
# List guilds (servers)
blink connector exec discord users/@me/guilds GET

# List channels in a guild
blink connector exec discord guilds/GUILD_ID/channels GET

# Send a message
blink connector exec discord channels/CHANNEL_ID/messages POST '{"content":"Hello from Blink!"}'
```

### Google Calendar

**IMPORTANT**: Run `blink connector status` first — use `google_calendar` or `composio_calendar`, whichever appears. Examples below use `CALENDAR` as placeholder.

```bash
# List calendars
blink connector exec CALENDAR users/me/calendarList GET

# List upcoming events (all param values must be strings)
blink connector exec CALENDAR calendars/primary/events GET '{"timeMin":"2026-04-17T00:00:00Z","timeMax":"2026-04-18T00:00:00Z","maxResults":"10","singleEvents":"true","orderBy":"startTime"}'

# Create an event
blink connector exec CALENDAR calendars/primary/events POST '{"summary":"Team Meeting","start":{"dateTime":"2026-04-18T10:00:00","timeZone":"America/New_York"},"end":{"dateTime":"2026-04-18T11:00:00","timeZone":"America/New_York"}}'

# Delete an event
blink connector exec CALENDAR calendars/primary/events/EVENT_ID DELETE '{}'

# Find free/busy time
blink connector exec CALENDAR freeBusy POST '{"timeMin":"2026-04-18T09:00:00Z","timeMax":"2026-04-18T17:00:00Z","items":[{"id":"primary"}]}'
```

### Gmail

```bash
# List unread messages
blink connector exec google_gmail users/me/messages GET '{"labelIds":"INBOX","q":"is:unread","maxResults":"10"}'

# Get a specific message
blink connector exec google_gmail users/me/messages/MESSAGE_ID GET '{"format":"full"}'

# List labels
blink connector exec google_gmail users/me/labels GET

# Send an email (raw RFC822 base64url encoded)
blink connector exec google_gmail users/me/messages/send POST '{"raw":"BASE64URL_ENCODED_EMAIL"}'
```

### Google Drive

```bash
# List files
blink connector exec google_drive files GET '{"pageSize":"20","fields":"files(id,name,mimeType,modifiedTime)"}'

# Search files
blink connector exec google_drive files GET '{"q":"name contains '\''report'\''","pageSize":"10"}'

# Get file metadata
blink connector exec google_drive files/FILE_ID GET '{"fields":"id,name,mimeType,size,modifiedTime"}'
```

### Google Docs

```bash
# Get a document's content
blink connector exec google_docs documents/DOCUMENT_ID GET

# Create a new document
blink connector exec google_docs documents POST '{"title":"My New Document"}'
```

### Google Sheets

```bash
# Create a spreadsheet
blink connector exec google_sheets spreadsheets POST '{"properties":{"title":"My Spreadsheet"}}'

# Read a range
blink connector exec google_sheets spreadsheets/SPREADSHEET_ID/values/Sheet1!A1:Z100 GET

# Write to a range
blink connector exec google_sheets spreadsheets/SPREADSHEET_ID/values/Sheet1!A1:B2 PUT '{"values":[["Name","Score"],["Alice","95"]],"valueInputOption":"USER_ENTERED"}'

# Get spreadsheet metadata
blink connector exec google_sheets spreadsheets/SPREADSHEET_ID GET
```

### Google Slides

```bash
# Get a presentation
blink connector exec google_slides presentations/PRESENTATION_ID GET

# Create a presentation
blink connector exec google_slides presentations POST '{"title":"My Presentation"}'
```

### YouTube

```bash
# List your channels
blink connector exec youtube channels GET '{"part":"snippet,statistics","mine":"true"}'

# Search videos
blink connector exec youtube search GET '{"part":"snippet","q":"blink.new tutorial","type":"video","maxResults":"5"}'

# List videos from a channel
blink connector exec youtube search GET '{"part":"snippet","channelId":"CHANNEL_ID","type":"video","maxResults":"10"}'

# Get video details
blink connector exec youtube videos GET '{"part":"snippet,statistics","id":"VIDEO_ID"}'
```

### HubSpot

```bash
# Search contacts
blink connector exec hubspot crm/v3/objects/contacts/search POST '{"filterGroups":[{"filters":[{"propertyName":"email","operator":"CONTAINS_TOKEN","value":"example.com"}]}],"limit":10}'

# List contacts
blink connector exec hubspot crm/v3/objects/contacts GET '{"limit":"10"}'

# Create a contact
blink connector exec hubspot crm/v3/objects/contacts POST '{"properties":{"email":"new@example.com","firstname":"John","lastname":"Doe"}}'

# List deals
blink connector exec hubspot crm/v3/objects/deals GET '{"limit":"10"}'
```

### Airtable

```bash
# List bases
blink connector exec airtable meta/bases GET

# List records in a table
blink connector exec airtable BASE_ID/TABLE_NAME GET '{"maxRecords":"50"}'

# Create a record
blink connector exec airtable BASE_ID/TABLE_NAME POST '{"records":[{"fields":{"Name":"New Record","Status":"Active"}}]}'
```

### Microsoft Outlook

```bash
# List inbox
blink connector exec microsoft_outlook me/messages GET '{"$top":"20","$select":"subject,from,receivedDateTime,isRead","$orderby":"receivedDateTime desc"}'

# Send email
blink connector exec microsoft_outlook me/sendMail POST '{"message":{"subject":"Hello","body":{"contentType":"Text","content":"Hi!"},"toRecipients":[{"emailAddress":{"address":"user@example.com"}}]}}'

# Get a message
blink connector exec microsoft_outlook me/messages/MESSAGE_ID GET
```

### Microsoft Calendar

```bash
# List events
blink connector exec microsoft_calendar me/events GET '{"$top":"10","$orderby":"start/dateTime"}'

# Create event
blink connector exec microsoft_calendar me/events POST '{"subject":"Meeting","start":{"dateTime":"2026-04-01T10:00:00","timeZone":"UTC"},"end":{"dateTime":"2026-04-01T11:00:00","timeZone":"UTC"}}'
```

### Microsoft OneDrive

```bash
# List root files
blink connector exec microsoft_onedrive me/drive/root/children GET

# Search files
blink connector exec microsoft_onedrive me/drive/root/search(q='report') GET
```

### Microsoft Teams

```bash
# List joined teams
blink connector exec microsoft_teams me/joinedTeams GET

# List channels in a team
blink connector exec microsoft_teams teams/TEAM_ID/channels GET
```

### LinkedIn

```bash
# Get profile info (name, email, picture)
blink connector exec linkedin userinfo GET

# Create a text post (replace PERSON_ID with sub from userinfo)
blink connector exec linkedin ugcPosts POST '{"author":"urn:li:person:PERSON_ID","lifecycleState":"PUBLISHED","specificContent":{"com.linkedin.ugc.ShareContent":{"shareCommentary":{"text":"Posted via Blink!"},"shareMediaCategory":"NONE"}},"visibility":{"com.linkedin.ugc.MemberNetworkVisibility":"PUBLIC"}}'

# Like a post
blink connector exec linkedin 'socialActions/urn%3Ali%3Ashare%3A123/likes' POST '{"actor":"urn:li:person:PERSON_ID"}'
```

### Salesforce

```bash
# SOQL query
blink connector exec salesforce services/data/v62.0/query GET '{"q":"SELECT Id,Name,Email FROM Contact LIMIT 20"}'

# List accounts
blink connector exec salesforce services/data/v62.0/sobjects/Account GET

# Get a specific record
blink connector exec salesforce services/data/v62.0/sobjects/Contact/CONTACT_ID GET
```

### GitHub

```bash
# Get authenticated user
blink connector exec github user GET

# List repos (sorted by last update)
blink connector exec github user/repos GET '{"per_page":"10","sort":"updated"}'

# Get repo details
blink connector exec github repos/OWNER/REPO GET

# List issues
blink connector exec github repos/OWNER/REPO/issues GET '{"state":"open","per_page":"10"}'

# Create an issue
blink connector exec github repos/OWNER/REPO/issues POST '{"title":"Bug report","body":"Description here","labels":["bug"]}'

# List pull requests
blink connector exec github repos/OWNER/REPO/pulls GET '{"state":"open"}'

# Browse repo file tree (root)
blink connector exec github repos/OWNER/REPO/contents/ GET

# Browse a specific directory
blink connector exec github repos/OWNER/REPO/contents/src GET

# Get file contents (returns base64-encoded content)
blink connector exec github repos/OWNER/REPO/contents/README.md GET
```

#### Cloning a repo locally

On Blink Claw machines, `git clone`, `git push`, and `gh` are **fully pre-authenticated** via the Blink GitHub App credential helper — no PAT, no SSH key, no `gh auth login` required. Just use git directly:

```bash
# Clone any repo the workspace's GitHub App has access to (public OR private)
git clone https://github.com/OWNER/REPO.git

# Or use the blink CLI helper which strips the token from .git/config after clone:
blink github clone OWNER/REPO

# Push, PR — all work automatically:
git push
gh pr create --fill
```

**OAuth fallback (no GitHub App installed)**: if `blink github clone` reports "No Blink GitHub App installation", it automatically falls back to the OAuth GitHub connector and pulls files via the Git Data API. You get all the source files (with binaries decoded correctly), but **no `.git` directory and no commit history** — `git push` and `gh pr create` will not work from the result. To get the full git workflow, install the Blink GitHub App at `blink.new/settings?tab=connectors`.

For reading specific files without cloning, use the API:

```bash
# Read a specific file (content is base64-encoded in the response)
blink connector exec github repos/OWNER/REPO/contents/package.json GET

# List the root directory
blink connector exec github repos/OWNER/REPO/contents/ GET
```

**See the `blink-github` skill for full clone/push/PR documentation.**

### Jira

```bash
# Get myself
blink connector exec jira myself GET

# Search issues (JQL)
blink connector exec jira search GET '{"jql":"assignee=currentUser() ORDER BY updated DESC","maxResults":"20"}'

# Get issue details
blink connector exec jira issue/ISSUE_KEY GET

# Create issue
blink connector exec jira issue POST '{"fields":{"project":{"key":"PROJ"},"summary":"New Bug","issuetype":{"name":"Bug"},"description":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Description"}]}]}}}'

# List projects
blink connector exec jira project GET
```

### Asana

```bash
# Get user info
blink connector exec asana users/me GET

# List workspaces
blink connector exec asana workspaces GET

# List projects in a workspace
blink connector exec asana projects GET '{"workspace":"WORKSPACE_GID"}'

# List tasks in a project
blink connector exec asana tasks GET '{"project":"PROJECT_GID"}'

# Create a task
blink connector exec asana tasks POST '{"data":{"name":"New Task","projects":["PROJECT_GID"],"workspace":"WORKSPACE_GID"}}'
```

### Linear (GraphQL)

```bash
# Get viewer info
blink connector exec linear '{ viewer { id name email teams { nodes { id name } } } }' POST

# List issues
blink connector exec linear '{ issues(first: 20) { nodes { id title state { name } assignee { name } } } }' POST

# Create an issue
blink connector exec linear 'mutation { issueCreate(input: { title: "Bug fix", teamId: "TEAM_ID" }) { success issue { id identifier title } } }' POST

# Search issues
blink connector exec linear '{ issueSearch(query: "bug", first: 10) { nodes { id title state { name } } } }' POST
```

### Attio

```bash
# List all objects (custom + standard)
blink connector exec attio objects GET

# List records for an object (e.g., People)
blink connector exec attio objects/people/records/query POST '{"limit":20}'

# Get a specific record
blink connector exec attio objects/people/records/RECORD_ID GET

# List all lists
blink connector exec attio lists GET

# Query list entries
blink connector exec attio lists/LIST_ID/entries/query POST '{"limit":20}'

# Search for records
blink connector exec attio objects/people/records/query POST '{"filter":{"email_addresses":{"contains":"@example.com"}}}'

# Create a record
blink connector exec attio objects/people/records POST '{"data":{"values":{"name":[{"first_name":"John","last_name":"Doe"}],"email_addresses":["john@example.com"]}}}'

# List notes
blink connector exec attio notes GET '{"limit":"20"}'
```

### Pipedrive

```bash
# Get current user
blink connector exec pipedrive users/me GET

# List deals
blink connector exec pipedrive deals GET '{"limit":"20","status":"open"}'

# Get deal details
blink connector exec pipedrive deals/DEAL_ID GET

# Create a deal
blink connector exec pipedrive deals POST '{"title":"New Deal","value":"5000","currency":"USD"}'

# List persons (contacts)
blink connector exec pipedrive persons GET '{"limit":"20"}'

# Search
blink connector exec pipedrive itemSearch GET '{"term":"Acme","item_types":"deal,person"}'

# List activities
blink connector exec pipedrive activities GET '{"limit":"20"}'
```

### Zoom

```bash
# List meetings
blink connector exec zoom users/me/meetings GET

# Get meeting details
blink connector exec zoom meetings/MEETING_ID GET

# Create a meeting
blink connector exec zoom users/me/meetings POST '{"topic":"Team Sync","type":2,"start_time":"2026-04-01T10:00:00Z","duration":30}'

# List recordings
blink connector exec zoom users/me/recordings GET '{"from":"2026-03-01","to":"2026-03-31"}'
```

### Stripe

```bash
# List customers
blink connector exec stripe customers GET '{"limit":"10"}'

# Get customer
blink connector exec stripe customers/CUSTOMER_ID GET

# List charges
blink connector exec stripe charges GET '{"limit":"10"}'

# List subscriptions
blink connector exec stripe subscriptions GET '{"limit":"10"}'

# List invoices
blink connector exec stripe invoices GET '{"limit":"10"}'
```

### Shopify

```bash
# List orders
blink connector exec shopify orders.json GET '{"limit":"10"}'

# List products
blink connector exec shopify products.json GET '{"limit":"10"}'

# Get a product
blink connector exec shopify products/PRODUCT_ID.json GET

# List customers
blink connector exec shopify customers.json GET '{"limit":"10"}'
```

### Figma

```bash
# Get user info
blink connector exec figma me GET

# Get a file
blink connector exec figma files/FILE_KEY GET

# List team projects
blink connector exec figma teams/TEAM_ID/projects GET

# Get file comments
blink connector exec figma files/FILE_KEY/comments GET
```

### Mailchimp

```bash
# Ping (health check)
blink connector exec mailchimp ping GET

# List audiences (lists)
blink connector exec mailchimp lists GET '{"count":"10"}'

# Get audience members
blink connector exec mailchimp lists/LIST_ID/members GET '{"count":"20"}'

# List campaigns
blink connector exec mailchimp campaigns GET '{"count":"10"}'

# Add subscriber to a list
blink connector exec mailchimp lists/LIST_ID/members POST '{"email_address":"user@example.com","status":"subscribed"}'
```

### Calendly

```bash
# Get current user
blink connector exec calendly users/me GET

# List event types
blink connector exec calendly event_types GET '{"user":"USER_URI"}'

# List scheduled events
blink connector exec calendly scheduled_events GET '{"user":"USER_URI","status":"active","count":"20"}'

# Get event details
blink connector exec calendly scheduled_events/EVENT_UUID GET
```

### Typeform

```bash
# List forms
blink connector exec typeform forms GET '{"page_size":"10"}'

# Get form details
blink connector exec typeform forms/FORM_ID GET

# List responses
blink connector exec typeform forms/FORM_ID/responses GET '{"page_size":"10"}'
```

### ConvertKit (Kit)

```bash
# Get account info
blink connector exec convertkit account GET

# List subscribers
blink connector exec convertkit subscribers GET '{"per_page":"20"}'

# List tags
blink connector exec convertkit tags GET

# List forms
blink connector exec convertkit forms GET

# List sequences
blink connector exec convertkit sequences GET
```

### Vercel

```bash
# Get user
blink connector exec vercel v2/user GET

# List projects
blink connector exec vercel v9/projects GET '{"limit":"10"}'

# List deployments
blink connector exec vercel v6/deployments GET '{"limit":"10"}'

# Get project
blink connector exec vercel v9/projects/PROJECT_ID GET
```

### Reddit

```bash
# Get your own identity
blink connector exec reddit api/v1/me GET

# Get another user's profile (MUST append /about — without it Reddit returns 403)
blink connector exec reddit user/USERNAME/about GET

# Search posts
blink connector exec reddit search GET '{"q":"OpenClaw","sort":"new","limit":"10"}'

# Get subreddit posts
blink connector exec reddit r/SUBREDDIT/hot GET '{"limit":"10"}'

# Get user's subscriptions
blink connector exec reddit subreddits/mine/subscriber GET '{"limit":"25"}'

# Comment on a post (thing_id = t3_POST_ID for posts, t1_COMMENT_ID for replies)
blink connector exec reddit api/comment POST '{"thing_id":"t3_POST_ID","text":"My comment"}'

# Submit a text post
blink connector exec reddit api/submit POST '{"sr":"SUBREDDIT","kind":"self","title":"Post title","text":"Post body"}'

# Submit a link post
blink connector exec reddit api/submit POST '{"sr":"SUBREDDIT","kind":"link","title":"Check this out","url":"https://example.com"}'

# Upvote/downvote (dir: 1=upvote, -1=downvote, 0=unvote)
blink connector exec reddit api/vote POST '{"id":"t3_POST_ID","dir":"1"}'

# Get comments on a post
blink connector exec reddit r/SUBREDDIT/comments/POST_ID GET '{"limit":"20","sort":"new"}'
```

### ClickUp

```bash
# List teams (workspaces)
blink connector exec clickup team GET

# List spaces in a team
blink connector exec clickup team/TEAM_ID/space GET

# List tasks in a list
blink connector exec clickup list/LIST_ID/task GET

# Create a task
blink connector exec clickup list/LIST_ID/task POST '{"name":"New Task","description":"Details","priority":3}'
```

### Twitter / X

Use the dedicated `blink twitter …` subcommands — they wrap Composio's native
Twitter tools and handle image/video upload + processing-status polling for
you. The old `blink connector exec composio_twitter …` HTTP-proxy path also
works for reads but can't do media upload.

```bash
# Profile lookup
blink twitter me

# Plain text tweet
blink twitter post "Shipping today 🚀"

# With one image (URL or local path — Composio uploads for you)
blink twitter post "Launch day" --image https://cdn.blink.new/hero.png

# Multiple images (up to 4)
blink twitter post "Carousel" --image ./a.png --image ./b.png --image ./c.png --image ./d.png

# With video (uploads chunked + polls processing; blocks up to 3 min)
blink twitter post "Demo video" --video ./demo.mp4

# Reply (= public comment). Optionally with media.
blink twitter reply 1820000000000000000 "My take on this"
blink twitter reply 1820000000000000000 "With a screenshot" --image ./reply.png

# Quote tweet
blink twitter quote 1820000000000000000 "This changes everything"

# Like / retweet / delete
blink twitter like    1820000000000000000
blink twitter retweet 1820000000000000000
blink twitter delete  1820000000000000000

# Chain tweets (capture the new id → thread it)
ROOT=$(blink twitter post "Thread 🧵 1/"            --json | jq -r .id)
blink twitter reply $ROOT  "2/ Here's the detail"
blink twitter reply $ROOT  "3/ And the conclusion"
```

Read-only / search / timelines still work through the HTTP-proxy path:

```bash
blink connector exec composio_twitter tweets/search/recent GET '{"query":"blink.new","max_results":"10"}'
blink connector exec composio_twitter users/me GET '{"user.fields":"username,name,profile_image_url"}'
```

If you need a Composio Twitter tool that isn't wrapped by `blink twitter …`,
drop down to the raw tool catalog — see the "Native Composio tools" section
below.

### Instagram

```bash
# Get user profile
blink connector exec instagram me GET '{"fields":"id,username,media_count"}'

# List media
blink connector exec instagram me/media GET '{"fields":"id,caption,media_type,timestamp","limit":"10"}'
```

### TikTok

```bash
# Get user info
blink connector exec tiktok user/info/ GET '{"fields":"display_name,follower_count,following_count"}'

# List videos
blink connector exec tiktok video/list/ POST '{"max_count":10}'
```

### Etsy

Etsy's API does **not** accept `me` as a user_id placeholder — pass the numeric `user_id` / `shop_id` returned by `/users/me`. If `/users/me` returns `"Could not find a shop for User with user_id = ..."`, the account has no Etsy shop and shop-scoped endpoints will always fail until the user creates one on etsy.com.

```bash
# Get user info (returns user_id + shop_id for shop owners)
blink connector exec etsy application/users/me GET

# Get shop info (use shop_id from /users/me)
blink connector exec etsy application/shops/SHOP_ID GET

# List shop listings
blink connector exec etsy application/shops/SHOP_ID/listings/active GET '{"limit":"25"}'

# Search shops by name (no auth needed on top of the linked account)
blink connector exec etsy application/shops GET '{"shop_name":"example","limit":"5"}'
```

### Composio Connectors

**IMPORTANT**: When `blink connector status` shows a `composio_`* provider (e.g. `composio_figma` instead of `figma`), use that exact key. The endpoints are the same as the legacy connector — just swap the provider key.

```bash
# If status shows composio_figma:
blink connector exec composio_figma me GET              # NOT figma
# If status shows composio_youtube:
blink connector exec composio_youtube channels GET '{"part":"snippet,statistics","mine":"true"}'
# If status shows composio_reddit:
blink connector exec composio_reddit api/v1/me GET
# Get another user's profile (MUST use /about suffix):
blink connector exec composio_reddit user/USERNAME/about GET
# If status shows composio_gmail:
blink connector exec composio_gmail users/me/messages GET '{"q":"is:unread","maxResults":"10"}'
```

### Facebook

```bash
# Get my profile
blink connector exec composio_facebook me GET '{"fields":"id,name,email"}'

# List my pages
blink connector exec composio_facebook me/accounts GET

# Get page posts
blink connector exec composio_facebook PAGE_ID/feed GET '{"limit":"10"}'
```

### Monday (GraphQL)

```bash
# List boards
blink connector exec composio_monday "" POST '{"query":"{ boards(limit:10) { id name } }"}'

# Get board items
blink connector exec composio_monday "" POST '{"query":"{ boards(ids: BOARD_ID) { items_page(limit:20) { items { id name } } } }"}'
```

### Google Analytics

```bash
# List account summaries
blink connector exec composio_googleanalytics accountSummaries GET

# List accounts
blink connector exec composio_googleanalytics accounts GET
```

### Zendesk

```bash
# List tickets
blink connector exec composio_zendesk tickets GET

# Get a ticket
blink connector exec composio_zendesk tickets/TICKET_ID GET

# Search tickets
blink connector exec composio_zendesk search GET '{"query":"status:open type:ticket"}'
```

### Apollo

```bash
# Search people
blink connector exec composio_apollo people/match POST '{"email":"user@example.com"}'

# Search organizations
blink connector exec composio_apollo organizations/search POST '{"q_organization_name":"Acme"}'
```

### Supabase

```bash
# List organizations
blink connector exec composio_supabase organizations GET

# List projects
blink connector exec composio_supabase projects GET
```

### Amplitude

```bash
# List charts
blink connector exec composio_amplitude 2/charts GET

# Get active users
blink connector exec composio_amplitude 2/users/search GET '{"user":"user@example.com"}'
```

### QuickBooks

QuickBooks is multi-tenant: every endpoint is scoped under the user's
`realmId` (also called `companyId`). Get it from `blink connector status`
metadata or by listing companies via OpenID Connect.

```bash
# List customers (replace REALMID with the company id)
blink connector exec composio_quickbooks v3/company/REALMID/query GET '{"query":"SELECT * FROM Customer MAXRESULTS 10"}'

# Get a specific invoice
blink connector exec composio_quickbooks v3/company/REALMID/invoice/INVOICE_ID GET

# Create an invoice
blink connector exec composio_quickbooks v3/company/REALMID/invoice POST '{"Line":[{"Amount":100,"DetailType":"SalesItemLineDetail","SalesItemLineDetail":{"ItemRef":{"value":"1"}}}],"CustomerRef":{"value":"CUSTOMER_ID"}}'
```

For complex writes (attachments, voids), prefer the native tool catalog:

```bash
blink connector tool-execute composio_quickbooks QUICKBOOKS_CREATE_INVOICE '{...}'
```

### Brex

```bash
# Get current user
blink connector exec composio_brex users/me GET

# List cards
blink connector exec composio_brex cards GET '{"limit":"20"}'

# List transactions
blink connector exec composio_brex transactions/card GET '{"limit":"20"}'
```

### Google Ads

Requires a `developer-token` header (Composio injects it server-side from the
auth config). All paths must include the API version:

```bash
# List accessible customers
blink connector exec composio_googleads v21/customers:listAccessibleCustomers GET

# Run a Google Ads Query Language (GAQL) report
blink connector exec composio_googleads v21/customers/CUSTOMER_ID/googleAds:search POST '{"query":"SELECT campaign.id, campaign.name FROM campaign LIMIT 10"}'
```

### Intercom

```bash
# Get current admin
blink connector exec composio_intercom me GET

# List contacts
blink connector exec composio_intercom contacts GET '{"per_page":"20"}'

# Create a contact
blink connector exec composio_intercom contacts POST '{"role":"user","email":"new@example.com","name":"Jane Doe"}'

# Search conversations
blink connector exec composio_intercom conversations/search POST '{"query":{"field":"open","operator":"=","value":"true"}}'
```

### ZoomInfo

```bash
# Search people
blink connector exec composio_zoominfo search/contact POST '{"firstName":"Jane","lastName":"Doe","companyName":"Acme"}'

# Search companies
blink connector exec composio_zoominfo search/company POST '{"companyName":"Acme"}'
```

### Gong

```bash
# List users
blink connector exec composio_gong users GET

# List calls (last 7 days)
blink connector exec composio_gong calls GET '{"fromDateTime":"2026-04-16T00:00:00Z","toDateTime":"2026-04-23T00:00:00Z"}'

# Get call transcript
blink connector exec composio_gong calls/transcript POST '{"filter":{"callIds":["CALL_ID"]}}'
```

### DocuSign

DocuSign is account-scoped. The connect callback captures both
`docusign_account_id` and `docusign_base_uri` into `metadata` so the executor
auto-routes to the correct account host (e.g. `https://na3.docusign.net/restapi/`).
Get `ACCOUNT_ID` from `blink connector status` metadata (`docusign_account_id`).

```bash
# Get my account info
blink connector exec composio_docusign v2.1/accounts/ACCOUNT_ID GET

# List envelopes
blink connector exec composio_docusign v2.1/accounts/ACCOUNT_ID/envelopes GET '{"from_date":"2026-01-01"}'

# Create an envelope (use tool-execute for file attachments)
blink connector tool-execute composio_docusign DOCUSIGN_CREATE_ENVELOPE '{...}'
```

### Box

```bash
# Get current user
blink connector exec composio_box users/me GET

# List items in root folder (folder id 0)
blink connector exec composio_box folders/0/items GET '{"limit":"20"}'

# Get file info
blink connector exec composio_box files/FILE_ID GET

# Create a folder
blink connector exec composio_box folders POST '{"name":"New Folder","parent":{"id":"0"}}'

# Upload a file (use tool-execute for multipart)
blink connector tool-execute composio_box BOX_UPLOAD_FILE '{"file":"./report.pdf","parent_id":"0"}'
```

### Todoist

```bash
# List projects
blink connector exec composio_todoist projects GET

# List active tasks
blink connector exec composio_todoist tasks GET

# Filter tasks by project
blink connector exec composio_todoist tasks GET '{"project_id":"PROJECT_ID"}'

# Create a task
blink connector exec composio_todoist tasks POST '{"content":"Ship the new connectors","project_id":"PROJECT_ID","due_string":"tomorrow at 5pm"}'

# Close a task
blink connector exec composio_todoist tasks/TASK_ID/close POST
```

### Ashby

Ashby uses API-key auth (Basic with empty password). Composio handles the
encoding — pass the path only.

```bash
# Get current user
blink connector exec composio_ashby user.me POST '{}'

# List candidates
blink connector exec composio_ashby candidate.list POST '{"limit":20}'

# Get a candidate
blink connector exec composio_ashby candidate.info POST '{"candidateId":"CANDIDATE_ID"}'

# List jobs
blink connector exec composio_ashby job.list POST '{"limit":20}'
```

### Basecamp

Basecamp 4 is account-scoped, but the executor auto-prepends the user's
account id from connection metadata (or, for legacy connections, looks it up
on Composio). You can write paths *without* the leading account id:

```bash
# List projects
blink connector exec composio_basecamp projects.json GET

# Get a specific project
blink connector exec composio_basecamp projects/PROJECT_ID.json GET

# Create a project (then later DELETE projects/PROJECT_ID.json to trash it)
blink connector exec composio_basecamp projects.json POST '{"name":"New Project","description":"Created via API"}'

# List todos in a todo list
blink connector exec composio_basecamp buckets/PROJECT_ID/todolists/TODOLIST_ID/todos.json GET

# Create a message
blink connector exec composio_basecamp buckets/PROJECT_ID/message_boards/BOARD_ID/messages.json POST '{"subject":"Status update","content":"<div>Shipping today.</div>","status":"active"}'
```

If you need to override the account (for users who belong to multiple
Basecamp accounts), you may still pass the numeric account id explicitly as
the first path segment, e.g. `6199974/projects.json`.

## Scripting — capture output

```bash
# Get a value from JSON response
RESULT=$(blink connector exec github user/repos GET --json)
echo "$RESULT" | python3 -c "import json,sys; repos=json.load(sys.stdin)['data']; [print(r['full_name']) for r in repos[:5]]"
```

## Multiple accounts

When multiple accounts are linked for the same provider, `blink connector status` shows all of them. Use `--account` to pick a specific account:

```bash
# Use the primary account (default)
blink connector exec composio_reddit api/v1/me GET

# Use a specific non-primary account
blink connector exec composio_reddit api/v1/me GET --account account_id_here
```

The `account_id` comes from the `blink connector status` output.

## Auto-link a connector

If a connector is connected to the workspace but not linked to this agent:

```bash
blink connector link <provider>
```

## Native Composio tools (power users)

`blink connector exec` talks to upstream APIs directly through Composio's HTTP
proxy — great for reads and simple writes, but it can't do multipart uploads
(no media/attachments). For that, use Composio's first-class tool catalog via
`blink connector tool-execute`. This unlocks every Composio tool across every
`composio_*` provider (1000+ tools total).

```bash
# Shape:
blink connector tool-execute <composio_provider> <TOOL_SLUG> '<json-args>' [--account <id>]
```

File arguments (images, videos, PDFs, attachments) accept **URLs or local file
paths** — Composio's SDK auto-uploads them to S3 and substitutes a proper file
descriptor before running the tool. Zero base64 or multipart wiring on your
side.

```bash
# Send a Gmail with an attachment
blink connector tool-execute composio_gmail GMAIL_SEND_EMAIL_WITH_ATTACHMENT \
  '{"recipient_email":"x@y.com","subject":"Report","body":"See attached","attachment":"https://cdn.blink.new/report.pdf"}'

# Upload a file to Slack
blink connector tool-execute composio_slack SLACK_FILES_UPLOAD \
  '{"channels":"C123","initial_comment":"New doc","file":"./spec.md"}'

# Create a Notion page with rich blocks
blink connector tool-execute composio_notion NOTION_CREATE_PAGE_WITH_BLOCKS \
  '{"parent_page_id":"abc-...","title":"Launch plan","blocks":[...]}'

# Low-level Twitter media dance (what `blink twitter post --image` does for you)
MEDIA=$(blink connector tool-execute composio_twitter TWITTER_UPLOAD_MEDIA \
    '{"media":"https://cdn.blink.new/hero.png","media_type":"image/png","media_category":"tweet_image"}' \
    --json | jq -r '.data.data.media_id_string')
blink connector tool-execute composio_twitter TWITTER_CREATION_OF_A_POST \
    '{"text":"Manual path","media_media_ids":["'"$MEDIA"'"]}'
```

Tool slugs follow the pattern `<TOOLKIT>_<ACTION>`. Browse the full catalog
at [docs.composio.dev/toolkits](https://docs.composio.dev/toolkits.md) — each
toolkit page lists every tool with its input schema.

### Known-good Composio tool slugs (reference)

If `tool-execute` returns `"Unable to retrieve tool with slug <SLUG>"`, the
slug is wrong — this is **not** a scope or API-version problem. Check the
Composio toolkit page or use one of these verified slugs:

```
composio_zoom      → ZOOM_GET_USER {"userId":"me"},
                     ZOOM_LIST_MEETINGS {"userId":"me","type":"upcoming"},
                     ZOOM_CREATE_MEETING, ZOOM_DELETE_MEETING,
                     ZOOM_LIST_RECORDINGS {"userId":"me"}
composio_youtube   → YOUTUBE_SEARCH_YOU_TUBE {"q":"..."},
                     YOUTUBE_LIST_USER_PLAYLISTS,
                     YOUTUBE_LIST_USER_SUBSCRIPTIONS
composio_figma     → FIGMA_GET_FILE, FIGMA_GET_FILE_NODES, FIGMA_GET_IMAGES
composio_reddit    → REDDIT_GET_CURRENT_USER_INFO, REDDIT_SEARCH_ACROSS_SUBREDDITS,
                     REDDIT_SUBMIT_POST_TO_SUBREDDIT
```

For a quick cross-check of reads, prefer the `blink connector exec` HTTP path —
it hits the upstream API directly and isn't gated by Composio's tool catalog.
