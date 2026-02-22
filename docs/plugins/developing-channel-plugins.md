# Developing Channel Plugins

This guide explains how to create, package, and distribute custom channel plugins for OpenClaw. Channel plugins enable OpenClaw to communicate through different messaging platforms.

## Overview

Channel plugins are dynamically loaded TypeScript/JavaScript modules that implement the `ChannelPlugin` interface. They can be:

- **Bundled**: Included in the OpenClaw codebase (official channels)
- **External**: Loaded from npm packages, local directories, or Git repositories

## Quick Start

### 1. Project Structure

Create a new directory for your channel plugin:

```bash
mkdir my-channel-plugin
cd my-channel-plugin
pnpm init
```

Recommended structure:

```
my-channel-plugin/
├── package.json           # Package configuration with OpenClaw metadata
├── tsconfig.json          # TypeScript configuration
├── src/
│   ├── index.ts           # Plugin entry point (required)
│   ├── channel.ts         # Channel definition
│   ├── runtime.ts         # Runtime adapter implementations
│   └── types.ts           # TypeScript type definitions
├── openclaw.plugin.json   # Plugin manifest (optional)
└── README.md              # Documentation
```

### 2. package.json Configuration

Add OpenClaw-specific metadata to your `package.json`:

```json
{
  "name": "@yourorg/openclaw-my-channel",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "peerDependencies": {
    "openclaw": ">=2026.0.0"
  },
  "dependencies": {
    // Your channel-specific dependencies
  },
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "pnpm build"
  },
  "openclaw": {
    "extensions": ["./dist/index.js"],
    "channel": {
      "id": "my-channel",
      "label": "My Channel",
      "category": "messaging"
    }
  }
}
```

**Key fields**:

- `openclaw.extensions`: Array of entry points for dynamic loading
- `openclaw.channel.id`: Unique channel identifier (lowercase, hyphens allowed)
- `openclaw.channel.label`: Human-readable channel name
- `openclaw.channel.category`: Optional category for organization (e.g., "email", "messaging", "social")

### 3. Plugin Entry Point

Create `src/index.ts`:

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { buildSimpleChannelConfigSchema } from "openclaw/plugin-sdk";
import { myChannelPlugin } from "./channel.js";

const plugin = {
  id: "my-channel",
  name: "My Channel",
  description: "Description of your channel plugin",
  configSchema: buildSimpleChannelConfigSchema({
    accountProperties: {
      apiKey: {
        type: "string",
        description: "API key for authentication",
      },
      region: {
        type: "string",
        enum: ["us", "eu", "asia"],
        description: "API region",
      },
    },
  }),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: myChannelPlugin });
  },
};

export default plugin;
```

### 4. Channel Definition

Create `src/channel.ts`:

```typescript
import type { ChannelPlugin } from "openclaw/plugin-sdk";

export const myChannelPlugin: ChannelPlugin = {
  id: "my-channel",
  meta: {
    label: "My Channel",
    discovery: {
      category: "messaging",
      keywords: ["chat", "messaging"],
      maturity: "stable",
      docsLink: "https://github.com/yourorg/openclaw-my-channel",
      author: "Your Name",
    },
  },
  capabilities: {
    // Define what your channel supports
    canSendText: true,
    canSendMedia: true,
    canSendFiles: true,
    canReceiveReadReceipts: false,
    // ... other capabilities
  },
  config: {
    // Configuration adapter implementation
    resolveAccount(cfg, accountId) {
      // Resolve account configuration
      return {
        // Return resolved account data
      };
    },
    listAccountIds(cfg) {
      // List available account IDs
      return Object.keys(cfg.channels?.myChannel?.accounts ?? {});
    },
  },
  outbound: {
    // Implement outbound messaging
    async send(context, target, payload) {
      // Send message logic
    },
  },
  // Add other adapters as needed...
};
```

## Configuration Schema

### Using Simple Schema Helper

For most channels, use `buildSimpleChannelConfigSchema`:

```typescript
import { buildSimpleChannelConfigSchema } from "openclaw/plugin-sdk";

