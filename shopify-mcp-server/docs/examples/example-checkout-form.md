# Checkout Form

**Description:** The checkout form is what customers use to review their cart, remove any unwanted products, and proceed to checkout. This code example includes product thumbnails, as well as remove, checkout and continue shopping buttons.

**Category:** Cart  
**Last Updated:** Feb 21, 2019

## Implementation

1. Place the following code in the `cart.liquid` template file. If this file doesn't exist, then create a new file in the template folder and name it `cart.liquid`.

## Code

```liquid
{%- if cart.item_count > 0 -%}

<form action="/cart" method="post">

  {%- for item in cart.items -%}
    <a href="{{ item.url | within: collections.all }}">
      <img src="{{ item | img_url: '200x200' }}" alt="{{ item.image.alt | escape }}">
      {{ item.product.title }}
    </a>

    {%- unless item.variant.title contains 'Default' -%}
      <p>{{ item.variant.title }}</p>
    {%- endunless -%}

    {%- assign property_size = item.properties | size -%}
    {%- if property_size > 0 -%}
      <ul>

        {%- for p in item.properties -%}
          {%- assign first_character_in_key = p.first | truncate: 1, '' -%}
          {%- unless p.last == blank or first_character_in_key == '_' -%}
            <li>
              {{ p.first }}:

              {%- if p.last contains '/uploads/' -%}
                <a href="{{ p.last }}">{{ p.last | split: '/' | last }}</a>
              {%- else -%}
                {{ p.last }}
              {%- endif -%}

            </li>
          {%- endunless -%}
        {%- endfor -%}

      </ul>
    {%- endif -%}

    <p>
      <a aria-label="Remove {{ item.variant.title }}" href="/cart/change?line={{ forloop.index }}&amp;quantity=0">Remove</a>
    </p>
  {%- endfor -%}

  <input type="submit" name="checkout" value="Checkout">
</form>

{%- else -%}
  <p>The cart is empty. <a href="/collections/all">Continue shopping</a></p>
{%- endif -%}
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
