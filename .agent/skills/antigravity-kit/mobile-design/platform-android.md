# Android Platform Guidelines

> Material Design 3 essentials, Android design conventions, Roboto typography, and native patterns.
> **Read this file when building for Android devices.**

---

## 1. Material Design 3 Philosophy

### Core Material Principles

```
MATERIAL AS METAPHOR:
├── Surfaces exist in 3D space
├── Light and shadow define hierarchy
├── Motion provides continuity
└── Bold, graphic, intentional design

ADAPTIVE DESIGN:
├── Responds to device capabilities
├── One UI for all form factors
├── Dynamic color from wallpaper
└── Personalized per user

ACCESSIBLE BY DEFAULT:
├── Large touch targets
├── Clear visual hierarchy
├── Semantic colors
└── Motion respects preferences
```

### Material Design Values

| Value | Implementation |
|-------|----------------|
| **Dynamic Color** | Colors adapt to wallpaper/user preference |
| **Personalization** | User-specific themes |
| **Accessibility** | Built into every component |
| **Responsiveness** | Works on all screen sizes |
| **Consistency** | Unified design language |

---

## 2. Android Typography

### Roboto Font Family

```
Android System Fonts:
├── Roboto: Default sans-serif
├── Roboto Flex: Variable font (API 33+)
├── Roboto Serif: Serif alternative
├── Roboto Mono: Monospace
└── Google Sans: Google products (special license)
```

### Material Type Scale

| Role | Size | Weight | Line Height | Usage |
|------|------|--------|-------------|-------|
| **Display Large** | 57sp | Regular | 64sp | Hero text, splash |
| **Display Medium** | 45sp | Regular | 52sp | Large headers |
| **Display Small** | 36sp | Regular | 44sp | Medium headers |
| **Headline Large** | 32sp | Regular | 40sp | Page titles |
| **Headline Medium** | 28sp | Regular | 36sp | Section headers |
| **Headline Small** | 24sp | Regular | 32sp | Subsections |
| **Title Large** | 22sp | Regular | 28sp | Dialogs, cards |
| **Title Medium** | 16sp | Medium | 24sp | Lists, navigation |
| **Title Small** | 14sp | Medium | 20sp | Tabs, secondary |
| **Body Large** | 16sp | Regular | 24sp | Primary content |
| **Body Medium** | 14sp | Regular | 20sp | Secondary content |
| **Body Small** | 12sp | Regular | 16sp | Captions |
| **Label Large** | 14sp | Medium | 20sp | Buttons, FAB |
| **Label Medium** | 12sp | Medium | 16sp | Navigation |
| **Label Small** | 11sp | Medium | 16sp | Chips, badges |

### Scalable Pixels (sp)

```
sp = Scale-independent pixels

sp automatically scales with:
├── User font size preference
├── Display density
└── Accessibility settings

RULE: ALWAYS use sp for text, dp for everything else.
```

### Font Weight Usage

| Weight | Use Case |
|--------|----------|
| Regular (400) | Body text, display |
| Medium (500) | Buttons, labels, emphasis |
| Bold (700) | Rarely, strong emphasis only |

---

## 3. Material Color System

### Dynamic Color (Material You)

```
Android 12+ Dynamic Color:

User's wallpaper → Color extraction → App theme

Your app automatically adapts to:
├── Primary color (from wallpaper)
├── Secondary color (complementary)
├── Tertiary color (accent)
├── Surface colors (derived)
└── All semantic colors adjust

RULE: Implement dynamic color for personalized feel.
```

### Semantic Color Roles

```
Surface Colors:
├── Surface → Main background
├── SurfaceVariant → Cards, containers
├── SurfaceTint → Elevation overlay
├── InverseSurface → Snackbars, tooltips

On-Surface Colors:
├── OnSurface → Primary text
├── OnSurfaceVariant → Secondary text
├── Outline → Borders, dividers
├── OutlineVariant → Subtle dividers

Primary Colors:
├── Primary → Key actions, FAB
├── OnPrimary → Text on primary
├── PrimaryContainer → Less emphasis
├── OnPrimaryContainer → Text on container

Secondary/Tertiary: Similar pattern
```

