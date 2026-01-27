---
title: Contributing Plugins
description: How to create, test, and distribute Clawdbot plugins
---

# Contributing Plugins

This guide walks you through creating plugins that extend Clawdbot with new channels, tools, commands, and services.

## What is a Plugin?

A plugin is a TypeScript module that extends Clawdbot at runtime. Plugins can:

- Register new messaging channels (like Matrix, Nostr, MS Teams)
- Add agent tools the AI can invoke
- Register Gateway RPC methods
- Add CLI commands
- Run background services
- Ship bundled skills
- Register auto-reply commands

Plugins run **in-process** with the Gateway, so treat them as trusted code.

## Quick Start

Create a minimal plugin in 5 minutes:

```bash
# Create plugin directory
mkdir -p ~/.clawdbot/extensions/hello-world

# Create the manifest
cat > ~/.clawdbot/extensions/hello-world/clawdbot.plugin.json << 'EOF'
{
  "id": "hello-world",
  "name": "Hello World",
  "description": "A simple example plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "greeting": {
        "type": "string",
        "default": "Hello"
      }
    }
  }
}
EOF

# Create the plugin code
cat > ~/.clawdbot/extensions/hello-world/index.ts << 'EOF'
export default function register(api) {
  const config = api.pluginConfig ?? {};
  const greeting = config.greeting ?? "Hello";

  // Register a Gateway RPC method
  api.registerGatewayMethod("hello.greet", ({ params, respond }) => {
    const name = params?.name ?? "World";
    respond(true, { message: `${greeting}, ${name}!` });
  });

  // Register an auto-reply command
  api.registerCommand({
    name: "hello",
    description: "Say hello",
    handler: () => ({ text: `${greeting} from the plugin!` }),
  });

  api.logger.info("[hello-world] Plugin loaded");
}
EOF
```

Restart the Gateway to load your plugin.

## Plugin Structure

### Directory Layout

```
my-plugin/
├── clawdbot.plugin.json    # Required: manifest
├── index.ts                # Required: entry point
├── package.json            # Optional: for npm distribution
├── src/                    # Optional: source files
│   ├── cli.ts
│   ├── tools.ts
│   └── types.ts
├── skills/                 # Optional: bundled skills
│   └── my-skill/
│       └── SKILL.md
└── README.md
```

### Plugin Manifest (clawdbot.plugin.json)

Every plugin **must** have a manifest:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "Does amazing things",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "enabled": { "type": "boolean" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "enabled": { "label": "Enable Feature" }
  }
}
```

#### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique plugin identifier |
| `configSchema` | object | JSON Schema for config validation |

#### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name |
| `description` | string | Short summary |
| `version` | string | Semantic version |
| `kind` | string | Plugin category (e.g., `"memory"`) |
| `channels` | string[] | Channel IDs this plugin registers |
| `providers` | string[] | Provider IDs this plugin registers |
| `skills` | string[] | Skill directories to load |
| `uiHints` | object | UI labels and hints |

### Entry Point (index.ts)

Plugins export either a function or an object:

```typescript
// Function style (simple)
export default function register(api) {
  // Registration code
}

// Object style (with metadata)
export default {
  id: "my-plugin",
  name: "My Plugin",
  configSchema: { /* ... */ },
  register(api) {
    // Registration code
  },
};
```

## Plugin API

The `api` object provides access to Clawdbot internals:

### Core Properties

```typescript
api.config       // Full Clawdbot configuration
api.pluginConfig // This plugin's config (plugins.entries.<id>.config)
api.logger       // Scoped logger instance
api.runtime      // Runtime helpers (TTS, etc.)
```

### Registration Methods

#### Gateway RPC Methods

```typescript
api.registerGatewayMethod("myplugin.action", async ({ params, respond }) => {
  // params: request parameters
  // respond(ok: boolean, payload?: any): send response

  try {
    const result = await doSomething(params);
    respond(true, { data: result });
  } catch (err) {
    respond(false, { error: err.message });
  }
});
```

#### Agent Tools

```typescript
import { Type } from "@sinclair/typebox";

