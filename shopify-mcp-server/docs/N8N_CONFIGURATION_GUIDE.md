# n8n Configuration Guide for Shopify MCP Server

## Overview

This guide explains how to configure the Shopify MCP server in n8n after the credential simplification update.

## Configuration Steps

### 1. MCP Node Settings

In the n8n MCP node, use these settings:

**Command Configuration:**

- **Command**: `node`
- **Arguments**: `/opt/mcp-servers/shopify-mcp-server/n8n-shopify-mcp-simplified.cjs`

**Alternative (using the original wrapper):**

- **Arguments**: `/opt/mcp-servers/shopify-mcp-server/n8n-shopify-mcp.cjs`

### 2. Credentials Configuration

Create or update your Shopify MCP credentials with only ONE environment variable:

**Environment Variables:**

```
SHOPIFY_ACCESS_TOKEN=shpat_EXAMPLE_REPLACE_WITH_YOUR_TOKEN
```

That's it! The domain `vividwalls-2.myshopify.com` is now hardcoded in the server, so you don't need to provide it.

### 3. Optional Environment Variables

You can optionally set:

- `SHOPIFY_API_VERSION`: API version (default: "2024-01")
- `DEBUG`: Set to "true" for debug logging

## Available Tools

Once configured, you'll have access to 58 Shopify tools including:

### Store Management

- `get-shop` - Get shop details
- `get-shop-details` - Get extended shop details

### Product Management

- `get-products` - Get all products or search by title
- `get-products-by-collection` - Get products from a collection
- `get-products-by-ids` - Get specific products

### Order Management

- `get-orders` - Get orders with filtering
- `get-order` - Get a specific order

### Customer Management

- `get-customers` - Get customers
- `tag-customer` - Add tags to customers

### Theme Development

- `get-themes` - List all themes
- `create-theme` - Create new theme
- `theme-pull` - Download theme files
- `theme-push` - Upload theme files

And many more!

## Testing the Configuration

To test if your configuration is working:

1. Add the MCP node to your n8n workflow
2. Configure it with the settings above
3. Connect it to a Function node with this code:

```javascript
const result = await $input.item.json;
return {
  tools_count: result.tools ? result.tools.length : 0,
  server_info: result.serverInfo || "No server info",
};
```

4. Run the workflow - you should see 58 tools available

## Troubleshooting

### Authentication Errors

- Verify your `SHOPIFY_ACCESS_TOKEN` is correct
- Check that the token has the necessary permissions

### Connection Issues

- Ensure the MCP server is deployed at `/opt/mcp-servers/shopify-mcp-server/`
- Check that the wrapper script is executable: `chmod +x n8n-shopify-mcp-simplified.cjs`

### Using the Original Wrapper

If you're using the original `n8n-shopify-mcp.cjs` wrapper, you'll also need:

```
SHOPIFY_STORE_URL=vividwalls-2.myshopify.com
```

However, we recommend using the simplified wrapper (`n8n-shopify-mcp-simplified.cjs`) for easier configuration.

## Migration from Old Configuration

If you were previously using two environment variables:

1. Remove `MYSHOPIFY_DOMAIN` or `SHOPIFY_STORE_URL` from your credentials
2. Keep only `SHOPIFY_ACCESS_TOKEN`
3. Update the wrapper script path to use `n8n-shopify-mcp-simplified.cjs`

## Benefits of Simplified Configuration

- **Fewer credentials to manage**: Only one environment variable needed
- **Less error-prone**: No domain configuration mistakes
- **Easier deployment**: Simplified credential rotation
- **Better security**: Fewer exposed configuration values