### Error, Warning, Success Colors

| Role | Light | Dark | Usage |
|------|-------|------|-------|
| Error | #B3261E | #F2B8B5 | Errors, destructive |
| OnError | #FFFFFF | #601410 | Text on error |
| ErrorContainer | #F9DEDC | #8C1D18 | Error backgrounds |

### Dark Theme

```
Material Dark Theme:

├── Background: #121212 (not pure black by default)
├── Surface: #1E1E1E, #232323, etc. (elevation)
├── Elevation: Higher = lighter overlay
├── Reduce saturation on colors
└── Check contrast ratios

Elevation overlays (dark mode):
├── 0dp → 0% overlay
├── 1dp → 5% overlay
├── 3dp → 8% overlay
├── 6dp → 11% overlay
├── 8dp → 12% overlay
├── 12dp → 14% overlay
```

---

## 4. Android Layout & Spacing

### Layout Grid

```
Android uses 8dp baseline grid:

All spacing in multiples of 8dp:
├── 4dp: Component internal (half-step)
├── 8dp: Minimum spacing
├── 16dp: Standard spacing
├── 24dp: Section spacing
├── 32dp: Large spacing

Margins:
├── Compact (phone): 16dp
├── Medium (small tablet): 24dp
├── Expanded (large): 24dp+ or columns
```

### Responsive Layout

```
Window Size Classes:

COMPACT (< 600dp width):
├── Phones in portrait
├── Single column layout
├── Bottom navigation

MEDIUM (600-840dp width):
├── Tablets, foldables
├── Consider 2 columns
├── Navigation rail option

EXPANDED (> 840dp width):
├── Large tablets, desktop
├── Multi-column layouts
├── Navigation drawer
```

### Canonical Layouts

| Layout | Use Case | Window Class |
|--------|----------|--------------|
| **List-Detail** | Email, messages | Medium, Expanded |
| **Feed** | Social, news | All |
| **Supporting Pane** | Reference content | Medium, Expanded |

---

## 5. Android Navigation Patterns

### Navigation Components

| Component | Use Case | Position |
|-----------|----------|----------|
| **Bottom Navigation** | 3-5 top-level destinations | Bottom |
| **Navigation Rail** | Tablets, foldables | Left side, vertical |
| **Navigation Drawer** | Many destinations, large screens | Left side, hidden/visible |
| **Top App Bar** | Current context, actions | Top |

### Bottom Navigation

```
┌─────────────────────────────────────┐
│                                     │
│         Content Area                │
│                                     │
├─────────────────────────────────────┤
│  🏠     🔍     ➕     ❤️     👤    │ ← 80dp height
│ Home   Search  FAB   Saved  Profile│
└─────────────────────────────────────┘

Rules:
├── 3-5 destinations
├── Icons: Material Symbols (24dp)
├── Labels: Always visible (accessibility)
├── Active: Filled icon + indicator pill
├── Badge: For notifications
├── FAB can integrate (optional)
```

### Top App Bar

```
Types:
├── Center-aligned: Logo apps, simple
├── Small: Compact, scrolls away
├── Medium: Title + actions, collapses
├── Large: Display title, collapses to small

┌─────────────────────────────────────┐
│  ☰   App Title              🔔 ⋮  │ ← 64dp (small)
├─────────────────────────────────────┤
│                                     │
│         Content Area                │
└─────────────────────────────────────┘

Actions: Max 3 icons, overflow menu ( ⋮ ) for more
```

### Navigation Rail (Tablets)

```
┌───────┬─────────────────────────────┐
│  ≡    │                             │
│       │                             │
│  🏠   │                             │
│ Home  │       Content Area          │
│       │                             │
│  ���   │                             │
│Search │                             │
│       │                             │
│  👤   │                             │
│Profile│                             │
└───────┴─────────────────────────────┘

Width: 80dp
Icons: 24dp
Labels: Below icon
FAB: Can be at top
```

### Back Navigation

