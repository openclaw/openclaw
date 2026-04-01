# Breadcrumb Navigation

**Description:** A Breadcrumb navigation, also known as breadcrumbs, can reduce the number of actions a visitor needs to take in order to navigate to a higher-level page, and improve the discoverability of a website's sections and pages. Like all Shopify based navigations, it uses the linklist object.

**Category:** Navigation  
**Last Updated:** Feb 21, 2019

## Implementation

1. Place the following code in the `theme.liquid` file, just inside the main content wrapper, or wherever you wish the breadcrumb to appear.
2. To see the breadcrumbs appear, ensure that your site has already been populated with products, collections, blog posts and pages.

## Code

```liquid
<style>
  .breadcrumbs {
    margin: 0 0 2em;
  }

  .breadcrumbs__list {
    list-style-type: none;
    margin: 0;
    padding: 0;
  }

  .breadcrumbs__item {
    display: inline-block;
  }

  .breadcrumbs__item:not(:last-child):after {
    border-style: solid;
    border-width: .10em .10em 0 0;
    content: '';
    display: inline-block;
    height: .20em;
    margin: 0 .20em;
    position: relative;
    transform: rotate(45deg);
    vertical-align: middle;
    width: .20em;
  }

  .breadcrumbs__link {
    text-decoration: underline;
  }

  .breadcrumbs__link[aria-current="page"] {
    color: inherit;
    font-weight: normal;
    text-decoration: none;
  }

  .breadcrumbs__link[aria-current="page"]:hover,
  .breadcrumbs__link[aria-current="page"]:focus {
    text-decoration: underline;
  }
</style>

{%- unless template == 'index' or template == 'cart' or template == 'list-collections' or template == '404' -%}
{%- assign t = template | split: '.' | first -%}

<nav class="breadcrumbs" role="navigation" aria-label="breadcrumbs">
  <ol class="breadcrumbs__list">
    <li class="breadcrumbs__item">
      <a class="breadcrumbs__link" href="/">Home</a>
    </li>
    {%- case t -%}
      {%- when 'page' -%}
        <li class="breadcrumbs__item">
          <a class="breadcrumbs__link" href="{{ page.url }}" aria-current="page">{{ page.title }}</a>
        </li>
      {%- when 'product' -%}
        {%- if collection.url -%}
          <li class="breadcrumbs__item">
            {{ collection.title | link_to: collection.url }}
          </li>
        {%- endif -%}
        <li class="breadcrumbs__item">
          <a class="breadcrumbs__link" href="{{ product.url }}" aria-current="page">{{ product.title }}</a>
        </li>
      {%- when 'collection' and collection.handle -%}
        {%- if current_tags -%}
          <li class="breadcrumbs__item">
            {{ collection.title | link_to: collection.url }}
          </li>
          <li class="breadcrumbs__item">
            {%- capture tag_url -%}{{ collection.url }}/{{ current_tags | join: "+"}}{%- endcapture -%}
            <a class="breadcrumbs__link" href="{{ tag_url }}" aria-current="page">{{ current_tags | join: " + "}}</a>
          </li>
        {%- else -%}
          <li class="breadcrumbs__item">
            <a class="breadcrumbs__link" href="{{ collection.url }}" aria-current="page">{{ collection.title }}</a>
          </li>
        {%- endif -%}
      {%- when 'blog' -%}
        {%- if current_tags -%}
          <li class="breadcrumbs__item">
            {{ blog.title | link_to: blog.url }}
          </li>
          <li class="breadcrumbs__item">
            {%- capture tag_url -%}{{blog.url}}/tagged/{{ current_tags | join: "+" }}{%- endcapture -%}
            <a class="breadcrumbs__link" href="{{ tag_url }}" aria-current="page">{{ current_tags | join: " + " }}</a>
          </li>
        {%- else -%}
          <li class="breadcrumbs__item">
            <a class="breadcrumbs__link" href="{{ blog.url }}" aria-current="page">{{ blog.title }}</a>
          </li>
        {%- endif -%}
      {%- when 'article' -%}
        <li class="breadcrumbs__item">
          {{ blog.title | link_to: blog.url }}
        </li>
        <li class="breadcrumbs__item">
          <a class="breadcrumbs__link" href="{{ article.url }}" aria-current="page">{{ article.title }}</a>
        </li>
      {%- else -%}
        <li class="breadcrumbs__item">
          <a class="breadcrumbs__link" href="{{ request.path }}" aria-current="page">{{ page_title }}</a>
        </li>
    {%- endcase -%}
  </ol>
</nav>
{%- endunless -%}
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
