# Decision Trees & Context Templates

> Context-based design THINKING, not fixed solutions.
> **These are decision GUIDES, not copy-paste templates.**
> **For UX psychology principles (Hick's, Fitts', etc.) see:** [ux-psychology.md](ux-psychology.md)

---

## ⚠️ How to Use This File

This file helps you DECIDE, not copy.

- Decision trees → Help you THINK through options
- Templates → Show STRUCTURE and PRINCIPLES, not exact values
- **Always ask user preferences** before applying
- **Generate fresh palettes** based on context, don't copy hex codes
- **Apply UX laws** from ux-psychology.md to validate decisions

---

## 1. Master Decision Tree

```
┌─────────────────────────────────────────────────────────────┐
│                     WHAT ARE YOU BUILDING?                   │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
   E-COMMERCE            SaaS/APP              CONTENT
   - Product pages       - Dashboard           - Blog
   - Checkout            - Tools               - Portfolio
   - Catalog             - Admin               - Landing
        │                     │                     │
        ▼                     ▼                     ▼
   PRINCIPLES:           PRINCIPLES:           PRINCIPLES:
   - Trust               - Functionality       - Storytelling
   - Action              - Clarity             - Emotion
   - Urgency             - Efficiency          - Creativity
```

---

## 2. Audience Decision Tree

### Who is your target user?

```
TARGET AUDIENCE
      │
      ├── Gen Z (18-25)
      │   ├── Colors: Bold, vibrant, unexpected combinations
      │   ├── Type: Large, expressive, variable
      │   ├── Layout: Mobile-first, vertical, snackable
      │   ├── Effects: Motion, gamification, interactive
      │   └── Approach: Authentic, fast, no corporate feel
      │
      ├── Millennials (26-41)
      │   ├── Colors: Muted, earthy, sophisticated
      │   ├── Type: Clean, readable, functional
      │   ├── Layout: Responsive, card-based, organized
      │   ├── Effects: Subtle, purposeful only
      │   └── Approach: Value-driven, transparent, sustainable
      │
      ├── Gen X (42-57)
      │   ├── Colors: Professional, trusted, conservative
      │   ├── Type: Familiar, clear, no-nonsense
      │   ├── Layout: Traditional hierarchy, predictable
      │   ├── Effects: Minimal, functional feedback
      │   └── Approach: Direct, efficient, reliable
      │
      ├── Boomers (58+)
      │   ├── Colors: High contrast, simple, clear
      │   ├── Type: Large sizes, high readability
      │   ├── Layout: Simple, linear, uncluttered
      │   ├── Effects: None or very minimal
      │   └── Approach: Clear, detailed, trustworthy
      │
      └── B2B / Enterprise
          ├── Colors: Professional palette, muted
          ├── Type: Clean, data-friendly, scannable
          ├── Layout: Grid-based, organized, efficient
          ├── Effects: Professional, subtle
          └── Approach: Expert, solution-focused, ROI-driven
```

---

## 3. Color Selection Decision Tree

### Instead of fixed hex codes, use this process:

```
WHAT EMOTION/ACTION DO YOU WANT?
            │
            ├── Trust & Security
            │   └── Consider: Blue family, professional neutrals
            │       → ASK user for specific shade preference
            │
            ├── Growth & Health
            │   └── Consider: Green family, natural tones
            │       → ASK user if eco/nature/wellness focus
            │
            ├── Urgency & Action
            │   └── Consider: Warm colors (orange/red) as ACCENTS
            │       → Use sparingly, ASK if appropriate
            │
            ├── Luxury & Premium
            │   └── Consider: Deep darks, metallics, restrained palette
            │       → ASK about brand positioning
            │
            ├── Creative & Playful
            │   └── Consider: Multi-color, unexpected combinations
            │       → ASK about brand personality
            │
            └── Calm & Minimal
                └── Consider: Neutrals with single accent
                    → ASK what accent color fits brand
```

### The Process:
1. Identify the emotion needed
2. Narrow to color FAMILY
3. ASK user for preference within family
4. Generate fresh palette using HSL principles

---

## 4. Typography Decision Tree

