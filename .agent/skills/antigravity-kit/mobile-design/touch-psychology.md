# Touch Psychology Reference

> Deep dive into mobile touch interaction, Fitts' Law for touch, thumb zone anatomy, gesture psychology, and haptic feedback.
> **This is the mobile equivalent of ux-psychology.md - CRITICAL for all mobile work.**

---

## 1. Fitts' Law for Touch

### The Fundamental Difference

```
DESKTOP (Mouse/Trackpad):
├── Cursor size: 1 pixel (precision)
├── Visual feedback: Hover states
├── Error cost: Low (easy to retry)
└── Target acquisition: Fast, precise

MOBILE (Finger):
├── Contact area: ~7mm diameter (imprecise)
├── Visual feedback: No hover, only tap
├── Error cost: High (frustrating retries)
├── Occlusion: Finger covers the target
└── Target acquisition: Slower, needs larger targets
```

### Fitts' Law Formula Adapted

```
Touch acquisition time = a + b × log₂(1 + D/W)

Where:
├── D = Distance to target
├── W = Width of target
└── For touch: W must be MUCH larger than desktop
```

### Minimum Touch Target Sizes

| Platform | Minimum | Recommended | Use For |
|----------|---------|-------------|---------|
| **iOS (HIG)** | 44pt × 44pt | 48pt+ | All tappable elements |
| **Android (Material)** | 48dp × 48dp | 56dp+ | All tappable elements |
| **WCAG 2.2** | 44px × 44px | - | Accessibility compliance |
| **Critical Actions** | - | 56-64px | Primary CTAs, destructive actions |

### Visual Size vs Hit Area

```
┌─────────────────────────────────────┐
│                                     │
│    ┌─────────────────────────┐      │
│    │                         │      │
│    │    [  BUTTON  ]         │ ← Visual: 36px
│    │                         │      │
│    └─────────────────────────┘      │
│                                     │ ← Hit area: 48px (padding extends)
└─────────────────────────────────────┘

✅ CORRECT: Visual can be smaller if hit area is minimum 44-48px
❌ WRONG: Making hit area same as small visual element
```

### Application Rules

| Element | Visual Size | Hit Area |
|---------|-------------|----------|
| Icon buttons | 24-32px | 44-48px (padding) |
| Text links | Any | 44px height minimum |
| List items | Full width | 48-56px height |
| Checkboxes/Radio | 20-24px | 44-48px tap area |
| Close/X buttons | 24px | 44px minimum |
| Tab bar items | Icon 24-28px | Full tab width, 49px height (iOS) |

---

## 2. Thumb Zone Anatomy

### One-Handed Phone Usage

```
Research shows: 49% of users hold phone one-handed.

┌─────────────────────────────────────┐
│                                     │
│  ┌─────────────────────────────┐    │
│  │       HARD TO REACH         │    │ ← Status bar, top nav
│  │      (requires stretch)     │    │    Put: Back, menu, settings
│  │                             │    │
│  ├─────────────────────────────┤    │
│  │                             │    │
│  │       OK TO REACH           │    │ ← Content area
│  │      (comfortable)          │    │    Put: Secondary actions, content
│  │                             │    │
│  ├─────────────────────────────┤    │
│  │                             │    │
│  │       EASY TO REACH         │    │ ← Tab bar, FAB zone
│  │      (thumb's arc)          │    │    Put: PRIMARY CTAs!
│  │                             │    │
│  └─────────────────────────────┘    │
│                                     │
│          [    HOME    ]             │
└─────────────────────────────────────┘
```

### Thumb Arc (Right-Handed User)

```
Right hand holding phone:

┌───────────────────────────────┐
│  STRETCH      STRETCH    OK   │
│                               │
│  STRETCH        OK       EASY │
│                               │
│    OK          EASY      EASY │
│                               │
│   EASY         EASY      EASY │
└───────────────────────────────┘

Left hand is mirrored.
→ Design for BOTH hands or assume right-dominant
```

