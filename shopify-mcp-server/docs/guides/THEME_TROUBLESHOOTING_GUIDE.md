# Shopify Theme Template Troubleshooting Guide

## Issue: Product Page Not Showing Custom VividWalls Design

Based on the screenshot analysis, your product page is displaying the default Dawn theme template instead of the custom VividWalls template that was deployed.

## Quick Diagnosis

Run this diagnostic script to check your theme configuration:

```bash
cd services/mcp-servers/core/shopify-mcp-server
SHOPIFY_ACCESS_TOKEN=your_token_here node fix-theme-template-issues.js
```

## Common Issues and Solutions

### 1. Template Not Selected in Theme Customizer

**Problem**: The product page is using the default template instead of "vividwalls"

**Solution**:

1. Go to your Shopify Admin
2. Navigate to **Online Store > Themes**
3. Click **Customize** on your theme
4. In the page selector dropdown at the top, navigate to **Products > Default product**
5. Change the template from "Default product" to "product.vividwalls"
6. Click **Save**

### 2. Template Not Applied to Individual Products

**Problem**: Specific products aren't using the VividWalls template

**Solution**:

1. Go to **Products** in your Shopify Admin
2. Click on the product (e.g., "Olive Weave")
3. Scroll down to "Online store" section
4. Under "Theme template", select "vividwalls" from the dropdown
5. Save the product

### 3. Missing Theme Files

**Problem**: The custom template files weren't properly deployed

**Solution**: Re-deploy the theme files:

```bash
cd services/mcp-servers/core/shopify-mcp-server
node deploy-vividwalls-product-page.js
```

### 4. CSS Not Loading

**Problem**: The custom styles aren't being applied

**Possible Causes**:

- CSS file reference is incorrect in the template
- CSS file wasn't uploaded to the theme
- Cache issues

**Solution**:

1. Clear your browser cache
2. Check the browser console for 404 errors on CSS files
3. Verify the CSS reference in the template:
   ```liquid
   {{ 'vividwalls-product-page.css' | asset_url | stylesheet_tag }}
   ```

### 5. Section Not Rendering

**Problem**: The main-product-vividwalls section isn't showing

**Check**:

1. In theme customizer, check if the section is added to the template
2. Look for any Liquid syntax errors in the section file
3. Verify all required product metafields exist

## Verification Steps

1. **Check Theme Files Exist**:
   - `templates/product.vividwalls.liquid`
   - `sections/main-product-vividwalls.liquid`
   - `assets/vividwalls-product-page.css`

2. **Test with Preview Links**:

   ```
   https://vividwalls-2.myshopify.com/products/olive-weave?preview_theme_id=172527026463
   ```

3. **Browser Console Check**:
   - Open Developer Tools (F12)
   - Check Console tab for JavaScript errors
   - Check Network tab for failed resource loads

## Template Structure

The VividWalls template should include:

- Custom header with VIVID branding
- Large product image display (715x670)
- Thumbnail gallery
- Product information panel
- Size/variant selector
- Add to cart functionality
- Artist information
- "You may also like" section

## Emergency Rollback

If you need to temporarily revert to the default template:

1. In Theme Customizer, change template back to "Default product"
2. Or edit products individually to use default template

## Need More Help?

1. Check the deployment log: `VIVIDWALLS_DESIGN_DEPLOYMENT.md`
2. Review the original Figma design specs
3. Verify all environment variables are set correctly
4. Check Shopify's System Status page for any platform issues
