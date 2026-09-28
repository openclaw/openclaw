# PostHog

Product analytics and project data through PostHog's official MCP service.

This built-in adapter is maintained by OpenClaw. The provider operates the
remote service; service terms, account permissions, and usage charges still apply.
No provider source, skills, logos, or third-party wrapper assets are included.

Provider setup: https://posthog.com/docs/model-context-protocol/faq

## Connect

The plugin is disabled by default. Enable it explicitly:

```sh
openclaw plugins enable posthog
```

Provide `POSTHOG_MCP_TOKEN` in the environment of the
OpenClaw process, using your secret manager. Do not put real keys in shell
history or checked-in configuration. Missing variables prevent this server
from loading; restart the Gateway after changing its environment.

Use a personal API key with the MCP Server preset. AI-powered tools may incur charges.

Check the connection:

```sh
openclaw mcp status --verbose
openclaw mcp probe posthog
```

Restart the Gateway after enabling or disabling plugins. Tool availability
depends on the provider and your account. Start with a read-only operation;
provider tools may also modify data or consume credits.

Setup and troubleshooting: https://docs.openclaw.ai/plugins/company-services