const configSchema = buildSimpleChannelConfigSchema({
  accountProperties: {
    apiKey: {
      type: "string",
      description: "API key for authentication",
    },
    webhookSecret: {
      type: "string",
      description: "Webhook verification secret",
      sensitive: true, // Will be masked in UI
    },
  },
  supportsMultipleAccounts: true, // Default: true
});
```

### Using Zod Schema

For more complex validation, use Zod:

```typescript
import { z } from "zod";
import { buildSimpleZodChannelConfigSchema } from "openclaw/plugin-sdk";

const accountSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
  region: z.enum(["us", "eu", "asia"]),
  enabled: z.boolean().default(true),
});

const configSchema = buildSimpleZodChannelConfigSchema(accountSchema);
```

### Manual Schema Definition

For full control, define the schema manually:

```typescript
import { buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

const fullSchema = z.object({
  enabled: z.boolean().optional(),
  accounts: z.record(
    z.object({
      apiKey: z.string(),
      enabled: z.boolean().default(true),
      // ... other fields
    }),
  ),
});

const configSchema = buildChannelConfigSchema(fullSchema);
```

## Channel Adapters

### Core Adapters

#### Config Adapter (Required)

Handles account configuration resolution:

```typescript
config: {
  resolveAccount(cfg, accountId) {
    const account = cfg.channels?.myChannel?.accounts?.[accountId];
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }
    return {
      accountId,
      apiKey: account.apiKey,
      // ... other resolved properties
    };
  },
  listAccountIds(cfg) {
    return Object.keys(cfg.channels?.myChannel?.accounts ?? {});
  }
}
```

#### Outbound Adapter (Required for sending)

Handles message sending:

```typescript
outbound: {
  async send(context, target, payload) {
    const { text, media, files } = payload;

    // Implement your sending logic
    const response = await fetch("https://api.example.com/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${context.account.apiKey}`
      },
      body: JSON.stringify({
        to: target.peerId,
        message: text
      })
    });

    return {
      externalId: await response.json().id
    };
  }
}
```

#### Status Adapter

Report channel health and issues:

```typescript
status: {
  async probe(account) {
    // Test connectivity
    const connected = await testConnection(account);
    return {
      ok: connected,
      issues: connected ? [] : [{ kind: "connection", message: "Failed to connect" }]
    };
  }
}
```

### Optional Adapters

- **setup**: Initial account setup wizard
- **pairing**: Device pairing flows
- **security**: DM/group policy enforcement
- **groups**: Group chat management
- **mentions**: @mention handling
- **streaming**: Streaming message support
- **threading**: Thread/reply support
- **messaging**: Inbound message handling
- **directory**: Contact/group directory
- **gateway**: Custom HTTP endpoints
- **commands**: Custom slash commands
- **heartbeat**: Periodic health checks

See the [Channel Adapter Reference](./channel-adapters.md) for detailed documentation.

## Development Workflow

### Local Development

1. **Link for testing**:

```bash
# In your plugin directory
pnpm link --global

# In OpenClaw directory
pnpm link --global @yourorg/openclaw-my-channel
```

2. **Configure OpenClaw to load the plugin**:

Edit `~/.config/openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/projects/my-channel-plugin"]
    }
  },
  "channels": {
    "myChannel": {
      "accounts": {
        "default": {
          "apiKey": "your-api-key",
          "region": "us"
        }
      }
    }
  }
}
```

3. **Start OpenClaw in development mode**:

```bash
pnpm dev
```

### Testing

Create unit tests for your channel:

```typescript
// src/channel.test.ts
import { describe, it, expect } from "vitest";
import { myChannelPlugin } from "./channel.js";

