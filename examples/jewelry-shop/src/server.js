// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_YOUR_SECRET_KEY_HERE');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// Calculate order amount from items
function calculateOrderAmount(items) {
    return items.reduce((total, item) => {
        return total + Math.round(parseFloat(item.price) * 100); // Convert to cents
    }, 0);
}

// Create payment intent endpoint
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { items, billingDetails } = req.body;
        
        // Validate request
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Invalid items in cart' });
        }
        
        // Calculate amount
        const amount = calculateOrderAmount(items);
        
        // Create a PaymentIntent with the order amount and currency
        const paymentIntent = await stripe.paymentIntents.create({
            amount,
            currency: 'usd',
            // Verify your integration in the Stripe Dashboard with this metadata
            metadata: {
                integration_check: 'accept_a_payment',
                items: JSON.stringify(items.map(item => ({
                    id: item.id,
                    name: item.name,
                    price: item.price,
                }))),
            },
            description: 'Jewelry purchase',
            receipt_email: billingDetails?.email || null,
        });
        
        res.json({
            clientSecret: paymentIntent.client_secret,
            amount: amount,
        });
    } catch (error) {
        console.error('Error creating payment intent:', error);
        res.status(500).json({ 
            error: 'Failed to create payment intent',
            message: error.message 
        });
    }
});

// Webhook endpoint for Stripe events (optional but recommended)
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    if (!webhookSecret) {
        console.warn('Warning: STRIPE_WEBHOOK_SECRET not set');
        return res.status(400).send('Webhook secret not configured');
    }
    
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    // Handle the event
    switch (event.type) {
        case 'payment_intent.succeeded':
            const paymentIntent = event.data.object;
            console.log('PaymentIntent was successful!', paymentIntent.id);
            // Here you would typically:
            // - Update your database
            // - Send confirmation email
            // - Fulfill the order
            break;
        case 'payment_intent.payment_failed':
            const failedPayment = event.data.object;
            console.log('Payment failed:', failedPayment.id);
            // Handle failed payment
            break;
        default:
            console.log(`Unhandled event type ${event.type}`);
    }
    
    res.json({ received: true });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok',
        stripe_configured: !!process.env.STRIPE_SECRET_KEY 
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`\nIMPORTANT: Set your Stripe API keys in .env file:`);
    console.log(`  STRIPE_SECRET_KEY=sk_test_...`);
    console.log(`  STRIPE_WEBHOOK_SECRET=whsec_... (optional, for webhooks)`);
    console.log(`\nStripe secret key configured: ${!!process.env.STRIPE_SECRET_KEY ? 'Yes' : 'No'}`);
});

module.exports = app;
