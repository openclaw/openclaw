# Shopify Liquid code examples

## Blog article list

Build and customize themes faster with component-based Liquid examples

Blog article list Last updated: Feb 21, 2019
Blog

This example displays a list of blog posts associated with a specific blog. The Liquid and HTML needed to display article titles, featured images, article excerpts, article tags, authors, and dates are found in this component. Learn more about blog templates in the Shopify Help Center.

1. Add the following code to the file that outputs content for the `blog` page.
2. Adjust styling on the theme's stylesheet for appropriate positioning and formatting.

```liquid
<h1>{{ page_title }}</h1>

<ul>
  {%- for article in blog.articles -%}
    <li>

      <h2>
        <a href="{{ article.url }}">

          {%- if article.image -%}
            <img src="{{ article.image | img_url: '300x300' }}" alt="">

            <noscript>
            <p>
              {{ article | img_url: '455x300', scale: 2 | img_tag: article.title }}
            </p>
            </noscript>
          {%- endif -%}

          {{ article.title }}
        </a>
      </h2>

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

      <p>
        {%- if article.excerpt.size > 0 -%}
          {{ article.excerpt }}
        {%- else -%}
          {{ article.content | strip_html | truncate: 150 }}
        {%- endif -%}
      </p>

      {%- if article.tags.size > 0 -%}
        <ul>
          {{ 'blogs.article.posted_in' }}
            <li>
              {%- for tag in article.tags -%}
                <a href="{{ blog.url }}/tagged/{{ tag | handle }}">{{ tag }}</a>{% unless forloop.last %}, {% endunless %}
              {%- endfor -%}
            </li>
        </ul>
      {%- endif -%}

      <ul>
        <li>
          <a href="{{ article.url }}" aria-label="Read more: {{ article.title }}">
            Read more
          </a>
        </li>
        {%- if blog.comments_enabled? and article.comments_count > 0 -%}
          <li>
            <a href="{{ article.url }}#comments">
              {{ article.comments_count }}
            </a>
          </li>
        {%- endif -%}
      </ul>

    </li>
  {%- endfor -%}
</ul>

{% schema %}
{
  "name": "Blog pages",
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
