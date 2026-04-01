# Tag Based Product Recommendations

**Description:** A recommended products section helps to drive sales by making it easy for customers to promote a curated list of products to customers as they browse. Recommended products are often displayed at the bottom of the product page. This example features products with the same tag. For a method which is based on collection and purchase history data, please see the Data based product recommendations code example.

**Category:** Products  
**Last Updated:** Feb 21, 2019

## Implementation

1. Add a new section in the `sections` directory and name it `recommended-products`. Paste the code below in the new file.
2. Locate the `product.liquid` template and add the following Liquid tag where you would like the recommended products to appear: `{% section 'recommended-products' %}`

## Code

```liquid
<style>
  .product-card {
    box-sizing: border-box;
    float: left;
    min-height: 1em;
    padding-left: 2em;
    vertical-align: top;
    width: 25%;
  }

  .visuallyhidden {
    border: 0;
    clip: rect(0 0 0 0);
    height: 1px;
    margin: -1px;
    overflow: hidden;
    padding: 0;
    position: absolute;
    width: 1px;
    white-space: nowrap;
  }
</style>

{%- assign counter = 0 -%}
{%- assign break_at = section.settings.number_of_products | plus: 0 -%}
{%- assign current_product = product -%}

{%- capture related_items -%}
  {%- for product in collections.all.products -%}
    {%- unless product.handle == current_product.handle -%}

      {%- if product.tags contains section.settings.related_tag -%}
        <a href="{{ product.url | within: collection }}" class="product-card">
          <img src="{{ product.featured_image.src | img_url: '1024x' }}" alt="">
          {{ product.title }}
          <p>
            <span aria-hidden="true">—</span>
            {%- if product.price_varies -%}
              <span class="visuallyhidden">Starting at</span>
              {{ product.price_min | money_without_trailing_zeros }}
              <span aria-hidden="true">+</span>
            {%- else -%}
              {{ product.price | money_without_trailing_zeros }}
            {%- endif -%}
          </p>
          <p>
            <span class="visuallyhidden">by</span>
            {{ product.vendor }}
          </p>
        </a>

        {%- assign counter = counter | plus: 1 -%}

        {%- if counter == break_at -%}
          {%- break -%}
        {%- endif -%}

      {%- endif -%}

    {%- endunless -%}
  {%- endfor -%}
{%- endcapture -%}

{%- assign related_items = related_items | trim -%}
{%- unless related_items == blank -%}
  <aside>
    {%- if section.settings.heading -%}
      <h2>{{ section.settings.heading }}</h2>
    {%- endif -%}

    {{ related_items }}
  </aside>
{%- endunless -%}

{% schema %}
{
  "name": "Recommended products",
  "settings": [
    {
      "type": "text",
      "id": "heading",
      "label": "Heading",
      "default": "Recommended products"
    },
    {
      "type": "text",
      "id": "related_tag",
      "label": "Tag",
      "info" : "The tag determines which products show as related products."
    },
    {
      "type": "select",
      "id": "number_of_products",
      "label": "Number of products to show",
      "default": "4",
      "options": [
        {
          "value": "4",
          "label": "4"
        },
        {
          "value": "8",
          "label": "8"
        },
        {
          "value": "12",
          "label": "12"
        }
      ]
    }
  ]
}
{% endschema %}
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
