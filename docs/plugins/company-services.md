---
summary: "Enable built-in plugins for official company MCP services"
read_when:
  - You want to connect a supported company service without copying an MCP URL
  - You need to choose between OAuth and a personal service token
  - A built-in company plugin is enabled but does not appear in MCP discovery
  - You need to distinguish a provider service from its OpenClaw adapter
title: "Company service plugins"
---

# Company service plugins

OpenClaw includes optional plugins that connect directly to official company MCP
services. Enable each plugin and connect your own account. These small adapters
are maintained by OpenClaw; the companies operate the remote services. They do
not include copied marketplace code, skills, hooks, or logos.

All plugins on this page are disabled by default. Provider permissions, account
plans, and usage charges still apply. A discoverable endpoint or successful OAuth
client registration does not prove that your account can use its tools.

## Connect a service

For an OAuth service such as Notion:

```sh
openclaw plugins enable notion
openclaw mcp login notion
openclaw mcp status --verbose
openclaw mcp probe notion
```

`login` prints the provider's authorization URL and waits for the browser callback. You do not need to provision a
separate OAuth application or supply a client secret. `status` inspects the local
configuration and authorization state; `probe` connects and lists capabilities.
Neither command proves that a particular provider tool can read your data.

Restart your Gateway after enabling or disabling a plugin. Once connected, the
plugin's tools use OpenClaw's existing MCP runtime and tool policies. They are
remote provider tools, and may include writes or operations that consume credits.
Start with a read-only action on data you are authorized to access.

For token services, supply the environment variable listed below to the OpenClaw
process using your secret manager, then enable the plugin and run `probe`. Do not
paste real tokens into shell history or checked-in files. A server with an unset
or empty required header variable is omitted with a diagnostic. Restart the
Gateway after changing its environment. Use least-privilege tokens where offered.

GoDaddy Domains and Excalidraw do not require account authentication: enable the
plugin and run `probe`.

## Regional accounts

The default Customer.io and Typeform URLs do not cover every account region.
Choose the endpoint for your account **before** logging in. The existing
`mcp.servers` override replaces the plugin default; no extra plugin is needed.

| Service / account region  | MCP URL                           |
| ------------------------- | --------------------------------- |
| Customer.io EU            | `https://mcp-eu.customer.io/mcp`  |
| Typeform EU data center 1 | `https://api.eu.typeform.com/mcp` |
| Typeform EU data center 2 | `https://api.typeform.eu/mcp`     |

For example, after enabling the relevant plugin:

```sh
openclaw mcp set customerio '{"url":"https://mcp-eu.customer.io/mcp","transport":"streamable-http","auth":"oauth"}'
openclaw mcp login customerio

openclaw mcp set typeform '{"url":"https://api.typeform.eu/mcp","transport":"streamable-http","auth":"oauth"}'
openclaw mcp login typeform
```