api.registerTool({
  name: "my_tool",
  description: "Does something useful",
  inputSchema: Type.Object({
    query: Type.String({ description: "Search query" }),
    limit: Type.Optional(Type.Number({ description: "Max results" })),
  }),
  handler: async ({ params, context }) => {
    const results = await search(params.query, params.limit);
    return { results };
  },
});
```

#### CLI Commands

```typescript
api.registerCli(({ program }) => {
  program
    .command("myplugin")
    .description("My plugin command")
    .option("-v, --verbose", "Verbose output")
    .action((options) => {
      console.log("Running with options:", options);
    });
}, { commands: ["myplugin"] });
```

#### Auto-Reply Commands

Commands that respond without invoking the AI:

```typescript
api.registerCommand({
  name: "mystatus",
  description: "Show plugin status",
  acceptsArgs: false,
  requireAuth: true,
  handler: (ctx) => ({
    text: `Plugin active on ${ctx.channel}`,
  }),
});
```

Handler context:

- `ctx.senderId` - Sender ID
- `ctx.channel` - Channel name
- `ctx.isAuthorizedSender` - Auth status
- `ctx.args` - Command arguments (if `acceptsArgs: true`)
- `ctx.config` - Clawdbot config

#### Background Services

```typescript
api.registerService({
  id: "my-background-service",
  start: async () => {
    api.logger.info("Service starting");
    // Initialize background work
  },
  stop: async () => {
    api.logger.info("Service stopping");
    // Cleanup
  },
});
```

#### Messaging Channels

```typescript
api.registerChannel({
  plugin: {
    id: "mychannel",
    meta: {
      id: "mychannel",
      label: "My Channel",
      selectionLabel: "My Channel (API)",
      docsPath: "/channels/mychannel",
      blurb: "Custom messaging channel",
      aliases: ["mc"],
    },
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: (cfg) =>
        Object.keys(cfg.channels?.mychannel?.accounts ?? {}),
      resolveAccount: (cfg, accountId) =>
        cfg.channels?.mychannel?.accounts?.[accountId ?? "default"],
    },
    outbound: {
      deliveryMode: "direct",
      sendText: async ({ text, target }) => {
        await deliverMessage(text, target);
        return { ok: true };
      },
    },
  },
});
```

#### Model Providers

```typescript
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth Login",
      kind: "oauth",
      run: async (ctx) => {
        // OAuth flow
        return {
          profiles: [{ profileId: "acme:default", credential: { ... } }],
          defaultModel: "acme/model-1",
        };
      },
    },
  ],
});
```

## Configuration

### User Configuration

Users configure your plugin in `~/.clawdbot/clawdbot.json`:

```json5
{
  plugins: {
    entries: {
      "my-plugin": {
        enabled: true,
        config: {
          apiKey: "sk-xxx",
          endpoint: "https://api.example.com"
        }
      }
    }
  }
}
```

### Config Schema

Define validation rules in the manifest:

```json
{
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["apiKey"],
    "properties": {
      "apiKey": {
        "type": "string",
        "minLength": 1
      },
      "endpoint": {
        "type": "string",
        "format": "uri"
      },
      "timeout": {
        "type": "integer",
        "minimum": 1000,
        "default": 30000
      }
    }
  }
}
```

### UI Hints

Help the Control UI render better forms:

```json
{
  "uiHints": {
    "apiKey": {
      "label": "API Key",
      "placeholder": "sk-...",
      "sensitive": true
    },
    "endpoint": {
      "label": "API Endpoint",
      "help": "Custom endpoint URL",
      "advanced": true
    },
    "timeout": {
      "label": "Timeout (ms)",
      "advanced": true
    }
  }
}
```

UI hint fields:

- `label` - Display label
- `placeholder` - Input placeholder
- `help` - Help text
- `sensitive` - Mark as password field
- `advanced` - Hide in basic view

## Bundling Skills

Plugins can ship skills:

```json
{
  "id": "my-plugin",
  "skills": ["./skills/my-skill"]
}
```

Skills are loaded when the plugin is enabled and follow standard skill precedence.

## Plugin Hooks

Plugins can register event hooks:

```typescript
import { registerPluginHooksFromDir } from "clawdbot/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Hook directories follow the standard hook structure (`HOOK.md` + `handler.ts`).

## Testing

### Local Testing

1. Create your plugin in `~/.clawdbot/extensions/`
2. Restart the Gateway
3. Check it loaded: `clawdbot plugins list`
4. Test your features

### Development Mode

Link your plugin for live development:

```bash
clawdbot plugins install -l ./my-plugin
```

The `-l` flag creates a symlink instead of copying.

### Unit Tests

Ship tests with your plugin:

