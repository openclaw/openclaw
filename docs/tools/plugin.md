---
summary: "Install, configure, and manage OpenClaw plugins"
read_when:
  - Installing or configuring plugins
  - Understanding plugin discovery and load rules
  - Working with Codex/Claude-compatible plugin bundles
title: "Plugins"
sidebarTitle: "Install and Configure"
---

# Plugins

Plugins extend OpenClaw with new capabilities: channels, model providers, tools,
skills, speech, image generation, and more. Some plugins are **core** (shipped
with OpenClaw), others are **external** (published on npm by the community).

## Quick start

<Steps>
  <Step title="See what is loaded">
    ```bash
    openclaw plugins list
    ```
  </Step>

  <Step title="Install a plugin">
    ```bash
    # From npm
    openclaw plugins install @openclaw/voice-call

    # From a local directory or archive
    openclaw plugins install ./my-plugin
    openclaw plugins install ./my-plugin.tgz
    ```

  </Step>

  <Step title="Restart the Gateway">
    ```bash
    openclaw gateway restart
    ```

    Then configure under `plugins.entries.\<id\>.config` in your config file.

  </Step>
</Steps>

## Plugin types

OpenClaw recognizes two plugin formats:

| Format     | How it works                                                       | Examples                                               |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| **Native** | `openclaw.plugin.json` + runtime module; executes in-process       | Official plugins, community npm packages               |
| **Bundle** | Codex/Claude/Cursor-compatible layout; mapped to OpenClaw features | `.codex-plugin/`, `.claude-plugin/`, `.cursor-plugin/` |

Both show up under `openclaw plugins list`. See [Plugin Bundles](/plugins/bundles) for bundle details.

## Official plugins

### Installable (npm)

| Plugin          | Package                | Docs                                 |
| --------------- | ---------------------- | ------------------------------------ |
| Matrix          | `@openclaw/matrix`     | [Matrix](/channels/matrix)           |
| Microsoft Teams | `@openclaw/msteams`    | [Microsoft Teams](/channels/msteams) |
| Nostr           | `@openclaw/nostr`      | [Nostr](/channels/nostr)             |
| Voice Call      | `@openclaw/voice-call` | [Voice Call](/plugins/voice-call)    |
| Zalo            | `@openclaw/zalo`       | [Zalo](/channels/zalo)               |
| Zalo Personal   | `@openclaw/zalouser`   | [Zalo Personal](/plugins/zalouser)   |

### Core (shipped with OpenClaw)

<AccordionGroup>
  <Accordion title="Model providers (enabled by default)">
    `anthropic`, `byteplus`, `cloudflare-ai-gateway`, `github-copilot`, `google`,
    `huggingface`, `kilocode`, `kimi-coding`, `minimax`, `mistral`, `modelstudio`,
    `moonshot`, `nvidia`, `openai`, `opencode`, `opencode-go`, `openrouter`,
    `qianfan`, `qwen-portal-auth`, `synthetic`, `together`, `venice`,
    `vercel-ai-gateway`, `volcengine`, `xiaomi`, `zai`
  </Accordion>

  <Accordion title="Memory plugins">
    - `memory-core` — bundled memory search (default via `plugins.slots.memory`)
    - `memory-lancedb` — install-on-demand long-term memory with auto-recall/capture (set `plugins.slots.memory = "memory-lancedb"`)
  </Accordion>

  <Accordion title="Speech providers (enabled by default)">
    `elevenlabs`, `microsoft`
  </Accordion>

  <Accordion title="Other">
    - `copilot-proxy` — VS Code Copilot Proxy bridge (disabled by default)
  </Accordion>
</AccordionGroup>

Looking for third-party plugins? See [Community Plugins](/plugins/community).

## Configuration

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

| Field            | Description                                               |
| ---------------- | --------------------------------------------------------- |
| `enabled`        | Master toggle (default: `true`)                           |
| `allow`          | Plugin allowlist (optional)                               |
| `deny`           | Plugin denylist (optional; deny wins)                     |
| `load.paths`     | Extra plugin files/directories                            |
| `slots`          | Exclusive slot selectors (e.g. `memory`, `contextEngine`) |
| `entries.\<id\>` | Per-plugin toggles + config                               |

Config changes **require a gateway restart**.

<Accordion title="Plugin states: disabled vs missing vs invalid">
  - **Disabled**: plugin exists but enablement rules turned it off. Config is preserved.
  - **Missing**: config references a plugin id that discovery did not find.
  - **Invalid**: plugin exists but its config does not match the declared schema.
</Accordion>

## Discovery and precedence

OpenClaw scans for plugins in this order (first match wins):

<Steps>
  <Step title="Config paths">
    `plugins.load.paths` — explicit file or directory paths.
  </Step>

  <Step title="Workspace extensions">
    `\<workspace\>/.openclaw/extensions/*.ts` and `\<workspace\>/.openclaw/extensions/*/index.ts`.
  </Step>

  <Step title="Global extensions">
    `~/.openclaw/extensions/*.ts` and `~/.openclaw/extensions/*/index.ts`.
  </Step>

  <Step title="Bundled plugins">
    Shipped with OpenClaw. Many are enabled by default (model providers, speech).
    Others require explicit enablement.
  </Step>
