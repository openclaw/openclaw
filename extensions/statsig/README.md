# Statsig

Feature gates and experiment data through Statsig's official MCP service.

This built-in adapter is maintained by OpenClaw. The provider operates the
remote service; service terms, account permissions, and usage charges still apply.
No provider source, skills, logos, or third-party wrapper assets are included.

Provider setup: https://docs.statsig.com/integrations/mcp/cursor

## Connect

The plugin is disabled by default. Enable it explicitly:

```sh
openclaw plugins enable statsig
```

Provide `STATSIG_CONSOLE_API_KEY` in the environment of the
OpenClaw process, using your secret manager. Do not put real keys in shell
history or checked-in configuration. Missing variables prevent this server
from loading; restart the Gateway after changing its environment.

Use a Console API key, not an SDK client or server key. Prefer a read-only key.

Check the connection:

```sh
openclaw mcp status --verbose
openclaw mcp probe statsig
```

Restart the Gateway after enabling or disabling plugins. Tool availability
depends on the provider and your account. Start with a read-only operation;
provider tools may also modify data or consume credits.

Setup and troubleshooting: https://docs.openclaw.ai/plugins/company-services
