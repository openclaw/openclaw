# Social Media Navigation

**Description:** Social media navigation is a static menu linking to various social media accounts using icons. These linked social media icons, or buttons, are usually located at the top or bottom of a webpage. Please note that this example uses an iconic font to display the social media icons. We highly recommend that you use inline SVG icons, or a third party service to generate an SVG sprite map of icons to use via class name such as Icomoon or Fontastic.

**Category:** Navigation  
**Last Updated:** Feb 21, 2019

## Implementation

1. Place the following code where you would like your social media navigation to appear.
2. The `visually-hidden` class hides the link text from the screen so only the icon is visible, and the `aria-describedby` attribute lets people using screen readers know that the link will open a new window. A longer explanation can be found in this article.

## Code

```liquid
{{ 'social/social-icons.css' | global_asset_url | stylesheet_tag }}

<div hidden>
  <span id="new-window-0">Opens in a new window</span>
</div>

<ul class="social-media-menu">
  <li>
    <a href="https://facebook.com/shopify"
      target="_blank"
      rel="noopener"
      aria-label="Facebook"
      aria-describedby="new-window-0">
      <span class="shopify-social-icon-facebook-circle" aria-hidden="true"></span>
    </a>
  </li>
  <li>
    <a href="https://twitter.com/shopify"
      target="_blank"
      rel="noopener"
      aria-label="Twitter"
      aria-describedby="new-window-0">
      <span class="visuallyhidden">Twitter</span>
      <span class="shopify-social-icon-twitter-circle" aria-hidden="true"></span>
    </a>
  </li>
  <li>
    <a href="https://pinterest.com/shopify/"
      target="_blank"
      rel="noopener"
      aria-label="Pinterest"
      aria-describedby="new-window-0">
      <span class="shopify-social-icon-pinterest-circle" aria-hidden="true"></span>
    </a>
  </li>
  <li>
    <a href="https://instagram.com/shopify/"
      target="_blank"
      rel="noopener"
      aria-label="Instagram"
      aria-describedby="new-window-0">
      <span class="shopify-social-icon-instagram-circle" aria-hidden="true"></span>
    </a>
  </li>
</ul>
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
