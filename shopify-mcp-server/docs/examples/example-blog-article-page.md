# Shopify Liquid code examples

## Blog article page

Build and customize themes faster with component-based Liquid examples

Blog article page Last updated: Feb 21, 2019
Blog

The blog article page is a dedicated page for an individual blog article. It includes elements such as the article title, author, published date, content, and tags. In this example, the visibility of the article author and published date can be enabled or disabled from the theme editor.

1. Place the following code in the `article-template.liquid` section file. If this file doesn't exist, add a new section called `article-template`.
2. Make sure that the `article.liquid` file includes the following Liquid tag: `{% section 'article-template' %}`. Add this tag to the file if it doesn't already exist.
3. Additional elements, such as social sharing buttons, can be added if required.

```liquid
<article>

  <header>
    <h1>{{ article.title }}</h1>

    {%- if section.settings.blog_show_author -%}
      <span>
        By {{ article.author }}
      </span>
    {%- endif -%}

    {%- if section.settings.blog_show_date -%}
      <span>
        {{ article.published_at | time_tag: format: 'month_day_year' }}
      </span>
    {%- endif -%}

  </header>

  {{ article.content }}

  {%- if article.tags.size > 0 -%}
    <footer>
      <ul aria-label="Tags">
      {%- for tag in article.tags -%}
        <li>
          <a href="{{ blog.url }}/tagged/{{ tag | handle }}">
            {{ tag }}
          </a>
        </li>
      {%- endfor -%}
      </ul>
    <footer>
  {%- endif -%}

</article>

{% schema %}
{
  "name": "Posts",
  "settings": [
    {
      "type": "checkbox",
      "id": "blog_show_author",
      "label": "Show author",
      "default": true
    },
    {
      "type": "checkbox",
      "id": "blog_show_date",
      "label": "Show date",
      "default": true
    }
  ]
}
{% endschema %}
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