```
WHAT'S THE CONTENT TYPE?
          │
          ├── Data-Heavy (Dashboard, SaaS)
          │   ├── Style: Sans-serif, clear, compact
          │   ├── Scale: Tighter ratio (1.125-1.2)
          │   └── Priority: Scannability, density
          │
          ├── Editorial (Blog, Magazine)
          │   ├── Style: Serif heading + Sans body works well
          │   ├── Scale: More dramatic (1.333+)
          │   └── Priority: Reading comfort, hierarchy
          │
          ├── Modern Tech (Startup, SaaS Marketing)
          │   ├── Style: Geometric or humanist sans
          │   ├── Scale: Balanced (1.25)
          │   └── Priority: Modern feel, clarity
          │
          ├── Luxury (Fashion, Premium)
          │   ├── Style: Elegant serif or thin sans
          │   ├── Scale: Dramatic (1.5-1.618)
          │   └── Priority: Sophistication, whitespace
          │
          └── Playful (Kids, Games, Casual)
              ├── Style: Rounded, friendly fonts
              ├── Scale: Varied, expressive
              └── Priority: Fun, approachable, readable
```

### Selection Process:
1. Identify content type
2. Choose style DIRECTION
3. ASK user if they have brand fonts
4. Select fonts that match direction

---

## 5. E-commerce Guidelines {#e-commerce}

### Key Principles (Not Fixed Rules)
- **Trust first:** How will you show security?
- **Action-oriented:** Where are the CTAs?
- **Scannable:** Can users compare quickly?

### Color Thinking:
```
E-commerce typically needs:
├── Trust color (often blue family) → ASK preference
├── Clean background (white/neutral) → depends on brand
├── Action accent (for CTAs, sales) → depends on urgency level
├── Success/error semantics → standard conventions work
└── Brand integration → ASK about existing colors
```

### Layout Principles:
```
┌────────────────────────────────────────────────────┐
│  HEADER: Brand + Search + Cart                      │
│  (Keep essential actions visible)                   │
├────────────────────────────────────────────────────┤
│  TRUST ZONE: Why trust this site?                   │
│  (Shipping, returns, security - if applicable)      │
├────────────────────────────────────────────────────┤
│  HERO: Primary message or offer                     │
│  (Clear CTA, single focus)                          │
├──────────────────────────────────────────────────��─┤
│  CATEGORIES: Easy navigation                        │
│  (Visual, filterable, scannable)                    │
├────────────────────────────────────────────────────┤
│  PRODUCTS: Easy comparison                          │
│  (Price, rating, quick actions visible)             │
├────────────────────────────────────────────────────┤
│  SOCIAL PROOF: Why others trust                     │
│  (Reviews, testimonials - if available)             │
├────────────────────────────────────────────────────┤
│  FOOTER: All the details                            │
│  (Policies, contact, trust badges)                  │
└────────────────────────────────────────────────────┘
```

### Psychology to Apply:
- Hick's Law: Limit navigation choices
- Fitts' Law: Size CTAs appropriately
- Social proof: Show where relevant
- Scarcity: Use honestly if at all

---

## 6. SaaS Dashboard Guidelines {#saas}

### Key Principles
- **Functional first:** Data clarity over decoration
- **Calm UI:** Reduce cognitive load
- **Consistent:** Predictable patterns

### Color Thinking:
```
Dashboard typically needs:
├── Background: Light OR dark (ASK preference)
├── Surface: Slight contrast from background
├── Primary accent: For key actions
├── Data colors: Success/warning/danger semantics
└── Muted: For secondary information
```

### Layout Principles:
```
Consider these patterns (not mandated):

OPTION A: Sidebar + Content
├── Fixed sidebar for navigation
└── Main area for content

OPTION B: Top nav + Content
├── Horizontal navigation
└── More horizontal content space

OPTION C: Collapsed + Expandable
├── Icon-only sidebar expands
└── Maximum content area

→ ASK user about their navigation preference
```

### Psychology to Apply:
- Hick's Law: Group navigation items
- Miller's Law: Chunk information
- Cognitive Load: Whitespace, consistency

---

## 7. Landing Page Guidelines {#landing-page}

### Key Principles
- **Hero-centric:** First impression matters most
- **Single focus:** One primary CTA
- **Emotional:** Connect before selling

