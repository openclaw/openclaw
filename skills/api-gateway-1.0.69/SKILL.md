---
name: api-gateway
description: |
  Connect to 100+ APIs (Google Workspace, Microsoft 365, GitHub, Notion, Slack, Airtable, HubSpot, etc.) with managed OAuth.
  Use this skill when users want to interact with external services.
  Security: The MATON_API_KEY authenticates with Maton.ai but grants NO access to third-party services by itself. Each service requires explicit OAuth authorization by the user through Maton's connect flow. Access is strictly scoped to connections the user has authorized. Provided by Maton (https://maton.ai).
compatibility: Requires network access and valid Maton API key
metadata:
  author: maton
  version: "1.0"
  clawdbot:
    emoji: 🧠
    homepage: "https://maton.ai"
    requires:
      env:
        - MATON_API_KEY
---

# API Gateway

Passthrough proxy for direct access to third-party APIs using managed OAuth connections, provided by [Maton](https://maton.ai). The API gateway lets you call native API endpoints directly.

## Quick Start

```bash
# Native Slack API call
python <<'EOF'
import urllib.request, os, json
data = json.dumps({'channel': 'C0123456', 'text': 'Hello from gateway!'}).encode()
req = urllib.request.Request('https://gateway.maton.ai/slack/api/chat.postMessage', data=data, method='POST')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
req.add_header('Content-Type', 'application/json')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

## Base URL

```
https://gateway.maton.ai/{app}/{native-api-path}
```

Replace `{app}` with the service name and `{native-api-path}` with the actual API endpoint path.

IMPORTANT: The URL path MUST start with the connection's app name (eg. `/google-mail/...`). This prefix tells the gateway which app connection to use. For example, the native Gmail API path starts with `gmail/v1/`, so full paths look like `/google-mail/gmail/v1/users/me/messages`.

## Authentication

All requests require the Maton API key in the Authorization header:

```
Authorization: Bearer $MATON_API_KEY
```

The API gateway automatically injects the appropriate OAuth token for the target service.

**Environment Variable:** You can set your API key as the `MATON_API_KEY` environment variable:

```bash
export MATON_API_KEY="YOUR_API_KEY"
```

## Getting Your API Key

1. Sign in or create an account at [maton.ai](https://maton.ai)
2. Go to [maton.ai/settings](https://maton.ai/settings)
3. Click the copy button on the right side of API Key section to copy it

## Connection Management

Connection management uses a separate base URL: `https://ctrl.maton.ai`

### List Connections

```bash
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://ctrl.maton.ai/connections?app=slack&status=ACTIVE')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

**Query Parameters (optional):**

- `app` - Filter by service name (e.g., `slack`, `hubspot`, `salesforce`)
- `status` - Filter by connection status (`ACTIVE`, `PENDING`, `FAILED`)

**Response:**

```json
{
  "connections": [
    {
      "connection_id": "21fd90f9-5935-43cd-b6c8-bde9d915ca80",
      "status": "ACTIVE",
      "creation_time": "2025-12-08T07:20:53.488460Z",
      "last_updated_time": "2026-01-31T20:03:32.593153Z",
      "url": "https://connect.maton.ai/?session_token=5e9...",
      "app": "slack",
      "method": "OAUTH2",
      "metadata": {}
    }
  ]
}
```

### Create Connection

```bash
python <<'EOF'
import urllib.request, os, json
data = json.dumps({'app': 'slack'}).encode()
req = urllib.request.Request('https://ctrl.maton.ai/connections', data=data, method='POST')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
req.add_header('Content-Type', 'application/json')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

**Request Body:**

- `app` (required) - Service name (e.g., `slack`, `notion`)
- `method` (optional) - Connection method (`API_KEY`, `BASIC`, `OAUTH1`, `OAUTH2`, `MCP`)

### Get Connection

```bash
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://ctrl.maton.ai/connections/{connection_id}')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

**Response:**

```json
{
  "connection": {
    "connection_id": "21fd90f9-5935-43cd-b6c8-bde9d915ca80",
    "status": "ACTIVE",
    "creation_time": "2025-12-08T07:20:53.488460Z",
    "last_updated_time": "2026-01-31T20:03:32.593153Z",
    "url": "https://connect.maton.ai/?session_token=5e9...",
    "app": "slack",
    "metadata": {}
  }
}
```

Open the returned URL in a browser to complete OAuth.

### Delete Connection

```bash
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://ctrl.maton.ai/connections/{connection_id}', method='DELETE')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

### Specifying Connection

If you have multiple connections for the same app, you can specify which connection to use by adding the `Maton-Connection` header with the connection ID:

```bash
python <<'EOF'
import urllib.request, os, json
data = json.dumps({'channel': 'C0123456', 'text': 'Hello!'}).encode()
req = urllib.request.Request('https://gateway.maton.ai/slack/api/chat.postMessage', data=data, method='POST')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
req.add_header('Content-Type', 'application/json')
req.add_header('Maton-Connection', '21fd90f9-5935-43cd-b6c8-bde9d915ca80')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

If omitted, the gateway uses the default (oldest) active connection for that app.

## Supported Services

| Service                | App Name                 | Base URL Proxied                  |
| ---------------------- | ------------------------ | --------------------------------- |
| ActiveCampaign         | `active-campaign`        | `{account}.api-us1.com`           |
| Acuity Scheduling      | `acuity-scheduling`      | `acuityscheduling.com`            |
| Airtable               | `airtable`               | `api.airtable.com`                |
| Apollo                 | `apollo`                 | `api.apollo.io`                   |
| Asana                  | `asana`                  | `app.asana.com`                   |
| Attio                  | `attio`                  | `api.attio.com`                   |
| Basecamp               | `basecamp`               | `3.basecampapi.com`               |
| Baserow                | `baserow`                | `api.baserow.io`                  |
| beehiiv                | `beehiiv`                | `api.beehiiv.com`                 |
| Box                    | `box`                    | `api.box.com`                     |
| Brevo                  | `brevo`                  | `api.brevo.com`                   |
| Brave Search           | `brave-search`           | `api.search.brave.com`            |
| Buffer                 | `buffer`                 | `api.buffer.com`                  |
| Calendly               | `calendly`               | `api.calendly.com`                |
| Cal.com                | `cal-com`                | `api.cal.com`                     |
| CallRail               | `callrail`               | `api.callrail.com`                |
| Chargebee              | `chargebee`              | `{subdomain}.chargebee.com`       |
| ClickFunnels           | `clickfunnels`           | `{subdomain}.myclickfunnels.com`  |
| ClickSend              | `clicksend`              | `rest.clicksend.com`              |
| ClickUp                | `clickup`                | `api.clickup.com`                 |
| Clockify               | `clockify`               | `api.clockify.me`                 |
| Coda                   | `coda`                   | `coda.io`                         |
| Confluence             | `confluence`             | `api.atlassian.com`               |
| CompanyCam             | `companycam`             | `api.companycam.com`              |
| Cognito Forms          | `cognito-forms`          | `www.cognitoforms.com`            |
| Constant Contact       | `constant-contact`       | `api.cc.email`                    |
| Dropbox                | `dropbox`                | `api.dropboxapi.com`              |
| Dropbox Business       | `dropbox-business`       | `api.dropboxapi.com`              |
| ElevenLabs             | `elevenlabs`             | `api.elevenlabs.io`               |
| Eventbrite             | `eventbrite`             | `www.eventbriteapi.com`           |
| Exa                    | `exa`                    | `api.exa.ai`                      |
| fal.ai                 | `fal-ai`                 | `queue.fal.run`                   |
| Fathom                 | `fathom`                 | `api.fathom.ai`                   |
| Firecrawl              | `firecrawl`              | `api.firecrawl.dev`               |
| Firebase               | `firebase`               | `firebase.googleapis.com`         |
| Fireflies              | `fireflies`              | `api.fireflies.ai`                |
| GetResponse            | `getresponse`            | `api.getresponse.com`             |
| Grafana                | `grafana`                | User's Grafana instance           |
| GitHub                 | `github`                 | `api.github.com`                  |
| Gumroad                | `gumroad`                | `api.gumroad.com`                 |
| Granola MCP            | `granola`                | `mcp.granola.ai`                  |
| Google Ads             | `google-ads`             | `googleads.googleapis.com`        |
| Google BigQuery        | `google-bigquery`        | `bigquery.googleapis.com`         |
| Google Analytics Admin | `google-analytics-admin` | `analyticsadmin.googleapis.com`   |
| Google Analytics Data  | `google-analytics-data`  | `analyticsdata.googleapis.com`    |
| Google Calendar        | `google-calendar`        | `www.googleapis.com`              |
| Google Classroom       | `google-classroom`       | `classroom.googleapis.com`        |
| Google Contacts        | `google-contacts`        | `people.googleapis.com`           |
| Google Docs            | `google-docs`            | `docs.googleapis.com`             |
| Google Drive           | `google-drive`           | `www.googleapis.com`              |
| Google Forms           | `google-forms`           | `forms.googleapis.com`            |
| Gmail                  | `google-mail`            | `gmail.googleapis.com`            |
| Google Merchant        | `google-merchant`        | `merchantapi.googleapis.com`      |
| Google Meet            | `google-meet`            | `meet.googleapis.com`             |
| Google Play            | `google-play`            | `androidpublisher.googleapis.com` |
| Google Search Console  | `google-search-console`  | `www.googleapis.com`              |
| Google Sheets          | `google-sheets`          | `sheets.googleapis.com`           |
| Google Slides          | `google-slides`          | `slides.googleapis.com`           |
| Google Tasks           | `google-tasks`           | `tasks.googleapis.com`            |
| Google Workspace Admin | `google-workspace-admin` | `admin.googleapis.com`            |
| HubSpot                | `hubspot`                | `api.hubapi.com`                  |
| Instantly              | `instantly`              | `api.instantly.ai`                |
| Jira                   | `jira`                   | `api.atlassian.com`               |
| Jobber                 | `jobber`                 | `api.getjobber.com`               |
| JotForm                | `jotform`                | `api.jotform.com`                 |
| Kaggle                 | `kaggle`                 | `api.kaggle.com`                  |
| Keap                   | `keap`                   | `api.infusionsoft.com`            |
| Kibana                 | `kibana`                 | User's Kibana instance            |
| Kit                    | `kit`                    | `api.kit.com`                     |
| Klaviyo                | `klaviyo`                | `a.klaviyo.com`                   |
| Lemlist                | `lemlist`                | `api.lemlist.com`                 |
| Linear                 | `linear`                 | `api.linear.app`                  |
| LinkedIn               | `linkedin`               | `api.linkedin.com`                |
| Mailchimp              | `mailchimp`              | `{dc}.api.mailchimp.com`          |
| MailerLite             | `mailerlite`             | `connect.mailerlite.com`          |
| Mailgun                | `mailgun`                | `api.mailgun.net`                 |
| ManyChat               | `manychat`               | `api.manychat.com`                |
| Manus                  | `manus`                  | `api.manus.ai`                    |
| Microsoft Excel        | `microsoft-excel`        | `graph.microsoft.com`             |
| Microsoft Teams        | `microsoft-teams`        | `graph.microsoft.com`             |
| Microsoft To Do        | `microsoft-to-do`        | `graph.microsoft.com`             |
| Monday.com             | `monday`                 | `api.monday.com`                  |
| Motion                 | `motion`                 | `api.usemotion.com`               |
| Netlify                | `netlify`                | `api.netlify.com`                 |
| Notion                 | `notion`                 | `api.notion.com`                  |
| Notion MCP             | `notion`                 | `mcp.notion.com`                  |
| OneNote                | `one-note`               | `graph.microsoft.com`             |
| OneDrive               | `one-drive`              | `graph.microsoft.com`             |
| Outlook                | `outlook`                | `graph.microsoft.com`             |
| PDF.co                 | `pdf-co`                 | `api.pdf.co`                      |
| Pipedrive              | `pipedrive`              | `api.pipedrive.com`               |
| Podio                  | `podio`                  | `api.podio.com`                   |
| PostHog                | `posthog`                | `{subdomain}.posthog.com`         |
| QuickBooks             | `quickbooks`             | `quickbooks.api.intuit.com`       |
| Quo                    | `quo`                    | `api.openphone.com`               |
| Reducto                | `reducto`                | `platform.reducto.ai`             |
| Resend                 | `resend`                 | `api.resend.com`                  |
| Salesforce             | `salesforce`             | `{instance}.salesforce.com`       |
| Sentry                 | `sentry`                 | `{subdomain}.sentry.io`           |
| SharePoint             | `sharepoint`             | `graph.microsoft.com`             |
| SignNow                | `signnow`                | `api.signnow.com`                 |
| Slack                  | `slack`                  | `slack.com`                       |
| Snapchat               | `snapchat`               | `adsapi.snapchat.com`             |
| Square                 | `squareup`               | `connect.squareup.com`            |
| Squarespace            | `squarespace`            | `api.squarespace.com`             |
| Sunsama MCP            | `sunsama`                | MCP server                        |
| Stripe                 | `stripe`                 | `api.stripe.com`                  |
| Systeme.io             | `systeme`                | `api.systeme.io`                  |
| Tally                  | `tally`                  | `api.tally.so`                    |
| Tavily                 | `tavily`                 | `api.tavily.com`                  |
| Telegram               | `telegram`               | `api.telegram.org`                |
| TickTick               | `ticktick`               | `api.ticktick.com`                |
| Todoist                | `todoist`                | `api.todoist.com`                 |
| Toggl Track            | `toggl-track`            | `api.track.toggl.com`             |
| Trello                 | `trello`                 | `api.trello.com`                  |
| Twilio                 | `twilio`                 | `api.twilio.com`                  |
| Typeform               | `typeform`               | `api.typeform.com`                |
| Unbounce               | `unbounce`               | `api.unbounce.com`                |
| Vimeo                  | `vimeo`                  | `api.vimeo.com`                   |
| WATI                   | `wati`                   | `{tenant}.wati.io`                |
| WhatsApp Business      | `whatsapp-business`      | `graph.facebook.com`              |
| WooCommerce            | `woocommerce`            | `{store-url}/wp-json/wc/v3`       |
| WordPress.com          | `wordpress`              | `public-api.wordpress.com`        |
| Wrike                  | `wrike`                  | `www.wrike.com`                   |
| Xero                   | `xero`                   | `api.xero.com`                    |
| YouTube                | `youtube`                | `www.googleapis.com`              |
| Zoho Bigin             | `zoho-bigin`             | `www.zohoapis.com`                |
| Zoho Bookings          | `zoho-bookings`          | `www.zohoapis.com`                |
| Zoho Books             | `zoho-books`             | `www.zohoapis.com`                |
| Zoho Calendar          | `zoho-calendar`          | `calendar.zoho.com`               |
| Zoho CRM               | `zoho-crm`               | `www.zohoapis.com`                |
| Zoho Inventory         | `zoho-inventory`         | `www.zohoapis.com`                |
| Zoho Mail              | `zoho-mail`              | `mail.zoho.com`                   |
| Zoho People            | `zoho-people`            | `people.zoho.com`                 |
| Zoho Projects          | `zoho-projects`          | `projectsapi.zoho.com`            |
| Zoho Recruit           | `zoho-recruit`           | `recruit.zoho.com`                |

See [references/](references/) for detailed routing guides per provider:

- [ActiveCampaign](references/active-campaign/README.md) - Contacts, deals, tags, lists, automations, campaigns
- [Acuity Scheduling](references/acuity-scheduling/README.md) - Appointments, calendars, clients, availability
- [Airtable](references/airtable/README.md) - Records, bases, tables
- [Apollo](references/apollo/README.md) - People search, enrichment, contacts
- [Asana](references/asana/README.md) - Tasks, projects, workspaces, webhooks
- [Attio](references/attio/README.md) - People, companies, records, tasks
- [Basecamp](references/basecamp/README.md) - Projects, to-dos, messages, schedules, documents
- [Baserow](references/baserow/README.md) - Database rows, fields, tables, batch operations
- [beehiiv](references/beehiiv/README.md) - Publications, subscriptions, posts, custom fields
- [Box](references/box/README.md) - Files, folders, collaborations, shared links
- [Brevo](references/brevo/README.md) - Contacts, email campaigns, transactional emails, templates
- [Brave Search](references/brave-search/README.md) - Web search, image search, news search, video search
- [Buffer](references/buffer/README.md) - Social media posts, channels, organizations, scheduling
- [Calendly](references/calendly/README.md) - Event types, scheduled events, availability, webhooks
- [Cal.com](references/cal-com/README.md) - Event types, bookings, schedules, availability slots, webhooks
- [CallRail](references/callrail/README.md) - Calls, trackers, companies, tags, analytics
- [Chargebee](references/chargebee/README.md) - Subscriptions, customers, invoices
- [ClickFunnels](references/clickfunnels/README.md) - Contacts, products, orders, courses, webhooks
- [ClickSend](references/clicksend/README.md) - SMS, MMS, voice messages, contacts, lists
- [ClickUp](references/clickup/README.md) - Tasks, lists, folders, spaces, webhooks
- [Clockify](references/clockify/README.md) - Time tracking, projects, clients, tasks, workspaces
- [Coda](references/coda/README.md) - Docs, pages, tables, rows, formulas, controls
- [Confluence](references/confluence/README.md) - Pages, spaces, blogposts, comments, attachments
- [CompanyCam](references/companycam/README.md) - Projects, photos, users, tags, groups, documents
- [Cognito Forms](references/cognito-forms/README.md) - Forms, entries, documents, files
- [Constant Contact](references/constant-contact/README.md) - Contacts, email campaigns, lists, segments
- [Dropbox](references/dropbox/README.md) - Files, folders, search, metadata, revisions, tags
- [Dropbox Business](references/dropbox-business/README.md) - Team members, groups, team folders, devices, audit logs
- [ElevenLabs](references/elevenlabs/README.md) - Text-to-speech, voice cloning, sound effects, audio processing
- [Eventbrite](references/eventbrite/README.md) - Events, venues, tickets, orders, attendees
- [Exa](references/exa/README.md) - Neural web search, content extraction, similar pages, AI answers, research tasks
- [fal.ai](references/fal-ai/README.md) - AI model inference (image generation, video, audio, upscaling)
- [Fathom](references/fathom/README.md) - Meeting recordings, transcripts, summaries, webhooks
- [Firecrawl](references/firecrawl/README.md) - Web scraping, crawling, site mapping, web search
- [Firebase](references/firebase/README.md) - Projects, web apps, Android apps, iOS apps, configurations
- [Fireflies](references/fireflies/README.md) - Meeting transcripts, summaries, AskFred AI, channels
- [GetResponse](references/getresponse/README.md) - Campaigns, contacts, newsletters, autoresponders, tags, segments
- [Grafana](references/grafana/README.md) - Dashboards, data sources, folders, annotations, alerts, teams
- [GitHub](references/github/README.md) - Repositories, issues, pull requests, commits
- [Gumroad](references/gumroad/README.md) - Products, sales, subscribers, licenses, webhooks
- [Granola MCP](references/granola-mcp/README.md) - MCP-based interface for meeting notes, transcripts, queries
- [Google Ads](references/google-ads/README.md) - Campaigns, ad groups, GAQL queries
- [Google Analytics Admin](references/google-analytics-admin/README.md) - Reports, dimensions, metrics
- [Google Analytics Data](references/google-analytics-data/README.md) - Reports, dimensions, metrics
- [Google BigQuery](references/google-bigquery/README.md) - Datasets, tables, jobs, SQL queries
- [Google Calendar](references/google-calendar/README.md) - Events, calendars, free/busy
- [Google Classroom](references/google-classroom/README.md) - Courses, coursework, students, teachers, announcements
- [Google Contacts](references/google-contacts/README.md) - Contacts, contact groups, people search
- [Google Docs](references/google-docs/README.md) - Document creation, batch updates
- [Google Drive](references/google-drive/README.md) - Files, folders, permissions
- [Google Forms](references/google-forms/README.md) - Forms, questions, responses
- [Gmail](references/google-mail/README.md) - Messages, threads, labels
- [Google Meet](references/google-meet/README.md) - Spaces, conference records, participants
- [Google Merchant](references/google-merchant/README.md) - Products, inventories, promotions, reports
- [Google Play](references/google-play/README.md) - In-app products, subscriptions, reviews
- [Google Search Console](references/google-search-console/README.md) - Search analytics, sitemaps
- [Google Sheets](references/google-sheets/README.md) - Values, ranges, formatting
- [Google Slides](references/google-slides/README.md) - Presentations, slides, formatting
- [Google Tasks](references/google-tasks/README.md) - Task lists, tasks, subtasks
- [Google Workspace Admin](references/google-workspace-admin/README.md) - Users, groups, org units, domains, roles
- [HubSpot](references/hubspot/README.md) - Contacts, companies, deals
- [Instantly](references/instantly/README.md) - Campaigns, leads, accounts, email outreach
- [Jira](references/jira/README.md) - Issues, projects, JQL queries
- [Jobber](references/jobber/README.md) - Clients, jobs, invoices, quotes (GraphQL)
- [JotForm](references/jotform/README.md) - Forms, submissions, webhooks
- [Kaggle](references/kaggle/README.md) - Datasets, models, competitions, kernels
- [Keap](references/keap/README.md) - Contacts, companies, tags, tasks, opportunities, campaigns
- [Kibana](references/kibana/README.md) - Saved objects, dashboards, data views, spaces, alerts, fleet
- [Kit](references/kit/README.md) - Subscribers, tags, forms, sequences, broadcasts
- [Klaviyo](references/klaviyo/README.md) - Profiles, lists, campaigns, flows, events
- [Lemlist](references/lemlist/README.md) - Campaigns, leads, activities, schedules, unsubscribes
- [Linear](references/linear/README.md) - Issues, projects, teams, cycles (GraphQL)
- [LinkedIn](references/linkedin/README.md) - Profile, posts, shares, media uploads
- [Mailchimp](references/mailchimp/README.md) - Audiences, campaigns, templates, automations
- [MailerLite](references/mailerlite/README.md) - Subscribers, groups, campaigns, automations, forms
- [Mailgun](references/mailgun/README.md) - Email sending, domains, routes, templates, mailing lists, suppressions
- [ManyChat](references/manychat/README.md) - Subscribers, tags, flows, messaging
- [Manus](references/manus/README.md) - AI agent tasks, projects, files, webhooks
- [Microsoft Excel](references/microsoft-excel/README.md) - Workbooks, worksheets, ranges, tables, charts
- [Microsoft Teams](references/microsoft-teams/README.md) - Teams, channels, messages, members, chats
- [Microsoft To Do](references/microsoft-to-do/README.md) - Task lists, tasks, checklist items, linked resources
- [Monday.com](references/monday/README.md) - Boards, items, columns, groups (GraphQL)
- [Motion](references/motion/README.md) - Tasks, projects, workspaces, schedules
- [Netlify](references/netlify/README.md) - Sites, deploys, builds, DNS, environment variables
- [Notion](references/notion/README.md) - Pages, databases, blocks
- [Notion MCP](references/notion-mcp/README.md) - MCP-based interface for pages, databases, comments, teams, users
- [OneNote](references/one-note/README.md) - Notebooks, sections, section groups, pages via Microsoft Graph
- [OneDrive](references/one-drive/README.md) - Files, folders, drives, sharing
- [Outlook](references/outlook/README.md) - Mail, calendar, contacts
- [PDF.co](references/pdf-co/README.md) - PDF conversion, merge, split, edit, text extraction, barcodes
- [Pipedrive](references/pipedrive/README.md) - Deals, persons, organizations, activities
- [Podio](references/podio/README.md) - Organizations, workspaces, apps, items, tasks, comments
- [PostHog](references/posthog/README.md) - Product analytics, feature flags, session recordings, experiments, HogQL queries
- [QuickBooks](references/quickbooks/README.md) - Customers, invoices, reports
- [Quo](references/quo/README.md) - Calls, messages, contacts, conversations, webhooks
- [Reducto](references/reducto/README.md) - Document parsing, extraction, splitting, editing
- [Resend](references/resend/README.md) - Transactional emails, domains, audiences, contacts, broadcasts, webhooks
- [Salesforce](references/salesforce/README.md) - SOQL, sObjects, CRUD
- [SignNow](references/signnow/README.md) - Documents, templates, invites, e-signatures
- [SendGrid](references/sendgrid/README.md) - Email sending, contacts, templates, suppressions, statistics
- [Sentry](references/sentry/README.md) - Issues, events, projects, teams, releases
- [SharePoint](references/sharepoint/README.md) - Sites, lists, document libraries, files, folders, versions
- [Slack](references/slack/README.md) - Messages, channels, users
- [Snapchat](references/snapchat/README.md) - Ad accounts, campaigns, ad squads, ads, creatives, audiences
- [Square](references/squareup/README.md) - Payments, customers, orders, catalog, inventory, invoices
- [Squarespace](references/squarespace/README.md) - Products, inventory, orders, profiles, transactions
- [Sunsama MCP](references/sunsama-mcp/README.md) - MCP-based interface for tasks, calendar, backlog, objectives, time tracking
- [Stripe](references/stripe/README.md) - Customers, subscriptions, payments
- [Systeme.io](references/systeme/README.md) - Contacts, tags, courses, communities, webhooks
- [Tally](references/tally/README.md) - Forms, submissions, workspaces, webhooks
- [Tavily](references/tavily/README.md) - AI web search, content extraction, crawling, research tasks
- [Telegram](references/telegram/README.md) - Messages, chats, bots, updates, polls
- [TickTick](references/ticktick/README.md) - Tasks, projects, task lists
- [Todoist](references/todoist/README.md) - Tasks, projects, sections, labels, comments
- [Toggl Track](references/toggl-track/README.md) - Time entries, projects, clients, tags, workspaces
- [Trello](references/trello/README.md) - Boards, lists, cards, checklists
- [Twilio](references/twilio/README.md) - SMS, voice calls, phone numbers, messaging
- [Typeform](references/typeform/README.md) - Forms, responses, insights
- [Unbounce](references/unbounce/README.md) - Landing pages, leads, accounts, sub-accounts, domains
- [Vimeo](references/vimeo/README.md) - Videos, folders, albums, comments, likes
- [WATI](references/wati/README.md) - WhatsApp messages, contacts, templates, interactive messages
- [WhatsApp Business](references/whatsapp-business/README.md) - Messages, templates, media
- [WooCommerce](references/woocommerce/README.md) - Products, orders, customers, coupons
- [WordPress.com](references/wordpress/README.md) - Posts, pages, sites, users, settings
- [Wrike](references/wrike/README.md) - Tasks, folders, projects, spaces, comments, timelogs, workflows
- [Xero](references/xero/README.md) - Contacts, invoices, reports
- [YouTube](references/youtube/README.md) - Videos, playlists, channels, subscriptions
- [Zoho Bigin](references/zoho-bigin/README.md) - Contacts, companies, pipelines, products
- [Zoho Bookings](references/zoho-bookings/README.md) - Appointments, services, staff, workspaces
- [Zoho Books](references/zoho-books/README.md) - Invoices, contacts, bills, expenses
- [Zoho Calendar](references/zoho-calendar/README.md) - Calendars, events, attendees, reminders
- [Zoho CRM](references/zoho-crm/README.md) - Leads, contacts, accounts, deals, search
- [Zoho Inventory](references/zoho-inventory/README.md) - Items, sales orders, invoices, purchase orders, bills
- [Zoho Mail](references/zoho-mail/README.md) - Messages, folders, labels, attachments
- [Zoho People](references/zoho-people/README.md) - Employees, departments, designations, attendance, leave
- [Zoho Projects](references/zoho-projects/README.md) - Projects, tasks, milestones, tasklists, comments
- [Zoho Recruit](references/zoho-recruit/README.md) - Candidates, job openings, interviews, applications

## Examples

### Slack - Post Message (Native API)

```bash
# Native Slack API: POST https://slack.com/api/chat.postMessage
python <<'EOF'
import urllib.request, os, json
data = json.dumps({'channel': 'C0123456', 'text': 'Hello!'}).encode()
req = urllib.request.Request('https://gateway.maton.ai/slack/api/chat.postMessage', data=data, method='POST')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
req.add_header('Content-Type', 'application/json; charset=utf-8')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

### HubSpot - Create Contact (Native API)

```bash
# Native HubSpot API: POST https://api.hubapi.com/crm/v3/objects/contacts
python <<'EOF'
import urllib.request, os, json
data = json.dumps({'properties': {'email': 'john@example.com', 'firstname': 'John', 'lastname': 'Doe'}}).encode()
req = urllib.request.Request('https://gateway.maton.ai/hubspot/crm/v3/objects/contacts', data=data, method='POST')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
req.add_header('Content-Type', 'application/json')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

### Google Sheets - Get Spreadsheet Values (Native API)

```bash
# Native Sheets API: GET https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://gateway.maton.ai/google-sheets/v4/spreadsheets/122BS1sFN2RKL8AOUQjkLdubzOwgqzPT64KfZ2rvYI4M/values/Sheet1!A1:B2')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

### Salesforce - SOQL Query (Native API)

```bash
# Native Salesforce API: GET https://{instance}.salesforce.com/services/data/v64.0/query?q=...
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://gateway.maton.ai/salesforce/services/data/v64.0/query?q=SELECT+Id,Name+FROM+Contact+LIMIT+10')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

### Airtable - List Tables (Native API)

```bash
# Native Airtable API: GET https://api.airtable.com/v0/meta/bases/{id}/tables
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://gateway.maton.ai/airtable/v0/meta/bases/appgqan2NzWGP5sBK/tables')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

### Notion - Query Database (Native API)

```bash
# Native Notion API: POST https://api.notion.com/v1/data_sources/{id}/query
python <<'EOF'
import urllib.request, os, json
data = json.dumps({}).encode()
req = urllib.request.Request('https://gateway.maton.ai/notion/v1/data_sources/23702dc5-9a3b-8001-9e1c-000b5af0a980/query', data=data, method='POST')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
req.add_header('Content-Type', 'application/json')
req.add_header('Notion-Version', '2025-09-03')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

### Stripe - List Customers (Native API)

```bash
# Native Stripe API: GET https://api.stripe.com/v1/customers
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://gateway.maton.ai/stripe/v1/customers?limit=10')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

## Code Examples

### JavaScript (Node.js)

```javascript
const response = await fetch("https://gateway.maton.ai/slack/api/chat.postMessage", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.MATON_API_KEY}`,
  },
  body: JSON.stringify({ channel: "C0123456", text: "Hello!" }),
});
```

### Python

```python
import os
import requests

