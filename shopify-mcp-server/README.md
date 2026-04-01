# Shopify Admin MCP Server

A focused Model Context Protocol (MCP) server for Shopify store administration and management. Provides comprehensive tools for managing products, orders, customers, collections, pages, navigation, themes, and store settings through GraphQL API.

<a href="https://glama.ai/mcp/servers/bemvhpy885"><img width="380" height="200" src="https://glama.ai/mcp/servers/bemvhpy885/badge" alt="Shopify Admin MCP Server" /></a>

## 🌟 Features

### Core Shopify Admin Operations

- **Product Management**: Search, retrieve, and manage product information
- **Customer Management**: Load customer data and manage customer tags
- **Order Management**: Advanced order querying, filtering, and draft order creation
- **Collection Management**: Manage product collections and organization
- **Page Management**: Create, update, and manage store pages
- **Navigation Management**: Manage menus and navigation items
- **Theme Management**: Basic theme operations and asset management
- **Discount Management**: Create and manage discount codes
- **Webhook Management**: Subscribe, find, and manage webhooks
- **Store Information**: Access shop details and configuration
- **GraphQL Integration**: Direct integration with Shopify's GraphQL Admin API
- **Custom Queries**: Execute custom GraphQL queries for advanced operations

## 🚀 Quick Start

### Prerequisites

1. Node.js (version 16 or higher)
2. Shopify Custom App Access Token (see setup instructions below)

### Installation

1. **Clone and Install**:

   ```bash
   git clone https://github.com/pashpashpash/shopify-admin-mcp-server.git
   cd shopify-admin-mcp-server
   npm install
   npm run build
   ```

2. **Environment Setup**:

   ```bash
   cp .env.example .env
   # Edit .env with your Shopify access token
   ```

3. **Configure for Claude Desktop**:
   Add to your `claude_desktop_config.json`:

   ```json
   {
     "mcpServers": {
       "shopify-admin": {
         "command": "node",
         "args": ["path/to/shopify-admin-mcp-server/build/index.js"],
         "env": {
           "SHOPIFY_ACCESS_TOKEN": "your_access_token"
         }
       }
     }
   }
   ```

   **Note**: This server is configured for the VividWalls Shopify store (vividwalls-2.myshopify.com). The store domain is hardcoded for simplified credential management.

## 📚 Available MCP Tools

### Product Management

- `get-products` - Get all products or search by title
- `get-products-by-collection` - Get products from a specific collection
- `get-products-by-ids` - Get products by their IDs
- `get-variants-by-ids` - Get product variants by their IDs

### Customer Management

- `get-customers` - Get customers with pagination support
- `tag-customer` - Add tags to a customer

### Order Management

- `get-orders` - Get orders with advanced filtering and sorting
- `get-order` - Get a single order by ID
- `create-draft-order` - Create a draft order
- `complete-draft-order` - Complete a draft order

### Collection Management

- `get-collections` - Get all collections

### Page Management

- `get-pages` - Get all pages from the store
- `get-page` - Get a specific page by ID
- `create-page` - Create a new page in the store
- `update-page` - Update an existing page
- `delete-page` - Delete a page from the store

### Navigation Management

- `get-navigation-menus` - Get all navigation menus
- `create-navigation-menu` - Create a new navigation menu
- `get-menu-items` - Get menu items for a specific navigation menu
- `create-menu-item` - Create a new menu item

### Theme Management

- `get-themes` - Get all themes in the store
- `get-theme` - Get a specific theme by ID
- `create-theme` - Create a new theme
- `duplicate-theme` - Duplicate an existing theme
- `get-theme-assets` - Get all assets for a specific theme
- `get-theme-asset` - Get a specific theme asset
- `update-theme-asset` - Update a theme asset
- `get-theme-settings` - Get theme settings
- `update-theme-settings` - Update theme settings

### Discount Management

- `create-discount` - Create a basic discount code

### Store Information

- `get-shop` - Get basic shop details
- `get-shop-details` - Get extended shop details including shipping countries

### Webhook Management

- `manage-webhook` - Subscribe, find, or unsubscribe webhooks

### Advanced Operations

- `custom-graphql-query` - Execute custom GraphQL queries against Shopify Admin API

## 🔧 Configuration

### Shopify Setup

1. From your Shopify admin, go to **Settings** > **Apps and sales channels**
2. Click **Develop apps** and create a new app
3. Configure Admin API scopes:
   - `read_products`, `write_products`
   - `read_customers`, `write_customers`
   - `read_orders`, `write_orders`
   - `read_themes`, `write_themes`
   - `read_content`, `write_content`
   - `read_discounts`, `write_discounts`
4. Install the app and copy your **Admin API access token**

### Environment Variables

Create a `.env` file:

```
SHOPIFY_ACCESS_TOKEN=your_access_token
```

**Note**: The Shopify store domain (vividwalls-2.myshopify.com) is hardcoded in the server for simplified credential management.

## 🛠️ Development

### Testing

```bash
npm test                   # Run all tests
npm run test:client       # Test Shopify client
npm run test:admin        # Test admin features
npm run test:mcp          # Test MCP integration
npm run test:watch        # Run tests in watch mode
```

### Building

```bash
npm run build             # Build the project
npm run dev               # Build and start in development mode
```

## 🔍 Troubleshooting

### Common Issues

1. **Authentication Errors**:
   - Verify your Shopify access token
   - Ensure all required API scopes are enabled

2. **GraphQL Errors**:
   - Check rate limits
   - Verify query syntax
   - Review MCP logs: `tail -f ~/Library/Logs/Claude/mcp*.log`

3. **Connection Issues**:
   - Verify network connectivity
   - Check firewall settings
   - Ensure proper environment variable configuration

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🔗 Links

- [Shopify GraphQL API](https://shopify.dev/api/admin-graphql)
- [MCP Protocol](https://github.com/modelcontextprotocol)

---

**Note**: This is a focused MCP server for Shopify admin operations. It provides essential store management capabilities through a clean, well-documented API interface.
