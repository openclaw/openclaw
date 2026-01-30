# Mobile Color System Reference

> OLED optimization, dark mode, battery-aware colors, and outdoor visibility.
> **Color on mobile isn't just aesthetics—it's battery life and usability.**

---

## 1. Mobile Color Fundamentals

### Why Mobile Color is Different

```
DESKTOP:                           MOBILE:
├── LCD screens (backlit)          ├── OLED common (self-emissive)
├── Controlled lighting            ├── Outdoor, bright sun
├── Stable power                   ├── Battery matters
├── Personal preference            ├── System-wide dark mode
└── Static viewing                 └── Variable angles, motion
```

### Mobile Color Priorities

| Priority | Why |
|----------|-----|
| **1. Readability** | Outdoor, variable lighting |
| **2. Battery efficiency** | OLED = dark mode saves power |
| **3. System integration** | Dark/light mode support |
| **4. Semantics** | Error, success, warning colors |
| **5. Brand** | After functional requirements |

---

## 2. OLED Considerations

### How OLED Differs

```
LCD (Liquid Crystal Display):
├── Backlight always on
├── Black = backlight through dark filter
├── Energy use = constant
└── Dark mode = no battery savings

OLED (Organic LED):
├── Each pixel emits own light
├── Black = pixel OFF (zero power)
├── Energy use = brighter pixels use more
└── Dark mode = significant battery savings
```

### Battery Savings with OLED

```
Color energy consumption (relative):

#000000 (True Black)  ████░░░░░░  0%
#1A1A1A (Near Black)  █████░░░░░  ~15%
#333333 (Dark Gray)   ██████░░░░  ~30%
#666666 (Medium Gray) ███████░░░  ~50%
#FFFFFF (White)       ██████████  100%

Saturated colors also use significant power:
├── Blue pixels: Most efficient
├── Green pixels: Medium
├── Red pixels: Least efficient
└── Desaturated colors save more
```

### True Black vs Near Black

```
#000000 (True Black):
├── Maximum battery savings
├── Can cause "black smear" on scroll
├── Sharp contrast (may be harsh)
└── Used by Apple in pure dark mode

#121212 or #1A1A1A (Near Black):
├── Still good battery savings
├── Smoother scrolling (no smear)
├── Slightly softer on eyes
└── Material Design recommendation

RECOMMENDATION: #000000 for backgrounds, #0D0D0D-#1A1A1A for surfaces
```

---

## 3. Dark Mode Design

### Dark Mode Benefits

```
Users enable dark mode for:
├── Battery savings (OLED)
├── Reduced eye strain (low light)
├── Personal preference
├── AMOLED aesthetic
└── Accessibility (light sensitivity)
```

### Dark Mode Color Strategy

```
LIGHT MODE                      DARK MODE
──────────                      ─────────
Background: #FFFFFF      →      #000000 or #121212
Surface:    #F5F5F5      →      #1E1E1E
Surface 2:  #EEEEEE      →      #2C2C2C

Primary:    #1976D2      →      #90CAF9 (lighter)
Text:       #212121      →      #E0E0E0 (not pure white)
Secondary:  #757575      →      #9E9E9E

Elevation in dark mode:
├── Higher = slightly lighter surface
├── 0dp →  0% overlay
├── 4dp →  9% overlay
├── 8dp →  12% overlay
└── Creates depth without shadows
```

### Text Colors in Dark Mode

| Role | Light Mode | Dark Mode |
|------|------------|-----------|
| Primary | #000000 (Black) | #E8E8E8 (Not pure white) |
| Secondary | #666666 | #B0B0B0 |
| Disabled | #9E9E9E | #6E6E6E |
| Links | #1976D2 | #8AB4F8 |

### Color Inversion Rules

```
DON'T just invert colors:
├── Saturated colors become eye-burning
├── Semantic colors lose meaning
├── Brand colors may break
└── Contrast ratios change unpredictably

DO create intentional dark palette:
├── Desaturate primary colors
├── Use lighter tints for emphasis
├── Maintain semantic color meanings
├── Check contrast ratios independently
```

---

## 4. Outdoor Visibility

### The Sunlight Problem

```
Screen visibility outdoors:
├── Bright sun washes out low contrast
├── Glare reduces readability
├── Polarized sunglasses affect
└── Users shield screen with hand

Affected elements:
├── Light gray text on white
├── Subtle color differences
├── Low opacity overlays
└── Pastel colors
```

### High Contrast Strategies

```
For outdoor visibility:

MINIMUM CONTRAST RATIOS:
├── Normal text: 4.5:1 (WCAG AA)
├── Large text: 3:1 (WCAG AA)
├── Recommended: 7:1+ (AAA)

AVOID:
├── #999 on #FFF (fails AA)
├── #BBB on #FFF (fails)
├── Pale colors on light backgrounds
└── Subtle gradients for critical info

DO:
├── Use system semantic colors
├── Test in bright environment
├── Provide high contrast mode
└── Use solid colors for critical UI
```

---

## 5. Semantic Colors

### Consistent Meaning

