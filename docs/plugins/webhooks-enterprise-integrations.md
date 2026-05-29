---
summary: "Configure common enterprise applications to send webhooks into OpenClaw"
read_when:
  - You want examples for connecting GitHub, Jira, PagerDuty, Stripe, or other enterprise applications to OpenClaw
  - You need a webhook configuration pattern for a SaaS or internal system
  - You want to validate OpenClaw Webhooks plugin routes against common application payloads
title: "Enterprise webhook integrations"
---

Use these examples to connect common enterprise applications to the bundled
Webhooks plugin. Each application sends HTTPS JSON to a Gateway route, OpenClaw
authenticates the request, filters the event type, deduplicates retries, renders
a prompt, and schedules an agent turn.

The examples use `dispatch.mode: "agent"` because that is the most common
enterprise workflow. Start with `deliveryMode: "none"` while testing so the
event is queued silently, then switch to `announce` when the target session
should see scheduled work.

## Before you begin

You need:

- A running Gateway with `plugins.entries.webhooks.enabled: true`.
- A public HTTPS URL for the route, usually from a reverse proxy, Tailscale
  Funnel, Cloudflare Tunnel, ngrok, or an API gateway.
- One route secret per application.
- A stable delivery id from the source application, or an integration gateway
  that adds one.

Store secrets in environment variables or another SecretRef source instead of
plaintext config:

```json5
{
  auth: {
    mode: "bearer",
    secret: { source: "env", provider: "default", id: "JIRA_WEBHOOK_TOKEN" },
  },
}
```

For GitHub-style HMAC, OpenClaw can verify the source signature directly. For
providers with vendor-specific signing formats, such as Stripe or Shopify,
verify the vendor signature in your API gateway or worker first, then forward a
normalized bearer/header-authenticated JSON request to OpenClaw.

## Common route shape

Use this shape for most applications:

```json5
{
  plugins: {
    entries: {
      webhooks: {
        enabled: true,
        config: {
          routes: {
            app_route_id: {
              path: "/plugins/webhooks/app-route-id",
              sessionKey: "agent:main:main",
              auth: {
                mode: "bearer",
                secret: {
                  source: "env",
                  provider: "default",
                  id: "APP_WEBHOOK_TOKEN",
                },
              },
              dispatch: {
                mode: "agent",
                agent: {
                  deliveryMode: "none",
                  delayMs: 1,
                  nameTemplate: "app-{eventType}",
                  tagTemplate: "app-{idempotencyKey}",
                },
              },
              event: { payloadPath: "type" },
              events: ["example.event"],
              idempotency: { payloadPath: "id", ttlHours: 24 },
              prompt: "Handle {type}: {__raw__}",
              skills: ["enterprise-webhook-triage"],
            },
          },
        },
      },
    },
  },
}
```

## Application examples

### GitHub pull requests and reviews

Use GitHub when you want OpenClaw to review PR activity, label risk, or start a
code-review workflow.

OpenClaw route:

```json5
github_pr_review: {
  path: "/plugins/webhooks/github-pr-review",
  sessionKey: "agent:main:main",
  auth: {
    mode: "hmac-sha256",
    header: "x-hub-signature-256",
    prefix: "sha256=",
    secret: { source: "env", provider: "default", id: "GITHUB_WEBHOOK_SECRET" },
  },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: { header: "x-github-event" },
  events: ["pull_request", "pull_request_review"],
  idempotency: { header: "x-github-delivery", ttlHours: 24 },
  prompt: "Review GitHub {headers.x-github-event} for {repository.full_name} PR #{pull_request.number}: {pull_request.title}\nAction: {action}\nURL: {pull_request.html_url}\n\nPayload:\n{__raw__}",
  skills: ["code-review"],
}
```

GitHub setup:

1. Open repository settings, then Webhooks.
2. Set Payload URL to
   `https://<gateway-host>/plugins/webhooks/github-pr-review`.
3. Set Content type to `application/json`.
4. Set Secret to `GITHUB_WEBHOOK_SECRET`.
5. Select `Pull requests` and `Pull request reviews`.

Verify by opening a PR and submitting a review. GitHub deliveries should return
`202`.

