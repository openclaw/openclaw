# Shopify Liquid code examples

## Announcement Bar

Build and customize themes faster with component-based Liquid examples

Announcement Bar Last updated: Feb 21, 2019
Sections

An announcement bar allows merchants to display custom updates and promote discounts. When added to a theme, this static section can be displayed on the homepage or on all pages, and can be configured from the theme editor.

Create a new file within the sections folder of your theme, and paste the code below into this file. Save as announcement-bar.liquid.
On the theme.liquid file add {% section 'announcement-bar' %} in the position where you would like it to appear (eg. within the main page wrapper container, above the {{ content_for_layout }} Liquid object). More info on how static sections can be added to pages can be found on our help docs.
Text, links, and the ability to enable the bar on the homepage or all pages can now be assigned from the theme editor.

```liquid
{%- if section.settings.show_announcement -%}
  {%- if section.settings.home_page_only == false or template.name == 'index' -%}

    {%- if section.settings.link == blank -%}
      <div>
    {%- else -%}
      <a href="{{ section.settings.link }}" >
    {%- endif -%}

      <p>{{ section.settings.text | escape }}</p>

    {%- if section.settings.link == blank -%}
      </div>
    {%- else -%}
      </a>
    {%- endif -%}

  {%- endif -%}
{%- endif -%}

{% schema %}
{
  "name": "Announcement bar",
  "settings": [
    {
      "type": "checkbox",
      "id": "show_announcement",
      "label": "Show announcement",
      "default": false
    },
    {
      "type": "checkbox",
      "id": "home_page_only",
      "label": "Home page only",
      "default": true
    },
    {
      "type": "text",
      "id": "text",
      "label": "Announcement text",
      "default": "Announce something here"
    },
    {
      "type": "url",
      "id": "link",
      "label": "Announcement link"
    }
  ]
}
{% endschema %}
```
