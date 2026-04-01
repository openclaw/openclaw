# Vendor Link List

**Description:** A vendor is usually the manufacturer, wholesaler, or creator of a product. This example creates a list of all the vendors for a store. Each vendor name links to a collection page that is filtered to show products by that particular vendor.

**Category:** Collections  
**Last Updated:** Feb 21, 2019

## Implementation

1. Place the following code where you would like the link list to appear, such as a content page, on a blog sidebar, or on a collection page.

## Code

```liquid
<ul>
  {%- for product_vendor in shop.vendors -%}
    <li>{{ product_vendor | link_to_vendor }}</li>
  {%- endfor -%}
</ul>
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
