# Price Range

**Description:** Displaying a product's minimum and maximum prices on collection pages allows merchants to represent the range of variants available. With the help of control-flow Liquid tags, this code example will only output the minimum and maximum variant price values when the `collection` template is being viewed. This ensures product pages and search results will display default price values. The money filter is also applied to format prices based on the Currency Formatting.

**Category:** Collections  
**Last Updated:** Apr 8, 2019

## Implementation

1. Locate the code where product price is being outputted on your theme.
2. Replace code for product price with the following code. The `product.price_min` and `product.price_max` objects will output the lowest and highest variant prices when a collection page is viewed.

## Code

```liquid
{% if available %}
  {% if product.price_varies and template == 'collection' %}
    <p>From {{ product.price_min | money }} to {{ product.price_max | money }}</p>
  {% else %}
    <p>{{ product.price | money }}</p>
  {% endif %}
{% else %}
  <p>Sold out</p>
{% endif %}
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