### Placement Guidelines

| Element Type | Ideal Position | Reason |
|--------------|----------------|--------|
| **Primary CTA** | Bottom center/right | Easy thumb reach |
| **Tab bar** | Bottom | Natural thumb position |
| **FAB** | Bottom right | Easy for right hand |
| **Navigation** | Top (stretch) | Less frequent use |
| **Destructive actions** | Top left | Hard to reach = harder to accidentally tap |
| **Dismiss/Cancel** | Top left | Convention + safety |
| **Confirm/Done** | Top right or bottom | Convention |

### Large Phone Considerations (>6")

```
On large phones, top 40% becomes "dead zone" for one-handed use.

Solutions:
├── Reachability features (iOS)
├── Pull-down interfaces (drawer pulls content down)
├── Bottom sheet navigation
├── Floating action buttons
└── Gesture-based alternatives to top actions
```

---

## 3. Touch vs Click Psychology

### Expectation Differences

| Aspect | Click (Desktop) | Touch (Mobile) |
|--------|-----------------|----------------|
| **Feedback timing** | Can wait 100ms | Expect instant (<50ms) |
| **Visual feedback** | Hover → Click | Immediate tap response |
| **Error tolerance** | Easy retry | Frustrating, feels broken |
| **Precision** | High | Low |
| **Context menu** | Right-click | Long press |
| **Cancel action** | ESC key | Swipe away, outside tap |

### Touch Feedback Requirements

```
Tap → Immediate visual change (< 50ms)
├── Highlight state (background color change)
├── Scale down slightly (0.95-0.98)
├── Ripple effect (Android Material)
├── Haptic feedback for confirmation
└── Never nothing!

Loading → Show within 100ms
├── If action takes > 100ms
├── Show spinner/progress
├── Disable button (prevent double tap)
└── Optimistic UI when possible
```

### The "Fat Finger" Problem

```
Problem: Finger occludes target during tap
├── User can't see exactly where they're tapping
├── Visual feedback appears UNDER finger
└── Increases error rate

Solutions:
├── Show feedback ABOVE touch point (tooltips)
├── Use cursor-like offset for precision tasks
├── Magnification loupe for text selection
└── Large enough targets that precision doesn't matter
```

---

## 4. Gesture Psychology

### Gesture Discoverability Problem

```
Problem: Gestures are INVISIBLE.
├── User must discover/remember them
├── No hover/visual hint
├── Different mental model than tap
└── Many users never discover gestures

Solution: Always provide visible alternative
├── Swipe to delete → Also show delete button or menu
├── Pull to refresh → Also show refresh button
├── Pinch to zoom → Also show zoom controls
└── Gestures as shortcuts, not only way
```

### Common Gesture Conventions

| Gesture | Universal Meaning | Usage |
|---------|-------------------|-------|
| **Tap** | Select, activate | Primary action |
| **Double tap** | Zoom in, like/favorite | Quick action |
| **Long press** | Context menu, selection mode | Secondary options |
| **Swipe horizontal** | Navigation, delete, actions | List actions |
| **Swipe down** | Refresh, dismiss | Pull to refresh |
| **Pinch** | Zoom in/out | Maps, images |
| **Two-finger scroll** | Scroll within scroll | Nested scrolls |

### Gesture Affordance Design

```
Swipe actions need visual hints:

┌─────────────────────────────────────────┐
│  ┌───┐                                  │
│  │ ≡ │  Item with hidden actions...   → │ ← Edge hint (partial color)
│  └───┘                                  │
└─────────────────────────────────────────┘

✅ Good: Slight color peek at edge suggesting swipe
✅ Good: Drag handle icon ( ≡ ) suggesting reorder
✅ Good: Onboarding tooltip explaining gesture
❌ Bad: Hidden gestures with no visual affordance
```

### Platform Gesture Differences

