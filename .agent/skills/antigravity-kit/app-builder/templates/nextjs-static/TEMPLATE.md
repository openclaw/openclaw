---
name: nextjs-static
description: Next.js static site template principles. Landing pages, portfolios, marketing.
---

# Next.js Static Site Template

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Next.js 14 (Static Export) |
| Language | TypeScript |
| Styling | Tailwind CSS |
| Animations | Framer Motion |
| Icons | Lucide React |
| SEO | Next SEO |

---

## Directory Structure

```
project-name/
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx      # Landing
│   │   ├── about/
│   │   ├── contact/
│   │   └── blog/
│   ├── components/
│   │   ├── layout/       # Header, Footer
│   │   ├── sections/     # Hero, Features, CTA
│   │   └── ui/
│   └── lib/
├── content/              # Markdown content
├── public/
└── next.config.js
```

---

## Static Export Config

```javascript
// next.config.js
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
};
```

---

## Landing Page Sections

| Section | Purpose |
|---------|---------|
| Hero | Main headline, CTA |
| Features | Product benefits |
| Testimonials | Social proof |
| Pricing | Plans |
| CTA | Final conversion |

---

## Animation Patterns

| Pattern | Use |
|---------|-----|
| Fade up | Content entry |
| Stagger | List items |
| Scroll reveal | On viewport |
| Hover | Interactive feedback |

---

## Setup Steps

1. `npx create-next-app {{name}} --typescript --tailwind --app`
2. Install: `npm install framer-motion lucide-react next-seo`
3. Configure static export
4. Create sections
5. `npm run dev`

---

## Deployment

| Platform | Method |
|----------|--------|
| Vercel | Auto |
| Netlify | Auto |
| GitHub Pages | gh-pages branch |
| Any host | Upload `out` folder |

---

## Best Practices

- Static export for maximum performance
- Framer Motion for premium animations
- Responsive mobile-first design
- SEO metadata on every page