### Color Thinking:
```
Landing page typically needs:
├── Brand primary: Hero background or accent
├── Clean secondary: Most of page
├── CTA color: Stands out from everything
├── Supporting: For sections, testimonials
└── ASK about brand colors first!
```

### Structure Principles:
```
┌────────────────────────────────────────────────────┐
│  Navigation: Minimal, CTA visible                   │
├────────────────────────────────────────────────────┤
│  HERO: Hook + Value + CTA                          │
│  (Most important section, biggest impact)           │
├────────────────────────────────────────────────────┤
│  PROBLEM: What pain do they have?                   │
├────────────────────────────────────────────────────┤
│  SOLUTION: How you solve it                         │
├────────────────────────────────────────────────────┤
│  PROOF: Why believe you?                            │
│  (Testimonials, logos, stats)                       │
├────────────────────────────────────────────────────┤
│  HOW: Simple explanation of process                 │
├────────────────────────────────────────────────────┤
│  PRICING: If applicable                             │
├────────────────────────────────────────────────────┤
│  FAQ: Address objections                            │
├────────────────────────────────────────────────────┤
│  FINAL CTA: Repeat main action                      │
└────────────────────────────────────────────────────┘
```

### Psychology to Apply:
- Visceral: Beautiful hero impression
- Serial Position: Key info top/bottom
- Social Proof: Testimonials work

---

## 8. Portfolio Guidelines {#portfolio}

### Key Principles
- **Personality:** Show who you are
- **Work-focused:** Let projects speak
- **Memorable:** Stand out from templates

### Color Thinking:
```
Portfolio is personal - many options:
├── Minimal: Neutrals + one signature accent
├── Bold: Unexpected color choices
├── Dark: Moody, artistic feel
├── Light: Clean, professional feel
└── ASK about personal brand identity!
```

### Structure Principles:
```
┌────────────────────────────────────────────────────┐
│  Navigation: Unique to your personality             │
├────────────────────────────────────────────────────┤
│  INTRO: Who you are, what you do                   │
│  (Make it memorable, not generic)                   │
├────────────────────────────────────────────────────┤
│  WORK: Featured projects                            │
│  (Large, visual, interactive)                       │
├────────────────────────────────────────────────────┤
│  ABOUT: Personal story                              │
│  (Creates connection)                               │
���────────────────────────────────────────────────────┤
│  CONTACT: Easy to reach                             │
│  (Clear, direct)                                    │
└────────���───────────────────────────────────────────┘
```

### Psychology to Apply:
- Von Restorff: Be uniquely memorable
- Reflective: Personal story creates connection
- Emotional: Personality over professionalism

---

## 9. Pre-Design Checklists

### Before Starting ANY Design

- [ ] **Audience defined?** (who exactly)
- [ ] **Primary goal identified?** (what action)
- [ ] **Constraints known?** (time, brand, tech)
- [ ] **Content available?** (or placeholders needed)
- [ ] **User preferences asked?** (colors, style, layout)

### Before Choosing Colors

- [ ] **Asked user preference?**
- [ ] **Considered context?** (industry, emotion)
- [ ] **Different from your default?**
- [ ] **Checked accessibility?**

### Before Finalizing Layout

- [ ] **Hierarchy clear?**
- [ ] **Primary CTA obvious?**
- [ ] **Mobile considered?**
- [ ] **Content fits structure?**

### Before Delivery

- [ ] **Looks premium, not generic?**
- [ ] **Would you be proud of this?**
- [ ] **Different from last project?**

---

## 10. Complexity Estimation

### Quick Projects (Hours)
```
Simple landing page
Small portfolio
Basic form
Single component
```
→ Approach: Minimal decisions, focused execution

### Medium Projects (Days)
```
Multi-page site
Dashboard with modules
E-commerce category
Complex forms
```
→ Approach: Establish tokens, custom components

### Large Projects (Weeks)
```
Full SaaS application
E-commerce platform
Custom design system
Complex workflows
```
→ Approach: Full design system, documentation, testing

---

> **Remember**: These templates show STRUCTURE and THINKING process. Every project needs fresh color, typography, and styling decisions based on its unique context. ASK when unclear.
