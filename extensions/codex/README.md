# OpenClaw Codex

Official OpenClaw provider and harness plugin for OpenAI Codex app-server integration. It exposes the Codex-managed GPT model catalog and the Codex runtime surfaces used by OpenClaw agents.

Install from OpenClaw:

```bash
openclaw plugin add @openclaw/codex
```

Use this plugin when you want OpenClaw to run Codex-backed model turns, media understanding, and prompt overlays through the Codex app-server harness.

## Codex sidebar app

The package is also a Codex plugin bundle. When installed in Codex, it connects to the already-installed OpenClaw CLI and exposes OpenClaw sessions as a native sidebar collection when the host supports collections. Older Codex hosts open the same session app with its own compact master-detail rail.

Add the OpenClaw marketplace, then install the Codex plugin:

```bash
codex plugin marketplace add openclaw/openclaw
codex plugin add codex@openclaw
```

The plugin id remains `codex` because this package also owns the Codex provider integration. Codex displays it as **OpenClaw** from the plugin interface metadata.

The bundle starts this MCP server from its package root:

```text
openclaw mcp serve --client codex --app-resource assets/openclaw-session-app.html
```

The `--client codex` mode registers the app-only session tools and both compatibility entrypoints on the shared `ui://openclaw/session` resource. The fallback global entrypoint and the sidebar collection entrypoint live on separate tools so older Codex hosts can keep the fallback without parsing the newer collection metadata. `--app-resource` must resolve a real path contained by the plugin root; the server must reject traversal and oversized resources. These two options are the companion OpenClaw MCP bridge contract required by the Codex bundle.
