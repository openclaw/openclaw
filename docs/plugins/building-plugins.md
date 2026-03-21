---
title: "Building Plugins"
sidebarTitle: "Building Plugins"
summary: "Step-by-step guide for creating OpenClaw plugins with any combination of capabilities"
read_when:
  - You want to create a new OpenClaw plugin
  - You need to understand the plugin SDK import patterns
  - You are adding a new channel, provider, tool, or other capability to OpenClaw
---

# Building Plugins

Plugins extend OpenClaw with new capabilities: channels, model providers, speech,
image generation, web search, agent tools, or any combination. A single plugin
can register multiple capabilities.

OpenClaw encourages **external plugin development**. You do not need to add your
plugin to the OpenClaw repository. Publish your plugin on npm, and users install
it with `openclaw plugins install <npm-spec>`. OpenClaw also maintains a set of
core plugins in-repo, but the plugin system is designed for independent ownership
and distribution.

## Prerequisites

- Node >= 22 and a package manager (npm or pnpm)
- Familiarity with TypeScript (ESM)
- For in-repo plugins: OpenClaw repository cloned and `pnpm install` done

## Plugin capabilities

A plugin can register one or more capabilities. The capability you register
determines what your plugin provides to OpenClaw:

| Capability          | Registration method                           | What it adds                   |
| ------------------- | --------------------------------------------- | ------------------------------ |
| Text inference      | `api.registerProvider(...)`                   | Model provider (LLM)           |
| Channel / messaging | `api.registerChannel(...)`                    | Chat channel (e.g. Slack, IRC) |
| Speech              | `api.registerSpeechProvider(...)`             | Text-to-speech / STT           |
| Media understanding | `api.registerMediaUnderstandingProvider(...)` | Image/audio/video analysis     |
| Image generation    | `api.registerImageGenerationProvider(...)`    | Image generation               |
| Web search          | `api.registerWebSearchProvider(...)`          | Web search provider            |
| Agent tools         | `api.registerTool(...)`                       | Tools callable by the agent    |

A plugin that registers zero capabilities but provides hooks or services is a
**hook-only** plugin. That pattern is still supported.

## Plugin structure

Plugins follow this layout (whether in-repo or standalone):

```text
my-plugin/
├── package.json          # npm metadata + openclaw config
├── openclaw.plugin.json  # Plugin manifest
├── index.ts              # Entry point
├── setup-entry.ts        # Setup wizard (optional)
├── api.ts                # Public exports (optional)
├── runtime-api.ts        # Internal exports (optional)
└── src/
    ├── provider.ts       # Capability implementation
    ├── runtime.ts        # Runtime wiring
    └── *.test.ts         # Colocated tests
```

## Create a plugin

