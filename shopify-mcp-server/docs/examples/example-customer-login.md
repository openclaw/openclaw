# Customer Login

**Description:** A customer login form is used by visitors to log in to their customer account page. This form is added to the customer login page template and demonstrates the markup required. The form includes an email and password field, a button to submit the form, and links to create a new customer account and recover a forgotten password. If the store lets customers check out without creating an account, it also renders a "Continue as guest" button. If creating an account is set as optional on admin settings, a "Continue as Guest" control will be displayed. Use JavaScript to show/hide the password recovery form. Learn more about the Customer login form on the Shopify Web Design and Development Blog.

**Category:** Global  
**Last Updated:** Feb 21, 2019

## Implementation

1. Place the following code in the `Template/customers/login.liquid` file.

## Code

```liquid
<h1>Sign in to your Account</h1>

{%- form 'customer_login' -%}
  {{ form.errors | default_errors }}

  <div>
    <label for="customerEmail">Email Address</label>
    <input type="email"
      name="customer[email]"
      id="customerEmail"
      autocorrect="off"
      autocapitalize="off"
      autocomplete="email">
  </div>
  <div>
    <label for="customerPassword">Password</label>
    <input type="password"
      name="customer[password]"
      id="customerPassword">
  </div>

  <input type="submit" value="Sign In" />

  <p>
    {{ 'Create Account' | customer_register_link }}
  </p>
  <p>
    <a href="#recover">Forgot your password?</a>
  </p>

{%- endform -%}

<!-- If accounts are set as optional, the following will be shown as an option when coming from checkout, not on the default /login page. -->
{%- if shop.checkout.guest_login -%}
  {%- form 'guest_login' -%}
    <input type="submit" value="Continue as Guest" />
  {%- endform -%}
{%- endif -%}

<!-- Use JavaScript to show/hide this form -->
{%- form 'recover_customer_password' -%}

  {%- if form.posted_successfully? -%}
    <div role="status">
      <p>We've sent you an email with a link to update your password.</p>
    </div>
  {%- endif -%}

  <div id="recover"{% unless form.errors %} style="display: none;"{% endunless %}>
    <p>We will send you an email to reset your password.</p>

    {{ form.errors | default_errors }}

    <label for="customerEmail">Email Address</label>
    <input type="email"
      name="email"
      id="customerEmail"
      autocorrect="off"
      autocapitalize="off"
      autocomplete="email">

    <input type="submit" value="Submit">
  </div>

{%- endform -%}
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