response = requests.post(
    'https://gateway.maton.ai/slack/api/chat.postMessage',
    headers={'Authorization': f'Bearer {os.environ["MATON_API_KEY"]}'},
    json={'channel': 'C0123456', 'text': 'Hello!'}
)
```

## Error Handling

| Status  | Meaning                                       |
| ------- | --------------------------------------------- |
| 400     | Missing connection for the requested app      |
| 401     | Invalid or missing Maton API key              |
| 429     | Rate limited (10 requests/second per account) |
| 500     | Internal Server Error                         |
| 4xx/5xx | Passthrough error from the target API         |

Errors from the target API are passed through with their original status codes and response bodies.

### Troubleshooting: API Key Issues

1. Check that the `MATON_API_KEY` environment variable is set:

```bash
echo $MATON_API_KEY
```

2. Verify the API key is valid by listing connections:

```bash
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://ctrl.maton.ai/connections')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

### Troubleshooting: Invalid App Name

1. Verify your URL path starts with the correct app name. The path must begin with `/google-mail/`. For example:

- Correct: `https://gateway.maton.ai/google-mail/gmail/v1/users/me/messages`
- Incorrect: `https://gateway.maton.ai/gmail/v1/users/me/messages`

2. Ensure you have an active connection for the app. List your connections to verify:

