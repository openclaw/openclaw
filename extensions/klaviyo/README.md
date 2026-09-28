# Klaviyo

Marketing accounts and campaign data through Klaviyo's official MCP service.

This built-in adapter is maintained by OpenClaw. The provider operates the
remote service; service terms, account permissions, and usage charges still apply.
No provider source, skills, logos, or third-party wrapper assets are included.

Provider setup: https://developers.klaviyo.com/en/docs/connect_to_the_klaviyo_mcp_server

## Connect

The plugin is disabled by default. Enable it explicitly:

```sh
openclaw plugins enable klaviyo
```

Connect your own account through public OAuth client registration:

```sh
openclaw mcp login klaviyo
```

No pre-provisioned client ID or client secret is bundled. Your account may need
workspace-admin permission or an eligible plan. Registration/discovery alone
does not prove account access or successful tool execution.

Check the connection:

```sh
openclaw mcp status --verbose
openclaw mcp probe klaviyo
```

Restart the Gateway after enabling or disabling plugins. Tool availability
depends on the provider and your account. Start with a read-only operation;
provider tools may also modify data or consume credits.

Setup and troubleshooting: https://docs.openclaw.ai/plugins/company-services
