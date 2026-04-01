# Directory Structure

This document explains the organized directory structure of the Shopify MCP Server project.

## Root Directory

The root directory has been cleaned and organized to contain only essential project files:

```
shopify-mcp-server/
├── README.md                 # Main project documentation
├── package.json             # Node.js dependencies and scripts
├── package-lock.json        # Locked dependency versions
├── tsconfig.json            # TypeScript configuration
├── jest.config.js           # Jest testing configuration
├── .gitignore              # Git ignore patterns
├── LICENSE                 # Project license
├── src/                    # Source code
├── scripts/                # Organized scripts directory
├── docs/                   # Documentation
├── theme/                  # Theme-related files
├── tools/                  # Development tools
├── config/                 # Configuration files
├── build/                  # Build artifacts
├── templates/              # Template files
└── node_modules/           # Dependencies (auto-generated)
```

## Scripts Directory (`scripts/`)

The scripts directory has been organized into logical subdirectories:

### `scripts/deployment/`

Contains all deployment-related scripts:

- `deploy-*.mjs` - Various deployment scripts for different features
- `make-vividwalls-default.mjs` - Script to set VividWalls as default
- `set-default-product-template.mjs` - Product template configuration
- `direct-deploy.mjs` - Direct deployment script

### `scripts/integration/`

Contains integration scripts, particularly for N8N:

- `n8n-shopify-mcp-*.cjs` - Various N8N integration configurations
- `n8n-test-wrapper.cjs` - Testing wrapper for N8N integration

### `scripts/theme/`

Contains theme-related scripts and files:

- `main-product-functions.js` - Product page JavaScript functions
- `main-product-fixed.liquid` - Fixed product page template
- Theme upload and management scripts

### Other Script Categories

- `scripts/testing/` - Test-related scripts
- `scripts/utilities/` - Utility scripts
- `scripts/inventory/` - Inventory management scripts
- `scripts/products/` - Product-related scripts

## Documentation Directory (`docs/`)

### `docs/summaries/`

Contains project summary documents:

- `DEPLOYMENT_SUMMARY.md` - Deployment process summary
- `CLEANUP_SUMMARY.md` - Cleanup process documentation

### Other Documentation

- `instruction.md` - General instructions
- `N8N_*.md` - N8N integration guides
- `TESTING_GUIDE.md` - Testing procedures
- `scope.md` - Project scope documentation

## Benefits of This Organization

1. **Clear Separation**: Different types of files are logically separated
2. **Easy Navigation**: Developers can quickly find relevant scripts and documentation
3. **Maintainability**: Easier to maintain and update specific components
4. **Scalability**: New scripts can be easily categorized and added
5. **Clean Root**: The root directory is no longer cluttered with temporary files

## Migration Notes

Files have been moved as follows:

- Deployment scripts (`deploy-*`) → `scripts/deployment/`
- N8N integration files (`n8n-*`) → `scripts/integration/`
- Theme files (`main-product-*`) → `scripts/theme/`
- Summary docs → `docs/summaries/`
- General documentation → `docs/`