```typescript
// src/my-plugin.test.ts
import { describe, it, expect } from "vitest";
import { myFunction } from "./my-function.js";

describe("myFunction", () => {
  it("should process input correctly", () => {
    expect(myFunction("test")).toBe("expected");
  });
});
```

Run with Vitest or your preferred test runner.

## Distribution

### npm Publishing

Package your plugin for npm:

```json
// package.json
{
  "name": "@yourname/clawdbot-my-plugin",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "clawdbot.plugin.json"],
  "clawdbot": {
    "extensions": ["./dist/index.js"]
  },
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build"
  }
}
```

Users install with:

```bash
clawdbot plugins install @yourname/clawdbot-my-plugin
```

### Local Distribution

Distribute as a tarball or zip:

```bash
# Create archive
tar -czf my-plugin.tar.gz my-plugin/

# Install
clawdbot plugins install ./my-plugin.tar.gz
```

## Best Practices

### Naming

- Plugin ID: kebab-case (`my-plugin`)
- npm package: `@scope/clawdbot-*` or `clawdbot-*`
- RPC methods: `pluginid.action`
- Tools: `snake_case`

### Error Handling

```typescript
api.registerGatewayMethod("myplugin.action", async ({ params, respond }) => {
  try {
    // Validate required params
    if (!params?.id) {
      respond(false, { error: "id is required" });
      return;
    }

    const result = await doWork(params.id);
    respond(true, { data: result });
  } catch (err) {
    api.logger.error("[myplugin] Action failed:", err);
    respond(false, {
      error: err instanceof Error ? err.message : "Unknown error"
    });
  }
});
```

### Logging

Use the scoped logger:

```typescript
api.logger.debug("[myplugin] Debug info");
api.logger.info("[myplugin] Starting");
api.logger.warn("[myplugin] Warning message");
api.logger.error("[myplugin] Error:", error);
```

### Configuration Defaults

Handle missing config gracefully:

```typescript
const config = api.pluginConfig ?? {};
const timeout = config.timeout ?? 30000;
const endpoint = config.endpoint ?? "https://api.example.com";
```

### Deprecation Warnings

```typescript
if (config.oldOption !== undefined) {
  api.logger.warn(
    "[myplugin] 'oldOption' is deprecated; use 'newOption' instead"
  );
}
```

### Cleanup

Always clean up resources:

```typescript
let interval: NodeJS.Timeout | null = null;

api.registerService({
  id: "my-service",
  start: () => {
    interval = setInterval(checkStatus, 60000);
  },
  stop: () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  },
});
```

## Example Plugins

Browse official plugins for patterns:

| Plugin | Description | Key Patterns |
|--------|-------------|--------------|
| [voice-call](https://github.com/clawdbot/clawdbot/tree/main/extensions/voice-call) | Phone calls | RPC methods, tools, CLI, config schema |
| [matrix](https://github.com/clawdbot/clawdbot/tree/main/extensions/matrix) | Matrix channel | Channel registration, E2EE |
| [memory-lancedb](https://github.com/clawdbot/clawdbot/tree/main/extensions/memory-lancedb) | Vector memory | Plugin slots, background service |
| [lobster](https://github.com/clawdbot/clawdbot/tree/main/extensions/lobster) | Natural CLI | Tool registration |

## Troubleshooting

### Plugin not loading

1. Check `clawdbot plugins list`
2. Verify manifest exists: `clawdbot.plugin.json`
3. Check for syntax errors in manifest JSON
4. Look for errors in logs: `clawdbot logs -f`
5. Run doctor: `clawdbot doctor`

### Config validation errors

1. Verify JSON Schema in manifest
2. Check `additionalProperties: false` blocks unknown keys
3. Test config against schema with a JSON validator

### RPC method not found

1. Verify method name matches registration
2. Check plugin is enabled in config
3. Restart Gateway after changes

### Tool not appearing

1. Verify tool registration code runs
2. Check tool name doesn't conflict
3. Verify schema is valid (no `anyOf`/`oneOf`)

## Resources

- [Plugin reference](/plugin) - Full API documentation
- [Plugin manifest](/plugins/manifest) - Manifest schema
- [Plugin agent tools](/plugins/agent-tools) - Tool authoring guide
- [Voice Call example](/plugins/voice-call) - Complete plugin example
- [Feature maturity](/reference/feature-maturity) - Plugin system stability