</Steps>

### Enablement rules

- `plugins.enabled: false` disables all plugins
- `plugins.deny` always wins over allow
- `plugins.entries.\<id\>.enabled: false` disables that plugin
- Workspace-origin plugins are **disabled by default** (must be explicitly enabled)
- Bundled plugins follow the built-in default-on set unless overridden
- Exclusive slots can force-enable the selected plugin for that slot

## Plugin slots (exclusive categories)

Some categories are exclusive (only one active at a time):

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable
      contextEngine: "legacy", // or a plugin id
    },
  },
}
```

| Slot            | What it controls      | Default             |
| --------------- | --------------------- | ------------------- |
| `memory`        | Active memory plugin  | `memory-core`       |
| `contextEngine` | Active context engine | `legacy` (built-in) |

## CLI reference

```bash
openclaw plugins list                    # compact inventory
openclaw plugins inspect <id>            # deep detail
openclaw plugins inspect <id> --json     # machine-readable
openclaw plugins status                  # operational summary
openclaw plugins doctor                  # diagnostics

openclaw plugins install <npm-spec>      # install from npm
openclaw plugins install <path>          # install from local path
openclaw plugins install -l <path>       # link (no copy) for dev
openclaw plugins update <id>             # update one plugin
openclaw plugins update --all            # update all

openclaw plugins enable <id>
openclaw plugins disable <id>
```

See [`openclaw plugins` CLI reference](/cli/plugins) for full details.

## Plugin API overview

Plugins export either a function or an object with `register(api)`:

```typescript
export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  register(api) {
    api.registerProvider({
      /* ... */
    });
    api.registerTool({
      /* ... */
    });
    api.registerChannel({
      /* ... */
    });
  },
});
```

Common registration methods:

| Method                               | What it registers    |
| ------------------------------------ | -------------------- |
| `registerProvider`                   | Model provider (LLM) |
| `registerChannel`                    | Chat channel         |
| `registerTool`                       | Agent tool           |
| `registerHook`                       | Command / gateway hooks|
| `on(...)`                            | Agent lifecycle hooks|
| `registerSpeechProvider`             | Text-to-speech / STT |
| `registerMediaUnderstandingProvider` | Image/audio analysis |
| `registerImageGenerationProvider`    | Image generation     |
| `registerWebSearchProvider`          | Web search           |
| `registerHttpRoute`                  | HTTP endpoint        |
| `registerCommand` / `registerCli`    | CLI commands         |
| `registerContextEngine`              | Context engine       |
| `registerService`                    | Background service   |

## Hook systems

Plugins can register two types of hooks:

### Internal Hooks (command and gateway events)

Use `api.registerHook()` for command and gateway events. Requires `hooks.internal.enabled: true`
in your config, and a `name` option to identify the hook:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  register(api) {
    api.registerHook("command:new", async () => {
      // Triggered when user issues /new command
      api.logger.info("New session started");
    }, { name: "my-plugin.command-new" });
  },
});
```

Common internal hook events: `command:new`, `command:reset`, `command:stop`, `gateway:startup`

Config prerequisite:

```json5
{
  hooks: { internal: { enabled: true } },
}
```

### Plugin Lifecycle Hooks (agent and tool events)

Use `api.on()` for agent lifecycle and tool execution events. No extra config required:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  register(api) {
    // Tool execution hook
    api.on("after_tool_call", async (event, ctx) => {
      api.logger.info(`Tool called: ${event.toolName}`);
      api.logger.info(`Duration: ${event.durationMs}ms`);
    });

    // Prompt injection hook
    api.on("before_prompt_build", async (event, ctx) => {
      return {
        prependContext: "Additional context for this turn",
      };
    });
  },
});
```

Common lifecycle hooks:

- `before_tool_call` / `after_tool_call` — tool execution
- `before_prompt_build` — inject context before agent runs
- `message_received` / `message_sent` — message events
- `session_start` / `session_end` — session lifecycle
- `before_compaction` / `after_compaction` — memory compaction
- `gateway_start` / `gateway_stop` — gateway startup and shutdown

See [Plugin Internals](/plugins/architecture#provider-runtime-hooks) for the complete hook list.

### Common mistake

```typescript
// ❌ Wrong: using registerHook for lifecycle events
api.registerHook("after_tool_call", handler, { name: "my-plugin.after-tool" });

// ✅ Correct: use api.on() for lifecycle events
api.on("after_tool_call", async (event, ctx) => {
  // event contains tool execution details
  // ctx contains agent/session context
});
```

**Important**: Lifecycle hooks like `before_tool_call`, `after_tool_call`, and `before_prompt_build` must use `api.on()`, not `api.registerHook()`.

## Related

- [Building Plugins](/plugins/building-plugins) — create your own plugin
- [Plugin Bundles](/plugins/bundles) — Codex/Claude/Cursor bundle compatibility
- [Plugin Manifest](/plugins/manifest) — manifest schema
- [Registering Tools](/plugins/building-plugins#registering-agent-tools) — add agent tools in a plugin
- [Plugin Internals](/plugins/architecture) — capability model and load pipeline
- [Community Plugins](/plugins/community) — third-party listings
