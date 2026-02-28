---
title: Developer Integration Guide
summary: Complete guide for building, testing, and publishing OpenClaw plugins and extensions
read_when:
  - Building a custom plugin or extension
  - Extending OpenClaw with new capabilities
  - Publishing a plugin to the community
---

# Developer Integration Guide

This guide covers everything you need to build, test, and publish plugins/extensions that integrate with OpenClaw. It's designed for developers who want to add custom messaging channels, model providers, agent tools, or other features to OpenClaw.

## Quick Start (5 minutes)

### Option 1: Local Extension (Development)

Create a plugin in your workspace:

```bash
mkdir -p ~/.openclaw/extensions/my-plugin
cd ~/.openclaw/extensions/my-plugin
cat > openclaw.plugin.json << 'EOF'
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.0.1",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
EOF

cat > index.ts << 'EOF'
export default function register(api) {
  api.logger.info("My plugin loaded!");
}
EOF
```

Restart the Gateway. Your plugin is now loaded.

### Option 2: NPM Package

Create a new npm package:

```bash
mkdir my-openclaw-plugin
cd my-openclaw-plugin
npm init -y
npm install --save-dev typescript @types/node openclaw
cat > package.json << 'EOF'
{
  "name": "@myorg/my-openclaw-plugin",
  "version": "0.0.1",
  "main": "dist/index.js",
  "openclaw": {
    "extensions": ["./dist/index.js"]
  }
}
EOF

cat > src/index.ts << 'EOF'
export default function register(api) {
  api.logger.info("My plugin loaded!");
}
EOF

npm run build
```

Install into OpenClaw:

```bash
openclaw plugins install /path/to/my-openclaw-plugin
```

## Plugin Architecture

### Core Concepts

An OpenClaw plugin is a **TypeScript/JavaScript module** that exports a default function. This function receives an `api` object with helpers to register features.

```ts
export default function register(api) {
  // Register tools, commands, channels, etc.
}
```

### Plugin Manifest (`openclaw.plugin.json`)

Every plugin must have a manifest in its root directory:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.0.1",
  "description": "Does something useful",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": {
      "label": "API Key",
      "sensitive": true,
      "placeholder": "sk_..."
    }
  }
}
```

**Key fields:**

- `id`: Unique plugin identifier (kebab-case)
- `name`: Display name
- `configSchema`: JSON Schema for plugin configuration
- `uiHints`: UI labels and hints for config fields (optional)

### Plugin Discovery

OpenClaw discovers plugins in this order:

1. `plugins.load.paths` (config-specified custom paths)
2. `<workspace>/.openclaw/extensions/` (workspace-local)
3. `~/.openclaw/extensions/` (global user extensions)
4. Bundled extensions (shipped with OpenClaw)

**Naming conventions:**

- Standalone file: `~/.openclaw/extensions/my-plugin.ts` → id = `my-plugin`
- Directory: `~/.openclaw/extensions/my-plugin/` → requires `openclaw.plugin.json`
- NPM package: `package.json` → `name` field becomes the id (scoped names are normalized to unscoped)

## Building Different Plugin Types

### Agent Tools

Tools are callable functions that agents can invoke to accomplish tasks.

```ts
export default function register(api) {
  api.registerAgentTool({
    id: "my_tool",
    name: "My Tool",
    description: "Describe what this tool does",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" }
      },
      required: ["query"]
    },
    handler: async (input, context) => {
      // input.query contains the agent's input
      // context has: logger, config, runtime, sessionKey, etc.
      
      const result = await myAsyncOperation(input.query);
      
      return {
        ok: true,
        data: result,
      };
    }
  });
}
```

**Context object:**

- `logger`: Write logs (shown in `openclaw logs`)
- `config`: Full OpenClaw configuration
- `runtime`: Access to core services (TTS, etc.)
- `sessionKey`: Current session identifier
- `agentId`: Current agent ID (if applicable)

**Error handling:**

```ts
handler: async (input, context) => {
  try {
    const result = await operation(input);
    return { ok: true, data: result };
  } catch (error) {
    return {
      ok: false,
      error: error.message, // Shown to user/agent
    };
  }
}
```

### Messaging Channels

Add a new chat platform (WhatsApp, Slack, Discord, etc.).

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "Chat via AcmeChat API",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct", "group"] },
  config: {
    listAccountIds: (cfg) =>
      Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {},
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text, to, from }) => {
      // Send message via your API
      return { ok: true };
    },
  },
  gateway: {
    start: async (context) => {
      // Start listening for inbound messages
      context.onInbound(async (message) => {
        // Handle inbound message
      });
    },
    stop: async () => {},
  },
};

export default function register(api) {
  api.registerChannel({ plugin: myChannel });
}
```

