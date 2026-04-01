# VividWalls Inventory Widget Deployment Guide

This guide explains how to deploy the VividWalls Limited Edition Inventory Widget to your Shopify store using the Shopify MCP server.

## Overview

The VividWalls Inventory Widget provides:

- Real-time inventory display for size variants (24x36, 36x48, 53x72)
- Visual progress bars showing stock levels
- Interactive variant selection with pricing
- Add to cart functionality with quantity controls
- Mobile-responsive design
- Certificate of authenticity information

## Prerequisites

### 1. Shopify Private App Setup

Create a Shopify private app with the following permissions:

- `read_themes`
- `write_themes`
- `read_products`
- `write_products`

### 2. Environment Configuration

Set the following environment variables in your `.env` file:

```bash
# Shopify Store Configuration
SHOPIFY_ACCESS_TOKEN=shpat_your_access_token_here
MYSHOPIFY_DOMAIN=your-store-name.myshopify.com
```

## Deployment Methods

### Method 1: Automated Script (Recommended)

From the project root directory:

```bash
./scripts/deploy-inventory-widget.sh
```

This script will:

1. Navigate to the Shopify MCP server directory
2. Build the MCP server if needed
3. Verify environment configuration
4. Deploy all widget components to your Shopify theme

### Method 2: Manual Deployment

1. Navigate to the Shopify MCP server directory:

```bash
cd services/mcp-servers/core/shopify-mcp-server
```

2. Build the MCP server:

```bash
npm run build
```

3. Deploy the inventory widget:

```bash
npm run deploy-inventory-widget
```

## Deployed Files

The deployment creates the following files in your active Shopify theme:

### 1. `snippets/vividwalls-inventory-widget.liquid`

The main inventory widget component with:

- Complete HTML structure and styling
- JavaScript functionality for inventory display
- Interactive variant selection
- Add to cart integration

### 2. `sections/vividwalls-inventory.liquid`

A section wrapper that allows adding the widget through the theme customizer:

- Configurable show/hide setting
- Customizable title
- Schema for theme editor integration

### 3. `snippets/vividwalls-inventory-api.liquid`

A server-side API endpoint that provides inventory data in JSON format:

- Product variant information
- Inventory quantities
- Pricing data
- Size allocation information

### 4. `templates/product.vividwalls.liquid`

A custom product template that includes the inventory widget:

- Based on your existing product template
- Automatically includes the widget
- Can be assigned to specific products

## Implementation Options

### Option 1: Product Template Assignment

1. Go to **Shopify Admin** > **Online Store** > **Themes**
2. Click **Customize** on your active theme
3. Navigate to any product page
4. In the theme editor, assign the `product.vividwalls` template to specific products

### Option 2: Product Tags

1. Add the `limited-edition` tag to products that should display the widget
2. The widget will automatically appear on those product pages
3. This method uses the existing product template with conditional logic

### Option 3: Section Integration

1. In the theme customizer, add the **VividWalls Inventory Widget** section
2. Place it on product page templates or any other template
3. Configure the section settings as needed

### Option 4: Manual Snippet Integration

Add this Liquid code to any template where you want the widget to appear:

```liquid
{% render 'vividwalls-inventory-widget' %}
```

## Widget Features

### Visual Elements

- **Edition Badge**: Shows "Limited Edition" with star icon
- **Size Cards**: Interactive cards for each size variant
- **Progress Bars**: Visual representation of stock levels
- **Pricing Display**: Current price with compare-at pricing
- **Discount Badges**: Percentage off indicators

### Color Coding

- **Green**: Good stock levels (available)
- **Yellow**: Low stock (3 or fewer items)
- **Red**: Sold out

### Interactive Features

- **Variant Selection**: Click size cards to select variants
- **Quantity Controls**: Plus/minus buttons and input field
- **Add to Cart**: Direct integration with Shopify cart
- **Loading States**: Visual feedback during operations

### Mobile Responsiveness

- Stacked layout on mobile devices
- Touch-friendly controls
- Optimized sizing for small screens

## Customization

### Styling

The widget includes comprehensive CSS that can be customized:

- Color scheme matches the gradient theme
- Responsive breakpoints for different screen sizes
- Accessibility features for high contrast mode

### Size Variants

The widget is configured for three standard sizes:

- **Small**: 24" × 36"
- **Medium**: 36" × 48"
- **Large**: 53" × 72"

### Edition Information

- Default edition size: 100 prints
- Customizable allocation per size
- Certificate of authenticity note

## Testing

### 1. Create Test Products

- Create products with multiple size variants
- Set different inventory levels for each size
- Add pricing and compare-at pricing

### 2. Test Scenarios

- **High Stock**: 10+ items available
- **Low Stock**: 1-3 items available
- **Sold Out**: 0 items available
- **Mixed Stock**: Different levels per size

### 3. Functionality Tests

- Variant selection updates pricing
- Quantity controls work correctly
- Add to cart functions properly
- Mobile responsiveness

### 4. Visual Tests

- Progress bars display correctly
- Color coding matches stock levels
- Pricing displays with discounts
- Layout works on all screen sizes

## Troubleshooting

### Common Issues

#### Deployment Fails

- Verify `SHOPIFY_ACCESS_TOKEN` has correct permissions
- Ensure `MYSHOPIFY_DOMAIN` is correct (include `.myshopify.com`)
- Check Shopify app scopes include theme modification rights

#### Widget Not Appearing

- Confirm product has `limited-edition` tag (if using tag method)
- Verify correct template is assigned to product
- Check theme customizer section settings

#### Inventory Not Updating

- Verify variant data is correctly mapped
- Check console for JavaScript errors
- Ensure API endpoint is accessible

#### Styling Issues

- Check for theme CSS conflicts
- Verify CSS is loading correctly
- Test on different devices and browsers

### Debug Mode

Enable debug logging by setting:

```bash
SHOPIFY_DEBUG=true
```

### API Rate Limits

Shopify has API rate limits. If you encounter 429 errors:

- Wait before retrying
- Reduce frequency of API calls
- Consider implementing caching

## Support

For technical support or customization requests:

- Check the Shopify MCP server documentation
- Review the widget source code in `src/templates/inventory-widget.liquid`
- Test with Shopify's theme inspector for debugging

## Security Considerations

- Environment variables contain sensitive data
- Keep access tokens secure
- Regularly rotate API credentials
- Monitor API usage for unusual activity

## Performance

The widget is optimized for performance:

- Minimal external dependencies
- Efficient JavaScript execution
- Responsive image loading
- Cached inventory data where possible

## Future Enhancements

Planned improvements:

- Real-time inventory sync
- Advanced analytics integration
- Custom size configuration
- A/B testing capabilities
- Multi-language support
