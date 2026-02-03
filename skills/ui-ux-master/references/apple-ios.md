# iOS Design Patterns

Complete guide to iOS-specific design patterns, layouts, and interactions.

## Table of Contents
1. Navigation Patterns
2. Layout Patterns
3. Data Display
4. User Input
5. Modality
6. Gestures & Haptics

---

## 1. Navigation Patterns

### Tab Bar
**Use when:** App has 3-5 primary, peer-level destinations

**Characteristics:**
- Always visible at bottom of screen
- Icons + text labels (optional text on iPhone landscape)
- Max 5 tabs (More tab for additional items)
- Badge notifications supported

**Best Practices:**
- Use recognizable SF Symbols
- Keep labels short (1-2 words)
- Highlight selected tab with accent color
- Persist selection across app launches

### Navigation Bar
**Use when:** Hierarchical content with parent-child relationships

**Characteristics:**
- At top of screen
- Large title (iOS 11+) or inline title
- Back button (automatic)
- Trailing actions (buttons, menus)

**Styles:**
- **Large Title:** Scrolls to inline when content scrolls
- **Inline:** Compact, always visible
- **Transparent:** Blends with content

### Search
**Use when:** Content is searchable or filterable

**Placement:**
- In navigation bar (iOS 11+)
- As first row in list
- As overlay (full screen)

**Features:**
- Search suggestions
- Scopes (filter tabs)
- Recent searches
- Cancel button

### Sidebar (iPad)
**Use when:** iPad app with multiple sections

**Characteristics:**
- Leading edge of screen
- Collapsible on smaller iPads
- Persistent on larger iPads (landscape)
- Can replace tab bar for complex navigation

---

## 2. Layout Patterns

### Safe Area
**Critical zones:**
- Top: Status bar (44pt), notch, Dynamic Island
- Bottom: Home indicator (34pt)
- Leading/trailing: 20pt margins (avoid too close to edges)

**SwiftUI:**
```swift
.safeAreaInset(edge: .bottom) { /* content */ }
.ignoresSafeArea() // when needed
```

### Size Classes
**Compact Width:**
- iPhone portrait (all sizes)
- iPhone landscape (smaller models)

**Regular Width:**
- iPad portrait/landscape
- iPhone landscape (Plus/Max/Pro Max models)

**Compact Height:**
- iPhone landscape

**Regular Height:**
- iPhone portrait
- iPad portrait/landscape

**Adaptive strategy:**
- Compact width → Stack vertically, single column
- Regular width → Multi-column, sidebars

### Margins & Spacing
**Standard spacing:**
- **16pt:** iPhone margins (edge to content)
- **20pt:** iPad margins
- **8pt:** Small spacing (related items)
- **16pt:** Medium spacing (groups)
- **24pt:** Large spacing (sections)

### Grid
**8pt grid system:**
- Base unit: 8pt
- Text: multiples of 8pt line height
- Icons: 20pt, 24pt, 28pt, 32pt
- Touch targets: min 44×44pt

---

## 3. Data Display

### Lists
**Styles:**
- **Inset Grouped** (modern, default iOS 13+)
- **Grouped** (legacy, full-width headers)
- **Plain** (edge-to-edge rows, iOS Settings style)

**Row Types:**
- Text only
- Text + detail (trailing or subtitle)
- Text + icon/image
- Custom (any view)

**Swipe Actions:**
- Leading actions (swipe right)
- Trailing actions (swipe left)
- Destructive action (red, at end)

**Features:**
- Pull to refresh
- Infinite scroll (pagination)
- Section headers/footers
- Index (A-Z sidebar)

### Grids (Collection Views)
**Layouts:**
- **Flow:** Wrapping grid (photos, products)
- **Columns:** Fixed columns (2, 3, 4)
- **Waterfall:** Pinterest-style (variable heights)

**Spacing:**
- 8-16pt between items
- 16-20pt section insets

### Cards
**Use when:** Grouping related content visually

**Characteristics:**
- Rounded corners (8-12pt radius)
- White/system background
- Subtle shadow (avoid heavy shadows)
- Padding: 12-16pt

**Interactive cards:**
- Tappable (full card acts as button)
- Long press for context menu
- Swipe gestures

---

## 4. User Input

### Text Fields
**Types:**
- Plain (underline)
- Rounded border
- Square border (macOS-like)

**Keyboard Types:**
- Default, email, URL, number pad, phone pad, decimal pad

**Features:**
- Placeholder text
- Clear button (×)
- Left/right accessory views
- Input validation (inline or on submit)

### Buttons
**Styles (iOS 15+):**
- **Filled:** Primary action (blue background)
- **Tinted:** Secondary action (tinted background)
- **Gray:** Tertiary action (gray background)
- **Plain:** Text-only, least prominent

**Sizes:**
- Small, Medium (default), Large
- Width: Flexible, Compact

**Prominence:**
- Large filled → Most important
- Plain → Least important

### Pickers
**Types:**
- **Wheel:** Inline scrolling (Date, Time)
- **Menu:** Dropdown (Compact, iOS 14+)
- **Inline:** Expanded menu (iOS 14+)

**Date Picker:**
- Wheel (default)
- Compact (badge with popover)
- Graphical (calendar, iOS 14+)

### Toggles & Switches
**Switch:**
- On/off only
- Green (on), gray (off)
- Label on leading side

**Toggle Button:**
- Multi-state (3+ options)
- Use segmented control or picker

### Segmented Control
**Use when:** 2-5 mutually exclusive options