```bash
python <<'EOF'
import urllib.request, os, json
req = urllib.request.Request('https://ctrl.maton.ai/connections?app=google-mail&status=ACTIVE')
req.add_header('Authorization', f'Bearer {os.environ["MATON_API_KEY"]}')
print(json.dumps(json.load(urllib.request.urlopen(req)), indent=2))
EOF
```

### Troubleshooting: Server Error

A 500 error may indicate an expired OAuth token. Try creating a new connection via the Connection Management section above and completing OAuth authorization. If the new connection is "ACTIVE", delete the old connection to ensure the gateway uses the new one.

## Rate Limits

- 10 requests per second per account
- Target API rate limits also apply

## Notes

- When using curl with URLs containing brackets (`fields[]`, `sort[]`, `records[]`), use the `-g` flag to disable glob parsing
- When piping curl output to `jq`, environment variables may not expand correctly in some shells, which can cause "Invalid API key" errors

## Tips

1. **Use native API docs**: Refer to each service's official API documentation for endpoint paths and parameters.

2. **Headers are forwarded**: Custom headers (except `Host` and `Authorization`) are forwarded to the target API.

3. **Query params work**: URL query parameters are passed through to the target API.

4. **All HTTP methods supported**: GET, POST, PUT, PATCH, DELETE are all supported.

5. **QuickBooks special case**: Use `:realmId` in the path and it will be replaced with the connected realm ID.

## Optional

- [Github](https://github.com/maton-ai/api-gateway-skill)
- [API Reference](https://www.maton.ai/docs/api-reference)
- [Maton Community](https://discord.com/invite/dBfFAcefs2)
- [Maton Support](mailto:support@maton.ai)
