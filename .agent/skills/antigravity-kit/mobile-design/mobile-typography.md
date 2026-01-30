# Mobile Typography Reference

> Type scale, system fonts, Dynamic Type, accessibility, and dark mode typography.
> **Typography failures are the #1 cause of unreadable mobile apps.**

---

## 1. Mobile Typography Fundamentals

### Why Mobile Type is Different

```
DESKTOP:                        MOBILE:
├── 20-30" viewing distance     ├── 12-15" viewing distance
├── Large viewport              ├── Small viewport, narrow
├── Hover for details           ├── Tap/scroll for details
├── Controlled lighting         ├── Variable (outdoor, etc.)
├── Fixed font size             ├── User-controlled sizing
└── Long reading sessions       └── Quick scanning
```

### Mobile Type Rules

| Rule | Desktop | Mobile |
|------|---------|--------|
| **Minimum body size** | 14px | 16px (14pt/14sp) |
| **Maximum line length** | 75 characters | 40-60 characters |
| **Line height** | 1.4-1.5 | 1.4-1.6 (more generous) |
| **Font weight** | Varies | Regular dominant, bold sparingly |
| **Contrast** | AA (4.5:1) | AA minimum, AAA preferred |

---

## 2. System Fonts

### iOS: SF Pro Family

```
San Francisco (SF) Family:
├── SF Pro Display: Large text (≥ 20pt)
├── SF Pro Text: Body text (< 20pt)
├── SF Pro Rounded: Friendly contexts
├── SF Mono: Monospace
└── SF Compact: Apple Watch, compact UI

Features:
├── Optical sizing (auto-adjusts)
├── Dynamic tracking (spacing)
├── Tabular/proportional figures
├── Excellent legibility
```

### Android: Roboto Family

```
Roboto Family:
├── Roboto: Default sans-serif
├── Roboto Flex: Variable font
├── Roboto Serif: Serif option
├── Roboto Mono: Monospace
├── Roboto Condensed: Narrow spaces

Features:
├── Optimized for screens
├── Wide language support
├── Multiple weights
├── Good at small sizes
```

### When to Use System Fonts

```
✅ USE system fonts when:
├── Brand doesn't mandate custom font
├── Reading efficiency is priority
├── App feels native/integrated important
├── Performance is critical
├── Wide language support needed

❌ AVOID system fonts when:
├── Brand identity requires custom
├── Design differentiation needed
├── Editorial/magazine style
└── (But still support accessibility)
```

### Custom Font Considerations

```
If using custom fonts:
├── Include all weights needed
├── Subset for file size
├── Test at all Dynamic Type sizes
├── Provide fallback to system
├── Test rendering quality
└── Check language support
```

---

## 3. Type Scale

### iOS Type Scale (Built-in)

| Style | Size | Weight | Line Height |
|-------|------|--------|-------------|
| Large Title | 34pt | Bold | 41pt |
| Title 1 | 28pt | Bold | 34pt |
| Title 2 | 22pt | Bold | 28pt |
| Title 3 | 20pt | Semibold | 25pt |
| Headline | 17pt | Semibold | 22pt |
| Body | 17pt | Regular | 22pt |
| Callout | 16pt | Regular | 21pt |
| Subhead | 15pt | Regular | 20pt |
| Footnote | 13pt | Regular | 18pt |
| Caption 1 | 12pt | Regular | 16pt |
| Caption 2 | 11pt | Regular | 13pt |

### Android Type Scale (Material 3)

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Display Large | 57sp | 400 | 64sp |
| Display Medium | 45sp | 400 | 52sp |
| Display Small | 36sp | 400 | 44sp |
| Headline Large | 32sp | 400 | 40sp |
| Headline Medium | 28sp | 400 | 36sp |
| Headline Small | 24sp | 400 | 32sp |
| Title Large | 22sp | 400 | 28sp |
| Title Medium | 16sp | 500 | 24sp |
| Title Small | 14sp | 500 | 20sp |
| Body Large | 16sp | 400 | 24sp |
| Body Medium | 14sp | 400 | 20sp |
| Body Small | 12sp | 400 | 16sp |
| Label Large | 14sp | 500 | 20sp |
| Label Medium | 12sp | 500 | 16sp |
| Label Small | 11sp | 500 | 16sp |

