# UX Psychology Reference

> Deep dive into UX laws, emotional design, trust building, and behavioral psychology.

---

## 1. Core UX Laws

### Hick's Law

**Principle:** The time to make a decision increases logarithmically with the number of choices.

```
Decision Time = a + b × log₂(n + 1)
Where n = number of choices
```

**Application:**
- Navigation: Max 5-7 top-level items
- Forms: Break into steps (progressive disclosure)
- Options: Default selections when possible
- Filters: Prioritize most-used, hide advanced

**Example:**
```
❌ Bad: 15 menu items in one nav
✅ Good: 5 main categories + "More" 

❌ Bad: 20 form fields at once
✅ Good: 3-step wizard with 5-7 fields each
```

---

### Fitts' Law

**Principle:** Time to reach a target = function of distance and size.

```
MT = a + b × log₂(1 + D/W)
Where D = distance, W = width
```

**Application:**
- CTAs: Make primary buttons larger (min 44px height)
- Touch targets: 44×44px minimum on mobile
- Placement: Important actions near natural cursor position
- Corners: "Magic corners" (infinite edge = easy to hit)

**Button Sizing:**
```css
/* Size by importance */
.btn-primary { height: 48px; padding: 0 24px; }
.btn-secondary { height: 40px; padding: 0 16px; }
.btn-tertiary { height: 36px; padding: 0 12px; }

/* Mobile touch targets */
@media (hover: none) {
  .btn { min-height: 44px; min-width: 44px; }
}
```

---

### Miller's Law

**Principle:** Average person can hold 7±2 chunks in working memory.

**Application:**
- Lists: Group into chunks of 5-7 items
- Navigation: Max 7 menu items
- Content: Break long content with headings
- Phone numbers: 555-123-4567 (chunked)

**Chunking Example:**
```
❌ 5551234567
✅ 555-123-4567

❌ Long paragraph of text without breaks
✅ Short paragraphs
   With bullet points
   And subheadings
```

---

### Von Restorff Effect (Isolation Effect)

**Principle:** An item that stands out is more likely to be remembered.

**Application:**
- CTA buttons: Distinct color from other elements
- Pricing: Highlight recommended plan
- Important info: Visual differentiation
- New features: Badge or callout

**Example:**
```css
/* All buttons gray, primary stands out */
.btn { background: #E5E7EB; }
.btn-primary { background: #3B82F6; }

/* Recommended plan highlighted */
.pricing-card { border: 1px solid #E5E7EB; }
.pricing-card.popular { 
  border: 2px solid #3B82F6;
  box-shadow: var(--shadow-lg);
}
```

---

### Serial Position Effect

**Principle:** Items at the beginning (primacy) and end (recency) of a list are remembered best.

**Application:**
- Navigation: Most important items first and last
- Lists: Key info at top and bottom
- Forms: Most critical fields at start
- CTAs: Repeat at top and bottom of long pages

**Example:**
```
Navigation: Home | [key items] | Contact

Long landing page:
- CTA at hero (top)
- Content sections
- CTA repeated at bottom
```

---

## 2. Emotional Design (Don Norman)

### Three Levels of Processing

```
┌─────────────────────────────────────────────────────────────┐
│  VISCERAL (Lizard Brain)                                    │
│  ─────────────────────                                      │
│  • Immediate, automatic reaction                            │
│  • First impressions (first 50ms)                          │
│  • Aesthetics: colors, shapes, imagery                      │
│  • "Wow, this looks beautiful!"                            │
├─────────────────────────────────────────────────────────────┤
│  BEHAVIORAL (Functional Brain)                              │
│  ─────────────────────────────                              │
│  • Usability and function                                   │
│  • Pleasure from effective use                              │
│  • Performance, reliability, ease                           │
│  • "This works exactly how I expected!"                    │
├─────────────────────────────────────────────────────────────┤
│  REFLECTIVE (Conscious Brain)                               │
│  ─────────────────────────────                              │
│  • Conscious thought and meaning                            │
│  • Personal identity and values                             │
│  • Long-term memory and loyalty                             │
│  • "This brand represents who I am"                        │
└─────────────────────────────────────────────────────────────┘
```

### Designing for Each Level

**Visceral:**
```css
/* Beautiful first impression */
.hero {
  background: linear-gradient(135deg, #0ea5e9 0%, #14b8a6 100%);
  color: white;
}

/* Pleasing microinteractions */
.button:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}
```

**Behavioral:**
```javascript
// Instant feedback
button.onclick = () => {
  button.disabled = true;
  button.textContent = 'Saving...';
  
  save().then(() => {
    showSuccess('Saved!');  // Immediate confirmation
  });
};
```

