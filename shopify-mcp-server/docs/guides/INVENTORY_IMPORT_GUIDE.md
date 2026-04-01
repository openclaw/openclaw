# VividWalls Inventory Import Guide

## Overview

This guide documents the process for importing inventory for the 15 fixed products that were recently corrected with proper 6-variant structures and SKUs.

## Background

- **Target Products**: 15 products that were fixed with correct variant structures
- **Missing Inventory**: 2,940 pieces need to be connected to existing variants
- **Expected Structure**: Each product should have exactly 300 pieces across 6 variants
- **Total Impact**: 4,500 pieces across 15 products (15 × 300)

## Target Products

```
vivid-mosaic-no4, purple-shade, emerald-shade, earthy-shade, rusty-shade,
primary-hue, teal-earth, noir-structures, earth-echoes, emerald-echoes,
noir-echoes, vista-echoes, space-form-no4, deep-echoes, intersecting-perspectives-no2
```

## Inventory Structure

Each product has exactly 6 variants with this distribution:

| Variant                      | Quantity       |
| ---------------------------- | -------------- |
| 24x36 Gallery Wrapped Canvas | 75 pieces      |
| 24x36 Canvas Roll            | 75 pieces      |
| 36x48 Gallery Wrapped Canvas | 51 pieces      |
| 36x48 Canvas Roll            | 54 pieces      |
| 53x72 Gallery Wrapped Canvas | 21 pieces      |
| 53x72 Canvas Roll            | 24 pieces      |
| **Total per product**        | **300 pieces** |

## Files

### 1. Data Source

- **File**: `/Users/kinglerbercy/Projects/vivid_mas/data/exports/inventory_export_limited_edition_FINAL.csv`
- **Format**: Shopify inventory export format
- **Records**: 90 inventory entries (15 products × 6 variants)
- **Location**: "170 Avenue F" (primary fulfillment location)

### 2. Tools Created

#### Planning Tool: `inventory-import-plan.js`

- **Purpose**: Analyze inventory data and validate structure
- **Safety**: Read-only, no Shopify modifications
- **Output**: Detailed execution plan and validation report

#### Production Tool: `import-inventory-production.js`

- **Purpose**: Execute actual inventory updates in Shopify
- **Safety**: Requires explicit `--execute` flag and environment setup
- **Features**: GraphQL-based updates, error handling, progress reporting

#### Legacy Tool: `import-inventory-via-mcp.js`

- **Purpose**: Alternative approach using MCP server (test version)
- **Status**: Development/testing version

## Prerequisites

### Environment Variables

```bash
export SHOPIFY_ACCESS_TOKEN="shpat_your_access_token_here"
export MYSHOPIFY_DOMAIN="vividwalls.myshopify.com"
```

### Required Permissions

The Shopify access token needs these scopes:

- `read_products`
- `write_products`
- `read_inventory`
- `write_inventory`

### Dependencies

```bash
npm install graphql-request csv-parser
```

## Execution Process

### Step 1: Validation and Planning

Run the planning tool to validate data structure:

```bash
node inventory-import-plan.js
```

**Expected Output:**

```
✅ DATA VALIDATION PASSED
All 15 products have the correct structure and inventory amounts.
Ready to proceed with actual Shopify import.
```

### Step 2: Environment Setup

Set your Shopify credentials:

```bash
export SHOPIFY_ACCESS_TOKEN="your_actual_token"
export MYSHOPIFY_DOMAIN="vividwalls.myshopify.com"
```

### Step 3: Production Import

**⚠️ IMPORTANT**: This step modifies actual Shopify data.

```bash
# First, run without --execute to see the plan
node import-inventory-production.js

# Then execute the actual import
node import-inventory-production.js --execute
```

### Step 4: Verification

After import, verify:

1. **Shopify Admin**: Check inventory levels for the 15 products
2. **Storefront**: Confirm products show as available
3. **Reports**: Run inventory reports to validate totals
4. **Expected Results**:
   - Each product: exactly 300 pieces
   - Total system increase: 4,500 pieces
   - Location: "170 Avenue F"

## Expected Results

### Before Import

- 15 products with 6 variants each but zero inventory
- Missing connection between SKUs and inventory data
- Products appear out of stock on storefront