### GitLab merge requests

Use GitLab merge request hooks for review or release automation.

```json5
gitlab_merge_request: {
  path: "/plugins/webhooks/gitlab-merge-request",
  sessionKey: "agent:main:main",
  auth: {
    mode: "header",
    header: "x-gitlab-token",
    secret: { source: "env", provider: "default", id: "GITLAB_WEBHOOK_TOKEN" },
  },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: { header: "x-gitlab-event" },
  events: ["Merge Request Hook"],
  idempotency: { header: "x-gitlab-event-uuid", ttlHours: 24 },
  prompt: "Review GitLab MR !{object_attributes.iid}: {object_attributes.title}\nURL: {object_attributes.url}\n\nPayload:\n{__raw__}",
  skills: ["code-review"],
}
```

GitLab setup: Project Settings -> Webhooks, set the URL, Secret token, and
enable Merge request events.

### Meego or Meegle requirements

Use Meego or Meegle work item events when a new requirement should trigger
triage, risk analysis, owner suggestions, or a follow-up TaskFlow.

Meego provider setup is environment-specific. First configure the Meego project
webhook or event subscription UI to send the real work-item-created event to the
OpenClaw route. Then capture one real delivery in `ack` or `deliver: "log"` mode
and copy the actual event header, payload event path, and delivery id path into
the route. Do not guess these fields from examples.

```json5
meego_requirement_created: {
  path: "/plugins/webhooks/meego-requirement-created",
  sessionKey: "agent:main:main",
  auth: {
    mode: "header",
    header: "x-meego-webhook-token",
    secret: { source: "env", provider: "default", id: "MEEGO_WEBHOOK_TOKEN" },
  },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: {
    // Replace this with the real header or payload path from the first delivery.
    payloadPath: "event.type",
  },
  verification: {
    // Optional. Use only if the Meego webhook setup sends a URL verification event.
    event: "url_verification",
    challengePath: "challenge",
    responsePath: "challenge",
  },
  events: ["requirement.created"],
  idempotency: {
    // Replace this with the real delivery id header or payload path.
    payloadPath: "event.id",
    ttlHours: 24,
  },
  prompt: "Analyze the new Meego requirement. Identify missing fields, risks, suggested owners, and next steps.\n\nPayload:\n{__raw__}",
  skills: ["requirement-triage"],
}
```

Operational notes:

- OpenClaw should receive Meego events as normal HTTP `POST` requests to the
  route. Do not build a Meego-to-OpenClaw WebSocket relay; OpenClaw's Gateway
  WebSocket is only the CLI/RPC control plane.
- The `@lark-project/meegle` CLI can create/query work items and add comments
  after authentication. It does not currently expose webhook, event,
  subscription, or callback management commands, so the real provider webhook
  must be configured from the Meego project/admin surface or another official
  project API.
- If the Meego setup flow sends a URL verification request, configure
  `verification` with the real event type and challenge/response payload paths.
  OpenClaw answers the challenge only after the route-specific auth check passes
  and does not dispatch an agent for verification requests.
- For end-to-end validation, create a real test requirement, record the provider
  delivery id, verify OpenClaw returns `202`, confirm the agent run id, and
  write back a Meego comment or send a channel notification. A CLI-created work
  item without a provider webhook delivery is not sufficient proof.
