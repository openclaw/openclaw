# Comment List

**Description:** Commenting on blogs is an optional setting which can be enabled from the main Shopify admin. This code component will display a list of comments for a specific blog post.

**Category:** Blog  
**Last Updated:** Feb 21, 2019

## Implementation

1. The following code should be added to the file that contains code for article content, such as `article.liquid`.
2. Code to display article content should be placed below variable tags and above `{%- if blog.comments_enabled? -%}`.

## Code

```liquid
{%- assign new_comment = false -%}
{%- if comment and comment.created_at -%}
  {%- assign new_comment = true -%}
  {%- assign new_comment_id = comment.id -%}
{%- endif -%}

{%- if new_comment -%}
  {%- assign duplicate_comment = false -%}
  {%- for comment in article.comments -%}
    {%- if comment.id == new_comment_id -%}
      {%- assign duplicate_comment = true -%}
      {% break %}
    {%- endif -%}
  {%- endfor -%}

  {%- if duplicate_comment -%}
    {%- assign number_of_comments = article.comments_count -%}
  {%- else -%}
    {%- assign number_of_comments = article.comments_count | plus: 1 -%}
  {%- endif -%}
  {%- else -%}
    {%- assign number_of_comments = article.comments_count -%}
{%- endif -%}

<!-- Code to output article content can be added here. -->

{%- if blog.comments_enabled? -%}
  {%- if number_of_comments > 0 -%}
    <hr aria-hidden="true">
    <h2>{{ article.comments_count }}</h2>
    <ul>

      <!-- If a comment was just submitted with no blank field, show it. -->
      {%- if new_comment -%}
        <li>
          {{ comment.content }}
          <span>{{ comment.author }}</span>
  	      <span>{{ comment.created_at | time_tag: format: 'month_day_year' }}</span>
        </li>
      {%- endif -%}

      {% for comment in article.comments %}
        {% unless comment.id == new_comment_id %}
          <li>
            {{ comment.content }}
            <span>{{ comment.author }}</span>
  	        <span>{{ comment.created_at | time_tag: format: 'month_day_year' }}</span>
          </li>
        {% endunless %}
      {% endfor %}

    </ul>
  {%- endif -%}
{%- endif -%}
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