### After Import

- 15 products with 300 pieces each (4,500 total)
- All variants properly connected to inventory
- Products available for purchase
- Complete limited edition inventory model

## Safety Features

### Planning Tool

- ✅ Read-only analysis
- ✅ Data validation
- ✅ Execution plan generation
- ✅ No Shopify modifications

### Production Tool

- ✅ Requires explicit `--execute` flag
- ✅ Environment variable validation
- ✅ GraphQL error handling
- ✅ Rate limiting (100ms delays)
- ✅ Detailed progress reporting
- ✅ Rollback-friendly approach

## Error Handling

### Common Issues and Solutions

1. **Missing Environment Variables**

   ```
   Error: Missing required environment variables
   Solution: Set SHOPIFY_ACCESS_TOKEN and MYSHOPIFY_DOMAIN
   ```

2. **Location Not Found**

   ```
   Error: Location not found: 170 Avenue F
   Solution: Verify location exists in Shopify admin
   ```

3. **SKU Mismatch**

   ```
   Error: Variant not found for SKU: PRODUCT-SKU
   Solution: Verify products were properly fixed with correct SKUs
   ```

4. **Rate Limiting**
   ```
   Error: API rate limit exceeded
   Solution: Tool includes 100ms delays, but you may need to retry
   ```

### Monitoring

The import tool provides real-time progress:

```
📦 Processing product: vivid-mosaic-no4
  Found: Vivid Mosaic no4 (6 variants)
  Inventory entries: 6
    VIVID-MOSAIC-NO4-GALLERY-WRAPPED-CANVAS-24X36: 0 → 75 pieces
      ✅ Updated successfully
    VIVID-MOSAIC-NO4-CANVAS-ROLL-24X36: 0 → 75 pieces
      ✅ Updated successfully
    ...
  ✅ vivid-mosaic-no4: 6/6 variants, 300 total pieces
```

## Validation Queries

### Check Product Inventory

```graphql
query ($handle: String!) {
  product(handle: $handle) {
    title
    variants(first: 10) {
      edges {
        node {
          sku
          inventoryQuantity
        }
      }
    }
  }
}
```

### Check Location Inventory

```graphql
query {
  location(id: "gid://shopify/Location/YOUR_LOCATION_ID") {
    name
    inventoryLevels(first: 100) {
      edges {
        node {
          available
          inventoryItem {
            sku
          }
        }
      }
    }
  }
}
```

## Rollback Process

If you need to rollback the inventory changes:

1. **Immediate Rollback**: Set all affected variants back to 0 inventory
2. **Partial Rollback**: Update specific products that had issues
3. **Data Recovery**: Use the import logs to identify what was changed

## Testing

### Test Environment Setup

For testing in a development store:

```bash
export SHOPIFY_ACCESS_TOKEN="test_token"
export MYSHOPIFY_DOMAIN="your-dev-store.myshopify.com"
```

### Smoke Test

Test with a single product first:

1. Modify `TARGET_PRODUCTS` to include only one product
2. Run the import
3. Verify results
4. Restore full product list

## Performance

- **Processing Time**: ~2-3 minutes for 15 products (with rate limiting)
- **API Calls**: ~95 calls total (5 setup + 90 inventory updates)
- **Rate Limiting**: 100ms delay between updates
- **Memory Usage**: Minimal (~50MB)

## Logs and Reporting

The tools generate comprehensive reports including:

- ✅ Products processed successfully
- ❌ Products with errors
- 📊 Inventory totals by product
- 🔍 SKU matching results
- ⚡ Performance metrics
- 📋 Verification checklist

## Support

For issues with this import process:

1. Check the error logs in the tool output
2. Verify environment variables are set correctly
3. Confirm the 15 target products exist with proper variants
4. Validate CSV data structure with the planning tool
5. Test in a development environment first

## Success Criteria

The import is considered successful when:

- ✅ All 15 products processed without errors
- ✅ Each product has exactly 300 pieces inventory
- ✅ All 90 variants have correct quantities
- ✅ Products show as available on storefront
- ✅ Total system inventory increases by 4,500 pieces
- ✅ No SKU mismatches or mapping errors
