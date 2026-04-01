# Fixing n8n Blank Value Override Issue

## Problem

When configuring Shopify MCP credentials in n8n, you may encounter:

```
__n8n_BLANK_VALUE_e5362baf-c777-4d57-a609-6eaf1f9e87f6
```

This blank placeholder overrides your actual Shopify API key.

## Solutions

### Solution 1: Use Expression Mode

1. In the MCP node, click on the credentials field
2. Switch from "Fixed" to "Expression" mode (toggle the `=` button)
3. Enter the credential as an expression:
   ```
   {{ $credentials.SHOPIFY_ACCESS_TOKEN }}
   ```

### Solution 2: Create New Credential Type

1. Delete the existing credential
2. Create a new credential with type "Header Auth" instead of generic
3. Set:
   - Name: `SHOPIFY_ACCESS_TOKEN`
   - Value: `shpat_EXAMPLE_REPLACE_WITH_YOUR_TOKEN`

### Solution 3: Direct Environment Variable

In the MCP node environment variables section, use:

```json
{
  "SHOPIFY_ACCESS_TOKEN": "shpat_EXAMPLE_REPLACE_WITH_YOUR_TOKEN"
}
```

### Solution 4: Use a Set Node First

1. Add a Set node before the MCP node
2. In the Set node, create a field:
   - Name: `shopify_token`
   - Value: `shpat_EXAMPLE_REPLACE_WITH_YOUR_TOKEN`
3. In the MCP node environment, reference it:
   ```json
   {
     "SHOPIFY_ACCESS_TOKEN": "{{ $json.shopify_token }}"
   }
   ```

### Solution 5: Hardcode in Wrapper (Not Recommended)

Create a custom wrapper that hardcodes the token:

```javascript
#!/usr/bin/env node
const { spawn } = require("child_process");

// Hardcode the token here
const SHOPIFY_TOKEN = "shpat_EXAMPLE_REPLACE_WITH_YOUR_TOKEN";

const env = {
  ...process.env,
  SHOPIFY_ACCESS_TOKEN: SHOPIFY_TOKEN,
  NODE_ENV: "production",
};

const serverProcess = spawn("node", ["build/index.js"], {
  env: env,
  stdio: "inherit",
  cwd: __dirname,
});

// ... rest of wrapper code
```

## Recommended Approach

For n8n, the most reliable method is **Solution 3** - using direct environment variables in the MCP node configuration:

1. In the MCP node, find the "Environment Variables" section
2. Add your variable directly:
   ```json
   {
     "SHOPIFY_ACCESS_TOKEN": "shpat_EXAMPLE_REPLACE_WITH_YOUR_TOKEN"
   }
   ```
3. Leave the credentials field empty or remove it

This bypasses n8n's credential management system and passes the environment variable directly to the MCP server.

## Testing the Fix

After applying the fix, test with a simple Function node:

```javascript
// Request to list tools
return {
  json: {
    jsonrpc: "2.0",
    method: "tools/list",
    id: 1,
  },
};
```

You should receive a response with 58 tools if the authentication is working correctly.
