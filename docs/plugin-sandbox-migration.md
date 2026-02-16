# Plugin Sandbox Migration Guide

## Overview

OpenClaw now enforces plugin sandboxing using `isolated-vm` to prevent security vulnerabilities. All plugins are executed in isolated V8 contexts with strict resource limits and permission controls.

## Security Improvements

The plugin sandbox prevents:

- **Filesystem access**: Plugins cannot read sensitive files (`/etc/passwd`, SSH keys, `.env`)
- **Network access**: No unauthorized network requests to exfiltrate data
- **Node.js built-ins**: No access to `fs`, `child_process`, `net`, `http`, etc. by default
- **Environment variables**: Process environment is not accessible by default
- **Resource exhaustion**: Memory and CPU limits prevent DoS attacks
- **Code injection**: `eval()` and `Function()` constructor are blocked

## Default Behavior

By default, all non-bundled plugins are sandboxed with these limits:

- **Memory limit**: 128MB
- **CPU timeout**: 5 seconds
- **No filesystem access**
- **No network access**
- **No Node.js built-ins**
- **No environment variables**

## Plugin Manifest Changes

### Adding Permissions

To request additional permissions, add a `permissions` field to your `openclaw.plugin.json`:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "configSchema": {},
  "permissions": {
    "memory": 256,
    "cpu": 10000,
    "filesystem": {
      "read": ["/path/to/safe/directory"],
      "write": ["/path/to/output/directory"]
    },
    "network": {
      "allowlist": ["api.example.com"]
    },
    "env": true,
    "envVars": ["MY_PLUGIN_API_KEY"]
  }
}
```

### Permission Fields

#### `memory` (number)

Maximum memory in MB. Default: 128MB, Max: 512MB.

```json
{
  "permissions": {
    "memory": 256
  }
}
```

#### `cpu` (number)

Maximum CPU time in milliseconds. Default: 5000ms, Max: 30000ms.

```json
{
  "permissions": {
    "cpu": 10000
  }
}
```

#### `filesystem` (object)

Paths allowed for read/write operations.

```json
{
  "permissions": {
    "filesystem": {
      "read": ["/workspace/data", "/tmp/plugin-cache"],
      "write": ["/workspace/output"]
    }
  }
}
```

#### `network` (object)

Network access controls.

```json
{
  "permissions": {
    "network": {
      "allowlist": ["api.example.com", "cdn.example.com"],
      "blocklist": ["evil.com"]
    }
  }
}
```

#### `env` (boolean)

Allow access to environment variables. Default: false.

```json
{
  "permissions": {
    "env": true,
    "envVars": ["API_KEY", "API_SECRET"]
  }
}
```

#### `nativeModules` (boolean)

Allow access to Node.js built-in modules. Default: false. **Use with extreme caution**.

```json
{
  "permissions": {
    "nativeModules": true,
    "allowedModules": ["path", "util"]
  }
}
```

### Disabling Sandbox (Not Recommended)

To disable sandboxing entirely (bundled plugins only):

```json
{
  "id": "trusted-plugin",
  "sandboxed": false,
  "configSchema": {}
}
```

**Warning**: Only disable sandboxing for trusted, internally-developed plugins. Third-party plugins should always be sandboxed.

## Migration Steps

### 1. Test Your Plugin

Run your plugin with default sandbox settings:

```bash
pnpm test src/plugins/plugin-sandbox.test.ts
```

### 2. Identify Required Permissions

If your plugin needs additional access, identify the minimum permissions required:

- Does it read/write files? → Add `filesystem` permissions
- Does it make API calls? → Add `network` permissions
- Does it need config from environment? → Add `env` permissions with specific `envVars`

### 3. Update Manifest

Add the `permissions` field to your `openclaw.plugin.json` with the minimum required permissions.

### 4. Test Again

Verify your plugin works with the specified permissions:

```bash
pnpm test
```

## Common Migration Issues

### Issue: Plugin tries to use `require()`

**Error**: `Module "fs" is not allowed by plugin permissions`

**Solution**: Sandboxed plugins cannot use `require()` for Node.js built-ins by default. Options:

1. **Refactor**: Remove dependency on Node.js built-ins
2. **Request permissions**: Add `nativeModules: true` and specify `allowedModules`
3. **Use Plugin API**: Use the provided `api.runtime` methods instead

### Issue: Plugin exceeds CPU timeout

**Error**: `Plugin exceeded CPU time limit (5000ms)`

**Solution**: Either:

1. Optimize your plugin code to be faster
2. Request higher CPU limit in manifest (max 30 seconds)

```json
{
  "permissions": {
    "cpu": 15000
  }
}
```

### Issue: Plugin exceeds memory limit

**Error**: Plugin execution fails with timeout (memory exhaustion)

**Solution**:

1. Optimize memory usage
2. Request higher memory limit (max 512MB)

```json
{
  "permissions": {
    "memory": 256
  }
}
```

## Best Practices

### 1. Principle of Least Privilege

Only request the minimum permissions your plugin needs:

```json
// ❌ Bad: Too broad
{
  "permissions": {
    "nativeModules": true,
    "env": true,
    "memory": 512
  }
}

