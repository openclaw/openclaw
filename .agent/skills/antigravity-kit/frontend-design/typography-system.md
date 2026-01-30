# Typography System Reference

> Typography principles and decision-making - learn to think, not memorize.
> **No fixed font names or sizes - understand the system.**

---

## 1. Modular Scale Principles

### What is a Modular Scale?

```
A mathematical relationship between font sizes:
├── Pick a BASE size (usually body text)
├── Pick a RATIO (multiplier)
└── Generate all sizes using: base × ratio^n
```

### Common Ratios and When to Use

| Ratio | Value | Feeling | Best For |
|-------|-------|---------|----------|
| Minor Second | 1.067 | Very subtle | Dense UI, small screens |
| Major Second | 1.125 | Subtle | Compact interfaces |
| Minor Third | 1.2 | Comfortable | Mobile apps, cards |
| Major Third | 1.25 | Balanced | General web (most common) |
| Perfect Fourth | 1.333 | Noticeable | Editorial, blogs |
| Perfect Fifth | 1.5 | Dramatic | Headlines, marketing |
| Golden Ratio | 1.618 | Maximum impact | Hero sections, display |

### Generate Your Scale

```
Given: base = YOUR_BASE_SIZE, ratio = YOUR_RATIO

Scale:
├── xs:  base ÷ ratio²
├── sm:  base ÷ ratio
├── base: YOUR_BASE_SIZE
├── lg:  base × ratio
├── xl:  base × ratio²
├── 2xl: base × ratio³
├── 3xl: base × ratio⁴
└── ... continue as needed
```

### Choosing Base Size

| Context | Base Size Range | Why |
|---------|-----------------|-----|
| Mobile-first | 16-18px | Readability on small screens |
| Desktop app | 14-16px | Information density |
| Editorial | 18-21px | Long-form reading comfort |
| Accessibility focus | 18px+ | Easier to read |

---

## 2. Font Pairing Principles

### What Makes Fonts Work Together

```
Contrast + Harmony:
├── Different ENOUGH to create hierarchy
├── Similar ENOUGH to feel cohesive
└── Usually: serif + sans, or display + neutral
```

### Pairing Strategies

| Strategy | How | Result |
|----------|-----|--------|
| **Contrast** | Serif heading + Sans body | Classic, editorial feel |
| **Same Family** | One variable font, different weights | Cohesive, modern |
| **Same Designer** | Fonts by same foundry | Often harmonious proportions |
| **Era Match** | Fonts from same time period | Historical consistency |

### What to Look For

```
When pairing, compare:
├── x-height (height of lowercase letters)
├── Letter width (narrow vs wide)
├── Stroke contrast (thin/thick variation)
└── Overall mood (formal vs casual)
```

### Safe Pairing Patterns

| Heading Style | Body Style | Mood |
|---------------|------------|------|
| Geometric sans | Humanist sans | Modern, friendly |
| Display serif | Clean sans | Editorial, sophisticated |
| Neutral sans | Same sans | Minimal, tech |
| Bold geometric | Light geometric | Contemporary |

### Avoid

- ❌ Two decorative fonts together
- ❌ Similar fonts that conflict
- ❌ More than 2-3 font families
- ❌ Fonts with very different x-heights

---

## 3. Line Height Principles

### The Relationship

```
Line height depends on:
├── Font size (larger text = less line height needed)
├── Line length (longer lines = more line height)
├── Font design (some fonts need more space)
└── Content type (headings vs body)
```

### Guidelines by Context

| Content Type | Line Height Range | Why |
|--------------|-------------------|-----|
| **Headings** | 1.1 - 1.3 | Short lines, want compact |
| **Body text** | 1.4 - 1.6 | Comfortable reading |
| **Long-form** | 1.6 - 1.8 | Maximum readability |
| **UI elements** | 1.2 - 1.4 | Space efficiency |

### Adjustment Factors

- **Longer line length** → Increase line height
- **Larger font size** → Decrease line height ratio
- **All caps** → May need more line height
- **Tight tracking** → May need more line height

---

## 4. Line Length Principles

### Optimal Reading Width

```
The sweet spot: 45-75 characters per line
├── < 45: Too choppy, breaks flow
├── 45-75: Comfortable reading
├── > 75: Eye tracking strain
```

### How to Measure

```css
/* Character-based (recommended) */
max-width: 65ch; /* ch = width of "0" character */

/* This adapts to font size automatically */
```

### Context Adjustments

