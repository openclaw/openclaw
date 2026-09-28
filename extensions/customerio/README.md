# Customer.io

Customer messaging and workspace data through Customer.io's official MCP service.

This built-in adapter is maintained by OpenClaw. The provider operates the
remote service; service terms, account permissions, and usage charges still apply.
No provider source, skills, logos, or third-party wrapper assets are included.

Provider setup: https://docs.customer.io/ai/mcp/get-started/

## Connect

The plugin is disabled by default. Enable it explicitly:

```sh
openclaw plugins enable customerio
```

The default uses the US region. EU accounts must select the EU endpoint before login.

```sh
openclaw mcp set customerio '{"url":"https://mcp-eu.customer.io/mcp","transport":"streamable-http","auth":"oauth"}'
```

If changing an existing connection, run `openclaw mcp logout customerio` before
changing its URL. Log in again afterward; do not reuse tokens between regions.

Connect your own account through public OAuth client registration:

```sh
openclaw mcp login customerio
```

No pre-provisioned client ID or client secret is bundled. Your account may need
workspace-admin permission or an eligible plan. Registration/discovery alone
does not prove account access or successful tool execution.

Check the connection:

```sh
openclaw mcp status --verbose
openclaw mcp probe customerio
```

Restart the Gateway after enabling or disabling plugins. Tool availability
depends on the provider and your account. Start with a read-only operation;
provider tools may also modify data or consume credits.

Setup and troubleshooting: https://docs.openclaw.ai/plugins/company-services
