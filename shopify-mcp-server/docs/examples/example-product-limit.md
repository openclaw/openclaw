# Product Limit

**Description:** A product limit allows you to specify the maximum number of products rendered on a single collection page. This example demonstrates how to use paginate tags to limit the number of products that show on each page of the collection. Learn more about product limits in the Shopify Help Center.

**Category:** Collections  
**Last Updated:** Feb 21, 2019

## Implementation

1. Place the paginate tags around a `forloop`, that loops through products within a collection.
2. Replace `limit` with the number of products you wish to show per page on the collection.

## Code

```liquid
{% paginate collection.products by limit %}
  <-- Product 'forloop' content goes here -->
{% endpaginate %}
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
