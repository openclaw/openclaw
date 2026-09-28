# Excalidraw

Diagram creation and rendering through Excalidraw's official MCP service.

This built-in adapter is maintained by OpenClaw. The provider operates the
remote service; service terms, account permissions, and usage charges still apply.
No provider source, skills, logos, or third-party wrapper assets are included.

Provider setup: https://github.com/excalidraw/excalidraw-mcp

## Connect

The plugin is disabled by default. Enable it explicitly:

```sh
openclaw plugins enable excalidraw
```

Public hosted diagram tools; this does not connect an Excalidraw+ workspace.

Check the connection:

```sh
openclaw mcp status --verbose
openclaw mcp probe excalidraw
```

Restart the Gateway after enabling or disabling plugins. Tool availability
depends on the provider and your account. Start with a read-only operation;
provider tools may also modify data or consume credits.

Setup and troubleshooting: https://docs.openclaw.ai/plugins/company-services