**Styles:**
- Standard (iOS default)
- Plain text
- Icon + text
- Icon only

---

## 5. Modality

### Sheets
**Use when:** Secondary task without leaving context

**Presentation:**
- Medium detent (half screen, iOS 15+)
- Large detent (full screen)
- Custom heights

**Dismissal:**
- Swipe down
- Close button (if needed)
- Tap outside (non-blocking)

**Best practices:**
- Use medium detent when possible
- Add grabber indicator
- Avoid nested sheets

### Full Screen Modal
**Use when:** Critical task requiring full attention

**Navigation:**
- **Done:** Complete and dismiss
- **Cancel:** Discard and dismiss
- **< Back:** Multi-step modal (nav stack)

**Presentation Styles:**
- Full Screen (default)
- Automatic (large on iPad)
- Form sheet (iPad centered)

### Alerts & Action Sheets
**Alert:**
- Title + message
- 1-2 buttons (max 3)
- Default, cancel, destructive actions

**Action Sheet:**
- Title + message (optional)
- Multiple actions (list)
- Cancel button at bottom
- Destructive action (red)

**Best practices:**
- Use sparingly (interrupting)
- Title should be question or statement
- Avoid nested alerts

### Popovers (iPad)
**Use when:** Contextual content or actions

**Characteristics:**
- Arrow pointing to source
- Auto-dismisses when tapping outside
- Size: compact to full screen

**On iPhone:**
- Converts to sheet or action sheet

### Context Menus
**Trigger:** Long press

**Content:**
- Primary action preview (optional)
- Action list (icons + text)
- Nested menus (submenus)

**Actions:**
- Use SF Symbols
- Destructive actions (red) at bottom
- Max 10-12 items

---

## 6. Gestures & Haptics

### Standard Gestures
- **Tap:** Select, activate
- **Double tap:** Zoom (maps, images)
- **Long press:** Context menu, drag preview
- **Swipe:** Navigate, reveal actions
- **Pinch:** Zoom in/out
- **Rotate:** Rotate content (photos)
- **Edge swipe:** Back navigation (leading edge)

### Haptic Feedback
**Impact:**
- Light: Small element collision
- Medium: Medium element collision
- Heavy: Large element collision

**Notification:**
- Success: ✓ (positive)
- Warning: ⚠︎ (caution)
- Error: ✕ (negative)

**Selection:**
- Picker value change
- Toggle state change
- Segmented control

**When to use:**
- Provide feedback for ambiguous actions
- Confirm state changes
- Enhance important moments
- Don't overuse (becomes noise)

### Pull to Refresh
**Standard pattern:**
- Pull down list/scroll view
- Release to trigger
- Loading indicator appears
- Auto-dismiss when complete

**Customization:**
- Custom loading views
- Haptic feedback on trigger

---

## iOS-Specific Features

### Widgets
**Types:**
- **Home Screen:** Small (2×2), Medium (2×4), Large (4×4), Extra Large (4×8, iPad only)
- **Lock Screen:** Circular, Rectangular, Inline
- **StandBy:** Full-screen glanceable info

**Best practices:**
- Show essential, at-a-glance info
- Update intelligently (timeline)
- Deep link to app
- Support all sizes (when appropriate)

### Live Activities (iOS 16+)
**Use when:** Real-time updates needed (sports, delivery, timers)

**Display:**
- Lock Screen (banner)
- Dynamic Island (iPhone 14 Pro+)

**Characteristics:**
- Starts from app
- Updates via push or app
- User-dismissible
- Max 8 hours

### App Clips
**Lightweight app experience:**
- Max 10MB download
- No App Store required
- Accessed via QR, NFC, Messages, Safari

**Design:**
- Single, focused task
- Simple, fast UI
- Optional account creation
- Prompt to install full app

---

## Accessibility (iOS)

### VoiceOver
- Add `accessibilityLabel` to all interactive elements
- Group related elements with `accessibilityElement(children: .combine)`
- Logical focus order (top to bottom, left to right)
- Custom actions for complex gestures

### Dynamic Type
- Use `Text` in SwiftUI (auto-scales)
- Use `UIFont.preferredFont` in UIKit
- Test at largest accessibility sizes (AX5)
- Allow multi-line labels

### Reduce Motion
- Provide crossfade alternative to slides
- Check `UIAccessibility.isReduceMotionEnabled`
- Avoid parallax and animated backgrounds

### Button Shapes
- When enabled, adds underlines to text buttons
- Test your UI with button shapes enabled

---

## Design Checklist

✅ **Layout**
- Respects safe areas
- Supports all device sizes
- Adaptive (compact/regular size classes)
- Margins and spacing follow 8pt grid

✅ **Typography**
- Uses SF Pro (system font)
- Supports Dynamic Type
- Appropriate text styles (Body, Headline, etc.)

✅ **Color**
- Uses semantic system colors
- Supports Light and Dark mode
- Sufficient contrast (4.5:1 minimum)

✅ **Components**
- Uses native iOS components when possible
- Custom components feel native
- Interactions match iOS patterns

✅ **Navigation**
- Clear hierarchy
- Consistent navigation pattern
- Back navigation always available

✅ **Accessibility**
- VoiceOver labels on all interactive elements
- Dynamic Type supported
- Reduce Motion alternatives
- Color contrast meets WCAG AA

✅ **Platform Features**
- Widgets (if appropriate)
- Shortcuts integration
- Handoff support (if multi-device)

---

*For component-specific details, see [ios-components.md](ios-components.md)*
