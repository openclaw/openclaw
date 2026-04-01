# Data Powered Product Recommendations

**Description:** The recommendations Liquid object provides merchants with the ability to surface data-powered product recommendations on their product pages. This static section can be added to product pages to display product recommendations, based on data from sales, product descriptions, and relations between products and collections. Product recommendations become more accurate over time as new orders and product data become available. More info can be found on the Shopify help docs.

**Category:** Products  
**Last Updated:** Jul 17, 2019

## Implementation

1. Create a new file within the `sections` folder of your theme, and paste the code below into this file. Save as `product-recommendations.liquid`.
2. On the `product.liquid` file add `{% section 'product-recommendations' %}` at the bottom of the file.
3. Product recommendations can be enabled on the theme editor.

## Code

```liquid
{%- if section.settings.show_product_recommendations -%}
  <div class="product-recommendations" data-product-id="{{ product.id }}" data-limit="4">
    {%- if recommendations.products_count > 0 -%}
      <h2>You may also like</h2>
      <ul>
        {%- for product in recommendations.products -%}
        <li>
          <a href="{{ product.url }}">
            <img src="{{ product.featured_image | img_url: '300x300' }}" alt="{{ product.featured_image.alt }}" />
            <p>{{ product.title }}</p>
            <p>{{ product.price | money}}</p>
          </a>
        </li>
        {%- endfor -%}
      </ul>
    {%- endif -%}
  </div>
{%- endif -%}

{% schema %}
{
  "name": "Product recommendations",
  "settings": [
    {
      "type": "checkbox",
      "id": "show_product_recommendations",
      "label": "Enable product recommendations",
      "default": false
    }
  ]
}
{% endschema %}


{% javascript %}
var loadProductRecommendationsIntoSection = function() {
  // Look for an element with class 'product-recommendations'
  var productRecommendationsSection = document.querySelector(".product-recommendations");
  if (productRecommendationsSection === null) { return; }
  // Read product id from data attribute
  var productId = productRecommendationsSection.dataset.productId;
  // Read limit from data attribute
  var limit = productRecommendationsSection.dataset.limit;
  // Build request URL
  var requestUrl = "/recommendations/products?section_id=product-recommendations&limit="+limit+"&product_id="+productId;
  // Create request and submit it using Ajax
  var request = new XMLHttpRequest();
  request.open("GET", requestUrl);
  request.onload = function() {
    if (request.status >= 200 && request.status < 300) {
      var container = document.createElement("div");
      container.innerHTML = request.response;
      productRecommendationsSection.parentElement.innerHTML = container.querySelector(".product-recommendations").innerHTML;
    }
  };
  request.send();
};
// If your section has theme settings, the theme editor
// reloads the section as you edit those settings. When that happens, the
// recommendations need to be fetched again.
// See https://help.shopify.com/en/themes/development/sections/integration-with-theme-editor
document.addEventListener("shopify:section:load", function(event) {
  if (event.detail.sectionId === "product-recommendations") {
    loadProductRecommendationsIntoSection();
  }
});
// Fetching the recommendations on page load
loadProductRecommendationsIntoSection();
{% endjavascript %}
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
