# Cart Notes

**Description:** You can add a text area to the cart page that allows customers to share special instructions for their order. Cart notes are submitted with a customer's order, and will appear on their order page in the Shopify admin. This code will display the user's instructions in a textarea element.

**Category:** Cart  
**Last Updated:** Feb 21, 2019

## Implementation

1. Add the following code to the `cart.liquid` file, inside the form. Cart notes typically appear just before the checkout button. Make sure that you keep `name="note"` so that cart notes are submitted correctly.

## Code

```liquid
<label for="CartNote">Special instructions</label>
<textarea name="note" id="CartNote">{{ cart.note }}</textarea>
```

**Please note:** We have intentionally limited CSS and JavaScript, and removed translation strings in order to keep these examples compatible with any theme. Any CSS we have included is for accessibility or rendering purposes.