### Creating Custom Scale

```
If creating custom scale, use modular ratio:

Recommended ratios:
├── 1.125 (Major second): Dense UI
├── 1.200 (Minor third): Compact
├── 1.250 (Major third): Balanced (common)
├── 1.333 (Perfect fourth): Spacious
└── 1.500 (Perfect fifth): Dramatic

Example with 1.25 ratio, 16px base:
├── xs: 10px (16 ÷ 1.25 ÷ 1.25)
├── sm: 13px (16 ÷ 1.25)
├── base: 16px
├── lg: 20px (16 × 1.25)
├── xl: 25px (16 × 1.25 × 1.25)
├── 2xl: 31px
├── 3xl: 39px
└── 4xl: 49px
```

---

## 4. Dynamic Type / Text Scaling

### iOS Dynamic Type (MANDATORY)

```swift
// ❌ WRONG: Fixed size (doesn't scale)
Text("Hello")
    .font(.system(size: 17))

// ✅ CORRECT: Dynamic Type
Text("Hello")
    .font(.body) // Scales with user setting

// Custom font with scaling
Text("Hello")
    .font(.custom("MyFont", size: 17, relativeTo: .body))
```

### Android Text Scaling (MANDATORY)

```
ALWAYS use sp for text:
├── sp = Scale-independent pixels
├── Scales with user font preference
├── dp does NOT scale (don't use for text)

User can scale from 85% to 200%:
├── Default (100%): 14sp = 14dp
├── Largest (200%): 14sp = 28dp

Test at 200%!
```

### Scaling Challenges

```
Problems at large text sizes:
├── Text overflows containers
├── Buttons become too tall
├── Icons look small relative to text
├── Layouts break

Solutions:
├── Use flexible containers (not fixed height)
├── Allow text wrapping
├── Scale icons with text
├── Test at extremes during development
├── Use scrollable containers for long text
```

---

## 5. Typography Accessibility

### Minimum Sizes

| Element | Minimum | Recommended |
|---------|---------|-------------|
| Body text | 14px/pt/sp | 16px/pt/sp |
| Secondary text | 12px/pt/sp | 13-14px/pt/sp |
| Captions | 11px/pt/sp | 12px/pt/sp |
| Buttons | 14px/pt/sp | 14-16px/pt/sp |
| **Nothing smaller** | 11px | - |

### Contrast Requirements (WCAG)

```
Normal text (< 18pt or < 14pt bold):
├── AA: 4.5:1 ratio minimum
├── AAA: 7:1 ratio recommended

Large text (≥ 18pt or ≥ 14pt bold):
├── AA: 3:1 ratio minimum
├── AAA: 4.5:1 ratio recommended

Logos/decorative: No requirement
```

### Line Height for Accessibility

```
WCAG Success Criterion 1.4.12:

Line height (line spacing): ≥ 1.5×
Paragraph spacing: ≥ 2× font size
Letter spacing: ≥ 0.12× font size
Word spacing: ≥ 0.16× font size

Mobile recommendation:
├── Body: 1.4-1.6 line height
├── Headings: 1.2-1.3 line height
├── Never below 1.2
```

---

## 6. Dark Mode Typography

### Color Adjustments

```
Light Mode:               Dark Mode:
├── Black text (#000)     ├── White/light gray (#E0E0E0)
├── High contrast         ├── Slightly reduced contrast
├── Full saturation       ├── Desaturated colors
└── Dark = emphasis       └── Light = emphasis

RULE: Don't use pure white (#FFF) on dark.
Use off-white (#E0E0E0 to #F0F0F0) to reduce eye strain.
```

### Dark Mode Hierarchy

| Level | Light Mode | Dark Mode |
|-------|------------|-----------|
| Primary text | #000000 | #E8E8E8 |
| Secondary text | #666666 | #A0A0A0 |
| Tertiary text | #999999 | #707070 |
| Disabled text | #CCCCCC | #505050 |