// ✅ Good: Specific and minimal
{
  "permissions": {
    "network": {
      "allowlist": ["api.myservice.com"]
    },
    "memory": 128
  }
}
```

### 2. Avoid Node.js Built-ins

Instead of using Node.js modules directly, use the provided runtime API:

```javascript
// ❌ Bad: Requires nativeModules permission
const fs = require("fs");
const data = fs.readFileSync("/path/to/file");

// ✅ Good: Use plugin runtime API
export function register(api) {
  // Use api.runtime methods provided by OpenClaw
  const config = api.pluginConfig;
}
```

### 3. Document Required Permissions

Add comments to your manifest explaining why each permission is needed:

```json
{
  "permissions": {
    "network": {
      "// reason": "Required to fetch user data from API",
      "allowlist": ["api.example.com"]
    },
    "env": true,
    "// envVars reason": "API key stored in environment",
    "envVars": ["EXAMPLE_API_KEY"]
  }
}
```

## Security Considerations

### Plugin Distribution

- **Sign your plugins**: Use plugin signing to verify authenticity
- **Review third-party plugins**: Always audit code before installing untrusted plugins
- **Monitor permissions**: Check what permissions plugins request before enabling them

### For Plugin Developers

- **Never store secrets in code**: Use environment variables with explicit permission
- **Validate all inputs**: Don't trust data from external sources
- **Handle errors gracefully**: Timeouts and permission errors should not crash your plugin

### For OpenClaw Operators

- **Enable signature verification**: Set `requireSignature: true` in config
- **Audit plugin permissions**: Review manifest files before enabling new plugins
- **Use allowlists**: Only enable plugins from trusted sources

## Example: Migrating a Simple Plugin

### Before (Unsafe)

```javascript
// plugin.js
const fs = require("fs");
const https = require("https");

export function register(api) {
  api.registerTool({
    name: "fetch-data",
    execute: async () => {
      const apiKey = process.env.API_KEY;
      const response = await fetch(`https://api.example.com/data?key=${apiKey}`);
      const data = await response.json();
      fs.writeFileSync("/tmp/cache.json", JSON.stringify(data));
      return data;
    },
  });
}
```

### After (Safe)

```json
// openclaw.plugin.json
{
  "id": "data-fetcher",
  "name": "Data Fetcher",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" }
    }
  },
  "permissions": {
    "network": {
      "allowlist": ["api.example.com"]
    },
    "cpu": 10000
  }
}
```

```javascript
// plugin.js (refactored)
export function register(api) {
  api.registerTool({
    name: "fetch-data",
    execute: async () => {
      // Use config instead of environment variables
      const apiKey = api.pluginConfig.apiKey;

      // Fetch is available in isolated-vm context
      const response = await fetch(`https://api.example.com/data?key=${apiKey}`);
      const data = await response.json();

      // Return data instead of writing to filesystem
      return data;
    },
  });
}
```

## Testing Your Sandboxed Plugin

Create a test file to verify sandbox behavior:

```typescript
import { describe, it, expect } from "vitest";
import { executeSandboxedPlugin } from "./plugin-sandbox";

describe("My Plugin Security", () => {
  it("should not access filesystem without permission", async () => {
    const result = await executeSandboxedPlugin({
      pluginId: "my-plugin",
      pluginSource: "plugin.js",
      filePath: "./plugin.js",
      permissions: {},
    });

    expect(result.success).toBe(true);
  });
});
```

## Support

If you encounter issues migrating your plugin, please:

1. Check the [security tests](../src/plugins/plugin-sandbox.test.ts) for examples
2. Review the [plugin permissions API](../src/plugins/plugin-permissions.ts)
3. Open an issue with details about your use case

## CVSS 9.8 Fix

This sandbox implementation addresses the critical vulnerability (CVSS 9.8) where plugins had unrestricted access to:

- System files and credentials
- Network resources
- Process spawning
- Environment variables
- Arbitrary code execution

All plugins now run in isolated contexts with enforced resource limits and permission controls.
