# Wrike

Project and task workflows through Wrike's official MCP service.

This built-in adapter is maintained by OpenClaw. The provider operates the
remote service; service terms, account permissions, and usage charges still apply.
No provider source, skills, logos, or third-party wrapper assets are included.

Provider setup: https://developers.wrike.com/docs/setup-other-mcp-clients-with-wrike-mcp

## Connect

The plugin is disabled by default. Enable it explicitly:

```sh
openclaw plugins enable wrike
```

Provide `WRIKE_ACCESS_TOKEN` in the environment of the
OpenClaw process, using your secret manager. Do not put real keys in shell
history or checked-in configuration. Missing variables prevent this server
from loading; restart the Gateway after changing its environment.

Use a permanent access token. The provider creates this token in its API app settings; no OAuth client secret is used.

Check the connection:

```sh
openclaw mcp status --verbose
openclaw mcp probe wrike
```

Restart the Gateway after enabling or disabling plugins. Tool availability
depends on the provider and your account. Start with a read-only operation;
provider tools may also modify data or consume credits.

Setup and troubleshooting: https://docs.openclaw.ai/plugins/company-services
