// Stripe checkout functionality
// IMPORTANT: Replace 'your_stripe_publishable_key_here' with your actual Stripe Publishable Key
const STRIPE_PUBLISHABLE_KEY = 'pk_test_YOUR_PUBLISHABLE_KEY_HERE';

let stripe;
let elements;
let cardElement;

// Get cart from localStorage
const cart = JSON.parse(localStorage.getItem('cart')) || [];

// Initialize Stripe
function initializeStripe() {
    try {
        stripe = Stripe(STRIPE_PUBLISHABLE_KEY);
        elements = stripe.elements();
        
        // Create card element
        cardElement = elements.create('card', {
            style: {
                base: {
                    fontSize: '16px',
                    color: '#333',
                    '::placeholder': {
                        color: '#aab7c4',
                    },
                },
                invalid: {
                    color: '#e74c3c',
                },
            },
        });
        
        // Mount card element
        cardElement.mount('#card-element');
        
        // Handle real-time validation errors
        cardElement.on('change', (event) => {
            const displayError = document.getElementById('card-errors');
            if (event.error) {
                displayError.textContent = event.error.message;
            } else {
                displayError.textContent = '';
            }
        });
    } catch (error) {
        console.error('Error initializing Stripe:', error);
        showMessage('Error initializing payment system. Please check your Stripe configuration.', 'error');
    }
}

// Display order summary
function displayOrderSummary() {
    const orderSummary = document.getElementById('order-summary');
    const orderTotal = document.getElementById('order-total');
    const cartCount = document.getElementById('cart-count');
    
    if (cart.length === 0) {
        orderSummary.innerHTML = '<p>No items in cart. <a href="index.html">Continue shopping</a></p>';
        orderTotal.textContent = '0.00';
        document.getElementById('payment-form').style.display = 'none';
        return;
    }
    
    orderSummary.innerHTML = cart.map(item => `
        <div class="order-item">
            <span>${item.name}</span>
            <span>$${parseFloat(item.price).toFixed(2)}</span>
        </div>
    `).join('');
    
    const total = cart.reduce((sum, item) => sum + parseFloat(item.price), 0);
    orderTotal.textContent = total.toFixed(2);
    cartCount.textContent = cart.length;
}

// Show message
function showMessage(messageText, type = 'error') {
    const messageContainer = document.getElementById('payment-message');
    messageContainer.textContent = messageText;
    messageContainer.className = `payment-message ${type}`;
    messageContainer.style.display = 'block';
    
    // Scroll to message
    messageContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Set loading state
function setLoading(isLoading) {
    const submitButton = document.getElementById('submit-payment');
    const buttonText = document.getElementById('button-text');
    const spinner = document.getElementById('spinner');
    
    if (isLoading) {
        submitButton.disabled = true;
        buttonText.style.display = 'none';
        spinner.style.display = 'inline-block';
    } else {
        submitButton.disabled = false;
        buttonText.style.display = 'inline';
        spinner.style.display = 'none';
    }
}

// Handle form submission
async function handleSubmit(event) {
    event.preventDefault();
    
    if (cart.length === 0) {
        showMessage('Your cart is empty.', 'error');
        return;
    }
    
    setLoading(true);
    
    // Get form data
    const name = document.getElementById('name').value;
    const email = document.getElementById('email').value;
    const address = document.getElementById('address').value;
    const city = document.getElementById('city').value;
    const zip = document.getElementById('zip').value;
    
    try {
        // In a real application, you would:
        // 1. Send cart data to your server
        // 2. Server creates a PaymentIntent with Stripe
        // 3. Server returns the client_secret
        // 4. Use the client_secret to confirm the payment
        
        // For demonstration purposes, we'll show what the flow would look like:
        
        // Step 1: Create payment intent on server (MUST be done server-side for security)
        const response = await fetch('/api/create-payment-intent', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                items: cart,
                billingDetails: {
                    name,
                    email,
                    address: {
                        line1: address,
                        city,
                        postal_code: zip,
                    },
                },
            }),
        });
        
        if (!response.ok) {
            throw new Error('Failed to create payment intent. Please ensure your server is running.');
        }
        
        const { clientSecret } = await response.json();
        
        // Step 2: Confirm the payment with Stripe
        const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
            payment_method: {
                card: cardElement,
                billing_details: {
                    name,
                    email,
                    address: {
                        line1: address,
                        city,
                        postal_code: zip,
                    },
                },
            },
        });
        
        if (error) {
            showMessage(error.message, 'error');
        } else if (paymentIntent.status === 'succeeded') {
            showMessage('Payment successful! Thank you for your purchase.', 'success');
            
            // Clear cart
            localStorage.removeItem('cart');
            
            // Redirect to success page after delay
            setTimeout(() => {
                window.location.href = 'index.html';
            }, 3000);
        }
    } catch (error) {
        console.error('Payment error:', error);
        showMessage(
            'Unable to process payment. This is a demo - please ensure the server is running. ' +
            'See README.md for setup instructions.',
            'error'
        );
    } finally {
        setLoading(false);
    }
}

// Initialize page
document.addEventListener('DOMContentLoaded', () => {
    displayOrderSummary();
    initializeStripe();
    
    // Handle form submission
    const form = document.getElementById('payment-form');
    if (form) {
        form.addEventListener('submit', handleSubmit);
    }
    
    // Cart link
    const cartLink = document.getElementById('cart-link');
    if (cartLink) {
        cartLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.location.href = 'index.html#cart-section';
        });
    }
});
