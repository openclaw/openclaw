# Modern Web Design Patterns

Complete guide to modern web design including responsive layouts, performance, and progressive enhancement.

## Core Web Principles

### 1. Mobile-First
Start with mobile design, progressively enhance for larger screens

### 2. Performance
Fast load times (<3s), optimized assets, minimal JS

### 3. Accessibility
Semantic HTML, keyboard nav, screen reader friendly

### 4. Progressive Enhancement
Works everywhere, enhanced where supported

---

## Responsive Design

### Breakpoints
```css
/* Mobile first */
.container { width: 100%; padding: 16px; }

/* Tablet: 640px+ */
@media (min-width: 640px) {
  .container { padding: 24px; }
}

/* Desktop: 1024px+ */
@media (min-width: 1024px) {
  .container { 
    max-width: 1200px;
    margin: 0 auto;
    padding: 32px;
  }
}

/* Wide: 1440px+ */
@media (min-width: 1440px) {
  .container { max-width: 1400px; }
}
```

### Responsive Patterns
- **Stack → Columns:** 1 col mobile, 2-4 desktop
- **Hide/Show:** Progressive disclosure
- **Reorder:** CSS Grid `order` property
- **Fluid Typography:** `clamp()` for responsive text

---

## Layout Systems

### CSS Grid
```css
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 24px;
}
```

### Flexbox
```css
.flex {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  align-items: center;
}
```

### Container Queries
```css
@container (min-width: 400px) {
  .card { display: grid; grid-template-columns: 1fr 2fr; }
}
```

---

## Modern CSS Techniques

### CSS Custom Properties
```css
:root {
  --primary: oklch(0.649 0.237 267);
  --spacing-m: 16px;
  --radius: 8px;
}

.button {
  background: var(--primary);
  padding: var(--spacing-m);
  border-radius: var(--radius);
}
```

### oklch() Colors
```css
/* Better than HSL - perceptually uniform */
:root {
  --primary: oklch(0.65 0.24 267); /* L C H */
  --hover: oklch(0.75 0.24 267);   /* Lighter */
}
```

### Modern Selectors
```css
/* :has() - parent selector */
.card:has(img) { padding-top: 0; }

/* :is() - grouping */
:is(h1, h2, h3) { font-family: Display; }

/* :where() - zero specificity */
:where(ul, ol) { padding-left: 1rem; }
```

---

## Component Patterns

### Cards
```html
<div class="card">
  <img src="..." alt="..." />
  <div class="card-body">
    <h3>Title</h3>
    <p>Description</p>
    <button>Action</button>
  </div>
</div>
```

```css
.card {
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  transition: transform 0.2s, box-shadow 0.2s;
}

.card:hover {
  transform: translateY(-4px);
  box-shadow: 0 4px 16px rgba(0,0,0,0.15);
}
```

### Navigation
```html
<nav class="navbar">
  <div class="nav-brand">Logo</div>
  <ul class="nav-menu">
    <li><a href="#">Home</a></li>
    <li><a href="#">About</a></li>
    <li><a href="#">Contact</a></li>
  </ul>
  <button class="nav-toggle">☰</button>
</nav>
```

### Modal
```html
<dialog class="modal">
  <div class="modal-content">
    <h2>Modal Title</h2>
    <p>Content here...</p>
    <button onclick="this.closest('dialog').close()">Close</button>
  </div>
</dialog>
```

---

## Performance Optimization

### Image Optimization
```html
<!-- Responsive images -->
<img 
  src="image-800.jpg"
  srcset="image-400.jpg 400w, image-800.jpg 800w, image-1200.jpg 1200w"
  sizes="(max-width: 640px) 100vw, 800px"
  alt="Description"
  loading="lazy"
/>

<!-- Modern formats with fallback -->
<picture>
  <source srcset="image.avif" type="image/avif" />
  <source srcset="image.webp" type="image/webp" />
  <img src="image.jpg" alt="Description" />
</picture>
```

### Font Loading
```css
/* Preload critical fonts */
<link rel="preload" href="font.woff2" as="font" type="font/woff2" crossorigin />

/* font-display for FOUT control */
@font-face {
  font-family: 'MyFont';
  src: url('font.woff2') format('woff2');
  font-display: swap; /* or optional, fallback */
}
```

### Critical CSS
- Inline critical above-the-fold CSS
- Load rest async
- Use `<link rel="preload">` for fonts/assets

---

## Accessibility

### Semantic HTML
```html
<header>
  <nav aria-label="Main navigation">...</nav>
</header>

<main>
  <article>
    <h1>Title</h1>
    <p>Content...</p>
  </article>
</main>

<aside aria-label="Related links">...</aside>

<footer>...</footer>
```

### ARIA Attributes
```html
<!-- Landmark roles (when semantic HTML insufficient) -->
<div role="navigation" aria-label="Breadcrumbs">...</div>

<!-- State -->
<button aria-pressed="false">Toggle</button>

<!-- Live regions -->
<div aria-live="polite">Status message</div>

<!-- Labels -->
<button aria-label="Close modal">✕</button>
```

### Skip Links
```html
<a href="#main-content" class="skip-link">Skip to main content</a>
```

---

## Progressive Web Apps (PWA)

### Manifest
```json
{
  "name": "My App",
  "short_name": "App",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#667eea",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

### Service Worker (Basic)
```javascript
// Cache-first strategy
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});
```

---

## CSS Frameworks & Libraries

### Tailwind CSS (Utility-First)
```html
<div class="p-4 bg-white rounded-lg shadow-md hover:shadow-lg transition">
  <h3 class="text-xl font-bold mb-2">Title</h3>
  <p class="text-gray-600">Description</p>
</div>
```

### CSS-in-JS (React)
```javascript
const Button = styled.button`
  padding: 12px 24px;
  background: var(--primary);
  color: white;
  border-radius: 8px;
  &:hover { background: var(--primary-hover); }
`;
```

---

## Browser Compatibility

### Feature Detection
```javascript
if ('IntersectionObserver' in window) {
  // Use Intersection Observer
} else {
  // Fallback
}
```

### CSS Feature Queries
```css
@supports (backdrop-filter: blur(10px)) {
  .glass { backdrop-filter: blur(10px); }
}

@supports not (backdrop-filter: blur(10px)) {
  .glass { background: rgba(255,255,255,0.9); }
}
```

---

## Design Checklist

✅ Mobile-first responsive
✅ Fast load (<3s)
✅ Accessible (WCAG AA)
✅ Semantic HTML
✅ Optimized images
✅ Works without JS (progressive enhancement)
✅ Cross-browser tested
✅ Touch-friendly (44px targets)

---

*For responsive patterns, see responsive-design.md. For forms, see forms.md.*
