// MeshGuard Website JavaScript

// Mobile Navigation Toggle
const navToggle = document.querySelector('.nav-toggle');
const navLinks = document.querySelector('.nav-links');

if (navToggle) {
    navToggle.addEventListener('click', () => {
        navLinks.classList.toggle('active');
        navToggle.classList.toggle('active');
    });
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            const navHeight = document.querySelector('.nav').offsetHeight;
            const targetPosition = target.offsetTop - navHeight - 20;
            window.scrollTo({
                top: targetPosition,
                behavior: 'smooth'
            });
            
            // Close mobile menu if open
            if (navLinks.classList.contains('active')) {
                navLinks.classList.remove('active');
                navToggle.classList.remove('active');
            }
        }
    });
});

// Navbar background on scroll
const nav = document.querySelector('.nav');
window.addEventListener('scroll', () => {
    if (window.scrollY > 50) {
        nav.style.boxShadow = '0 4px 6px -1px rgb(0 0 0 / 0.1)';
    } else {
        nav.style.boxShadow = 'none';
    }
});

// Animate elements on scroll
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('animate-in');
            observer.unobserve(entry.target);
        }
    });
}, observerOptions);

// Observe elements for animation
document.querySelectorAll('.feature-card, .pricing-card, .stat, .step, .question-card').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    observer.observe(el);
});

// Add animation class styles
const style = document.createElement('style');
style.textContent = `
    .animate-in {
        opacity: 1 !important;
        transform: translateY(0) !important;
    }
    
    .nav-links.active {
        display: flex !important;
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        flex-direction: column;
        background: white;
        padding: 24px;
        gap: 16px;
        border-bottom: 1px solid #E2E8F0;
    }
    
    .nav-toggle.active span:nth-child(1) {
        transform: rotate(45deg) translate(5px, 5px);
    }
    
    .nav-toggle.active span:nth-child(2) {
        opacity: 0;
    }
    
    .nav-toggle.active span:nth-child(3) {
        transform: rotate(-45deg) translate(5px, -5px);
    }
`;
document.head.appendChild(style);

// Form submission handling
const form = document.querySelector('.cta-form');
if (form) {
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = form.querySelector('input[type="email"]').value;
        const button = form.querySelector('button');
        const originalText = button.textContent;
        
        button.textContent = 'Sending...';
        button.disabled = true;
        
        // Simulate form submission (replace with actual endpoint)
        try {
            // For now, just show success
            setTimeout(() => {
                button.textContent = 'Thank you!';
                form.querySelector('input').value = '';
                
                setTimeout(() => {
                    button.textContent = originalText;
                    button.disabled = false;
                }, 3000);
            }, 1000);
        } catch (error) {
            button.textContent = 'Error - try again';
            button.disabled = false;
        }
    });
}

// Console easter egg
console.log('%c🛡️ MeshGuard', 'font-size: 24px; font-weight: bold; color: #0A2540;');
console.log('%cGovernance Control Plane for the Agent Mesh', 'font-size: 14px; color: #64748B;');
console.log('%cInterested in joining us? david@meshguard.app', 'font-size: 12px; color: #00D4AA;');
