# Shopify MCP Server - n8n Credential Simplification

## Overview

The Shopify MCP server has been modified to simplify credential management for n8n integration. Previously, the server required two environment variables:

- `SHOPIFY_ACCESS_TOKEN` - API key for authentication
- `MYSHOPIFY_DOMAIN` - Shopify store URL

Now, only the `SHOPIFY_ACCESS_TOKEN` is required as an environment variable.

## Changes Made

### 1. Hardcoded Domain

The Shopify domain `vividwalls-2.myshopify.com` is now hardcoded in the server code (`src/index.ts`):

```typescript
// Hardcoded Shopify domain for simplified credential management
const MYSHOPIFY_DOMAIN = "vividwalls-2.myshopify.com";
```

### 2. Removed Environment Variable Check

The server no longer checks for or requires the `MYSHOPIFY_DOMAIN` environment variable at startup.

## Benefits for n8n Integration

1. **Simplified Credential Management**: n8n only needs to manage a single credential (the API token) instead of two.

2. **Reduced Configuration Errors**: Eliminates the possibility of domain misconfiguration.

3. **Easier Secret Management**: Only one secret needs to be stored and rotated.

## n8n Configuration

### Before (Two credentials required):

```json
{
  "credentials": {
    "shopifyApi": {
      "accessToken": "{{ $credentials.shopifyApi.accessToken }}",
      "shopDomain": "{{ $credentials.shopifyApi.shopDomain }}"
    }
  }
}
```

### After (Single credential):

```json
{
  "credentials": {
    "shopifyApi": {
      "accessToken": "{{ $credentials.shopifyApi.accessToken }}"
    }
  }
}
```

## MCP Client Configuration

When configuring the MCP client in n8n or other tools, only provide the access token:

```json
{
  "env": {
    "SHOPIFY_ACCESS_TOKEN": "your_access_token"
  }
}
```

## Important Notes

1. **Store-Specific**: This server is now specifically configured for the VividWalls store (vividwalls-2.myshopify.com). To use with a different store, the hardcoded domain in `src/index.ts` must be changed.

2. **Security**: The API token remains sensitive and should be properly secured in n8n's credential store.

3. **Deployment**: When deploying to production, ensure the server code matches the intended Shopify store.

## Reverting Changes

If you need to make the domain configurable again:

1. Edit `src/index.ts`
2. Replace the hardcoded domain with:
   ```typescript
   const MYSHOPIFY_DOMAIN = process.env.MYSHOPIFY_DOMAIN;
   if (!MYSHOPIFY_DOMAIN) {
     console.error("Error: MYSHOPIFY_DOMAIN environment variable is required");
     process.exit(1);
   }
   ```
3. Update all documentation accordingly