**Reflective:**
```html
<!-- Brand story and values -->
<section class="about">
  <h2>Why We Exist</h2>
  <p>We believe technology should empower, not complicate...</p>
</section>

<!-- Social proof connecting to identity -->
<blockquote>
  "This tool helped me become the designer I wanted to be."
</blockquote>
```

---

## 3. Trust Building System

### Trust Signal Categories

| Category | Elements | Implementation |
|----------|----------|----------------|
| **Security** | SSL, badges, encryption | Visible padlock, security logos on forms |
| **Social Proof** | Reviews, testimonials, logos | Star ratings, customer photos, brand logos |
| **Transparency** | Policies, pricing, contact | Clear links, no hidden fees, real address |
| **Professional** | Design quality, consistency | No broken elements, consistent branding |
| **Authority** | Certifications, awards, media | "As seen in...", industry certifications |

### Trust Signal Placement

```
┌────────────────────────────────────────────────────┐
│  HEADER: Trust banner ("Free shipping | 30-day    │
│          returns | Secure checkout")               │
├────────────────────────────────────────────────────┤
│  HERO: Social proof ("Trusted by 10,000+")        │
├────────────────────────────────────────────────────┤
│  PRODUCT: Reviews visible, security badges         │
├────────────────────────────────────────────────────┤
│  CHECKOUT: Payment icons, SSL badge, guarantee     │
├────────────────────────────────────────────────────┤
│  FOOTER: Contact info, policies, certifications    │
└────────────────────────────────────────────────────┘
```

### Trust-Building CSS Patterns

```css
/* Trust badge styling */
.trust-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: #F0FDF4;  /* Light green = security */
  border-radius: 2px; /* Sharp for trust = precision feel */
  font-size: 14px;
  color: #166534;
}

/* Secure form indicator */
.secure-form::before {
  content: '🔒 Secure form';
  display: block;
  font-size: 12px;
  color: #166534;
  margin-bottom: 8px;
}

/* Testimonial card */
.testimonial {
  display: flex;
  gap: 16px;
  padding: 24px;
  background: white;
  border-radius: 16px; /* Friendly = larger radius */
  box-shadow: var(--shadow-sm);
}

.testimonial-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;  /* Real photos > initials */
}
```

---

## 4. Cognitive Load Management

### Three Types of Cognitive Load

| Type | Definition | Designer's Role |
|------|------------|-----------------|
| **Intrinsic** | Inherent complexity of task | Break into smaller steps |
| **Extraneous** | Load from poor design | Eliminate this! |
| **Germane** | Effort for learning | Support and encourage |

### Reduction Strategies

**1. Simplify (Reduce Extraneous)**
```css
/* Visual noise → Clean */
.card-busy {
  border: 2px solid red;
  background: linear-gradient(...);
  box-shadow: 0 0 20px ...;
  /* Too much! */
}

.card-clean {
  background: white;
  border-radius: 16px;
  box-shadow: 0 10px 30px -10px rgba(0,0,0,0.1);
  /* Calm, focused */
}
```

**2. Chunk Information**
```html
<!-- Overwhelming -->
<form>
  <!-- 15 fields at once -->
</form>

<!-- Chunked -->
<form>
  <fieldset>
    <legend>Step 1: Personal Info</legend>
    <!-- 3-4 fields -->
  </fieldset>
  <fieldset>
    <legend>Step 2: Shipping</legend>
    <!-- 3-4 fields -->
  </fieldset>
</form>
```

**3. Progressive Disclosure**
```html
<!-- Hide complexity until needed -->
<div class="filters">
  <div class="filters-basic">
    <!-- Common filters visible -->
  </div>
  <button onclick="toggleAdvanced()">
    Advanced Options ▼
  </button>
  <div class="filters-advanced" hidden>
    <!-- Complex filters hidden -->
  </div>
</div>
```

**4. Use Familiar Patterns**
```
✅ Standard navigation placement
✅ Expected icon meanings (🔍 = search)
✅ Conventional form layouts
✅ Common gesture patterns (swipe, pinch)
```

**5. Offload Information**
```html
<!-- Don't make users remember -->
<label>
  Card Number
  <input type="text" inputmode="numeric" 
         autocomplete="cc-number" 
         placeholder="1234 5678 9012 3456">
</label>

<!-- Show what they entered -->
<div class="order-summary">
  <p>Shipping to: <strong>John Doe, 123 Main St...</strong></p>
  <a href="#">Edit</a>
</div>
```

---

## 5. Persuasive Design (Ethical)

### Ethical Persuasion Techniques