**Configuration example:**

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: {
          accountId: "myaccount",
          apiToken: "...",
          enabled: true
        }
      }
    }
  }
}
```

### Model Providers

Register a new LLM provider (for OAuth or API key auth).

```ts
export default function register(api) {
  api.registerProvider({
    id: "acmeai",
    label: "AcmeAI",
    auth: [
      {
        id: "api-key",
        label: "API Key",
        kind: "apikey",
        run: async (ctx) => {
          const apiKey = await ctx.prompter("Enter your API key");
          
          return {
            profiles: [
              {
                profileId: "acmeai:default",
                credential: {
                  type: "api_key",
                  provider: "acmeai",
                  key: apiKey,
                }
              }
            ],
            defaultModel: "acmeai/gpt-4",
          };
        }
      }
    ]
  });
}
```

### CLI Commands

Add custom commands to the CLI.

```ts
export default function register(api) {
  api.registerCli(({ program }) => {
    program
      .command("mycmd <arg>")
      .description("Does something cool")
      .action((arg) => {
        console.log(`Received: ${arg}`);
      });
  }, { commands: ["mycmd"] });
}
```

### Auto-Reply Commands

Commands that execute **without** invoking the AI agent (useful for toggles, status checks).

```ts
export default function register(api) {
  api.registerCommand({
    name: "ping",
    description: "Check plugin status",
    handler: async (ctx) => {
      return { text: "Pong! Plugin is running." };
    }
  });
}
```

**Context:**

- `senderId`: Sender's ID (if available)
- `channel`: Channel ID where command was sent
- `isAuthorizedSender`: Boolean (requires config auth)
- `args`: Argument string if `acceptsArgs: true`
- `config`: Full OpenClaw config

### Background Services

Run long-lived background processes.

```ts
export default function register(api) {
  api.registerService({
    id: "my-background-service",
    start: async () => {
      api.logger.info("Service starting...");
      
      // Start listening, polling, etc.
      setInterval(() => {
        api.logger.debug("Heartbeat");
      }, 60000);
    },
    stop: async () => {
      api.logger.info("Service stopping...");
      // Clean up
    }
  });
}
```

## Development Workflow

### 1. Set Up Local Development

Create a workspace plugin:

```bash
mkdir -p ~/.openclaw/extensions/my-plugin
cd ~/.openclaw/extensions/my-plugin

# Create manifest
cat > openclaw.plugin.json << 'EOF'
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.0.1",
  "configSchema": { "type": "object" }
}
EOF

# Create plugin entry
cat > index.ts << 'EOF'
import { logger } from "openclaw/runtime";

export default function register(api) {
  api.logger.info("Plugin loaded");
  
  api.registerCommand({
    name: "test",
    description: "Test command",
    handler: async () => ({ text: "Hello from plugin!" })
  });
}
EOF
```

### 2. Local Testing

Load your plugin by placing it in `~/.openclaw/extensions/` (or configure `plugins.load.paths`).

Restart the Gateway:

```bash
# If using the CLI
openclaw gateway run