| Context | Character Range |
|---------|-----------------|
| Desktop article | 60-75 characters |
| Mobile | 35-50 characters |
| Sidebar text | 30-45 characters |
| Wide monitors | Still cap at ~75ch |

---

## 5. Responsive Typography Principles

### The Problem

```
Fixed sizes don't scale well:
├── Desktop size too big on mobile
├── Mobile size too small on desktop
└── Breakpoint jumps feel jarring
```

### Fluid Typography (clamp)

```css
/* Syntax: clamp(MIN, PREFERRED, MAX) */
font-size: clamp(
  MINIMUM_SIZE,
  FLUID_CALCULATION,
  MAXIMUM_SIZE
);

/* FLUID_CALCULATION typically: 
   base + viewport-relative-unit */
```

### Scaling Strategy

| Element | Scaling Behavior |
|---------|-----------------|
| Body text | Slight scaling (1rem → 1.125rem) |
| Subheadings | Moderate scaling |
| Headings | More dramatic scaling |
| Display text | Most dramatic scaling |

---

## 6. Weight and Emphasis Principles

### Semantic Weight Usage

| Weight Range | Name | Use For |
|--------------|------|---------|
| 300-400 | Light/Normal | Body text, paragraphs |
| 500 | Medium | Subtle emphasis |
| 600 | Semibold | Subheadings, labels |
| 700 | Bold | Headings, strong emphasis |
| 800-900 | Heavy/Black | Display, hero text |

### Creating Contrast

```
Good contrast = skip at least 2 weight levels
├── 400 body + 700 heading = good
├── 400 body + 500 emphasis = subtle
├── 600 heading + 700 subheading = too similar
```

### Avoid

- ❌ Too many weights (max 3-4 per page)
- ❌ Adjacent weights for hierarchy (400/500)
- ❌ Heavy weights for long text

---

## 7. Letter Spacing (Tracking)

### Principles

```
Large text (headings): tighter tracking
├── Letters are big, gaps feel larger
└── Slight negative tracking looks better

Small text (body): normal or slightly wider
├── Improves readability at small sizes
└── Never negative for body text

ALL CAPS: always wider tracking
├── Uppercase lacks ascenders/descenders
└── Needs more space to feel right
```

### Adjustment Guidelines

| Context | Tracking Adjustment |
|---------|---------------------|
| Display/Hero | -2% to -4% |
| Headings | -1% to -2% |
| Body text | 0% (normal) |
| Small text | +1% to +2% |
| ALL CAPS | +5% to +10% |

---

## 8. Hierarchy Principles

### Visual Hierarchy Through Type

```
Ways to create hierarchy:
├── SIZE (most obvious)
├── WEIGHT (bold stands out)
├── COLOR (contrast levels)
├── SPACING (margins separate sections)
└── POSITION (top = important)
```

### Typical Hierarchy

| Level | Characteristics |
|-------|-----------------|
| Primary (H1) | Largest, boldest, most distinct |
| Secondary (H2) | Noticeably smaller but still bold |
| Tertiary (H3) | Medium size, may use weight only |
| Body | Standard size and weight |
| Caption/Meta | Smaller, often lighter color |

### Testing Hierarchy

Ask: "Can I tell what's most important at a glance?"

If squinting at the page, the hierarchy should still be clear.

---

## 9. Readability Psychology

### F-Pattern Reading

```
Users scan in F-pattern:
├── Across the top (first line)
├── Down the left side
├── Across again (subheading)
└── Continue down left
```

**Implication**: Key info on left and in headings

### Chunking for Comprehension

- Short paragraphs (3-4 lines max)
- Clear subheadings
- Bullet points for lists
- White space between sections

### Cognitive Ease

- Familiar fonts = easier reading
- High contrast = less strain
- Consistent patterns = predictable

---

## 10. Typography Selection Checklist

Before finalizing typography:

- [ ] **Asked user for font preferences?**
- [ ] **Considered brand/context?**
- [ ] **Selected appropriate scale ratio?**
- [ ] **Limited to 2-3 font families?**
- [ ] **Tested readability at all sizes?**
- [ ] **Checked line length (45-75ch)?**
- [ ] **Verified contrast for accessibility?**
- [ ] **Different from your last project?**

### Anti-Patterns

- ❌ Same fonts every project
- ❌ Too many font families
- ❌ Ignoring readability for style
- ❌ Fixed sizes without responsiveness
- ❌ Decorative fonts for body text

---

> **Remember**: Typography is about communication clarity. Choose based on content needs and audience, not personal preference.