```
Android provides system back:
├── Back button (3-button nav)
├── Back gesture (swipe from edge)
├── Predictive back (Android 14+)

Your app must:
├── Handle back correctly (pop stack)
├── Support predictive back animation
├── Never hijack/override back unexpectedly
└── Confirm before discarding unsaved work
```

---

## 6. Material Components

### Buttons

```
Button Types:

┌──────────────────────┐
│    Filled Button     │  ← Primary action
└──────────────────────┘

┌──────────────────────┐
│    Tonal Button      │  ← Secondary, less emphasis
└──────────────────────┘

┌──────────────────────┐
│   Outlined Button    │  ← Tertiary, lower emphasis
└──────────────────────┘

    Text Button           ← Lowest emphasis

Heights:
├── Small: 40dp (when constrained)
├── Standard: 40dp
├── Large: 56dp (FAB size when needed)

Min touch target: 48dp (even if visual is smaller)
```

### Floating Action Button (FAB)

```
FAB Types:
├── Standard: 56dp diameter
├── Small: 40dp diameter
├── Large: 96dp diameter
├── Extended: Icon + text, variable width

Position: Bottom right, 16dp from edges
Elevation: Floats above content

┌─────────────────────────────────────┐
│                                     │
│         Content                     │
│                                     │
│                              ┌────┐ │
│                              │ ➕ │ │ ← FAB
│                              └────┘ │
├─────────────────────────────────────┤
│       Bottom Navigation             │
└─────────────────────────────────────┘
```

### Cards

```
Card Types:
├── Elevated: Shadow, resting state
├── Filled: Background color, no shadow
├── Outlined: Border, no shadow

Card Anatomy:
┌─────────────────────────────────────┐
│           Header Image              │ ← Optional
├─────────────────────────────────────┤
│  Title / Headline                   │
│  Subhead / Supporting text          │
├─────────────────────────────────────┤
│      [ Action ]    [ Action ]       │ ← Optional actions
└─────────────────────────────────────┘

Corner radius: 12dp (M3 default)
Padding: 16dp
```

### Text Fields

```
Types:
├── Filled: Background fill, underline
├── Outlined: Border all around

┌─────────────────────────────────────┐
│  Label                              │ ← Floats up on focus
│  ________________________________________________
│  │     Input text here...          │ ← Leading/trailing icons
│  ‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾���
│  Supporting text or error           │
└─────────────────────────────────────┘

Height: 56dp
Label: Animates from placeholder to top
Error: Red color + icon + message
```

### Chips

```
Types:
├── Assist: Smart actions (directions, call)
├── Filter: Toggle filters
├── Input: Represent entities (tags, contacts)
├── Suggestion: Dynamic recommendations

┌───────────────┐
│  🏷️ Filter   │  ← 32dp height, 8dp corner radius
└───────────────┘

States: Unselected, Selected, Disabled
```

---

## 7. Android-Specific Patterns

### Snackbars

```
Position: Bottom, above navigation
Duration: 4-10 seconds
Action: One optional text action

┌─────────────────────────────────────────────────┐
│  Archived 1 item                    [ UNDO ]    │
└─────────────────────────────────────────────────┘

Rules:
├── Brief message, single line if possible
├── Max 2 lines
├── One action (text, not icon)
├── Can be dismissed by swipe
└── Don't stack, queue them
```

### Bottom Sheets

```
Types:
├── Standard: Interactive content
├── Modal: Blocks background (with scrim)

Modal Bottom Sheet:
┌─────────────────────────────────────┐
│                                     │
│        (Scrim over content)         │
│                                     │
├═════════════════════════════════════┤
│  ─────  (Drag handle, optional)     │
│                                     │
│        Sheet Content                │
│                                     │
│        Actions / Options            │
│                                     │
└─────────────────────────────────────┘

Corner radius: 28dp (top corners)
```

### Dialogs

```
Types:
├── Basic: Title + content + actions
├── Full-screen: Complex editing (mobile)
├── Date/Time picker
├── Confirmation dialog

┌─────────────────────────────────────┐
│              Title                  │
│                                     │
│       Supporting text that          │
│       explains the dialog           │
│                                     │
│           [ Cancel ]  [ Confirm ]   │
└─────────────────────────────────────┘

Rules:
├── Centered on screen
├── Scrim behind (dim background)
├── Max 2 actions aligned right
├── Destructive action can be on left
```

