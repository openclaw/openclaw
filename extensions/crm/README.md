# CRM OpenClaw plugin

Tools for a self-hosted [trycompai/crm](https://github.com/trycompai/crm) instance.

This plugin does not bundle or start the CRM. Run the CRM API, create an API key
under **Settings → API keys**, and point the plugin at that API.

## Install

```bash
openclaw plugins install @openclaw/crm-plugin
openclaw gateway restart
```

## Configure

Set the API origin and key in the OpenClaw config:

```json5
{
  plugins: {
    entries: {
      crm: {
        enabled: true,
        config: {
          baseUrl: "http://localhost:3001",
          apiKey: "crm_...",
        },
      },
    },
  },
}
```

Or leave `apiKey` unset and provide `CRM_API_KEY` in the Gateway environment.
`CRM_BASE_URL` and `CRM_TIMEOUT_SECONDS` are the environment fallbacks for the
other two fields.

The key is sent as the `x-api-key` header to the CRM REST bridge under `/rest`.
It carries the permissions of the CRM user who created it, so store it like any
other credential.

## Tools

| Tool                    | Purpose                                                   |
| ----------------------- | --------------------------------------------------------- |
| `crm_search`            | Quick search across contacts, companies, and deals.       |
| `crm_list_records`      | Filtered, paginated record lists with facet counts.       |
| `crm_get_record`        | Full detail for one contact, company, or deal.            |
| `crm_create_record`     | Create a contact, company, or deal.                       |
| `crm_update_record`     | Update fields; deal stage changes use the stage endpoint. |
| `crm_log_activity`      | Log a note, call, email, meeting, or task.                |
| `crm_timeline`          | Activity timeline for one record.                         |
| `crm_my_tasks`          | Open tasks assigned to the API key's user.                |
| `crm_complete_activity` | Complete or reopen a task or activity.                    |

## CRM API notes

The plugin uses the CRM's generated REST bridge, so the running CRM version must
expose `/rest` (`apps/api` in the CRM repository). The API key must be created by
a signed-in user; the CRM does not mint keys from the CLI.