| Semantic | Meaning | iOS Default | Android Default |
|----------|---------|-------------|-----------------|
| Error | Problems, destruction | #FF3B30 | #B3261E |
| Success | Completion, positive | #34C759 | #4CAF50 |
| Warning | Attention, caution | #FF9500 | #FFC107 |
| Info | Information | #007AFF | #2196F3 |

### Semantic Color Rules

```
NEVER use semantic colors for:
├── Branding (confuses meaning)
├── Decoration (reduces impact)
├── Arbitrary styling
└── Status indicators (use icons too)

ALWAYS:
├── Pair with icons (colorblind users)
├── Maintain across light/dark modes
├── Keep consistent throughout app
└── Follow platform conventions
```

### Error State Colors

```
Error states need:
├── Red-ish color (semantic)
├── High contrast against background
├── Icon reinforcement
├── Clear text explanation

iOS:
├── Light: #FF3B30
├── Dark: #FF453A

Android:
├── Light: #B3261E
├── Dark: #F2B8B5 (on error container)
```

---

## 6. Dynamic Color (Android)

### Material You

```
Android 12+ Dynamic Color:

User's wallpaper → Color extraction → App theme

Your app automatically gets:
├── Primary (from wallpaper dominant)
├── Secondary (complementary)
├── Tertiary (accent)
├── Surface colors (neutral, derived)
├── On-colors (text on each)
```

### Supporting Dynamic Color

```kotlin
// Jetpack Compose
MaterialTheme(
    colorScheme = dynamicColorScheme()
        ?: staticColorScheme() // Fallback for older Android
)

// React Native
// Limited support - consider react-native-material-you
```

### Fallback Colors

```
When dynamic color unavailable:
├── Android < 12
├── User disabled
├── Non-supporting launchers

Provide static color scheme:
├── Define your brand colors
├── Test in both modes
├── Match dynamic color roles
└── Support light + dark
```

---

## 7. Color Accessibility

### Colorblind Considerations

```
~8% of men, ~0.5% of women are colorblind

Types:
├── Protanopia (red weakness)
├── Deuteranopia (green weakness)
├── Tritanopia (blue weakness)
├── Monochromacy (rare, no color)

Design rules:
├── Never rely on color alone
├── Use patterns, icons, text
├── Test with simulation tools
├── Avoid red/green distinctions only
```

### Contrast Testing Tools

```
Use these to verify:
├── Built-in accessibility inspector (Xcode)
├── Accessibility Scanner (Android)
├── Contrast ratio calculators
├── Colorblind simulation
└── Test on actual devices in sunlight
```

### Sufficient Contrast

```
WCAG Guidelines:

AA (Minimum)
├── Normal text: 4.5:1
├── Large text (18pt+): 3:1
├── UI components: 3:1

AAA (Enhanced)
├── Normal text: 7:1
├── Large text: 4.5:1

Mobile recommendation: Meet AA, aim for AAA
```

---

## 8. Color Anti-Patterns

### ❌ Common Mistakes

| Mistake | Problem | Fix |
|---------|---------|-----|
| **Light gray on white** | Invisible outdoors | Min 4.5:1 contrast |
| **Pure white in dark mode** | Eye strain | Use #E0E0E0-#F0F0F0 |
| **Same saturation dark mode** | Garish, glowing | Desaturate colors |
| **Red/green only indicator** | Colorblind users can't see | Add icons |
| **Semantic colors for brand** | Confusing meaning | Use neutral for brand |
| **Ignoring system dark mode** | Jarring experience | Support both modes |

### ❌ AI Color Mistakes

```
AI tends to:
├── Use same colors for light/dark
├── Ignore OLED battery implications
├── Skip contrast calculations
├── Default to purple/violet (BANNED)
├── Use low contrast "aesthetic" grays
├── Not test in outdoor conditions
└── Forget colorblind users

RULE: Design for the worst case.
Test in bright sunlight, with colorblindness simulation.
```

---

## 9. Color System Checklist

### Before Choosing Colors

- [ ] Light and dark mode variants defined?
- [ ] Contrast ratios checked (4.5:1+)?
- [ ] OLED battery considered (dark mode)?
- [ ] Semantic colors follow conventions?
- [ ] Colorblind-safe (not color-only indicators)?

### Before Release

- [ ] Tested in bright sunlight?
- [ ] Tested dark mode on OLED device?
- [ ] System dark mode respected?
- [ ] Dynamic color supported (Android)?
- [ ] Error/success/warning consistent?
- [ ] All text meets contrast requirements?

---

## 10. Quick Reference

### Dark Mode Backgrounds

```
True black (OLED max savings): #000000
Near black (Material):         #121212
Surface 1:                     #1E1E1E
Surface 2:                     #2C2C2C
Surface 3:                     #3C3C3C
```

### Text on Dark

```
Primary:   #E0E0E0 to #ECECEC
Secondary: #A0A0A0 to #B0B0B0
Disabled:  #606060 to #707070
```

### Contrast Ratios

```
Small text:  4.5:1 (minimum)
Large text:  3:1 (minimum)
UI elements: 3:1 (minimum)
Ideal:       7:1 (AAA)
```

---

> **Remember:** Color on mobile must work in the worst conditions—bright sun, tired eyes, colorblindness, low battery. Pretty colors that fail these tests are useless colors.