describe("My Channel Plugin", () => {
  it("should have correct metadata", () => {
    expect(myChannelPlugin.id).toBe("my-channel");
    expect(myChannelPlugin.meta.label).toBe("My Channel");
  });

  // Add more tests...
});
```

## Distribution

### npm Package

1. **Build your package**:

```bash
pnpm build
```

2. **Publish to npm**:

```bash
npm publish --access public
```

3. **Users install via**:

```bash
pnpm add @yourorg/openclaw-my-channel
```

Then configure in `openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["node_modules/@yourorg/openclaw-my-channel"]
    }
  }
}
```

### GitHub Repository

Users can load directly from GitHub:

```json
{
  "plugins": {
    "load": {
      "paths": ["github:yourorg/openclaw-my-channel#v1.0.0"]
    }
  }
}
```

### Local Path

For private or development versions:

```json
{
  "plugins": {
    "load": {
      "paths": ["../my-channel-plugin"]
    }
  }
}
```

## Best Practices

### 1. Error Handling

Always handle errors gracefully:

```typescript
outbound: {
  async send(context, target, payload) {
    try {
      const response = await api.send(target, payload);
      return { externalId: response.id };
    } catch (error) {
      context.log("error", "Failed to send message", { error });
      throw error;  // Re-throw for proper handling
    }
  }
}
```

### 2. Logging

Use the provided logger:

```typescript
context.log("info", "Message sent successfully", {
  messageId,
  target: target.peerId,
});
```

Log levels: `debug`, `info`, `warn`, `error`

### 3. Type Safety

Export TypeScript types for users:

```typescript
// src/types.ts
export interface MyChannelAccountConfig {
  apiKey: string;
  region: "us" | "eu" | "asia";
  enabled?: boolean;
}

export interface MyChannelConfig {
  enabled?: boolean;
  accounts?: Record<string, MyChannelAccountConfig>;
}
```

### 4. Documentation

Include comprehensive README.md:

- Installation instructions
- Configuration examples
- Feature list and limitations
- Troubleshooting guide
- License information

### 5. Versioning

Follow semantic versioning:

- **MAJOR**: Breaking changes
- **MINOR**: New features, backward compatible
- **PATCH**: Bug fixes

### 6. Security

- Mark sensitive fields in config schema
- Validate all external inputs
- Use environment variables for secrets
- Never log sensitive data

```typescript
configSchema: buildSimpleChannelConfigSchema({
  accountProperties: {
    apiKey: {
      type: "string",
      description: "API key",
      sensitive: true, // Will be masked in logs and UI
    },
  },
});
```

## Troubleshooting

### Plugin Not Loading

1. Check the plugin path in `openclaw.json`
2. Verify `openclaw.extensions` in `package.json` points to built files
3. Run `pnpm build` in your plugin directory
4. Check OpenClaw logs for loading errors

### Configuration Not Working

1. Validate your JSON schema structure
2. Check field names match your adapter expectations
3. Test with a minimal configuration first
4. Use the `openclaw config validate` CLI command

### Runtime Errors

1. Enable debug logging: `export LOG_LEVEL=debug`
2. Check for missing dependencies
3. Verify API credentials and connectivity
4. Test adapters individually

## Examples

### Minimal Channel

```typescript
// src/index.ts
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { buildSimpleChannelConfigSchema } from "openclaw/plugin-sdk";

const plugin = {
  id: "minimal",
  name: "Minimal Channel",
  configSchema: buildSimpleChannelConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({
      plugin: {
        id: "minimal",
        meta: { label: "Minimal Channel" },
        capabilities: { canSendText: true },
        config: {
          resolveAccount: () => ({ accountId: "default" }),
          listAccountIds: () => ["default"],
        },
        outbound: {
          async send(context, target, payload) {
            console.log("Sending:", payload.text);
            return { externalId: Date.now().toString() };
          },
        },
      },
    });
  },
};

export default plugin;
```

### Full Featured Channel

See the [Email Channel](https://github.com/openclaw/openclaw-email-channel) repository for a complete example with:

- IMAP/SMTP integration
- Multi-account support
- Media attachments
- Security policies
- Status monitoring
- Comprehensive error handling

## Resources

- [Plugin Manifest Specification](./manifest.md)
- [Channel Adapter Reference](./channel-adapters.md)
- [Community Plugins](./community.md)
- [OpenClaw API Documentation](../api/README.md)

## Getting Help

- **GitHub Issues**: [openclaw/openclaw](https://github.com/openclaw/openclaw/issues)
- **Discord**: [Join our community](https://discord.gg/openclaw)
- **Documentation**: [docs.openclaw.dev](https://docs.openclaw.dev)
