# Nested Navigation

**Description:** A nested navigation or nested menu is a popular solution for effectively organizing collections, products, and pages. This example will output a nested menu of links in an unordered list up to three levels deep, all of which can be easily updated using the Shopify Admin. A nested navigation uses the Shopify linklist object.

**Category:** Navigation  
**Last Updated:** Feb 21, 2019

## Implementation

1. Place the following code in the `Sections/header.liquid` file, or wherever you wish the nested navigation to appear.
2. If used in a section, you can also create a settings option in the section schema, and replace the `forloop` in this example with `{% for link in linklists[section.settings.main_linklist].links %}` where `main_linklist` is the `id` of the schema setting. This setting would specify a `link_list` picker, and the `default` value would be set to `main-menu`.
3. Add relevant classes and styles to create dropdown functionality via CSS.

## Code

```liquid
<nav role="navigation">
  <ul>
    {%- for link in linklists.main-menu.links -%}
      <li>
        <a href="{{ link.url }}" {% if link.active %}aria-current="page"{% endif %}>
          {{ link.title }}
        </a>

        {%- if link.links != blank -%}
          <ul>
            {%- for child_link in link.links -%}
              <li>
                <a href="{{ child_link.url }}" {% if child_link.active %}aria-current="page"{% endif %}>
                  {{ child_link.title }}
                </a>

                {%- if child_link.links != blank -%}
                  <ul>
                    {%- for grandchild_link in child_link.links -%}
                      <li>
                        <a href="{{ grandchild_link.url }}" {% if grandchild_link.active %}aria-current="page"{% endif %}>
                          {{ grandchild_link.title }}
                        </a>
                      </li>
                    {%- endfor -%}
                  </ul>
                {%- endif -%}

              </li>
            {%- endfor -%}
          </ul>
        {%- endif -%}

      </li>
    {%- endfor -%}
  </ul>
</nav>
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
