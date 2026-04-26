---
name: component-picker
description: "Browse and select clawy Web Components, brand assets, and design tokens for building apps. Use when: (1) building a UI and needing the right component, (2) looking up available Web Components in /components/, (3) checking brand colors, fonts, or design tokens in /brand/, (4) finding the right Lucide icon name, (5) deciding which tile color or layout pattern to use. NOT for: deploying apps (use app-deploy), debugging (use app-debug), or writing tests (use app-test)."
---

# Component Picker

Find the right components, brand assets, and design tokens for clawy apps. Use this instead of reading the entire `/components/` and `/brand/` directories into context.

## How to Use

1. Read the component catalog below to identify what you need
2. Browse `/components/` for live previews and copy-paste code of specific components
3. Check `/brand/` for detailed design system documentation
4. Verify icon names at <https://lucide.dev/icons/> — never guess

## Component Catalog

The `/components/` directory contains 16+ ready-made Web Components. All are loaded by a single script:

```html
<script src="/components/clawy-ui.js"></script>
```

### Available Components

| Component | Tag | Use For |
|-----------|-----|---------|
| Button | `<clawy-button>` | Primary/secondary/ghost actions |
| Card | `<clawy-card>` | Content containers, feature cards |
| Input | `<clawy-input>` | Text fields, search boxes |
| Badge | `<clawy-badge>` | Status labels, tags, counts |
| Header | `<clawy-header>` | App navigation bar |
| Hero | `<clawy-hero>` | Landing page hero sections |
| FAQ | `<clawy-faq>` | Accordion FAQ sections |
| Pricing | `<clawy-pricing>` | Pricing comparison tables |
| Testimonial | `<clawy-testimonial>` | User quotes, reviews |
| Feature | `<clawy-feature>` | Feature highlight blocks |
| Stats | `<clawy-stats>` | Number displays, metrics |
| Footer | `<clawy-footer>` | Page footers |
| Modal | `<clawy-modal>` | Dialogs, confirmations |
| Toast | `<clawy-toast>` | Notifications, alerts |
| Tabs | `<clawy-tabs>` | Tab navigation |
| Divider | `<clawy-divider>` | Section separators |

### Header Component

```html
<script src="/assets/clawy-header.js"></script>
<clawy-header page-title="Your App"></clawy-header>
```

## Brand System

### Colors

| Token | Hex | Use |
|-------|-----|-----|
| `text-brand` / `bg-brand` | `#7c3aed` | Primary brand violet |
| `tile-cyan` | `#2e7d9e` | Cool accent |
| `tile-purple` | `#7c3aed` | Purple accent |
| `tile-amber` | `#d97706` | Warm accent |
| `tile-pink` | `#ec4899` | Pink accent |
| `tile-green` | `#16a34a` | Green accent |
| `tile-sand` | `#d4a76a` | Neutral warm |

Tailwind config is at `/assets/clawy-tailwind.js`:
```html
<script src="/assets/clawy-tailwind.js"></script>
```

### Typography

| Class | Font | Use For |
|-------|------|---------|
| `font-display` | Space Grotesk | Headings, hero text |
| `font-sans` | Inter | Body text, UI |
| `font-mono` | JetBrains Mono | Code, data, numbers |

### Icons — Lucide

1500+ icons. **Always verify at <https://lucide.dev/icons/>** — never guess icon names (hallucinated names silently fail).

```html
<i data-lucide="plus" class="w-4 h-4"></i>
```

After adding icons to the DOM (including dynamic content), call:
```javascript
lucide.createIcons();
```

## Tile Colors for Dashboard

When adding an app tile to the dashboard, pick a color:
- `tile-cyan` → apps related to data/analytics
- `tile-purple` → creative/productivity apps
- `tile-amber` → finance/business apps
- `tile-pink` → social/communication apps
- `tile-green` → health/nature apps
- `tile-sand` → neutral/utility apps

## Full Page Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>App Name</title>
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lucide@latest"></script>
  <script src="/assets/clawy-tailwind.js"></script>
  <script src="/components/clawy-ui.js"></script>
  <script src="/assets/clawy-header.js"></script>
</head>
<body class="font-sans bg-gray-50 min-h-screen">
  <clawy-header page-title="App Name"></clawy-header>
  <main class="max-w-2xl mx-auto px-4 py-8">
    <!-- App content -->
  </main>
  <script>lucide.createIcons();</script>
</body>
</html>
```
