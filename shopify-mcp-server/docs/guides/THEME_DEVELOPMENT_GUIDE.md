# Shopify Theme Development Guide

This guide covers the enhanced Shopify MCP server with full theme development capabilities using the Shopify CLI and custom scripts.

## Table of Contents

1. [Overview](#overview)
2. [Setup](#setup)
3. [Theme Development Tools](#theme-development-tools)
4. [MCP Tools Reference](#mcp-tools-reference)
5. [CLI Scripts](#cli-scripts)
6. [Workflows](#workflows)
7. [Best Practices](#best-practices)
8. [Troubleshooting](#troubleshooting)

## Overview

The enhanced Shopify MCP server provides comprehensive theme development capabilities including:

- **Theme Creation**: Create themes from scratch, templates, or by cloning existing themes
- **Development Server**: Live preview with hot reloading
- **Theme Management**: Pull, push, sync, and deploy themes
- **Code Quality**: Syntax checking and validation
- **Asset Management**: Package, extract, and manage theme files
- **GraphQL Integration**: Advanced API access and schema introspection

## Setup

### Prerequisites

1. **Shopify CLI**: Install the official Shopify CLI

   ```bash
   npm install -g @shopify/cli @shopify/theme
   ```

2. **Shopify Store Access**: You need:
   - Store URL (e.g., `your-store.myshopify.com`)
   - Private app access token with theme permissions

3. **Environment Variables**:
   ```bash
   export SHOPIFY_ACCESS_TOKEN="your_access_token"
   export MYSHOPIFY_DOMAIN="your-store.myshopify.com"
   export THEME_WORKSPACE="./themes"  # Optional, defaults to ./themes
   ```

### Installation

1. Install dependencies:

   ```bash
   npm install
   ```

2. Build the MCP server:

   ```bash
   npm run build
   ```

3. Initialize Shopify CLI configuration:
   ```bash
   npm run theme:create
   ```

## Theme Development Tools

### ✅ NEW: Theme File Editing Capabilities Added!

The Shopify MCP server now includes comprehensive theme file editing tools:

#### 🎯 Core Editing Features:

- **File Operations**: Read, write, create, delete, rename/move theme files
- **Search & Replace**: Powerful text replacement across multiple files with regex support
- **Content Creation**: Generate snippets, sections, and templates from customizable templates
- **Settings Management**: Update theme settings schema and data
- **Localization**: Manage theme translations and locale files
- **Asset Management**: Upload and optimize theme assets

#### 📝 New MCP Tools for Theme Editing:

- `theme-file-read` - Read any theme file contents
- `theme-file-write` - Write content to theme files with backup support
- `theme-file-create` - Create new files from templates
- `theme-file-delete` - Delete files with optional backup
- `theme-file-rename` - Rename or move files
- `theme-search-replace` - Search and replace across multiple files
- `theme-snippet-create` - Generate Liquid snippets
- `theme-section-create` - Create theme sections with schema
- `theme-template-create` - Generate page templates
- `theme-settings-update` - Update theme configuration
- `theme-locales-update` - Manage translations
- `theme-asset-upload` - Upload and manage assets
- `theme-assets-optimize` - Optimize images, CSS, and JavaScript

#### 🛠️ Interactive Editing Tool:

```bash
node scripts/edit-theme.js
```

This provides a menu-driven interface for all theme editing operations.

### Interactive Development Tool

Launch the interactive theme development tool:

```bash
node scripts/theme-development-tools.js
```

This provides a menu-driven interface for all theme operations.

### Quick Commands

```bash
# Create a new theme
npm run theme:create

# Start development server
npm run theme:dev

# Pull theme from Shopify
npm run theme:pull

# Push theme to Shopify
npm run theme:push

# Deploy theme
node scripts/deploy-theme.js
```

## MCP Tools Reference

### Theme Creation Tools

#### `theme-create`

Create a new Shopify theme from template or existing theme.

**Parameters:**

- `name` (required): Name of the new theme
- `template` (optional): Template URL or name (e.g., 'dawn', 'debut')
- `cloneThemeId` (optional): ID of existing theme to clone
- `directory` (optional): Local directory for theme files

**Example:**

```json
{
  "tool": "theme-create",
  "arguments": {
    "name": "my-custom-theme",
    "template": "dawn"
  }
}
```

#### `theme-generate`

Generate theme from custom template configuration.

**Parameters:**

- `name` (required): Name of the new theme
- `description` (optional): Theme description
- `author` (optional): Theme author
- `settings` (optional): Theme settings schema
- `sections` (optional): Theme sections configuration

### Theme Management Tools

#### `theme-pull`

Download theme files from Shopify to local directory.

**Parameters:**

- `themeId` (required): ID of the theme to download
- `directory` (optional): Local directory to save theme files

#### `theme-push`

Upload local theme files to Shopify.

**Parameters:**

- `directory` (required): Local directory containing theme files
- `themeId` (optional): ID of existing theme to update
- `allowLive` (optional): Allow pushing to live theme
- `unpublished` (optional): Create as unpublished theme

#### `theme-dev`

Start theme development server with live preview.

**Parameters:**

- `directory` (required): Local directory containing theme files
- `themeId` (optional): ID of theme to use for development
- `port` (optional): Port for development server
- `host` (optional): Host for development server
- `liveReload` (optional): Enable live reload

### Quality Assurance Tools

#### `theme-check`

Validate theme files for syntax errors and best practices.

**Parameters:**

- `directory` (required): Local directory containing theme files

**Response:**

```json
{
  "valid": true,
  "errors": [
    {
      "file": "templates/product.liquid",
      "line": 42,
      "message": "Unknown filter 'invalid_filter'"
    }
  ]
}
```

### Asset Management Tools

#### `theme-package`

Package theme files into ZIP archive.

**Parameters:**

- `directory` (required): Local directory containing theme files
- `outputPath` (optional): Output path for ZIP file

#### `theme-extract`

Extract theme from ZIP archive.

**Parameters:**

- `zipPath` (required): Path to ZIP file containing theme
- `targetDirectory` (required): Directory to extract theme to

#### `theme-files-list`

Get list of all files in a theme directory.

**Parameters:**

- `directory` (required): Local directory containing theme files

### Advanced GraphQL Tools

#### `graphql-schema`

Get Shopify GraphQL Admin API schema information.

**Parameters:**

- `introspect` (optional): Perform full schema introspection

#### `custom-graphql-query`

Execute custom GraphQL query against Shopify Admin API.

**Parameters:**

- `query` (required): GraphQL query string
- `variables` (optional): Query variables

### Configuration Tools

#### `shopify-cli-init`

Initialize Shopify CLI configuration.

## CLI Scripts

### Theme Creation Script

Create themes interactively:

```bash
node scripts/create-theme.js
```

Features:

- Interactive theme creation wizard
- Template selection
- Automatic development server startup
- Theme structure validation

### Theme Deployment Script

Deploy themes with safety checks:

```bash
node scripts/deploy-theme.js
```

Features:

- Pre-deployment validation
- Multiple deployment modes
- Backup creation
- Rollback capability

### Development Tools

Comprehensive development interface:

```bash
node scripts/theme-development-tools.js
```

Features:

- Menu-driven interface
- Real-time development server management
- Theme synchronization
- File management

## Workflows

### 1. Creating a New Theme

```bash
# Option 1: Using MCP tool
npx shopify-mcp-server --tool theme-create --name "my-theme" --template "dawn"

# Option 2: Using script
node scripts/create-theme.js

# Option 3: Using interactive tool
node scripts/theme-development-tools.js
```

### 2. Development Workflow

```bash
# 1. Pull existing theme
npx shopify-mcp-server --tool theme-pull --themeId "123456789"

# 2. Start development server
npx shopify-mcp-server --tool theme-dev --directory "./themes/my-theme" --port 3000 --liveReload

# 3. Make changes and test

# 4. Check for errors
npx shopify-mcp-server --tool theme-check --directory "./themes/my-theme"

# 5. Push changes
npx shopify-mcp-server --tool theme-push --directory "./themes/my-theme" --themeId "123456789"
```

### 3. Production Deployment

```bash
# 1. Run final checks
npx shopify-mcp-server --tool theme-check --directory "./themes/my-theme"

# 2. Package theme
npx shopify-mcp-server --tool theme-package --directory "./themes/my-theme"

# 3. Deploy with script
node scripts/deploy-theme.js
```

### 4. Theme Migration

```bash
# 1. Pull source theme
npx shopify-mcp-server --tool theme-pull --themeId "source-theme-id" --directory "./source-theme"

# 2. Create new theme based on source
npx shopify-mcp-server --tool theme-create --name "migrated-theme" --cloneThemeId "source-theme-id"

# 3. Customize and test

# 4. Deploy to production
```

## Best Practices

### 1. Theme Structure

Maintain proper theme structure:

```
theme/
├── assets/           # CSS, JS, images
├── config/           # Settings and theme configuration
├── layout/           # Base templates
├── locales/          # Translation files
├── sections/         # Reusable theme sections
├── snippets/         # Reusable code snippets
├── templates/        # Page templates
└── .shopifyignore    # Files to ignore during sync
```

### 2. Development Environment

- Always use development themes for testing
- Enable live reload for faster development
- Use version control (Git) for theme files
- Test on multiple devices and browsers

### 3. Code Quality

- Run theme checks before deployment
- Follow Shopify's coding standards
- Use semantic versioning for themes
- Document customizations

### 4. Performance

- Optimize images and assets
- Minimize HTTP requests
- Use lazy loading for images
- Compress CSS and JavaScript

### 5. Security

- Never commit access tokens
- Use environment variables for configuration
- Validate user inputs in templates
- Follow Shopify security best practices

## Environment Configuration

### .env File

Create a `.env` file in your project root:

```env
# Shopify Store Configuration
SHOPIFY_ACCESS_TOKEN=your_private_app_token
MYSHOPIFY_DOMAIN=your-store.myshopify.com

# Theme Development
THEME_WORKSPACE=./themes
THEME_DEFAULT_PORT=3000

# Development Options
SHOPIFY_CLI_THEME_TOKEN=your_theme_token
SHOPIFY_FLAG_STORE=your-store
```

### Shopify CLI Configuration

The MCP server automatically configures Shopify CLI with your credentials:

```yaml
# .shopify/config.yml (auto-generated)
development_store: your-store.myshopify.com
password: your_access_token
timeout: 60
```

## Advanced GraphQL Usage

### Schema Introspection

Get complete API schema:

```bash
npx shopify-mcp-server --tool graphql-schema --introspect
```

### Custom Queries

Execute custom GraphQL queries:

```bash
npx shopify-mcp-server --tool custom-graphql-query --query "
  query GetProducts($first: Int!) {
    products(first: $first) {
      edges {
        node {
          id
          title
          handle
          productType
        }
      }
    }
  }
" --variables '{"first": 10}'
```

### Common GraphQL Patterns

#### Get Theme Information

```graphql
query GetThemes {
  themes(first: 50) {
    edges {
      node {
        id
        name
        role
        createdAt
        updatedAt
      }
    }
  }
}
```

#### Create Product

```graphql
mutation CreateProduct($input: ProductInput!) {
  productCreate(input: $input) {
    product {
      id
      title
      handle
    }
    userErrors {
      field
      message
    }
  }
}
```

## Troubleshooting

### Common Issues

#### 1. Shopify CLI Not Found

```bash
# Install Shopify CLI globally
npm install -g @shopify/cli @shopify/theme

# Or use npx
npx @shopify/cli version
```

#### 2. Authentication Errors

- Verify your access token has theme permissions
- Check that MYSHOPIFY_DOMAIN is correct
- Ensure your private app is active

#### 3. Theme Pull/Push Failures

- Check theme ID exists
- Verify permissions
- Ensure theme isn't being edited by another user

#### 4. Development Server Issues

- Check port availability
- Verify theme directory structure
- Check for syntax errors in theme files

#### 5. Package Installation Issues

```bash
# Clear npm cache
npm cache clean --force

# Remove node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

### Debug Mode

Enable debug logging:

```bash
export DEBUG=shopify-mcp-server:*
npm run build
```

### Log Files

Check logs for detailed error information:

```bash
# MCP server logs
tail -f logs/mcp-server.log

# Shopify CLI logs
tail -f ~/.shopify/logs/shopify.log
```

## Support and Resources

### Documentation

- [Shopify Theme Development](https://shopify.dev/themes)
- [Shopify CLI Documentation](https://shopify.dev/themes/tools/cli)
- [Liquid Template Language](https://shopify.github.io/liquid/)
- [GraphQL Admin API](https://shopify.dev/api/admin-graphql)

### Community

- [Shopify Partners Community](https://community.shopify.com/c/partners/bd-p/partners)
- [Shopify GitHub](https://github.com/Shopify)
- [Theme Development Discord](https://discord.gg/shopifypartners)

### Tools

- [Theme Inspector](https://chrome.google.com/webstore/detail/shopify-theme-inspector/fndnankcflemoafdeboboehphmiijkgp)
- [Shopify Theme Check](https://github.com/Shopify/theme-check)
- [Liquid VS Code Extension](https://marketplace.visualstudio.com/items?itemName=Shopify.theme-check-vscode)

---

For more information and updates, visit the [Shopify MCP Server repository](https://github.com/your-repo/shopify-mcp-server).
