# Copyright Text

**Description:** Copyright text is typically displayed in the footer section of an online store, and provides a clear indication of a copyright symbol, the year of creation and author of the content. This example includes the copyright symbol, the current year, your store name, and a "Powered by Shopify" link.

**Category:** Global  
**Last Updated:** Feb 21, 2019

## Implementation

1. Add the following code into your `footer.liquid` section, or wherever you wish the copyright to appear.

## Code

```liquid
<p>&copy; {{ 'now' | date: '%Y' }}, {{ shop.name | link_to: '/' }}</p>
<p>{{ powered_by_link }}</p>
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