Use `api.eu.typeform.com` instead for Typeform EU data center 1. These two
Typeform regions are not interchangeable and may use different OAuth issuers.
If switching an existing connection, log out before changing the URL, then log
in again and restart the Gateway. Do not copy tokens between regions.
See [Customer.io setup](https://docs.customer.io/ai/mcp/get-started/) and
[Typeform regions](https://developer.typeform.com/developers/mcp/core-concepts/).

## Services and authentication

Each provider link explains its account requirements. OAuth means public client
registration with PKCE; key/token means the provider's user-issued credential,
not an OAuth application secret.

### OAuth

| Service                                                                                                       | Plugin ID     | Category            |
| ------------------------------------------------------------------------------------------------------------- | ------------- | ------------------- |
| [Amplemarket](https://knowledge.amplemarket.com/articles/8022685319-connecting-to-the-amplemarket-mcp-server) | `amplemarket` | sales-marketing     |
| [Attio](https://docs.attio.com/mcp/overview)                                                                  | `attio`       | sales-marketing     |
| [beehiiv](https://www.beehiiv.com/support/article/39255979546263-getting-started-with-the-beehiiv-mcp)        | `beehiiv`     | sales-marketing     |
| [Brex](https://www.brex.com/support/using-brex-in-ai-apps)                                                    | `brex`        | finance-payments    |
| [Calendly](https://developer.calendly.com/docs/mcp/calendly-mcp-server)                                       | `calendly`    | scheduling          |
| [Clay](https://university.clay.com/docs/connect-to-clay-mcp)                                                  | `clay`        | sales-marketing     |
| [Craft](https://www.craft.do/imagine/guide/mcp)                                                               | `craft`       | documents-files     |
| [Customer.io](https://docs.customer.io/ai/mcp/get-started/)                                                   | `customerio`  | sales-marketing     |
| [Fathom](https://developers.fathom.ai/mcp-docs)                                                               | `fathom`      | inbox-collaboration |
| [Intercom](https://developers.intercom.com/docs/guides/mcp)                                                   | `intercom`    | inbox-collaboration |
| [Jotform](https://www.jotform.com/mcp/)                                                                       | `jotform`     | productivity        |
| [Klaviyo](https://developers.klaviyo.com/en/docs/connect_to_the_klaviyo_mcp_server)                           | `klaviyo`     | sales-marketing     |
| [MailerLite](https://developers.mailerlite.com/mcp)                                                           | `mailerlite`  | sales-marketing     |
| [Mem](https://docs.mem.ai/mcp/overview)                                                                       | `mem`         | documents-files     |
| [Mercury](https://docs.mercury.com/docs/connecting-mercury-mcp)                                               | `mercury`     | finance-payments    |
| [Notion](https://developers.notion.com/guides/mcp/build-mcp-client)                                           | `notion`      | documents-files     |
| [Otter.ai](https://help.otter.ai/hc/en-us/articles/35287607569687-Otter-MCP-Server)                           | `otter`       | inbox-collaboration |
| [Readwise](https://docs.readwise.io/tools/mcp)                                                                | `readwise`    | documents-files     |
| [Todoist](https://github.com/Doist/todoist-mcp)                                                               | `todoist`     | productivity        |
| [Typeform](https://developers.typeform.com/developers/get-started/mcp/)                                       | `typeform`    | productivity        |
| [Upwork](https://www.upwork.com/ai/mcp)                                                                       | `upwork`      | productivity        |
| [Workable](https://workable.readme.io/reference/workable-mcp-server)                                          | `workable`    | productivity        |

### User keys and tokens

| Service                                                                                                                 | Plugin ID         | Category            | Credential                     |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------- | ------------------------------ |
| [Brevo](https://developers.brevo.com/docs/mcp-protocol)                                                                 | `brevo`           | sales-marketing     | `BREVO_MCP_TOKEN`              |
| [Buffer](https://developers.buffer.com/guides/integrations/mcp.html)                                                    | `buffer`          | sales-marketing     | `BUFFER_API_KEY`               |
| [Fireflies](https://guide.fireflies.ai/articles/8272956938-learn-about-the-fireflies-mcp-server-model-context-protocol) | `fireflies`       | inbox-collaboration | `FIREFLIES_API_KEY`            |
| [GitHub MCP](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)                            | `github-mcp`      | developer-tools     | `GITHUB_MCP_TOKEN`             |
| [Guru](https://help.getguru.com/docs/connecting-gurus-mcp-server)                                                       | `guru`            | context             | `GURU_EMAIL`, `GURU_API_TOKEN` |
| [Hunter](https://hunter.io/mcp)                                                                                         | `hunter`          | sales-marketing     | `HUNTER_API_KEY`               |
| [PostHog](https://posthog.com/docs/model-context-protocol/faq)                                                          | `posthog`         | data-analytics      | `POSTHOG_MCP_TOKEN`            |
| [Statsig](https://docs.statsig.com/integrations/mcp/cursor)                                                             | `statsig`         | data-analytics      | `STATSIG_CONSOLE_API_KEY`      |
| [Superhuman Docs](https://help.superhuman.com/hc/en-us/articles/46210076980365-Connect-to-the-Superhuman-Docs-MCP)      | `superhuman-docs` | documents-files     | `SUPERHUMAN_DOCS_MCP_TOKEN`    |
| [TinyFish](https://docs.tinyfish.ai/mcp-integration)                                                                    | `tinyfish`        | web                 | `TINYFISH_API_KEY`             |
| [Wrike](https://developers.wrike.com/docs/setup-other-mcp-clients-with-wrike-mcp)                                       | `wrike`           | productivity        | `WRIKE_ACCESS_TOKEN`           |

### No authentication

| Service                                                                | Plugin ID    | Category       |
| ---------------------------------------------------------------------- | ------------ | -------------- |
| [Excalidraw](https://github.com/excalidraw/excalidraw-mcp)             | `excalidraw` | media          |
| [GoDaddy Domains](https://developer.godaddy.com/en/docs/api-users/mcp) | `godaddy`    | infrastructure |

### Credential details

- Brevo requires an MCP-specific token, not its ordinary API key.
- Superhuman Docs (formerly Coda) requires a personal token with the MCP restriction.
- GitHub MCP requires a personal access token. It adds repository, issue, and pull
  request tools; the existing GitHub plugin remains the public link reader.
- Guru sends the email and API token together using its documented Bearer format.
- PostHog recommends the MCP Server key preset. Some AI-powered tools incur charges.
- Statsig requires a Console API key, not an SDK key. Prefer read-only access.
- TinyFish documents an API-key route; account entitlement and actual key acceptance
  must be checked with your own account.
- Wrike uses a permanent access token created in its API app settings. This path
  does not use an OAuth client secret.

GoDaddy provides public domain suggestions and availability, not purchases or DNS
management. Excalidraw connects to the public hosted diagram service, not an
Excalidraw+ workspace.

## Disconnect or troubleshoot

```sh
openclaw mcp logout notion
openclaw plugins disable notion
```

`logout` removes the saved local OAuth credential. To revoke the provider grant,
use the provider's connected-app settings. For key-based services, revoke the key
with the provider and remove it from the Gateway environment.

If a plugin is missing from `mcp list`, check that it is enabled and that its
required environment variables are present. An explicit same-name `mcp.servers`
entry overrides the plugin endpoint; an explicit `enabled: false` suppresses it.
Remove an obsolete manual definition if you want the built-in definition to own
that connection. Enabling the plugin does not bypass plugin allow/deny policies.

If registration succeeds but login or a tool call fails, check the provider's
account, workspace-admin, and plan requirements. Discovery, client registration,
user authorization, and a successful tool call are different checks.

See [MCP commands](/cli/mcp), [plugin management](/cli/plugins), and
[remote MCP authentication](/cli/mcp/transports).