- Use the Meego-specific 20-scenario matrix in
  [Enterprise webhook validation and deployment](/plugins/webhooks-enterprise-validation#meego-real-e2e-scenario-matrix)
  before marking the integration as production-ready.

### Jira issues

Use Jira webhooks to triage issue changes and create follow-up TaskFlows.

```json5
jira_issue: {
  path: "/plugins/webhooks/jira-issue",
  sessionKey: "agent:main:main",
  auth: { mode: "bearer", secret: { source: "env", provider: "default", id: "JIRA_WEBHOOK_TOKEN" } },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: { payloadPath: "webhookEvent" },
  events: ["jira:issue_created", "jira:issue_updated"],
  idempotency: { payloadPath: "webhookEventId", ttlHours: 24 },
  prompt: "Triage Jira {issue.key}: {issue.fields.summary}\nStatus: {issue.fields.status.name}\n\nPayload:\n{__raw__}",
  skills: ["issue-triage"],
}
```

Jira setup: System -> Webhooks, set the URL, choose issue created/updated
events, and add an Authorization bearer token if your Jira edition supports
custom headers. Otherwise route through an API gateway that adds the bearer
header.

### PagerDuty incidents

Use PagerDuty webhooks to start incident triage without waiting for a chat
message.

```json5
pagerduty_incident: {
  path: "/plugins/webhooks/pagerduty-incident",
  sessionKey: "agent:main:main",
  auth: { mode: "bearer", secret: { source: "env", provider: "default", id: "PAGERDUTY_WEBHOOK_TOKEN" } },
  dispatch: { mode: "agent", agent: { deliveryMode: "announce", delayMs: 1 } },
  event: { payloadPath: "event.event_type" },
  events: ["incident.triggered", "incident.acknowledged", "incident.resolved"],
  idempotency: { payloadPath: "event.id", ttlHours: 24 },
  prompt: "Handle PagerDuty {event.data.id}: {event.data.title}\nUrgency: {event.data.urgency}\n\nPayload:\n{__raw__}",
  skills: ["incident-response"],
}
```

PagerDuty setup: Service -> Integrations -> Webhooks, set the OpenClaw route as
the endpoint. Use an integration gateway if you need to add custom bearer auth.

### Sentry issues

Use Sentry to send new or regressed errors to an agent.

```json5
sentry_issue: {
  path: "/plugins/webhooks/sentry-issue",
  sessionKey: "agent:main:main",
  auth: {
    mode: "header",
    header: "x-openclaw-sentry-token",
    secret: { source: "env", provider: "default", id: "SENTRY_WEBHOOK_TOKEN" },
  },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: { header: "x-sentry-hook-resource" },
  events: ["issue", "error"],
  idempotency: { payloadPath: "id", ttlHours: 24 },
  prompt: "Investigate Sentry {project_slug}: {event.title}\nURL: {url}\n\nPayload:\n{__raw__}",
  skills: ["bug-triage"],
}
```

Sentry setup: Settings -> Developer Settings -> Webhooks, select issue/error
events. If Sentry cannot send your chosen auth header directly, add it at your
edge proxy.

### Datadog monitors

Use Datadog monitor notifications to trigger operational analysis.

```json5
datadog_monitor: {
  path: "/plugins/webhooks/datadog-monitor",
  sessionKey: "agent:main:main",
  auth: {
    mode: "header",
    header: "x-openclaw-datadog-token",
    secret: { source: "env", provider: "default", id: "DATADOG_WEBHOOK_TOKEN" },
  },
  dispatch: { mode: "agent", agent: { deliveryMode: "announce", delayMs: 1 } },
  event: { payloadPath: "alert_type" },
  events: ["query_alert", "service_check"],
  idempotency: { payloadPath: "id", ttlHours: 24 },
  prompt: "Analyze Datadog monitor {id}: {title}\nStatus: {alert_status}\n\nPayload:\n{__raw__}",
  skills: ["incident-response"],
}
```

Datadog setup: Integrations -> Webhooks, create a webhook endpoint and include
`x-openclaw-datadog-token` if your Datadog plan supports custom headers.

### Stripe billing events

Use Stripe events for billing follow-up, customer-success workflows, and revenue
risk analysis.

```json5
stripe_event: {
  path: "/plugins/webhooks/stripe-event",
  sessionKey: "agent:main:main",
  auth: {
    mode: "header",
    header: "x-openclaw-stripe-token",
    secret: { source: "env", provider: "default", id: "STRIPE_FORWARD_TOKEN" },
  },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: { payloadPath: "type" },
  events: ["invoice.payment_failed", "customer.subscription.deleted"],
  idempotency: { payloadPath: "id", ttlHours: 72 },
  prompt: "Follow up Stripe {type} for customer {data.object.customer}\n\nPayload:\n{__raw__}",
  skills: ["billing-ops"],
}
```

Stripe setup: Verify `Stripe-Signature` at your edge, then forward the JSON to
OpenClaw with `x-openclaw-stripe-token`. Do not send card data or full payment
method objects into the prompt.

### Shopify orders

Use Shopify order webhooks for fulfillment exceptions or fraud review.

```json5
shopify_order: {
  path: "/plugins/webhooks/shopify-order",
  sessionKey: "agent:main:main",
  auth: {
    mode: "header",
    header: "x-openclaw-shopify-token",
    secret: { source: "env", provider: "default", id: "SHOPIFY_FORWARD_TOKEN" },
  },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: { header: "x-shopify-topic" },
  events: ["orders/create", "orders/updated"],
  idempotency: { header: "x-shopify-webhook-id", ttlHours: 72 },
  prompt: "Review Shopify order {id} for {customer.email}\nTotal: {total_price}\n\nPayload:\n{__raw__}",
  skills: ["commerce-ops"],
}
```

Shopify setup: Verify Shopify HMAC at your edge and forward only the fields the
agent needs.

### HubSpot deals

Use HubSpot webhooks to watch deal stage changes or customer lifecycle events.

```json5
hubspot_deal: {
  path: "/plugins/webhooks/hubspot-deal",
  sessionKey: "agent:main:main",
  auth: { mode: "bearer", secret: { source: "env", provider: "default", id: "HUBSPOT_WEBHOOK_TOKEN" } },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: { payloadPath: "subscriptionType" },
  events: ["deal.propertyChange", "contact.propertyChange"],
  idempotency: { payloadPath: "eventId", ttlHours: 24 },
  prompt: "Update HubSpot object {objectId}: {propertyName}\nNew value: {propertyValue}\n\nPayload:\n{__raw__}",
  skills: ["sales-ops"],
}
```

HubSpot setup: Create an app webhook subscription, select object property
changes, and forward through a small verifier if you need custom auth headers.

### Salesforce change events

Use Salesforce Platform Events or Change Data Capture to trigger CRM workflows.

```json5
salesforce_change: {
  path: "/plugins/webhooks/salesforce-change",
  sessionKey: "agent:main:main",
  auth: { mode: "bearer", secret: { source: "env", provider: "default", id: "SALESFORCE_WEBHOOK_TOKEN" } },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: { payloadPath: "ChangeEventHeader.entityName" },
  events: ["CaseChangeEvent", "OpportunityChangeEvent"],
  idempotency: { payloadPath: "ChangeEventHeader.commitNumber", ttlHours: 24 },
  prompt: "Review Salesforce {ChangeEventHeader.entityName} {CaseNumber}: {Subject}\n\nPayload:\n{__raw__}",
  skills: ["sales-ops"],
}
```

Salesforce setup: Use an event relay, MuleSoft, or another HTTP bridge to send
change events to the OpenClaw route with bearer auth.

### ServiceNow incidents

Use ServiceNow business rules or outbound REST messages to notify OpenClaw.

```json5
servicenow_incident: {
  path: "/plugins/webhooks/servicenow-incident",
  sessionKey: "agent:main:main",
  auth: { mode: "bearer", secret: { source: "env", provider: "default", id: "SERVICENOW_WEBHOOK_TOKEN" } },
  dispatch: { mode: "agent", agent: { deliveryMode: "announce", delayMs: 1 } },
  event: { payloadPath: "event.name" },
  events: ["incident.created", "incident.updated"],
  idempotency: { payloadPath: "sys_id", ttlHours: 24 },
  prompt: "Act on ServiceNow {number}: {short_description}\nPriority: {priority}\n\nPayload:\n{__raw__}",
  skills: ["incident-response"],
}
```

ServiceNow setup: Create an outbound REST message or flow action that posts the
selected record fields to the route.

### Zendesk tickets

Use Zendesk triggers to summarize escalations or route support follow-up.

```json5
zendesk_ticket: {
  path: "/plugins/webhooks/zendesk-ticket",
  sessionKey: "agent:main:main",
  auth: { mode: "bearer", secret: { source: "env", provider: "default", id: "ZENDESK_WEBHOOK_TOKEN" } },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: { payloadPath: "type" },
  events: ["ticket.created", "ticket.updated"],
  idempotency: { payloadPath: "id", ttlHours: 24 },
  prompt: "Summarize Zendesk ticket {ticket.id}: {ticket.subject}\nRequester: {ticket.requester.email}\n\nPayload:\n{__raw__}",
  skills: ["support-ops"],
}
```

Zendesk setup: Admin Center -> Apps and integrations -> Webhooks, then attach
the webhook to a trigger.

### Slack workflow builder

Use Slack workflows when human operators need a button or form to start an
OpenClaw workflow.

```json5
slack_workflow: {
  path: "/plugins/webhooks/slack-workflow",
  sessionKey: "agent:main:main",
  auth: { mode: "bearer", secret: { source: "env", provider: "default", id: "SLACK_WORKFLOW_TOKEN" } },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: { payloadPath: "type" },
  events: ["workflow_step", "form.submitted"],
  idempotency: { payloadPath: "event_id", ttlHours: 24 },
  prompt: "Process Slack workflow {workflow.name} from {user.id}\n\nPayload:\n{__raw__}",
  skills: ["workflow-ops"],
}
```

Slack setup: Configure Workflow Builder or a Slack app to call the route with an
Authorization bearer token.

### Microsoft Teams and Power Automate

Use Power Automate to connect Teams approvals and Microsoft 365 events.

```json5
teams_power_automate: {
  path: "/plugins/webhooks/teams-power-automate",
  sessionKey: "agent:main:main",
  auth: { mode: "bearer", secret: { source: "env", provider: "default", id: "TEAMS_FLOW_TOKEN" } },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: { payloadPath: "eventType" },
  events: ["approval.requested", "message.flagged"],
  idempotency: { payloadPath: "triggerId", ttlHours: 24 },
  prompt: "Handle Teams approval {approval.id}: {approval.title}\nRequester: {approval.requester}\n\nPayload:\n{__raw__}",
  skills: ["workflow-ops"],
}
```

Power Automate setup: Add an HTTP action that posts JSON to the route and sets
`Authorization: Bearer <TEAMS_FLOW_TOKEN>`.

### Notion page updates

Use Notion automation or middleware to send page changes to OpenClaw.

```json5
notion_page: {
  path: "/plugins/webhooks/notion-page",
  sessionKey: "agent:main:main",
  auth: { mode: "bearer", secret: { source: "env", provider: "default", id: "NOTION_WEBHOOK_TOKEN" } },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: { payloadPath: "type" },
  events: ["page.created", "page.updated"],
  idempotency: { payloadPath: "id", ttlHours: 24 },
  prompt: "Review Notion page {entity.id}: {entity.title}\n\nPayload:\n{__raw__}",
  skills: ["knowledge-ops"],
}
```

Notion setup: Use Notion automation or an integration service that can call an
HTTP endpoint with bearer auth.

### Airtable records

Use Airtable automation scripts or webhooks for database row changes.

```json5
airtable_record: {
  path: "/plugins/webhooks/airtable-record",
  sessionKey: "agent:main:main",
  auth: { mode: "bearer", secret: { source: "env", provider: "default", id: "AIRTABLE_WEBHOOK_TOKEN" } },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: { payloadPath: "action" },
  events: ["record.created", "record.updated"],
  idempotency: { payloadPath: "webhook.id", ttlHours: 24 },
  prompt: "Inspect Airtable {base.id}/{table.id}: {record.id}\n\nPayload:\n{__raw__}",
  skills: ["ops-analysis"],
}
```

Airtable setup: Create an automation that posts the base, table, record id, and
changed fields to the route.

### Google Forms

Use Google Apps Script to send form submissions into OpenClaw.

```json5
google_forms: {
  path: "/plugins/webhooks/google-forms",
  sessionKey: "agent:main:main",
  auth: { mode: "bearer", secret: { source: "env", provider: "default", id: "GOOGLE_FORMS_WEBHOOK_TOKEN" } },
  dispatch: { mode: "agent", agent: { deliveryMode: "none", delayMs: 1 } },
  event: { payloadPath: "eventType" },
  events: ["form.submit"],
  idempotency: { payloadPath: "responseId", ttlHours: 24 },
  prompt: "Process Google Forms {formId}: {answers.summary}\n\nPayload:\n{__raw__}",
  skills: ["workflow-ops"],
}
```

Google setup: Add an Apps Script `onFormSubmit` trigger that posts JSON to the
route with a bearer token.

### Jenkins builds

Use Jenkins to notify OpenClaw about failed builds or deployment gates.

```json5
jenkins_build: {
  path: "/plugins/webhooks/jenkins-build",
  sessionKey: "agent:main:main",
  auth: {
    mode: "header",
    header: "x-jenkins-token",
    secret: { source: "env", provider: "default", id: "JENKINS_WEBHOOK_TOKEN" },
  },
  dispatch: { mode: "agent", agent: { deliveryMode: "announce", delayMs: 1 } },
  event: { payloadPath: "event" },
  events: ["build.completed", "build.failed"],
  idempotency: { payloadPath: "build.id", ttlHours: 24 },
  prompt: "Investigate Jenkins {job.name} build {build.number}: {build.status}\nURL: {build.url}\n\nPayload:\n{__raw__}",
  skills: ["ci-triage"],
}
```

Jenkins setup: Use the HTTP Request plugin or a post-build action to post the
build payload with `x-jenkins-token`.

### Argo CD applications

Use Argo CD notifications to trigger deployment repair workflows.

```json5
argocd_app: {
  path: "/plugins/webhooks/argocd-app",
  sessionKey: "agent:main:main",
  auth: { mode: "bearer", secret: { source: "env", provider: "default", id: "ARGOCD_WEBHOOK_TOKEN" } },
  dispatch: { mode: "agent", agent: { deliveryMode: "announce", delayMs: 1 } },
  event: { payloadPath: "event" },
  events: ["app.sync.failed", "app.health.degraded"],
  idempotency: { payloadPath: "app.metadata.uid", ttlHours: 24 },
  prompt: "Repair Argo CD {app.metadata.name}: {app.status.sync.status}\nHealth: {app.status.health.status}\n\nPayload:\n{__raw__}",
  skills: ["deploy-ops"],
}
```

Argo CD setup: Configure Notifications with a webhook service that calls the
OpenClaw route.

### Prometheus Alertmanager

Use Alertmanager for infrastructure alert correlation.

```json5
alertmanager: {
  path: "/plugins/webhooks/alertmanager",
  sessionKey: "agent:main:main",
  auth: { mode: "bearer", secret: { source: "env", provider: "default", id: "ALERTMANAGER_WEBHOOK_TOKEN" } },
  dispatch: { mode: "agent", agent: { deliveryMode: "announce", delayMs: 1 } },
  event: { payloadPath: "status" },
  events: ["firing", "resolved"],
  idempotency: { payloadPath: "groupKey", ttlHours: 24 },
  prompt: "Correlate Alertmanager {commonLabels.alertname}: {status}\n\nPayload:\n{__raw__}",
  skills: ["incident-response"],
}
```

Alertmanager setup: Add a `webhook_configs` receiver for the route and set the
Authorization header at a reverse proxy if Alertmanager cannot send the exact
header you need.

## Validation report

The Webhooks plugin test suite includes an enterprise integration catalog that
exercises all 20 application patterns above through the real request handler.
It verifies:

- Auth mode: bearer, custom header, and HMAC-SHA256.
- Event extraction from headers and JSON payload paths.
- Event allowlists.
- Idempotency key extraction from headers and JSON payload paths.
- Prompt rendering from representative application payloads.
- Agent dispatch with `deliveryMode: "none"` and route-specific scheduler names
  and tags.

The same suite also includes five negative and edge-angle checks. These are
expected safety behaviors, not unresolved failures:

- Invalid GitHub-style HMAC is rejected with `401` before agent dispatch.
- A Jira event outside the configured allowlist is acknowledged as skipped and
  does not schedule work.
- A replayed Shopify delivery id returns a duplicate acknowledgment and does not
  schedule a second agent turn.
- A Sentry payload with a missing template field keeps the unresolved
  placeholder visible and still includes the raw JSON payload for inspection.
- Two source-control routes sharing one path are isolated by route-specific auth
  and dispatch to the matching route only.

## Handling edge cases

Use the negative checks above as runbooks for production integrations.

### Fix signature failures

If a GitHub-style HMAC request returns `401`, OpenClaw intentionally refuses to
dispatch the event. Check:

- The source webhook secret and the OpenClaw `auth.secret` refer to the same
  value.
- The source sends the exact raw JSON body that was signed. Proxies must not
  reformat JSON before OpenClaw verifies the signature.
- The header and prefix match the source. GitHub uses
  `x-hub-signature-256: sha256=<hex>`.
- If the source uses a vendor-specific signing format, verify it at your edge
  and forward to OpenClaw with bearer or header auth.

Do not weaken the route to accept unsigned traffic. Rotate the route secret if
the secret may have been copied into logs or chat.

### Handle skipped events

If a Jira or similar event is acknowledged as `skipped`, the route matched but
the event type was not in `events`. This prevents high-volume sources from
triggering agents for unrelated changes.

Fix by either adding the event type intentionally:

```json5
events: ["jira:issue_created", "jira:issue_updated", "jira:issue_deleted"]
```

or by keeping the event excluded and treating the `skipped` response as a normal
acknowledgment in the source system.

### Handle duplicate deliveries

If a Shopify or similar retry returns `duplicate: true`, OpenClaw has already
processed that delivery id. This is the desired behavior for sources that retry
on network timeouts.

Use the source delivery id for idempotency:

```json5
idempotency: { header: "x-shopify-webhook-id", ttlHours: 72 }
```

If a source does not provide a stable id, add one at your integration gateway.
Avoid hashing the entire payload unless the source has no better identifier,
because harmless payload ordering changes can bypass deduplication.

### Fix missing template fields

If a prompt contains an unresolved placeholder such as `{event.title}`, the
payload did not contain that path. OpenClaw leaves single-brace placeholders
visible so operators can see which source field is missing.

Fix by updating either the source mapping or the prompt:

```json5
prompt: "Investigate Sentry {project_slug}: {issue.title}\nRaw:\n{__raw__}"
```

Keep `{__raw__}` during rollout so the first real deliveries show the actual
payload shape. Remove or shorten raw payload inclusion after the route is
stable if the source includes sensitive data.

### Separate routes that share a path

OpenClaw can host multiple route targets on the same path, but production
configs are easier to audit when each application has its own path. Prefer:

```json5
path: "/plugins/webhooks/github-pr-review"
path: "/plugins/webhooks/gitlab-merge-request"
```

If you intentionally share a path, use route-specific auth headers or secrets so
OpenClaw can select the correct route without trusting event names alone.

Run the validation:

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.extension-misc.config.ts extensions/webhooks/src/http.test.ts
```

Additional live proof was run against GitHub with a real repository webhook,
public HTTPS tunnel, PR creation, and PR review submission. GitHub returned
`202` for both `pull_request/opened` and `pull_request_review/submitted`, and
the local Gateway wrote matching `plugin:webhooks` scheduled agent turns.

The remaining SaaS examples are OpenClaw-side ingress validations. To complete
vendor-console live proof for each application, create the route, configure the
source application as described above, trigger a real event, and confirm:

- The source delivery returns `200` or `202`.
- The Gateway log shows the route registered.
- `openclaw cron list --json` shows a `plugin:webhooks` job for agent dispatch,
  or the configured channel receives a delivery for `deliver` mode.
- Replaying the same delivery id returns a duplicate acknowledgment without a
  second side effect.

## Production checklist

- Use one route and one secret per application.
- Keep vendor signature verification at the edge when the provider uses a
  vendor-specific signature format.
- Do not send payment method, credential, or customer-private blobs unless the
  agent needs them.
- Configure `events` for every high-volume source.
- Configure `idempotency` before enabling retries in the source system.
- Start with `deliveryMode: "none"` or `deliver: "log"`, then enable visible
  delivery after prompt review.

## Related docs

- [Webhooks plugin](/plugins/webhooks)
- [Enterprise webhook validation and deployment](/plugins/webhooks-enterprise-validation)
- [Gateway configuration](/gateway/configuration-reference)
- [Plugin runtime SDK](/plugins/sdk-runtime)
