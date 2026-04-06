# Stripe E-commerce Jewelry Shop

A simple, elegant jewelry e-commerce website with Stripe payment integration for secure checkout processing.

## Features

- 🛍️ Product catalog with jewelry items
- 🛒 Shopping cart functionality
- 💳 Secure payment processing with Stripe Elements
- 🔒 Server-side payment handling for security
- 📱 Responsive design for mobile and desktop
- ✨ Clean and modern UI

## Prerequisites

- Node.js (v14 or higher)
- A Stripe account (free test account works)
- npm or yarn package manager

## Getting Started

### 1. Get Your Stripe API Keys

1. Sign up for a free Stripe account at [stripe.com](https://stripe.com)
2. Navigate to the [Stripe Dashboard API Keys page](https://dashboard.stripe.com/apikeys)
3. You'll find two keys:
   - **Publishable key** (starts with `pk_test_...`) - Safe to use in frontend code
   - **Secret key** (starts with `sk_test_...`) - Keep this secure, use only on server

> **Security Note:** Never commit your secret key to version control or expose it in client-side code!

### 2. Install Dependencies

```bash
cd examples/jewelry-shop
npm install
```

This will install:
- `express` - Web server framework
- `stripe` - Official Stripe Node.js library
- `cors` - Enable CORS for API requests
- `dotenv` - Environment variable management

### 3. Configure Stripe Keys

#### Backend Configuration (Server-side)

Create a `.env` file in the `jewelry-shop` directory:

```bash
cp .env.example .env
```

Edit `.env` and add your Stripe secret key:

```
STRIPE_SECRET_KEY=sk_test_YOUR_ACTUAL_SECRET_KEY_HERE
PORT=3000
```

#### Frontend Configuration (Client-side)

Edit `src/checkout.js` and replace the placeholder with your publishable key:

```javascript
const STRIPE_PUBLISHABLE_KEY = 'pk_test_YOUR_ACTUAL_PUBLISHABLE_KEY_HERE';
```

### 4. Start the Server

```bash
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

The server will start on http://localhost:3000

### 5. Test the Application

1. Open your browser to http://localhost:3000
2. Browse the jewelry collection
3. Add items to your cart
4. Proceed to checkout
5. Use Stripe test card numbers:
   - **Success**: `4242 4242 4242 4242`
   - **Decline**: `4000 0000 0000 0002`
   - Use any future expiry date (e.g., 12/34)
   - Use any 3-digit CVC (e.g., 123)
   - Use any ZIP code

More test cards: [Stripe Testing Documentation](https://stripe.com/docs/testing)

## Project Structure

```
jewelry-shop/
├── index.html              # Main product listing page
├── checkout.html           # Checkout page with Stripe Elements
├── package.json            # Node.js dependencies
├── .env.example           # Example environment variables
├── public/
│   └── styles.css         # CSS styles
└── src/
    ├── app.js             # Frontend cart logic
    ├── checkout.js        # Stripe checkout integration (client-side)
    └── server.js          # Express server with Stripe API (server-side)
```

## How It Works

### Frontend (Client-side)

1. **Product Display** (`index.html`): Shows jewelry products with "Add to Cart" buttons
2. **Cart Management** (`app.js`): Handles cart operations using localStorage
3. **Checkout Form** (`checkout.html` + `checkout.js`):
   - Collects billing information
   - Integrates Stripe Elements for secure card input
   - Communicates with backend to process payment

### Backend (Server-side)

The `server.js` file provides secure payment processing:

1. **Create Payment Intent** (`/api/create-payment-intent`):
   - Receives cart items and billing details
   - Calculates total amount
   - Creates a Stripe PaymentIntent
   - Returns client secret to frontend

2. **Webhook Handler** (`/api/webhook`):
   - Receives payment events from Stripe
   - Handles successful payments, failures, etc.
   - Update database, send emails, fulfill orders (implement as needed)

### Security Best Practices

✅ **DO:**
- Keep secret keys in `.env` file and never commit them
- Always process payments server-side
- Validate all data on the server
- Use HTTPS in production
- Implement webhook signature verification
- Use Stripe's official libraries

❌ **DON'T:**
- Never expose secret keys in frontend code
- Don't trust client-side data for payment amounts
- Don't handle card details directly (use Stripe Elements)
- Don't skip server-side validation

## Stripe Elements Integration

Stripe Elements provides pre-built UI components that:
- Collect card information securely
- Handle validation and formatting
- Support responsive design
- Reduce PCI compliance scope
- Prevent common input errors

The card element is mounted in `checkout.html`:

```html
<div id="card-element"></div>
```

And initialized in `checkout.js`:

```javascript
const cardElement = elements.create('card');
cardElement.mount('#card-element');
```

## Customization

### Adding More Products

Edit `index.html` and add more product cards:

```html
<div class="product-card" data-id="7" data-name="Product Name" data-price="999.99">
    <div class="product-image">💎</div>
    <h3>Product Name</h3>
    <p class="description">Product description</p>
    <p class="price">$999.99</p>
    <button class="add-to-cart">Add to Cart</button>
</div>
```

### Styling

Modify `public/styles.css` to match your brand colors and design preferences.

### Payment Processing

Extend `server.js` to add:
- Database integration for order storage
- Email confirmation using SendGrid or similar
- Inventory management
- Order tracking
- Customer accounts

## Production Deployment

Before going live:

1. **Switch to Live Keys**:
   - Replace test keys (`pk_test_...`, `sk_test_...`) with live keys (`pk_live_...`, `sk_live_...`)

2. **Enable HTTPS**:
   - Use SSL certificates (Let's Encrypt, CloudFlare, etc.)
   - Update CORS settings for your domain

3. **Set Up Webhooks**:
   - Configure webhook endpoint in Stripe Dashboard
   - Add `STRIPE_WEBHOOK_SECRET` to `.env`
   - Ensure `/api/webhook` is accessible

4. **Environment Variables**:
   - Set environment variables on your hosting platform
   - Never commit `.env` to version control

5. **Testing**:
   - Test with live mode test cards before processing real payments
   - Verify webhook events are received correctly

## Resources

- [Stripe Documentation](https://stripe.com/docs)
- [Stripe API Reference](https://stripe.com/docs/api)
- [Stripe Elements](https://stripe.com/docs/stripe-js)
- [Payment Intents API](https://stripe.com/docs/payments/payment-intents)
- [Testing Stripe](https://stripe.com/docs/testing)
- [Webhook Events](https://stripe.com/docs/webhooks)

## Support

For Stripe-specific issues:
- [Stripe Support](https://support.stripe.com/)
- [Stripe Community](https://github.com/stripe)

## License

MIT License - feel free to use this as a template for your own projects.
