# VividWalls Inventory Widget Deployment

## Files Created

- `snippets/vividwalls-inventory-widget.liquid` - The main widget component
- `sections/vividwalls-inventory.liquid` - Section for theme customizer

## Manual Deployment Steps

### Option 1: Upload via Shopify Admin

1. Go to **Online Store > Themes > Actions > Edit code**
2. Upload the files to their respective directories:
   - Upload `vividwalls-inventory-widget.liquid` to **snippets/** folder
   - Upload `vividwalls-inventory.liquid` to **sections/** folder

### Option 2: Add to Product Template

Add this line to your product template (templates/product.liquid):

```liquid
{% render 'vividwalls-inventory-widget' %}
```

### Option 3: Use Section in Theme Customizer

1. Go to **Online Store > Themes > Customize**
2. Navigate to a product page
3. Add section > **VividWalls Inventory Widget**

## Testing

1. Visit a product page with size variants
2. The widget should display inventory counts for each size
3. Test variant selection and cart functionality

## Configuration

- Products should have variants with size options (24x36, 36x48, 53x72)
- Set up inventory tracking in Shopify admin
- Configure the n8n workflow for advanced inventory sync (optional)
