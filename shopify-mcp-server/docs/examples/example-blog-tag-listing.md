# Shopify Liquid code examples

## Blog tag listing

Build and customize themes faster with component-based Liquid examples

Blog tag listing Last updated: Feb 21, 2019
Blog

Tags are a type of taxonomy, or labelling system, and are often used to reflect the keywords of a blog article. Tags also provide a means of navigation for customers browsing for similar blog posts. This component displays all the tags that exist on the current blog.

1. Locate the section file which contains your theme's blog article listing, such as `blog-template.liquid`, and paste the code below into the file.
2. The section settings in this example can be placed inside the sections' existing schema array, if it is already present. For example, it can be placed within the section setting named `Blog pages`. In this case, the code within the `{% schema %}` tags below can be added within the existing schema settings (including a comma to separate from other settings).
3. By default, tags for all blogs will appear. This can be disabled on the theme editor.

```liquid
<aside>
  {%- if section.settings.blog_show_tags -%}
    <ul>
      <li>
        {%- for tag in blog.all_tags -%}
          <a href="{{ blog.url }}/tagged/{{ tag | handle }}">{{ tag }}</a>{% unless forloop.last %}, {% endunless %}
        {%- endfor -%}
      </li>
    </ul>
  {%- endif -%}
</aside>

{% schema %}
{
  "name": "Blog posts",
  "settings": [
    {
      "type": "checkbox",
      "id": "blog_show_tags",
      "label": "Show tags",
      "default": true
    }
  ]
}
{% endschema %}
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