# Or if using macOS app, restart via the app menu
```

Check logs:

```bash
openclaw logs --follow
```

### 3. Use TypeScript

If your plugin uses TypeScript, OpenClaw loads it at runtime via `jiti`:

```ts
// ~/.openclaw/extensions/my-plugin/index.ts
export default function register(api) {
  api.logger.info("TypeScript plugin loaded!");
}
```

For npm packages, build to JavaScript:

```bash
npm run build
# Ensure package.json points to dist/index.js
```

### 4. Testing

Write Vitest tests alongside your plugin:

```ts
// my-plugin.test.ts
import { describe, it, expect, vi } from "vitest";

describe("My Plugin", () => {
  it("registers a tool", () => {
    const api = {
      registerAgentTool: vi.fn(),
      logger: { info: vi.fn() }
    };
    
    register(api);
    
    expect(api.registerAgentTool).toHaveBeenCalled();
  });
});
```

Run tests:

```bash
npm test
```

## Configuration & Secrets

### Plugin Config

Config lives under `plugins.entries.<id>`:

```json5
{
  plugins: {
    entries: {
      "my-plugin": {
        enabled: true,
        config: {
          apiKey: "sk_...",
          region: "us-east-1"
        }
      }
    }
  }
}
```

### Accessing Config in Your Plugin

```ts
export default function register(api) {
  api.registerCommand({
    name: "status",
    handler: async (ctx) => {
      const pluginConfig = ctx.config.plugins?.entries?.["my-plugin"]?.config;
      const apiKey = pluginConfig?.apiKey;
      
      return { text: `Config loaded: ${!!apiKey}` };
    }
  });
}
```

### Secrets Management

Use OpenClaw's credential storage:

```bash
# Users can store credentials
openclaw config set plugins.entries.my-plugin.config.apiKey "sk_secret"
```

Or use environment variables in your code:

```ts
const apiKey = process.env.MY_PLUGIN_API_KEY || config.plugins.entries["my-plugin"].config.apiKey;
```

## Publishing

### Publish to NPM

1. Create your `package.json`:

```json
{
  "name": "@myorg/my-openclaw-plugin",
  "version": "0.0.1",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "openclaw.plugin.json"],
  "openclaw": {
    "extensions": ["./dist/index.js"]
  }
}
```

2. Build your plugin:

```bash
npm run build
```

3. Publish:

```bash
npm publish --access public
```

4. Users can install:

```bash
openclaw plugins install @myorg/my-openclaw-plugin
```

### Channel Plugins (Optional Metadata)

If building a channel plugin, add discovery metadata:

```json
{
  "name": "@myorg/acmechat",
  "openclaw": {
    "extensions": ["./dist/index.js"],
    "channel": {
      "id": "acmechat",
      "label": "AcmeChat",
      "selectionLabel": "AcmeChat (API)",
      "docsPath": "/channels/acmechat",
      "blurb": "Chat via AcmeChat API",
      "order": 70,
      "aliases": ["acme"]
    },
    "install": {
      "npmSpec": "@myorg/acmechat",
      "defaultChoice": "npm"
    }
  }
}
```

## Dependency Management

### For NPM Packages

Install runtime dependencies in your package:

```bash
npm install node-fetch dotenv
```

These go in `dependencies` (or `peerDependencies` if OpenClaw provides them).

**Important:** Avoid using `workspace:*` for OpenClaw in `dependencies`. Instead, use `devDependencies`:

```json
{
  "dependencies": {
    "node-fetch": "^3.0.0"
  },
  "devDependencies": {
    "openclaw": "^2024.1.0"
  }
}
```

### For Local Plugins

Place all dependencies in `node_modules` or use bundled ones. TypeScript is supported natively.

## Common Patterns

### Error Handling

```ts
api.registerAgentTool({
  id: "my_tool",
  handler: async (input, context) => {
    try {
      const result = await operation(input);
      return { ok: true, data: result };
    } catch (error) {
      context.logger.error(`Tool failed: ${error.message}`);
      return {
        ok: false,
        error: `Failed to fetch data: ${error.message}`
      };
    }
  }
});
```

### Logging

```ts
api.logger.debug("Detailed info");
api.logger.info("User-visible info");
api.logger.warn("Warning");
api.logger.error("Error");
```

View logs:

```bash
openclaw logs --follow
openclaw logs --category my-plugin
```

### Async Operations

```ts
handler: async (input, context) => {
  // Tools support async operations
  const data = await fetchRemoteData(input.url);
  const processed = await processData(data);
  
  return { ok: true, data: processed };
}
```

### Stateful Plugins

Use files or environment to persist state:

```ts
import * as fs from "fs";

