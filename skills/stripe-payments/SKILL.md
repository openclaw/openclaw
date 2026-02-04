---
name: stripe-payments
description: "Create payment links, manage subscriptions, and track payments using Stripe API. For e-commerce, services, and subscription businesses."
homepage: https://stripe.com
metadata:
  {
    "openclaw":
      {
        "emoji": "💳",
        "requires": { "env": ["STRIPE_SECRET_KEY"] },
        "tags": ["payments", "stripe", "e-commerce", "subscriptions"],
        "install":
          [
            {
              "id": "npm",
              "kind": "npm",
              "package": "stripe",
              "label": "Install Stripe SDK (npm)",
            },
          ],
      },
  }
---

# Stripe Payments Skill

Create payment links, manage subscriptions, and track payments using the Stripe API.

## Setup

### Environment Variables

```bash
export STRIPE_SECRET_KEY="sk_live_..." # or sk_test_... for testing
export STRIPE_WEBHOOK_SECRET="whsec_..."
```

### Install Stripe CLI (optional, for testing)

```bash
# macOS
brew install stripe/stripe-cli/stripe

# Linux
curl -s https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public | gpg --dearmor | sudo tee /usr/share/keyrings/stripe.gpg
echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" | sudo tee -a /etc/apt/sources.list.d/stripe.list
sudo apt update && sudo apt install stripe
```

## Payment Links (Recommended for WhatsApp)

Payment Links are the easiest way to accept payments via messaging apps.

### Create a Payment Link

```bash
# Using Stripe CLI
stripe payment_links create \
  --line-items[0][price_data][currency]=brl \
  --line-items[0][price_data][product_data][name]="Site One Page" \
  --line-items[0][price_data][unit_amount]=50000 \
  --line-items[0][quantity]=1 \
  --after-completion[type]=redirect \
  --after-completion[redirect][url]="https://seusite.com/obrigado"
```

### Using the API (Node.js)

```javascript
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function createPaymentLink(productName, amountInCents, currency = 'brl') {
  const paymentLink = await stripe.paymentLinks.create({
    line_items: [
      {
        price_data: {
          currency: currency,
          product_data: {
            name: productName,
          },
          unit_amount: amountInCents,
        },
        quantity: 1,
      },
    ],
    after_completion: {
      type: 'redirect',
      redirect: {
        url: 'https://seusite.com/obrigado?session_id={CHECKOUT_SESSION_ID}',
      },
    },
  });

  return paymentLink.url;
}

// Example: Create link for R$ 500 site
const link = await createPaymentLink('Site One Page', 50000, 'brl');
console.log(link); // https://buy.stripe.com/xxx
```

## Pricing Products

### Create Products and Prices

```javascript
// Create a product
const product = await stripe.products.create({
  name: 'Site Institucional',
  description: 'Site profissional com 3-5 páginas',
});

// Create a one-time price
const price = await stripe.prices.create({
  product: product.id,
  unit_amount: 100000, // R$ 1.000,00
  currency: 'brl',
});

// Create a recurring price (subscription)
const monthlyPrice = await stripe.prices.create({
  product: product.id,
  unit_amount: 10000, // R$ 100,00/mês
  currency: 'brl',
  recurring: {
    interval: 'month',
  },
});
```

## Website Builder Pricing Examples

```javascript
const PRICING = {
  onePage: {
    name: 'Site One Page',
    amount: 50000, // R$ 500
    currency: 'brl',
  },
  institutional: {
    name: 'Site Institucional (3-5 páginas)',
    amount: 100000, // R$ 1.000
    currency: 'brl',
  },
  ecommerce: {
    name: 'Loja Virtual Básica',
    amount: 200000, // R$ 2.000
    currency: 'brl',
  },
  maintenance: {
    name: 'Manutenção Mensal',
    amount: 10000, // R$ 100/mês
    currency: 'brl',
    recurring: true,
  },
};

async function createPaymentLinkForService(serviceType) {
  const service = PRICING[serviceType];

  const lineItem = {
    price_data: {
      currency: service.currency,
      product_data: {
        name: service.name,
      },
      unit_amount: service.amount,
    },
    quantity: 1,
  };

  if (service.recurring) {
    lineItem.price_data.recurring = { interval: 'month' };
  }

  const paymentLink = await stripe.paymentLinks.create({
    line_items: [lineItem],
    after_completion: {
      type: 'redirect',
      redirect: {
        url: 'https://seusite.com/obrigado',
      },
    },
    // Collect customer info
    phone_number_collection: { enabled: true },
    // Allow promotion codes
    allow_promotion_codes: true,
  });

  return paymentLink.url;
}
```

## Webhooks for Payment Confirmation

### Set up webhook endpoint

```javascript
const express = require('express');
const app = express();

// Stripe webhook endpoint
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.log(`Webhook signature verification failed.`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      console.log('Payment completed:', session.id);

      // Get customer info
      const customerEmail = session.customer_details.email;
      const customerPhone = session.customer_details.phone;

      // Trigger delivery workflow
      await handlePaymentSuccess(session);
      break;

    case 'payment_intent.payment_failed':
      const paymentIntent = event.data.object;
      console.log('Payment failed:', paymentIntent.id);
      await handlePaymentFailure(paymentIntent);
      break;

    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

async function handlePaymentSuccess(session) {
  // 1. Update client state
  // 2. Send confirmation via WhatsApp
  // 3. Trigger site delivery workflow
}
```

## Stripe CLI Commands

### Test webhooks locally

```bash
# Forward webhooks to local server
stripe listen --forward-to localhost:3000/webhook/stripe

# Trigger test events
stripe trigger checkout.session.completed
```

### List payment links

```bash
stripe payment_links list --limit 10
```

### Check payment status

```bash
stripe checkout sessions list --limit 5
stripe checkout sessions retrieve cs_xxx
```

## Integration with WhatsApp Workflow

### Send Payment Link Message

```javascript
async function sendPaymentRequest(phoneNumber, serviceType, clientName) {
  const paymentLink = await createPaymentLinkForService(serviceType);
  const service = PRICING[serviceType];
  const formattedAmount = (service.amount / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });

  const message = `
Olá ${clientName}! Seu site está pronto para publicação! 🎉

💰 **Serviço:** ${service.name}
💵 **Valor:** ${formattedAmount}

Para liberar o acesso, clique no link de pagamento:
${paymentLink}

Após a confirmação, você receberá:
✅ Link do site publicado
✅ Instruções de acesso ao painel
✅ Suporte por 30 dias
  `.trim();

  // Send via WhatsApp
  await sendWhatsAppMessage(phoneNumber, message);
}
```

### Payment Confirmation Notification

```javascript
async function notifyPaymentReceived(phoneNumber, clientName, siteUrl) {
  const message = `
✅ Pagamento confirmado, ${clientName}!

Seu site está no ar:
🌐 ${siteUrl}

Obrigado pela confiança! 🙏
  `.trim();

  await sendWhatsAppMessage(phoneNumber, message);
}
```

## Security Best Practices

1. **Never expose secret keys** - Use environment variables
2. **Verify webhook signatures** - Always validate events
3. **Use test mode** - Use `sk_test_` keys for development
4. **HTTPS only** - Webhook endpoints must use HTTPS
5. **Idempotency** - Handle duplicate webhook events gracefully

## Stripe Dashboard Links

- [Payment Links](https://dashboard.stripe.com/payment-links)
- [Payments](https://dashboard.stripe.com/payments)
- [Webhooks](https://dashboard.stripe.com/webhooks)
- [API Keys](https://dashboard.stripe.com/apikeys)
