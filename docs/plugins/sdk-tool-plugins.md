---
title: "Building Tool Plugins"
sidebarTitle: "Tool Plugins"
summary: "Step-by-step guide to building a plugin that adds tools, hooks, and commands"
read_when:
  - You are building a plugin that adds agent tools
  - You want a guide for non-channel, non-provider plugins
  - You need examples for optional tools and runtime-aware tools
---

# Building Tool Plugins

This guide walks through building a plugin that adds agent tools. Tool plugins
can also register hooks, commands, HTTP routes, or services, but tools are
usually the main entry point.

<Info>
  If you have not built any OpenClaw plugin before, read
  [Getting Started](/plugins/building-plugins) first for the basic package
  structure and manifest setup.
</Info>

## Walkthrough

<Steps>
  <Step title="Package and manifest">
    <CodeGroup>
    ```json package.json
    {
      "name": "@myorg/openclaw-acme-tools",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"]
      }
    }
    ```

    ```json openclaw.plugin.json
    {
      "id": "acme-tools",
      "name": "Acme Tools",
      "description": "Acme workflow tools for OpenClaw",
      "configSchema": {
        "type": "object",
        "properties": {
          "baseUrl": { "type": "string" }
        },
        "additionalProperties": false
      }
    }
    ```
    </CodeGroup>

    Every native plugin needs `openclaw.plugin.json`, even if the config schema
    is just an empty object. See [Plugin Manifest](/plugins/manifest) for the
    full field reference.

  </Step>

  <Step title="Register a required tool">
    Use `definePluginEntry(...)` for tool plugins:

    ```typescript index.ts
    import { Type } from "@sinclair/typebox";
    import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

    export default definePluginEntry({
      id: "acme-tools",
      name: "Acme Tools",
      description: "Acme workflow tools for OpenClaw",
      register(api) {
        api.registerTool({
          name: "acme_echo",
          description: "Echo text back to the agent",
          parameters: Type.Object({
            text: Type.String({ description: "Text to echo" }),
          }),
          async execute(_id, params) {
            return {
              content: [{ type: "text", text: params.text }],
            };
          },
        });
      },
    });
    ```

    Required tools are available whenever the plugin is loaded.

  </Step>

  <Step title="Make side-effecting tools optional">
    Use `optional: true` for tools that call outside systems, mutate state, or
    depend on local binaries:

    ```typescript
    import { Type } from "@sinclair/typebox";

    register(api) {
      api.registerTool(
        {
          name: "acme_publish",
          description: "Publish the current draft",
          parameters: Type.Object({
            documentId: Type.String(),
          }),
          async execute(_id, params) {
            return {
              content: [
                {
                  type: "text",
                  text: `Published ${params.documentId}`,
                },
              ],
            };
          },
        },
        { optional: true },
      );
    }
    ```

    Users must allow optional tools in config:

    ```json5
    {
      tools: {
        allow: ["acme_publish"],
      },
    }
    ```

    You can also allow every optional tool from one plugin by adding the plugin
    id to `tools.allow`.

  </Step>

  <Step title="Use runtime-aware tool factories when needed">
    If a tool should only exist in some environments, register a factory and
    return `null` when the tool should be hidden:

    ```typescript
    import { Type } from "@sinclair/typebox";

    register(api) {
      api.registerTool(
        (ctx) => {
          if (ctx.sandboxed) {
            return null;
          }

          return {
            name: "acme_shell",
            description: "Run a local shell command",
            parameters: Type.Object({
              command: Type.String(),
            }),
            async execute(_id, params) {
              api.logger.info(`running ${params.command}`);
              return {
                content: [{ type: "text", text: `Ran ${params.command}` }],
              };
            },
          };
        },
        { optional: true },
      );
    }
    ```

    This pattern is useful for sandbox-sensitive tools, tools that require
    plugin config, or tools that should only appear for some channels.

  </Step>

  <Step title="Add hooks or routes around the tool">
    Tool plugins are also a common place for lifecycle hooks or plugin-owned
    HTTP routes:

    ```typescript
    register(api) {
      api.on("before_prompt_build", async () => ({
        prependSystemContext: "You can use acme_echo for literal echo tasks.",
      }));

      api.registerHttpRoute({
        path: "/plugins/acme-tools/health",
        auth: "plugin",
        handler: async () => ({
          ok: true,
          body: { status: "ok" },
        }),
      });
    }
    ```

    For the full registration surface, see
    [Plugin SDK Overview](/plugins/sdk-overview#registration-api) and
    [Plugin Entry Points](/plugins/sdk-entrypoints).

  </Step>

  <Step title="Test and inspect">
    For in-repo plugins:

    ```bash
    pnpm test -- extensions/acme-tools/
    ```

    After install, confirm what OpenClaw sees:

    ```bash
    openclaw plugins inspect acme-tools
    ```

    The inspect output shows whether the plugin loaded, which tools it
    registered, and any diagnostics.

  </Step>
</Steps>

## File structure

```text
acme-tools/
  package.json
  openclaw.plugin.json
  index.ts
  src/
    tools/
    config.ts
```

- `index.ts` exports the plugin entry and registers tools.
- `openclaw.plugin.json` is the manifest OpenClaw reads before loading code.
- `src/` holds the actual tool logic and any config helpers.

## When to use a tool plugin

Use a tool plugin when your plugin mainly adds actions the agent can call.

Use a provider plugin instead when you are adding models, auth, catalogs, or
provider runtime hooks.

Use a channel plugin instead when you are adding message transport, setup
surfaces, target resolution, or send/receive behavior.

## Next steps

- [Plugin SDK Overview](/plugins/sdk-overview) — registration methods and API object
- [Plugin Runtime Helpers](/plugins/sdk-runtime) — `api.runtime`, logging, config, subagents
- [Plugin Testing](/plugins/sdk-testing) — test utilities and patterns
- [Plugin Troubleshooting](/plugins/sdk-troubleshooting) — common load and config failures