let state = {};

export default function register(api) {
  // Load state on startup
  const statePath = `${process.env.HOME}/.openclaw/my-plugin/state.json`;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch {
    state = {};
  }
  
  api.registerCommand({
    name: "increment",
    handler: async () => {
      state.count = (state.count ?? 0) + 1;
      fs.writeFileSync(statePath, JSON.stringify(state));
      return { text: `Count: ${state.count}` };
    }
  });
}
```

## Security Considerations

### Input Validation

Always validate and sanitize user input:

```ts
const inputSchema = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 500 }
  },
  required: ["query"]
};

// OpenClaw validates against schema before calling handler
```

### Secrets

Never log or expose API keys:

```ts
api.logger.info(`API Key: ${apiKey}`); // ❌ BAD
api.logger.info("API Key configured"); // ✅ GOOD

// Use the uiHints "sensitive" flag
"uiHints": {
  "apiKey": { "label": "API Key", "sensitive": true }
}
```

### Permissions

Check authorization in auto-reply commands:

```ts
api.registerCommand({
  name: "admin",
  requireAuth: true, // Requires authorized sender
  handler: async (ctx) => {
    if (!ctx.isAuthorizedSender) {
      return { text: "Unauthorized" };
    }
    // Admin logic
  }
});
```

## Troubleshooting

### Plugin Not Loading

1. Check manifest (`openclaw.plugin.json` exists)
2. Check id matches plugin directory
3. Check syntax errors in code (use `pnpm build` for TypeScript)
4. Look at logs: `openclaw logs --follow`
5. Verify config: `openclaw plugins list`

### Config Not Working

1. Config changes require Gateway restart
2. Check config schema validation: `openclaw plugins doctor`
3. Config keys are case-sensitive

### Tool Not Appearing

1. Verify `registerAgentTool` is called
2. Check tool id (must be `snake_case`)
3. Restart Gateway

### NPM Package Issues

1. Ensure `package.json` has `openclaw.extensions` field
2. Build TypeScript to JavaScript: `npm run build`
3. Point `main` field to built output (`dist/index.js`)

## Next Steps

- **Create a tool:** [Agent Tools Guide](/plugins/agent-tools)
- **Build a channel:** [Channel Plugin Reference](/channels/overview)
- **Deploy provider auth:** [Provider Authentication](/providers/overview)
- **Write hooks:** [Event Hooks](/hooks/custom-hooks)
- **See examples:** Check `extensions/*` in the OpenClaw repo

## Resources

- [Plugin Documentation](/plugins)
- [Plugin Manifest Format](/plugins/manifest)
- [Agent Tools API](/plugins/agent-tools)
- [Configuration](/configuration)
- [Community Plugins](https://github.com/openclaw/openclaw/discussions/categories/plugins)

## Support

- GitHub Issues: [openclaw/openclaw](https://github.com/openclaw/openclaw/issues)
- Discussions: [openclaw/openclaw/discussions](https://github.com/openclaw/openclaw/discussions)
- Docs: [docs.openclaw.ai](https://docs.openclaw.ai)