### Pull to Refresh

```
Android uses SwipeRefreshLayout pattern:

┌─────────────────────────────────────┐
│         ○ (Spinner)                 │ ← Circular progress
├─────────────────────────────────────┤
│                                     │
│         Content                     │
│                                     │
└─────────────────────────────────────┘

Spinner: Material circular indicator
Position: Top center, pulls down with content
```

### Ripple Effect

```
Every touchable element needs ripple:

Touch down → Ripple expands from touch point
Touch up → Ripple completes and fades

Color: 
├── On light: Black at ~12% opacity
├── On dark: White at ~12% opacity
├── On colored: Appropriate contrast

This is MANDATORY for Android feel.
```

---

## 8. Material Symbols

### Usage Guidelines

```
Material Symbols: Google's icon library

Styles:
├── Outlined: Default, most common
├── Rounded: Softer, friendly
├── Sharp: Angular, precise

Variable font axes:
├── FILL: 0 (outline) to 1 (filled)
├── wght: 100-700 (weight)
├── GRAD: -25 to 200 (emphasis)
├── opsz: 20, 24, 40, 48 (optical size)
```

### Icon Sizes

| Size | Usage |
|------|-------|
| 20dp | Dense UI, inline |
| 24dp | Standard (most common) |
| 40dp | Larger touch targets |
| 48dp | Emphasis, standalone |

### States

```
Icon States:
├── Default: Full opacity
├── Disabled: 38% opacity
├── Hover/Focus: Container highlight
├── Selected: Filled variant + tint

Active vs Inactive:
├── Inactive: Outlined
├── Active: Filled + indicator
```

---

## 9. Android Accessibility

### TalkBack Requirements

```
Every interactive element needs:
├── contentDescription (what it is)
├── Correct semantics (button, checkbox, etc.)
├── State announcements (selected, disabled)
└── Grouping where logical

Jetpack Compose:
Modifier.semantics {
    contentDescription = "Play button"
    role = Role.Button
}

React Native:
accessibilityLabel="Play button"
accessibilityRole="button"
accessibilityState={{ disabled: false }}
```

### Touch Target Size

```
MANDATORY: 48dp × 48dp minimum

Even if visual element is smaller:
├── Icon: 24dp visual, 48dp touch area
├── Checkbox: 20dp visual, 48dp touch area
└── Add padding to reach 48dp

Spacing between targets: 8dp minimum
```

### Font Scaling

```
Android supports font scaling:
├── 85% (smaller)
├── 100% (default)
├── 115%, 130%, 145%...
├── Up to 200% (largest)

RULE: Test your UI at 200% font scale.
Use sp units and avoid fixed heights.
```

### Reduce Motion

```kotlin
// Check motion preference
val reduceMotion = Settings.Global.getFloat(
    contentResolver,
    Settings.Global.ANIMATOR_DURATION_SCALE,
    1f
) == 0f

if (reduceMotion) {
    // Skip or reduce animations
}
```

---

## 10. Android Checklist

### Before Every Android Screen

- [ ] Using Material 3 components
- [ ] Touch targets ≥ 48dp
- [ ] Ripple effect on all touchables
- [ ] Roboto or Material type scale
- [ ] Semantic colors (dynamic color support)
- [ ] Back navigation works correctly

### Before Android Release

- [ ] Dark theme tested
- [ ] Dynamic color tested (if supported)
- [ ] All font sizes tested (200% scale)
- [ ] TalkBack tested
- [ ] Predictive back implemented (Android 14+)
- [ ] Edge-to-edge display (Android 15+)
- [ ] Different screen sizes tested (phones, tablets)
- [ ] Navigation patterns match platform (back, gestures)

---

> **Remember:** Android users expect Material Design. Custom designs that ignore Material patterns feel foreign and broken. Use Material components as your foundation, customize thoughtfully.
