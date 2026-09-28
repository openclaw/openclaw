# GitHub MCP

Repositories, issues, and pull requests through GitHub MCP's official MCP service.

This built-in adapter is maintained by OpenClaw. The provider operates the
remote service; service terms, account permissions, and usage charges still apply.
No provider source, skills, logos, or third-party wrapper assets are included.

Provider setup: https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md

## Connect

The plugin is disabled by default. Enable it explicitly:

```sh
openclaw plugins enable github-mcp
```

Provide `GITHUB_MCP_TOKEN` in the environment of the
OpenClaw process, using your secret manager. Do not put real keys in shell
history or checked-in configuration. Missing variables prevent this server
from loading; restart the Gateway after changing its environment.

Use a least-privilege GitHub personal access token. This is separate from the public GitHub link-reader plugin.

Check the connection:

```sh
openclaw mcp status --verbose
openclaw mcp probe github-mcp
```

Restart the Gateway after enabling or disabling plugins. Tool availability
depends on the provider and your account. Start with a read-only operation;
provider tools may also modify data or consume credits.

Setup and troubleshooting: https://docs.openclaw.ai/plugins/company-services
