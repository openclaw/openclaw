# Shopify Liquid code examples

## Accessible pagination

Build and customize themes faster with component-based Liquid examples

< Browse library
Accessible paginationLast updated: Feb 21, 2019
Navigation

Pagination is an ordered numbering of pages usually located at the top or bottom of a webpage. These ordered page numbers enable users to navigate through a series of pages where content has been split up for design purposes, usability, faster loading, and so on. Splitting products, blog articles, and search results across multiple pages is a necessary part of theme design, as you are limited to 50 results per page in any forloop.

Place the following code where you wish pagination to display. This code must appear within paginate tags for the following example to work. Within the paginate tags, you can access the paginate object.
Specify the type of content you want to paginate, and at what limit you wish to paginate by, for example {% paginate collection.products by limit %} or {% paginate blog.articles by 12 %}.

https://shopify.github.io/liquid-code-examples/example/accessible-pagination

```liquid
<style>
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

{%- paginate blog.articles by 5 -%}
  {%- for article in blog.articles -%}
    <!-- show blog article details here -->
  {%- endfor -%}

  {%- if paginate.pages > 1 -%}
    <nav role="navigation">
      <ol class="pagination">
        {%- if paginate.previous-%}
          <li>
            <a href="{{ paginate.previous.url }}">
              <span aria-hidden="true">&laquo;</span>
              Previous <span class="visuallyhidden">page</span>
            </a>
          </li>
        {%- else -%}
          <li class="disabled">
            <span aria-hidden="true">&laquo;</span>
            Previous <span class="visuallyhidden">page</span>
          </li>
        {%- endif -%}

        {%- for part in paginate.parts -%}
          {%- if part.is_link -%}
            <li>
              <a href="{{ part.url }}">
                <span class="visuallyhidden">page</span> {{ part.title }}
              </a>
            </li>
          {%- else -%}
            {%- if part.title == paginate.current_page -%}
              <li class="active" aria-current="page">
                <span class="visuallyhidden">page</span> {{ part.title }}
              </li>
            {%- else -%}
              <li>
                <span class="visuallyhidden">page</span> {{ part.title }}
              </li>
            {%- endif -%}
          {%- endif -%}
        {%- endfor -%}

        {%- if paginate.next -%}
          <li>
            <a href="{{ paginate.next.url }}">
              Next <span class="visuallyhidden">page</span>
              <span aria-hidden="true">&raquo;</span>
            </a>
          </li>
        {%- else -%}
          <li class="disabled">
            Next <span class="visuallyhidden">page</span>
            <span aria-hidden="true">&raquo;</span>
          </li>
        {%- endif -%}
      </ol>
    </nav>
  {%- endif -%}
{%- endpaginate -%}
```
