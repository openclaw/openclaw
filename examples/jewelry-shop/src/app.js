// Shopping cart functionality
let cart = JSON.parse(localStorage.getItem('cart')) || [];

// Update cart count
function updateCartCount() {
    const cartCount = document.getElementById('cart-count');
    if (cartCount) {
        cartCount.textContent = cart.length;
    }
}

// Add to cart
function addToCart(product) {
    cart.push(product);
    localStorage.setItem('cart', JSON.stringify(cart));
    updateCartCount();
    showCartSection();
    renderCart();
    alert(`${product.name} added to cart!`);
}

// Remove from cart
function removeFromCart(index) {
    cart.splice(index, 1);
    localStorage.setItem('cart', JSON.stringify(cart));
    updateCartCount();
    renderCart();
    if (cart.length === 0) {
        hideCartSection();
    }
}

// Calculate total
function calculateTotal() {
    return cart.reduce((total, item) => total + parseFloat(item.price), 0);
}

// Render cart
function renderCart() {
    const cartItems = document.getElementById('cart-items');
    const cartTotal = document.getElementById('cart-total');
    
    if (!cartItems) return;
    
    if (cart.length === 0) {
        cartItems.innerHTML = '<p style="text-align: center; padding: 2rem;">Your cart is empty</p>';
        cartTotal.textContent = '0.00';
        return;
    }
    
    cartItems.innerHTML = cart.map((item, index) => `
        <div class="cart-item">
            <div class="cart-item-info">
                <div class="cart-item-name">${item.name}</div>
                <div class="cart-item-price">$${parseFloat(item.price).toFixed(2)}</div>
            </div>
            <button class="remove-item" onclick="removeFromCart(${index})">Remove</button>
        </div>
    `).join('');
    
    cartTotal.textContent = calculateTotal().toFixed(2);
}

// Show/hide cart section
function showCartSection() {
    const cartSection = document.getElementById('cart-section');
    if (cartSection) {
        cartSection.style.display = 'block';
    }
}

function hideCartSection() {
    const cartSection = document.getElementById('cart-section');
    if (cartSection) {
        cartSection.style.display = 'none';
    }
}

// Initialize page
document.addEventListener('DOMContentLoaded', () => {
    updateCartCount();
    
    // Add to cart buttons
    const addToCartButtons = document.querySelectorAll('.add-to-cart');
    addToCartButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            const card = e.target.closest('.product-card');
            const product = {
                id: card.dataset.id,
                name: card.dataset.name,
                price: card.dataset.price
            };
            addToCart(product);
        });
    });
    
    // Cart link
    const cartLink = document.getElementById('cart-link');
    if (cartLink) {
        cartLink.addEventListener('click', (e) => {
            e.preventDefault();
            if (cart.length > 0) {
                showCartSection();
                renderCart();
                document.getElementById('cart-section').scrollIntoView({ behavior: 'smooth' });
            } else {
                alert('Your cart is empty');
            }
        });
    }
    
    // Checkout button
    const checkoutBtn = document.getElementById('checkout-btn');
    if (checkoutBtn) {
        checkoutBtn.addEventListener('click', () => {
            if (cart.length > 0) {
                window.location.href = 'checkout.html';
            } else {
                alert('Your cart is empty');
            }
        });
    }
    
    // Show cart if items exist
    if (cart.length > 0) {
        showCartSection();
        renderCart();
    }
});