### Weight in Dark Mode

```
Dark mode text appears thinner due to halation
(light bleeding into dark background)

Consider:
├── Using medium weight for body (instead of regular)
├── Increasing letter-spacing slightly
├── Testing on actual OLED displays
└── Using slightly bolder weight than light mode
```

---

## 7. Typography Anti-Patterns

### ❌ Common Mistakes

| Mistake | Problem | Fix |
|---------|---------|-----|
| **Fixed font sizes** | Ignores accessibility | Use dynamic sizing |
| **Too small text** | Unreadable | Min 14pt/sp |
| **Low contrast** | Invisible in sunlight | Min 4.5:1 |
| **Long lines** | Hard to track | Max 60 chars |
| **Tight line height** | Cramped, hard to read | Min 1.4× |
| **Too many sizes** | Visual chaos | Max 5-7 sizes |
| **All caps body** | Hard to read | Headlines only |
| **Light gray on white** | Impossible in bright light | Higher contrast |

### ❌ AI Typography Mistakes

```
AI tends to:
├── Use fixed px values instead of pt/sp
��── Skip Dynamic Type support
├── Use too small text (12-14px body)
├── Ignore line height settings
├── Use low contrast "aesthetic" grays
├── Apply same scale to mobile as desktop
└── Skip testing at large text sizes

RULE: Typography must SCALE.
Test at smallest and largest settings.
```

---

## 8. Font Loading & Performance

### Font File Optimization

```
Font file sizes matter on mobile:
├── Full font: 100-300KB per weight
├── Subset (Latin): 15-40KB per weight
├── Variable font: 100-200KB (all weights)

Recommendations:
├── Subset to needed characters
├── Use WOFF2 format
├── Max 2-3 font files
├── Consider variable fonts
├── Cache fonts appropriately
```

### Loading Strategy

```
1. SYSTEM FONT FALLBACK
   Show system font → swap when custom loads
   
2. FONT DISPLAY SWAP
   font-display: swap (CSS)
   
3. PRELOAD CRITICAL FONTS
   Preload fonts needed above the fold
   
4. DON'T BLOCK RENDER
   Don't wait for fonts to show content
```

---

## 9. Typography Checklist

### Before Any Text Design

- [ ] Body text ≥ 16px/pt/sp?
- [ ] Line height ≥ 1.4?
- [ ] Line length ≤ 60 chars?
- [ ] Type scale defined (max 5-7 sizes)?
- [ ] Using pt (iOS) or sp (Android)?

### Before Release

- [ ] Dynamic Type tested (iOS)?
- [ ] Font scaling tested at 200% (Android)?
- [ ] Dark mode contrast checked?
- [ ] Sunlight readability tested?
- [ ] All text has proper hierarchy?
- [ ] Custom fonts have fallbacks?
- [ ] Long text scrolls properly?

---

## 10. Quick Reference

### Typography Tokens

```
// iOS
.largeTitle  // 34pt, Bold
.title       // 28pt, Bold
.title2      // 22pt, Bold
.title3      // 20pt, Semibold
.headline    // 17pt, Semibold
.body        // 17pt, Regular
.subheadline // 15pt, Regular
.footnote    // 13pt, Regular
.caption     // 12pt, Regular

// Android (Material 3)
displayLarge   // 57sp
headlineLarge  // 32sp
titleLarge     // 22sp
bodyLarge      // 16sp
labelLarge     // 14sp
```

### Minimum Sizes

```
Body:       14-16pt/sp (16 preferred)
Secondary:  12-13pt/sp
Caption:    11-12pt/sp
Nothing:    < 11pt/sp
```

### Line Height

```
Headings:  1.1-1.3
Body:      1.4-1.6
Long text: 1.5-1.75
```

---

> **Remember:** If users can't read your text, your app is broken. Typography isn't decoration—it's the primary interface. Test on real devices, in real conditions, with accessibility settings enabled.
