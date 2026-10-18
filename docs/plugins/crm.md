---
summary: "Agent tools for a self-hosted trycompai CRM instance"
read_when:
  - You are installing, configuring, or using the bundled CRM plugin
  - You want OpenClaw agents to read or update contacts, companies, and deals
  - You need to connect OpenClaw to a self-hosted trycompai/crm API
title: "CRM plugin"
---

The CRM plugin connects OpenClaw to a self-hosted
[trycompai/crm](https://github.com/trycompai/crm) instance. It does not bundle,
start, or provision the CRM; it calls the REST bridge exposed by a running CRM
API and authenticates with a CRM API key.

The plugin adds nine tools for searching records, reading and changing contacts,
companies, and deals, and working with activities and tasks.

## Before you begin

You need:

- A running CRM API reachable from the Gateway.
- A CRM build that exposes the generated REST bridge under `/rest`
  (`apps/api` in the CRM repository).
- An API key created by a signed-in CRM user under **Settings → API keys**. The
  CRM does not mint keys from its CLI.

The API key acts as the user who created it. Create a dedicated user or key when
you want to limit what the agent can read or change.

## Configure

The plugin is bundled and enabled through the normal plugin configuration:

```json5
{
  plugins: {
    entries: {
      crm: {
        enabled: true,
        config: {
          baseUrl: "http://localhost:3001",
          apiKey: "example-crm-api-key-not-real",
          timeoutSeconds: 30,
        },
      },
    },
  },
}
```

Use the CRM API origin for `baseUrl`; the plugin appends `/rest` itself. Trailing
slashes are ignored, and credentials embedded in the URL are rejected.

The API key can also come from the environment. Resolution order:

| Setting    | Plugin config    | Environment fallback  | Default                                 |
| ---------- | ---------------- | --------------------- | --------------------------------------- |
| API origin | `baseUrl`        | `CRM_BASE_URL`        | `http://localhost:3001`                 |
| API key    | `apiKey`         | `CRM_API_KEY`         | none; the tools fail until a key is set |
| Timeout    | `timeoutSeconds` | `CRM_TIMEOUT_SECONDS` | 30 seconds                              |

Timeouts are clamped to 1-300 seconds; non-positive or invalid values fall back
to the 30-second default. The `apiKey` field accepts a SecretRef, so the key can
stay in a secret manager or environment instead of the config file.

Restart the Gateway after changing plugin configuration.

## Tools

| Tool                    | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `crm_search`            | Search contacts, companies, and deals by name, email, domain, or deal title. |
| `crm_list_records`      | Filtered, paginated record lists with total and facet counts.                |
| `crm_get_record`        | Full detail for one contact, company, or deal.                               |
| `crm_create_record`     | Create a contact, company, or deal.                                          |
| `crm_update_record`     | Update selected fields; deal stage changes use the stage endpoint.           |
| `crm_log_activity`      | Log a note, call, email, meeting, or task against a record.                  |
| `crm_timeline`          | Read the activity timeline for one company, contact, or deal.                |
| `crm_my_tasks`          | List open tasks assigned to the API key's user.                              |
| `crm_complete_activity` | Complete or reopen a task or activity.                                       |

Record tools use `entity: "contact" | "company" | "deal"` plus a record `id`.
Write tools accept the CRM's own field names, so create and update payloads match
the CRM API rather than a separate OpenClaw schema.

### Notes and limits

- `crm_search` needs at least two characters and returns quick hits rather than
  the full result set; use `crm_list_records` for pagination and filters.
- Supported list filters differ by entity. For example, deals accept `status`,
  `owner`, `stage`, and `closing`; the tool rejects unknown filters before
  calling the API.
- Creating a deal requires `name`, `companyId`, and `ownerId`. Deal stage values
  are the CRM pipeline stages (`DEMO_BOOKED`, `QUALIFIED_TO_BUY`,
  `UNQUALIFIED_TO_BUY`, `DECISION_MAKER_BOUGHT_IN`, `CONTRACT_SENT`,
  `CLOSED_WON`, `CLOSED_LOST`).
- Changing a deal's stage and other fields in the same `crm_update_record` call
  uses two sequential CRM requests.
- `crm_timeline` requires exactly one of `companyId`, `contactId`, or `dealId`.
- Task activities require a `subject`; activities must be attached to a company,
  contact, or deal.
- Requests are not retried. A timeout or transport failure is reported to the
  agent with the configured origin so the next step is visible.

## Security

The plugin sends the API key as the `x-api-key` header to the configured origin.
Treat the key like any other credential: store it in the Gateway environment, a
SecretRef, or the plugin config, and never commit it.

The agent inherits the key's permissions. Use a dedicated CRM user or a
restricted key when the agent should not be able to change deals, read all
contacts, or act outside a specific team.

## Troubleshooting

- **401 or 403:** the key is missing, revoked, or lacks permission for that
  operation. Create a new key under **Settings → API keys** and update the
  plugin config or `CRM_API_KEY`.
- **Connection errors:** confirm the CRM API is running and that `baseUrl`
  points at the API process, not the CRM web app.
- **404 under `/rest`:** the CRM build is older than the REST bridge or the
  origin includes an extra path segment.

## Related

- [CRM plugin reference](/plugins/reference/crm) -- generated manifest, package,
  and tool surface.
- [Manage plugins](/plugins/manage-plugins) -- install, enable, and inspect
  plugins.