<Steps>
  <Step title="Create the package">
    Create `package.json` with the `openclaw` metadata block. The structure
    depends on what capabilities your plugin provides.

    **Channel plugin example:**

    ```json
    {
      "name": "@myorg/openclaw-my-channel",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "channel": {
          "id": "my-channel",
          "label": "My Channel",
          "blurb": "Short description of the channel."
        }
      }
    }
    ```

    **Provider plugin example:**

    ```json
    {
      "name": "@myorg/openclaw-my-provider",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "providers": ["my-provider"]
      }
    }
    ```

    The `openclaw` field tells the plugin system what your plugin provides.
    A plugin can declare both `channel` and `providers` if it provides multiple
    capabilities.

  </Step>

  <Step title="Define the entry point">
    The entry point registers your capabilities with the plugin API.

    **Channel plugin:**

    ```typescript
    import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";

    export default defineChannelPluginEntry({
      id: "my-channel",
      name: "My Channel",
      description: "Connects OpenClaw to My Channel",
      plugin: {
        // Channel adapter implementation
      },
    });
    ```

    **Provider plugin:**

    ```typescript
    import { definePluginEntry } from "openclaw/plugin-sdk/core";

    export default definePluginEntry({
      id: "my-provider",
      name: "My Provider",
      register(api) {
        api.registerProvider({
          // Provider implementation
        });
      },
    });
    ```

    **Multi-capability plugin** (provider + tool):

    ```typescript
    import { definePluginEntry } from "openclaw/plugin-sdk/core";

    export default definePluginEntry({
      id: "my-plugin",
      name: "My Plugin",
      register(api) {
        api.registerProvider({ /* ... */ });
        api.registerTool({ /* ... */ });
        api.registerImageGenerationProvider({ /* ... */ });
      },
    });
    ```

    Use `defineChannelPluginEntry` for channel plugins and `definePluginEntry`
    for everything else. A single plugin can register as many capabilities as needed.

  </Step>

  <Step title="Import from focused SDK subpaths">
    Always import from specific `openclaw/plugin-sdk/\<subpath\>` paths. The old
    monolithic import is deprecated (see [SDK Migration](/plugins/sdk-migration)).

    If older plugin code still imports `openclaw/extension-api`, treat that as a
    temporary compatibility bridge only. New code should use injected runtime
    helpers such as `api.runtime.agent.*` instead of importing host-side agent
    helpers directly.

    ```typescript
    // Correct: focused subpaths
    import { definePluginEntry } from "openclaw/plugin-sdk/core";
    import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
    import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-oauth";

    // Wrong: monolithic root (lint will reject this)
    import { ... } from "openclaw/plugin-sdk";

    // Deprecated: legacy host bridge
    import { runEmbeddedPiAgent } from "openclaw/extension-api";
    ```

    <Accordion title="Common subpaths reference">
      | Subpath | Purpose |
      | --- | --- |
      | `plugin-sdk/core` | Plugin entry definitions and base types |
      | `plugin-sdk/channel-setup` | Setup wizard adapters |
      | `plugin-sdk/channel-pairing` | DM pairing primitives |
      | `plugin-sdk/channel-reply-pipeline` | Reply prefix + typing wiring |
      | `plugin-sdk/channel-config-schema` | Config schema builders |
      | `plugin-sdk/channel-policy` | Group/DM policy helpers |
      | `plugin-sdk/secret-input` | Secret input parsing/helpers |
      | `plugin-sdk/webhook-ingress` | Webhook request/target helpers |
      | `plugin-sdk/runtime-store` | Persistent plugin storage |
      | `plugin-sdk/allow-from` | Allowlist resolution |
      | `plugin-sdk/reply-payload` | Message reply types |
      | `plugin-sdk/provider-oauth` | OAuth login + PKCE helpers |
      | `plugin-sdk/provider-onboard` | Provider onboarding config patches |
      | `plugin-sdk/testing` | Test utilities |
    </Accordion>

    Use the narrowest subpath that matches the job.

  </Step>

  <Step title="Use local modules for internal imports">
    Within your plugin, create local module files for internal code sharing
    instead of re-importing through the plugin SDK:

    ```typescript
    // api.ts — public exports for this plugin
    export { MyConfig } from "./src/config.js";
    export { MyRuntime } from "./src/runtime.js";

    // runtime-api.ts — internal-only exports
    export { internalHelper } from "./src/helpers.js";
    ```

    <Warning>
      Never import your own plugin back through its published SDK path from
      production files. Route internal imports through local files like `./api.ts`
      or `./runtime-api.ts`. The SDK path is for external consumers only.
    </Warning>

  </Step>

  <Step title="Add a plugin manifest">
    Create `openclaw.plugin.json` in your plugin root:

    ```json
    {
      "id": "my-plugin",
      "kind": "provider",
      "name": "My Plugin",
      "description": "Adds My Provider to OpenClaw"
    }
    ```

    For channel plugins, set `"kind": "channel"` and add `"channels": ["my-channel"]`.

    See [Plugin Manifest](/plugins/manifest) for the full schema.

  </Step>

  <Step title="Test your plugin">
    **External plugins:** run your own test suite against the plugin SDK contracts.

    **In-repo plugins:** OpenClaw runs contract tests against all registered plugins:

    ```bash
    pnpm test:contracts:channels   # channel plugins
    pnpm test:contracts:plugins    # provider plugins
    ```

    For unit tests, import test helpers from the testing surface:

    ```typescript
    import { createTestRuntime } from "openclaw/plugin-sdk/testing";
    ```

  </Step>

  <Step title="Publish and install">
    **External plugins:** publish to npm, then install:

    ```bash
    npm publish
    openclaw plugins install @myorg/openclaw-my-plugin
    ```

    **In-repo plugins:** place the plugin under `extensions/` and it is
    automatically discovered during build.

    Users can browse and install community plugins with:

    ```bash
    openclaw plugins search <query>
    openclaw plugins install <npm-spec>
    ```

  </Step>
</Steps>

## Registering agent tools

Plugins can register **agent tools** — typed functions the LLM can call. Tools
can be required (always available) or optional (users opt in via allowlists).

```typescript
import { Type } from "@sinclair/typebox";

export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  register(api) {
    // Required tool (always available)
    api.registerTool({
      name: "my_tool",
      description: "Do a thing",
      parameters: Type.Object({ input: Type.String() }),
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.input }] };
      },
    });

    // Optional tool (user must add to allowlist)
    api.registerTool(
      {
        name: "workflow_tool",
        description: "Run a workflow",
        parameters: Type.Object({ pipeline: Type.String() }),
        async execute(_id, params) {
          return { content: [{ type: "text", text: params.pipeline }] };
        },
      },
      { optional: true },
    );
  },
});
```

Enable optional tools in config:

```json5
{
  tools: { allow: ["workflow_tool"] },
}
```

Tips:

- Tool names must not clash with core tool names (conflicts are skipped)
- Use `optional: true` for tools that trigger side effects or require extra binaries
- Users can enable all tools from a plugin by adding the plugin id to `tools.allow`

## Lint enforcement (in-repo plugins)

Three scripts enforce SDK boundaries for plugins in the OpenClaw repository:

1. **No monolithic root imports** — `openclaw/plugin-sdk` root is rejected
2. **No direct src/ imports** — plugins cannot import `../../src/` directly
3. **No self-imports** — plugins cannot import their own `plugin-sdk/\<name\>` subpath

Run `pnpm check` to verify all boundaries before committing.

External plugins are not subject to these lint rules, but following the same
patterns is strongly recommended.

## Pre-submission checklist

<Check>**package.json** has correct `openclaw` metadata</Check>
<Check>Entry point uses `defineChannelPluginEntry` or `definePluginEntry`</Check>
<Check>All imports use focused `plugin-sdk/\<subpath\>` paths</Check>
<Check>Internal imports use local modules, not SDK self-imports</Check>
<Check>`openclaw.plugin.json` manifest is present and valid</Check>
<Check>Tests pass</Check>
<Check>`pnpm check` passes (in-repo plugins)</Check>

## Related

- [Plugin SDK Migration](/plugins/sdk-migration) — migrating from deprecated compat surfaces
- [Plugin Architecture](/plugins/architecture) — internals and capability model
- [Plugin Manifest](/plugins/manifest) — full manifest schema
- [Plugin Agent Tools](/plugins/building-plugins#registering-agent-tools) — adding agent tools in a plugin
- [Community Plugins](/plugins/community) — listing and quality bar