| Gesture | iOS | Android |
|---------|-----|---------|
| **Back** | Edge swipe from left | System back button/gesture |
| **Share** | Action sheet | Share sheet |
| **Context menu** | Long press / Force touch | Long press |
| **Dismiss modal** | Swipe down | Back button or swipe |
| **Delete in list** | Swipe left, tap delete | Swipe left, immediate or undo |

---

## 5. Haptic Feedback Patterns

### Why Haptics Matter

```
Haptics provide:
├── Confirmation without looking
├── Richer, more premium feel
├── Accessibility (blind users)
├── Reduced error rate
└── Emotional satisfaction

Without haptics:
├── Feels "cheap" or web-like
├── User unsure if action registered
└── Missed opportunity for delight
```

### iOS Haptic Types

| Type | Intensity | Use Case |
|------|-----------|----------|
| `selection` | Light | Picker scroll, toggle, selection |
| `light` | Light | Minor actions, hover equivalent |
| `medium` | Medium | Standard tap confirmation |
| `heavy` | Strong | Important completed, drop |
| `success` | Pattern | Task completed successfully |
| `warning` | Pattern | Warning, attention needed |
| `error` | Pattern | Error occurred |

### Android Haptic Types

| Type | Use Case |
|------|----------|
| `CLICK` | Standard tap feedback |
| `HEAVY_CLICK` | Important actions |
| `DOUBLE_CLICK` | Confirm actions |
| `TICK` | Scroll/scrub feedback |
| `LONG_PRESS` | Long press activation |
| `REJECT` | Error/invalid action |

### Haptic Usage Guidelines

```
✅ DO use haptics for:
├── Button taps
├── Toggle switches
├── Picker/slider values
├── Pull to refresh trigger
├── Successful action completion
├── Errors and warnings
├── Swipe action thresholds
└── Important state changes

❌ DON'T use haptics for:
├── Every scroll position
├── Every list item
├── Background events
├── Passive displays
└── Too frequently (haptic fatigue)
```

### Haptic Intensity Mapping

| Action Importance | Haptic Level | Example |
|-------------------|--------------|---------|
| Minor/Browsing | Light / None | Scrolling, hovering |
| Standard Action | Medium / Selection | Tap, toggle |
| Significant Action | Heavy / Success | Complete, confirm |
| Critical/Destructive | Heavy / Warning | Delete, payment |
| Error | Error pattern | Failed action |

---

## 6. Mobile Cognitive Load

### How Mobile Differs from Desktop

| Factor | Desktop | Mobile | Implication |
|--------|---------|--------|-------------|
| **Attention** | Focused sessions | Interrupted constantly | Design for micro-sessions |
| **Context** | Controlled environment | Anywhere, any condition | Handle bad lighting, noise |
| **Multitasking** | Multiple windows | One app visible | Complete task in-app |
| **Input speed** | Fast (keyboard) | Slow (touch typing) | Minimize input, smart defaults |
| **Error recovery** | Easy (undo, back) | Harder (no keyboard shortcuts) | Prevent errors, easy recovery |

### Reducing Mobile Cognitive Load

```
1. ONE PRIMARY ACTION per screen
   └── Clear what to do next
   
2. PROGRESSIVE DISCLOSURE
   └── Show only what's needed now
   
3. SMART DEFAULTS
   └── Pre-fill what you can
   
4. CHUNKING
   └── Break long forms into steps
   
5. RECOGNITION over RECALL
   └── Show options, don't make user remember
   
6. CONTEXT PERSISTENCE
   └── Save state on interrupt/background
```

### Miller's Law for Mobile

```
Desktop: 7±2 items in working memory
Mobile: Reduce to 5±1 (more distractions)

Navigation: Max 5 tab bar items
Options: Max 5 per menu level
Steps: Max 5 visible steps in progress
```

### Hick's Law for Mobile