| Technique | Ethical Use | Dark Pattern (Avoid) |
|-----------|-------------|----------------------|
| **Scarcity** | Real stock levels | Fake countdown timers |
| **Social Proof** | Genuine reviews | Fake testimonials |
| **Authority** | Real credentials | Misleading badges |
| **Urgency** | Real deadlines | Manufactured FOMO |
| **Commitment** | Progress saving | Guilt-tripping |

### Nudge Patterns

**Smart Defaults:**
```html
<!-- Pre-select the recommended option -->
<input type="radio" name="plan" value="monthly">
<input type="radio" name="plan" value="annual" checked>
  Annual (Save 20%)
```

**Anchoring:**
```html
<!-- Show original price to frame discount -->
<div class="price">
  <span class="original">$99</span>
  <span class="current">$79</span>
  <span class="savings">Save 20%</span>
</div>
```

**Social Proof:**
```html
<!-- Real-time activity -->
<div class="activity">
  <span class="avatar">👤</span>
  <span>Sarah from NYC just purchased</span>
</div>

<!-- Aggregate proof -->
<p>Join 50,000+ designers who use our tool</p>
```

**Progress & Commitment:**
```html
<!-- Show progress to encourage completion -->
<div class="progress">
  <div class="progress-bar" style="width: 60%"></div>
  <span>60% complete - almost there!</span>
</div>
```

---

## 6. User Persona Quick Reference

### Gen Z (Born 1997-2012)

```
CHARACTERISTICS:
- Digital natives, mobile-first
- Value authenticity, diversity
- Short attention spans
- Visual learners

DESIGN APPROACH:
├── Colors: Vibrant, hypercolor, bold gradients
├── Typography: Large, variable, experimental
├── Layout: Vertical scroll, mobile-native
├── Interactions: Fast, gamified, gesture-based
├── Content: Short-form video, memes, stories
└── Trust: Peer reviews > authority
```

### Millennials (Born 1981-1996)

```
CHARACTERISTICS:
- Value experiences over things
- Research before buying
- Socially conscious
- Price-sensitive but quality-aware

DESIGN APPROACH:
├── Colors: Muted pastels, earth tones
├── Typography: Clean, readable sans-serif
├── Layout: Responsive, card-based
├── Interactions: Smooth, purposeful animations
├── Content: Value-driven, transparent
└── Trust: Reviews, sustainability, values
```

### Gen X (Born 1965-1980)

```
CHARACTERISTICS:
- Independent, self-reliant
- Value efficiency
- Skeptical of marketing
- Balanced tech comfort

DESIGN APPROACH:
├── Colors: Professional, trustworthy
├── Typography: Familiar, conservative
├── Layout: Clear hierarchy, traditional
├── Interactions: Functional, not flashy
├── Content: Direct, fact-based
└── Trust: Expertise, track record
```

### Baby Boomers (Born 1946-1964)

```
CHARACTERISTICS:
- Detail-oriented
- Loyal when trusted
- Value personal service
- Less tech-confident

DESIGN APPROACH:
├── Colors: High contrast, simple palette
├── Typography: Large (18px+), high contrast
├── Layout: Simple, linear, spacious
├��─ Interactions: Minimal, clear feedback
├── Content: Comprehensive, detailed
└── Trust: Phone numbers, real people
```

---

## 7. Emotion Color Mapping

```
┌────────────────────────────────────────────────────┐
│  EMOTION          │  COLORS           │  USE       │
├───────────────────┼───────────────────┼────────────┤
│  Trust            │  Blue, Green      │  Finance   │
│  Excitement       │  Red, Orange      │  Sales     │
│  Calm             │  Blue, Soft green │  Wellness  │
│  Luxury           │  Black, Gold      │  Premium   │
│  Creativity       │  Teal, Pink       │  Art       │
│  Energy           │  Yellow, Orange   │  Sports    │
│  Nature           │  Green, Brown     │  Eco       │
│  Happiness        │  Yellow, Orange   │  Kids      │
│  Sophistication   │  Gray, Navy       │  Corporate │
│  Urgency          │  Red              │  Errors    │
└───────────────────┴───────────────────┴────────────┘
```

---

## 8. Psychology Checklist

### Before Launch

- [ ] **Hick's Law:** No more than 7 choices in navigation
- [ ] **Fitts' Law:** Primary CTAs are large and reachable
- [ ] **Miller's Law:** Content is chunked appropriately
- [ ] **Von Restorff:** CTAs stand out from surroundings
- [ ] **Trust:** Security badges, reviews, policies visible
- [ ] **Emotional:** Design evokes intended feeling
- [ ] **Cognitive Load:** Interface is clean, not overwhelming
- [ ] **Familiar Patterns:** Standard conventions used
- [ ] **Feedback:** All actions have clear responses
- [ ] **Accessibility:** Inclusive for all users
