---
name: landing-page-design
description: "Landing page conversion optimization with layout rules, hero section design, and CTA psychology. Covers above-the-fold formula, social proof placement, mobile design, and F-pattern reading. Use for: startup landing pages, product pages, SaaS marketing, conversion optimization. Triggers: landing page, hero section, above the fold, conversion optimization, landing page design, cta button, hero image, landing page layout, saas landing page, product page design, conversion rate, landing page best practices"
allowed-tools: Bash(infsh *)
---

# Landing Page Design

Design high-converting landing pages with AI-generated visuals via [inference.sh](https://inference.sh) CLI.

## Quick Start

```bash
curl -fsSL https://cli.inference.sh | sh && infsh login

# Generate a hero image
infsh app run falai/flux-dev-lora --input '{
  "prompt": "professional person smiling while using a laptop showing a clean dashboard interface, bright modern office, natural lighting, warm and productive atmosphere, lifestyle marketing photography",
  "width": 1248,
  "height": 832
}'

# Research competitor landing pages
infsh app run tavily/search-assistant --input '{
  "query": "best SaaS landing page examples 2024 conversion rate"
}'
```

> **Install note:** The [install script](https://cli.inference.sh) only detects your OS/architecture, downloads the matching binary from `dist.inference.sh`, and verifies its SHA-256 checksum. No elevated permissions or background processes. [Manual install & verification](https://dist.inference.sh/cli/checksums.txt) available.

## Above-the-Fold Formula

Everything visible before scrolling must communicate value in 5 seconds.

```
┌─────────────────────────────────────────────────┐
│  [Logo]              [Nav]        [CTA Button]  │
│                                                 │
│   Headline (6-12 words)                         │
│   ─────────────────────────                     │
│   Subheadline (15-25 words)        [Hero Image] │
│                                    showing the  │
│   [Primary CTA Button]            OUTCOME, not  │
│   "Start Free Trial"              the product   │
│                                                 │
│   Social proof: "Trusted by 10,000+ teams"      │
│   [logo] [logo] [logo] [logo] [logo]            │
└─────────────────────────────────────────────────┘
```

### The 5 Elements

| Element          | Rule                               | Example                                                                                |
| ---------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| **Headline**     | 6-12 words, states the outcome     | "Ship docs in minutes, not days"                                                       |
| **Subheadline**  | 15-25 words, expands on how        | "AI-powered documentation that writes itself from your codebase. No templates needed." |
| **Hero image**   | Shows the OUTCOME, not the product | Person looking satisfied at results, not a screenshot of your UI                       |
| **Primary CTA**  | Action verb + value                | "Start Free Trial" not "Submit" or "Learn More"                                        |
| **Social proof** | Logos, count, or micro-testimonial | "Trusted by 10,000+ teams at [logos]"                                                  |

## Headlines

### Formulas That Convert

| Formula                           | Example                                    |
| --------------------------------- | ------------------------------------------ |
| [Outcome] without [pain]          | "Beautiful docs without the design skills" |
| [Outcome] in [timeframe]          | "Launch your site in 5 minutes"            |
| The [better way] to [common task] | "The faster way to build APIs"             |
| Stop [pain]. Start [outcome].     | "Stop guessing. Start knowing."            |
| [Number] [things] to [outcome]    | "One tool to manage all your data"         |

### What Makes Headlines Fail

```
❌ "Welcome to Our Platform" (says nothing about value)
❌ "The World's Most Advanced AI-Powered Solution" (buzzwords, no specifics)
❌ "We Help Businesses Grow" (vague, generic)
❌ "Next-Generation Enterprise Software" (what does it DO?)

✅ "Turn customer feedback into product features, automatically"
✅ "The spreadsheet that thinks like a database"
✅ "Find and fix bugs before your users do"
```

## Hero Images

### Show the Outcome, Not the Product

```
❌ Screenshot of your dashboard (boring, hard to parse at a glance)
❌ Abstract geometric background (says nothing)
❌ Stock photo of a handshake (cliché)

✅ Person looking satisfied at clear results on their screen
✅ Before/after transformation
✅ The end result of using your product
```

```bash
# Outcome-focused hero
infsh app run falai/flux-dev-lora --input '{
  "prompt": "happy professional team celebrating around a laptop showing positive growth charts, bright modern office, natural sunlight, authentic candid moment, marketing photography style, warm tones",
  "width": 1248,
  "height": 832
}'

# Product-in-context hero
infsh app run bytedance/seedream-4-5 --input '{
  "prompt": "clean modern laptop on a minimalist desk showing a beautiful analytics dashboard, floating UI elements emerging from the screen, soft gradient background, product marketing style, professional",
  "size": "2K"
}'
```

## CTA Buttons

### Text

| Good CTAs                  | Bad CTAs                      |
| -------------------------- | ----------------------------- |
| "Start Free Trial"         | "Submit"                      |
| "Get Started Free"         | "Click Here"                  |
| "See It in Action"         | "Learn More" (low commitment) |
| "Create Your First Report" | "Sign Up" (vague)             |
| "Try Free for 14 Days"     | "Register"                    |

**Formula:** Action verb + value/outcome + (optional: reduce risk)

### Design

| Element       | Rule                                                             |
| ------------- | ---------------------------------------------------------------- |
| Color         | High contrast with background — must be the most visible element |
| Size          | Minimum 44px height (tap target), wide enough for text + padding |
| Position      | Above the fold, repeated after each major section                |
| Whitespace    | Generous padding around button, don't crowd it                   |
| Secondary CTA | If needed, use text link below ("or watch a demo")               |

## Section Order

The proven sequence for landing pages:

| Section                  | Purpose                 | Key Element                          |
| ------------------------ | ----------------------- | ------------------------------------ |
| 1. **Hero**              | Core value, primary CTA | Headline + image + CTA               |
| 2. **Social Proof**      | Build trust             | Logos, numbers, badges               |
| 3. **Problem**           | Create empathy          | Pain point they recognize            |
| 4. **Solution/Features** | Show how you solve it   | 3 key features with visuals          |
| 5. **How It Works**      | Reduce complexity       | 3 steps: sign up, configure, benefit |
| 6. **Testimonials**      | Prove it works          | 2-3 specific customer quotes         |
| 7. **Pricing**           | Enable decision         | Clear tiers, highlight recommended   |
| 8. **FAQ**               | Handle objections       | 5-7 common questions                 |
| 9. **Final CTA**         | Capture remainders      | Repeat primary CTA with urgency      |

## Social Proof Types

| Type                 | Impact                         | Placement                   |
| -------------------- | ------------------------------ | --------------------------- |
| **Company logos**    | Fastest to process, high trust | Below hero                  |
| **User count**       | Scale signal                   | Hero or social proof bar    |
| **Star rating**      | Product quality                | Near CTA                    |
| **Testimonials**     | Detailed credibility           | Dedicated section           |
| **Case study stats** | Specific proof                 | Feature sections            |
| **Trust badges**     | Security/compliance            | Near forms, pricing, footer |

```bash
# Research for social proof stats
infsh app run exa/answer --input '{
  "question": "What is the average conversion rate for SaaS landing pages with social proof vs without?"
}'
```

## Form Design

| Rule                                | Impact                                     |
| ----------------------------------- | ------------------------------------------ |
| Every field reduces conversion ~11% | Minimize fields                            |
| Name + Email = maximum for signups  | Don't ask for phone, company, role         |
| Single-column layout                | Don't use multi-column forms               |
| Inline validation                   | Show errors immediately, not on submit     |
| Clear error messages                | "Email is required" not "Error in field 3" |
| Submit button text = action         | "Create Account" not "Submit"              |

## Mobile Optimization

| Rule                        | Why                         |
| --------------------------- | --------------------------- |
| CTA button full width       | Easy to tap with thumbs     |
| Sticky CTA on scroll        | Always accessible           |
| No horizontal scrolling     | Breaks mobile layout        |
| Font minimum 16px           | iOS zooms inputs below 16px |
| Tap targets minimum 48x48px | Apple HIG, Google Material  |
| Images responsive           | Don't overflow viewport     |
| Prioritize headline + CTA   | Simplify above-the-fold     |

## OG Image for Sharing

```bash
# Generate an OG image for the landing page
infsh app run falai/flux-dev-lora --input '{
  "prompt": "clean professional social sharing card, product name and tagline on modern gradient background, minimal design, corporate tech aesthetic, 1200x630 aspect ratio equivalent",
  "width": 1200,
  "height": 630
}'

# Or use html-to-image for a template-based approach
infsh app run infsh/html-to-image --input '{
  "html": "<div style=\"width:1200px;height:630px;background:linear-gradient(135deg,#667eea,#764ba2);display:flex;align-items:center;justify-content:center;font-family:sans-serif;color:white\"><div style=\"text-align:center\"><h1 style=\"font-size:48px;margin:0\">DataFlow</h1><p style=\"font-size:24px;opacity:0.9\">Ship docs in minutes, not days</p></div></div>"
}'
```

## Page Speed

| Rule                           | Target   | Why                      |
| ------------------------------ | -------- | ------------------------ |
| Hero image                     | < 200 KB | First thing to load      |
| Total page weight              | < 2 MB   | Mobile data, patience    |
| Lazy load below-fold           | Always   | Only load what's visible |
| Minimize JavaScript            | < 200 KB | Blocks rendering         |
| LCP (Largest Contentful Paint) | < 2.5s   | Google Core Web Vitals   |

## Common Mistakes

| Mistake                      | Problem                          | Fix                                     |
| ---------------------------- | -------------------------------- | --------------------------------------- |
| No clear headline            | Visitor doesn't know what you do | 6-12 words, outcome-focused             |
| CTA says "Learn More"        | Too low commitment               | Action verb + specific value            |
| Hero is a product screenshot | Hard to parse, boring            | Show the outcome, use lifestyle imagery |
| Multiple competing CTAs      | Decision paralysis               | One primary CTA, one secondary max      |
| No social proof              | No trust signal                  | Add logos, counts, or testimonials      |
| Too many form fields         | Conversion drops ~11% per field  | Name + email maximum                    |
| Desktop-only design          | 60%+ traffic is mobile           | Design mobile-first                     |
| No urgency in final CTA      | Visitors leave and forget        | "Start your free 14-day trial"          |

## Related Skills

```bash
npx skills add inference-sh/skills@ai-image-generation
npx skills add inference-sh/skills@web-search
npx skills add inference-sh/skills@prompt-engineering
```

Browse all apps: `infsh app list`