```
More choices = slower decisions

Mobile impact: Even worse than desktop
├── Smaller screen = less overview
├── Scrolling required = items forgotten
├── Interruptions = lost context
└── Decision fatigue faster

Solution: Progressive disclosure
├── Start with 3-5 options
├── "More" for additional
├── Smart ordering (most used first)
└── Previous selections remembered
```

---

## 7. Touch Accessibility

### Motor Impairment Considerations

```
Users with motor impairments may:
├── Have tremors (need larger targets)
├── Use assistive devices (different input method)
├── Have limited reach (one-handed necessity)
├── Need more time (avoid timeouts)
└── Make accidental touches (need confirmation)

Design responses:
├── Generous touch targets (48dp+)
├── Adjustable timing for gestures
├── Undo for destructive actions
├── Switch control support
└── Voice control support
```

### Touch Target Spacing (A11y)

```
WCAG 2.2 Success Criterion 2.5.8:

Touch targets MUST have:
├── Width: ≥ 44px
├── Height: ≥ 44px
├── Spacing: ≥ 8px from adjacent targets

OR the target is:
├── Inline (within text)
├── User-controlled (user can resize)
├── Essential (no alternative design)
```

### Accessible Touch Patterns

| Pattern | Accessible Implementation |
|---------|---------------------------|
| Swipe actions | Provide menu alternative |
| Drag and drop | Provide select + move option |
| Pinch zoom | Provide zoom buttons |
| Force touch | Provide long press alternative |
| Shake gesture | Provide button alternative |

---

## 8. Emotion in Touch

### The Premium Feel

```
What makes touch feel "premium":
├── Instant response (< 50ms)
├── Appropriate haptic feedback
├── Smooth 60fps animations
├── Correct resistance/physics
├── Sound feedback (when appropriate)
└── Attention to spring physics
```

### Emotional Touch Feedback

| Emotion | Touch Response |
|---------|----------------|
| Success | Haptic success + confetti/check |
| Error | Haptic error + shake animation |
| Warning | Haptic warning + attention color |
| Delight | Unexpected smooth animation |
| Power | Heavy haptic on significant action |

### Trust Building Through Touch

```
Trust signals in touch interactions:
├── Consistent behavior (same action = same response)
├── Reliable feedback (never fails silently)
├── Secure feel for sensitive actions
├── Professional animations (not janky)
└── No accidental actions (confirmation for destructive)
```

---

## 9. Touch Psychology Checklist

### Before Every Screen

- [ ] **All touch targets ≥ 44-48px?**
- [ ] **Primary CTA in thumb zone?**
- [ ] **Destructive actions require confirmation?**
- [ ] **Gesture alternatives exist (visible buttons)?**
- [ ] **Haptic feedback on important actions?**
- [ ] **Immediate visual feedback on tap?**
- [ ] **Loading states for actions > 100ms?**

### Before Release

- [ ] **Tested on smallest supported device?**
- [ ] **Tested one-handed on large phone?**
- [ ] **All gestures have visible alternatives?**
- [ ] **Haptics work correctly (test on device)?**
- [ ] **Touch targets tested with accessibility settings?**
- [ ] **No tiny close buttons or icons?**

---

## 10. Quick Reference Card

### Touch Target Sizes

```
                     iOS        Android     WCAG
Minimum:           44pt       48dp       44px
Recommended:       48pt+      56dp+      -
Spacing:           8pt+       8dp+       8px+
```

### Thumb Zone Actions

```
TOP:      Navigation, settings, back (infrequent)
MIDDLE:   Content, secondary actions
BOTTOM:   Primary CTA, tab bar, FAB (frequent)
```

### Haptic Selection

```
Light:    Selection, toggle, minor
Medium:   Tap, standard action
Heavy:    Confirm, complete, drop
Success:  Task done
Error:    Failed action
Warning:  Attention needed
```

---

> **Remember:** Every touch is a conversation between user and device. Make it feel natural, responsive, and respectful of human fingers—not precise cursor points.
