# Customer Account Links

**Description:** Customer account links allow customers to log into their existing account or to create a new customer account on a Shopify store. These links typically appear in the header area of a website.

**Category:** Global  
**Last Updated:** Feb 21, 2019

## Implementation

1. Add the following code to the `header.liquid` section file, or in the place that you want the customer account links to appear.

## Code

```liquid
{%- if shop.customer_accounts_enabled -%}
  <ul>
    {%- if customer -%}
      <li>
        <a href="/account">Account</a>
      </li>
      <li>
        {{ 'Log out' | customer_logout_link }}
      </li>
    {%- else -%}
      <li>
        {{ 'Log in' | customer_login_link }}
      </li>
      <li>
        {{ 'Create account' | customer_register_link }}
      </li>
    {%- endif -%}
  </ul>
{%- endif -%}
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
