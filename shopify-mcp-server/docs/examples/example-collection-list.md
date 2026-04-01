# Collection List

**Description:** A collection list is a page that displays all the collections in a store. In this example, the collection name will be displayed, as well as a featured image for the collection, if one has been uploaded. By default the `list-collections.liquid` file will output the collections in alphabetical order. When you loop through the collections array, the collections will be output in alphabetical order by default.

**Category:** Collections  
**Last Updated:** Feb 21, 2019

## Implementation

1. Place the following code in the `list-collections.liquid` file. If this file doesn't exist, create one in the `Templates` directory of your theme.

## Code

```liquid
<h1>{{ page_title }}</h1>

<ul>
  {%- for collection in collections -%}
    <li>
      <!--
        These control flow tags check to see if there is a featured image for a collection.
        If there isn't one, then we assign the image from the first product in the collection.
      -->
      {%- if collection.image -%}
        {%- assign collection_image = collection.image -%}
      {%- elsif collection.products.first and collection.products.first.images != empty -%}
        {%- assign collection_image = collection.products.first.featured_image -%}
      {%- else -%}
        {%- assign collection_image = blank -%}
      {%- endif -%}

      <a href="{{ collection.url }}">
        <img src="{{ collection_image | img_url: '480x' }}" alt="">
        {{ collection.title }}
      </a>
    </li>
  {%- endfor -%}
</ul>
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
