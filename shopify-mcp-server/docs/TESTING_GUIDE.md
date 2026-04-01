# Shopify MCP Server Testing Guide

## Overview

This guide explains how to run comprehensive tests for the Shopify MCP Server to verify that all tools work as designed.

## Test Structure

The test suite includes:

1. **Unit Tests**
   - `ShopifyClient.test.ts` - Tests the Shopify API client functionality
   - `AdminFeatures.test.ts` - Tests admin-specific features

2. **Integration Tests**
   - `McpServerIntegration.test.ts` - Comprehensive test of all MCP tools

## Running Tests

### Quick Start

Run all tests comprehensively:

```bash
npm run test:comprehensive
```

This will:

1. Build the project
2. Run unit tests
3. Run admin feature tests
4. Run comprehensive MCP integration tests
5. Provide a summary of results

### Individual Test Suites

Run specific test suites:

```bash
# Run only MCP integration tests
npm run test:mcp

# Run only ShopifyClient tests
npm run test:client

# Run only admin features tests
npm run test:admin

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch
```

## Test Coverage

The comprehensive MCP integration test (`McpServerIntegration.test.ts`) covers all available tools:

### Product Management Tools

- ✅ `get-products` - Search and list products
- ✅ `get-products-by-collection` - Get products from specific collections
- ✅ `get-products-by-ids` - Get specific products by ID
- ✅ `get-variants-by-ids` - Get product variants

### Customer Management Tools

- ✅ `get-customers` - List customers with pagination
- ✅ `tag-customer` - Add tags to customers

### Order Management Tools

- ✅ `get-orders` - List orders with filtering
- ✅ `get-order` - Get specific order details

### Discount & Pricing Tools

- ✅ `create-discount` - Create discount codes

### Draft Order Tools

- ✅ `create-draft-order` - Create draft orders
- ✅ `complete-draft-order` - Complete draft orders

### Shop Information Tools

- ✅ `get-shop` - Get basic shop information
- ✅ `get-shop-details` - Get extended shop details
- ✅ `get-collections` - List collections

### Webhook Management Tools

- ✅ `manage-webhook` - Subscribe/unsubscribe webhooks

### Content Management Tools

- ✅ `get-pages` - List store pages
- ✅ `get-page` - Get specific page
- ✅ `create-page` - Create new pages
- ✅ `update-page` - Update existing pages
- ✅ `delete-page` - Delete pages

### Navigation Tools

- ✅ `get-navigation-menus` - List navigation menus
- ✅ `create-navigation-menu` - Create menus
- ✅ `get-menu-items` - Get menu items
- ✅ `create-menu-item` - Create menu items

### Theme Management Tools

- ✅ `get-themes` - List themes
- ✅ `get-theme` - Get theme details
- ✅ `create-theme` - Create new themes
- ✅ `duplicate-theme` - Duplicate themes
- ✅ `get-theme-assets` - List theme assets
- ✅ `get-theme-asset` - Get specific asset
- ✅ `update-theme-asset` - Update assets
- ✅ `get-theme-settings` - Get theme settings
- ✅ `update-theme-settings` - Update settings

### Theme Development Tools

- ✅ `theme-create` - Create theme from template
- ✅ `theme-pull` - Pull theme from Shopify
- ✅ `theme-push` - Push theme to Shopify
- ✅ `theme-dev` - Start development server
- ✅ `theme-check` - Validate theme
- ✅ `theme-package` - Package theme
- ✅ `theme-extract` - Extract theme archive
- ✅ `theme-files-list` - List theme files
- ✅ `theme-generate` - Generate theme
- ✅ `shopify-cli-init` - Initialize Shopify CLI
- ✅ `theme-file-read` - Read theme files
- ✅ `theme-file-write` - Write theme files
- ✅ `theme-file-create` - Create new files
- ✅ `theme-file-delete` - Delete files
- ✅ `theme-file-rename` - Rename files
- ✅ `theme-search-replace` - Search and replace
- ✅ `theme-snippet-create` - Create snippets
- ✅ `theme-section-create` - Create sections
- ✅ `theme-template-create` - Create templates

## Test Environment

### Mock Mode (Default)

Tests run with mocked Shopify API responses by default. This is suitable for:

- CI/CD pipelines
- Local development
- Verifying MCP protocol implementation

### Live Mode

To test against a real Shopify store:

```bash
export SHOPIFY_ACCESS_TOKEN="your_token"
npm run test:comprehensive
```

⚠️ **Warning**: Live mode will interact with your actual Shopify store. Use a development store for testing.

## Error Testing

The test suite includes comprehensive error handling tests:

- Invalid tool names
- Missing required arguments
- API error handling
- Network failures
- Invalid input validation

## Writing New Tests

When adding new tools to the MCP server:

1. Add test cases to `McpServerIntegration.test.ts`
2. Include both success and error scenarios
3. Mock the ShopifyClient method if needed
4. Run the comprehensive test suite

Example test structure:

```typescript
test("tool-name should perform expected action", async () => {
  const response = await client.request("tools/call", {
    name: "tool-name",
    arguments: {
      // Required arguments
    },
  });

  expect(response.content).toBeDefined();
  // Add specific assertions
});
```

## Troubleshooting

### Common Issues

1. **Tests fail with "Tool not found"**
   - Ensure the server is properly initialized
   - Check that all tools are registered

2. **Mock not working**
   - Verify jest mocks are set up before imports
   - Check mock implementation matches expected interface

3. **Timeout errors**
   - Increase Jest timeout for integration tests
   - Check for unresolved promises

### Debug Mode

Run tests with verbose output:

```bash
DEBUG=* npm test
```

## Continuous Integration

The test suite is designed to run in CI environments:

```yaml
# Example GitHub Actions workflow
- name: Run Tests
  run: |
    npm ci
    npm run build
    npm run test:comprehensive
```

## Performance

- Unit tests: ~2-5 seconds
- Integration tests: ~10-15 seconds
- Full comprehensive test: ~20-30 seconds

Tests use mocked responses for speed and reliability.
