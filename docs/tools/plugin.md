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

If you prefer chat-native control, enable `commands.plugins: true` and use:

```text
/plugin install clawhub:@openclaw/voice-call
/plugin show voice-call
/plugin enable voice-call
```

The install path uses the same resolver as the CLI: local path/archive, explicit
`clawhub:<pkg>`, or bare package spec (ClawHub first, then npm fallback).

## Plugin types

OpenClaw recognizes two plugin formats:

| Format     | How it works                                                       | Examples                                               |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| **Native** | `openclaw.plugin.json` + runtime module; executes in-process       | Official plugins, community npm packages               |
| **Bundle** | Codex/Claude/Cursor-compatible layout; mapped to OpenClaw features | `.codex-plugin/`, `.claude-plugin/`, `.cursor-plugin/` |

Both show up under `openclaw plugins list`. See [Plugin Bundles](/plugins/bundles) for bundle details.

If you are writing a native plugin, start with [Building Plugins](/plugins/building-plugins)
and the [Plugin SDK Overview](/plugins/sdk-overview).

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
    `qianfan`, `synthetic`, `together`, `venice`,
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
    - `browser` — bundled browser plugin for the browser tool, `openclaw browser` CLI, `browser.request` gateway method, browser runtime, and default browser control service (enabled by default; disable before replacing it)
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

Config changes **require a gateway restart**. If the Gateway is running with config
watch + in-process restart enabled (the default `openclaw gateway` path), that
restart is usually performed automatically a moment after the config write lands.

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
    `\<workspace\>/.openclaw/<plugin-root>/*.ts` and `\<workspace\>/.openclaw/<plugin-root>/*/index.ts`.
  </Step>

  <Step title="Global extensions">
    `~/.openclaw/<plugin-root>/*.ts` and `~/.openclaw/<plugin-root>/*/index.ts`.
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

openclaw plugins install <package>        # install (ClawHub first, then npm)
openclaw plugins install clawhub:<pkg>   # install from ClawHub only
openclaw plugins install <spec> --force  # overwrite existing install
openclaw plugins install <path>          # install from local path
openclaw plugins install -l <path>       # link (no copy) for dev
openclaw plugins install <spec> --dangerously-force-unsafe-install
openclaw plugins update <id>             # update one plugin
openclaw plugins update <id> --dangerously-force-unsafe-install
openclaw plugins update --all            # update all

openclaw plugins enable <id>
openclaw plugins disable <id>
```

`--force` overwrites an existing installed plugin or hook pack in place.

`--dangerously-force-unsafe-install` is a break-glass override for false
positives from the built-in dangerous-code scanner. It allows plugin installs
and plugin updates to continue past built-in `critical` findings, but it still
does not bypass plugin `before_install` policy blocks or scan-failure blocking.

This CLI flag applies to plugin install/update flows only. Gateway-backed skill
dependency installs use the matching `dangerouslyForceUnsafeInstall` request
override instead, while `openclaw skills install` remains the separate ClawHub
skill download/install flow.

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
| `registerHook` / `on(...)`           | Lifecycle hooks      |
| `registerSpeechProvider`             | Text-to-speech / STT |
| `registerMediaUnderstandingProvider` | Image/audio analysis |
| `registerImageGenerationProvider`    | Image generation     |
| `registerWebSearchProvider`          | Web search           |
| `registerHttpRoute`                  | HTTP endpoint        |
| `registerCommand` / `registerCli`    | CLI commands         |
| `registerContextEngine`              | Context engine       |
| `registerService`                    | Background service   |

Hook guard behavior for typed lifecycle hooks:

- `before_tool_call`: `{ block: true }` is terminal; lower-priority handlers are skipped.
- `before_tool_call`: `{ block: false }` is a no-op and does not clear an earlier block.
- `before_install`: `{ block: true }` is terminal; lower-priority handlers are skipped.
- `before_install`: `{ block: false }` is a no-op and does not clear an earlier block.
- `message_sending`: `{ cancel: true }` is terminal; lower-priority handlers are skipped.
- `message_sending`: `{ cancel: false }` is a no-op and does not clear an earlier cancel.

For full typed hook behavior, see [SDK Overview](/plugins/sdk-overview#hook-decision-semantics).

## Related

- [Building Plugins](/plugins/building-plugins) — create your own plugin
- [Plugin Bundles](/plugins/bundles) — Codex/Claude/Cursor bundle compatibility
- [Plugin Manifest](/plugins/manifest) — manifest schema
- [Registering Tools](/plugins/building-plugins#registering-agent-tools) — add agent tools in a plugin
- [Plugin Internals](/plugins/architecture) — capability model and load pipeline
- [Community Plugins](/plugins/community) — third-party listings
