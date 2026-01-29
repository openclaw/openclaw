# DNA Landing Page Specification

## Domain & Hosting

**Domain:** `dna.somovselect.com` (subdomain)
**Hosting:** **Cloudflare Pages** (Recommended)

### Why Cloudflare Pages?

| Feature | Cloudflare | Vercel | Netlify |
|---------|------------|--------|---------|
| Free tier bandwidth | Unlimited | 100GB | 100GB |
| Build minutes | 500/mo | 6000/mo | 300/mo |
| Edge network | Best-in-class | Great | Good |
| Custom domain | Free SSL | Free SSL | Free SSL |
| Cost at scale | Lowest | $$$ | $$ |

**Winner:** Cloudflare Pages for unlimited bandwidth and best global performance.

### Setup Steps

1. Create Cloudflare account (free)
2. Add `somovselect.com` to Cloudflare DNS
3. Create Pages project, connect GitHub repo
4. Add CNAME: `dna` → `<project>.pages.dev`

---

## Tech Stack

**Framework:** Astro + Tailwind CSS
**Template:** AstroWind (open source, fast, modern)
**Icons:** Phosphor Icons
**Fonts:** Inter (Variable)

---

## Page Structure

### 1. Header (Fixed)
```
[Logo]                    [Docs] [GitHub] [Get Started →]
```

### 2. Hero Section
```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│              Your AI, Everywhere You Chat                    │
│                                                             │
│    One AI assistant. WhatsApp. Telegram. Discord.           │
│         Persistent memory. Your machine.                     │
│                                                             │
│         [Get Started]  [Watch Demo →]                       │
│                                                             │
│            ┌─────────────────────────────────┐              │
│            │                                 │              │
│            │     [Product Screenshot]        │              │
│            │                                 │              │
│            └─────────────────────────────────┘              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Hero copy options:**

Option A (Current favorite):
- Headline: "Your AI, Everywhere You Chat"
- Subhead: "One AI assistant. WhatsApp. Telegram. Discord. Persistent memory. Your machine."

Option B:
- Headline: "AI That Actually Remembers"
- Subhead: "Connect your AI to WhatsApp, Telegram, and more. It remembers your context across every conversation."

Option C:
- Headline: "Stop Copy-Pasting to ChatGPT"
- Subhead: "DNA brings AI to your messaging apps. With memory that persists and tools that work."

### 3. Trust Block
```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   ⭐ 500+ GitHub Stars    📦 60+ Skills    🔒 Self-Hosted   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4. Features Grid
```
┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐
│  📱 Multi-Platform    │ │  🧠 Persistent Memory  │ │  🛠️ 60+ Skills       │
│                       │ │                        │ │                       │
│  WhatsApp, Telegram,  │ │  Remembers context     │ │  GitHub, Calendar,    │
│  Discord, Slack,      │ │  across conversations  │ │  Weather, Notion,     │
│  Signal, iMessage     │ │  Days, weeks, months   │ │  and more             │
└───────────────────────┘ └───────────────────────┘ └───────────────────────┘

┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐
│  💻 Built-in IDE      │ │  🔒 Privacy-First     │ │  🎨 Fully Customizable│
│                       │ │                        │ │                       │
│  AI-powered code      │ │  Runs on YOUR machine │ │  Choose your model,   │
│  editor with inline   │ │  Your data never      │ │  personality, and     │
│  editing & agent mode │ │  leaves your computer │ │  tools                │
└───────────────────────┘ └───────────────────────┘ └───────────────────────┘
```

### 5. Product Demo Section
```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│                    See DNA in Action                        │
│                                                             │
│    ┌─────────────────────────────────────────────────┐      │
│    │                                                 │      │
│    │           [Embedded Video Player]              │      │
│    │                                                 │      │
│    └─────────────────────────────────────────────────┘      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 6. How It Works
```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│                    Get Started in 5 Minutes                 │
│                                                             │
│   ┌──────┐        ┌──────┐        ┌──────┐        ┌──────┐ │
│   │  1   │───────▶│  2   │───────▶│  3   │───────▶│  4   │ │
│   │Clone │        │Setup │        │ Scan │        │ Chat │ │
│   └──────┘        └──────┘        └──────┘        └──────┘ │
│                                                             │
│   Clone the       Run wizard,     Scan QR for    Start     │
│   repository      add API key     WhatsApp       chatting! │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 7. Code Preview
```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│    $ git clone https://github.com/vanek-nutic/dna.git      │
│    $ cd dna && npm install && npm run build                │
│    $ ./dna.mjs wizard                                       │
│                                                             │
│    ✓ Select provider: Anthropic                            │
│    ✓ API key saved                                         │
│    ✓ WhatsApp connected                                    │
│    ✓ DNA is ready!                                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 8. Social Proof (Optional - Add Later)
```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  "DNA changed how I interact with AI. Having it on         │
│   WhatsApp means I can get help anywhere."                  │
│                                                             │
│   — Developer testimonial                                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 9. FAQ Section
```
Accordion with 6 key questions from FAQ doc
```

### 10. Final CTA
```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│              Ready to Try DNA?                              │
│                                                             │
│      Free and open source. Get started in 5 minutes.       │
│                                                             │
│         [Get Started]     [View Documentation]              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 11. Footer
```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  DNA                    Docs          Community             │
│  © 2026               - Quick Start  - GitHub               │
│  MIT License          - Install      - Discord              │
│                       - Config       - Twitter              │
│                       - Skills                              │
│                       - FAQ                                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Color Implementation

```css
:root {
  --color-primary: #6366F1;
  --color-primary-light: #818CF8;
  --color-primary-dark: #4F46E5;
  --color-bg-dark: #0F0D15;
  --color-bg-light: #FAFAFA;
  --color-text-dark: #1F2937;
  --color-text-light: #F9FAFB;
}
```

---

## SEO

**Title:** DNA — Your AI, Everywhere You Chat
**Description:** Self-hosted AI assistant for WhatsApp, Telegram, Discord and more. Persistent memory, 60+ skills, privacy-first.
**Keywords:** AI assistant, WhatsApp AI, self-hosted AI, ChatGPT alternative, Claude API

**Open Graph:**
- og:image: Product screenshot with DNA branding
- og:title: DNA — Your AI, Everywhere You Chat
- og:description: One AI assistant across all your messaging apps

---

## Implementation Steps

1. **Fork AstroWind template**
2. **Apply DNA branding** (colors, fonts, logo)
3. **Write content sections**
4. **Add product screenshots**
5. **Embed demo video**
6. **Deploy to Cloudflare Pages**
7. **Configure DNS** (dna.somovselect.com)
8. **Test performance** (aim for 95+ Lighthouse)
