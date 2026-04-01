# Featured Blog Posts

**Description:** Merchants will often want to display previews of recent blog articles on their homepage. This featured blog posts section allows merchants to choose how many articles appear in this dynamic section, as well as turn on and off the visibility of the author info and publish date.

**Category:** Blog  
**Last Updated:** Feb 21, 2019

## Implementation

1. Create a new file within the `sections` folder of your theme, and paste the code below into this file. Save file as `featured-blog.liquid`.
2. Navigate to the theme editor and select **"Add section"**. Within the blog category there will be an option for **"Blog posts"**.
3. When added to the homepage, merchants can choose the number of blog posts they wish to appear, as well as make the author info and publish date visible or hidden.

## Code

```liquid
<h1>{{ section.settings.title | escape }}</h1>

{%- assign blog = blogs[section.settings.blog] -%}

{%- if blog.articles_count > 0 -%}
  <ul>

    {%- for article in blog.articles limit: section.settings.post_limit -%}
      <li>
        <a href="{{ article.url }}">
          {%- if article.image -%}
            {{ article | img_url: '150x150', scale: 2 | img_tag: '' }}
          {%- endif -%}
          <h2>{{ article.title }}</h2>
        </a>

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

        {%- if article.excerpt.size > 0 -%}
          {{ article.excerpt }}
        {%- else -%}
          {{ article.content | strip_html | truncate: 150 }}
        {%- endif -%}

        {%- if article.tags.size > 0 -%}
          <ul aria-label="{{ 'blogs.article.tags' }}">
          {%- for tag in article.tags -%}
            <li>
              <a href="{{ blog.url }}/tagged/{{ tag | handle }}">{{ tag }}</a>
            </li>
          {%- endfor -%}
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
                {{ article.comments_count }} comments
              </a>
            </li>
          {%- endif -%}

        </ul>
      </li>
    {%- endfor -%}

  </ul>
{%- endif -%}

{%- if section.settings.show_view_all -%}
  <a href="{{ blog.url }}"
    class="btn"
    aria-label="{{ 'blogs.article.view_all_blogs' }}">
    {{ 'blogs.article.view_all' }}
  </a>
{%- endif -%}

{% schema %}
{
  "name": "Blog posts",
  "class": "index-section",
  "settings": [
    {
      "type": "text",
      "id": "title",
      "label": "Heading",
      "default": "Blog posts"
    },
    {
      "id": "blog",
      "type": "blog",
      "label": "Blog"
    },
    {
      "type": "range",
      "id": "post_limit",
      "label": "Posts",
      "min": 3,
      "max": 12,
      "step": 3,
      "default": 3
    },
    {
      "type": "checkbox",
      "id": "blog_show_author",
      "label": "Show author",
      "default": false
    },
    {
      "type": "checkbox",
      "id": "blog_show_date",
      "label": "Show date",
      "default": true
    },
    {
      "type": "checkbox",
      "id": "show_view_all",
      "label": "Show 'View all' button",
      "default": false
    }
  ],
  "presets": [
    {
      "name": "Blog posts",
      "category": "Blog",
      "settings": {
        "blog": "News",
        "post_limit": 3
      }
    }
  ]
}
{% endschema %}
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
