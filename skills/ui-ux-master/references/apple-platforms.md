# Apple Platforms - Complete Guide

Comprehensive guide for all Apple platforms: iOS, iPadOS, macOS, watchOS, tvOS, and visionOS.

## Table of Contents
1. Core Design Principles
2. Platform Comparison
3. Typography & SF Symbols
4. Color & Dark Mode
5. Layout Systems
6. Platform-Specific Deep Dives

---

## 1. Core Design Principles

### Clarity
**Definition:** Content and functionality are obvious at every size

**Implementation:**
- Text legible at all Dynamic Type sizes
- Icons precise and immediately recognizable
- UI elements have clear affordances
- Adornments are subtle, never distracting

### Deference
**Definition:** UI defers to content, never competing with it

**Implementation:**
- Content fills the screen
- Translucency hints at more content below
- Minimal bezels, gradients, shadows
- Controls appear only when needed

### Depth
**Definition:** Visual layers and motion convey hierarchy

**Implementation:**
- Layered UI with elevation
- Smooth, realistic motion
- Touch interactions feel natural
- Spatial awareness in 3D (visionOS)

---

## 2. Platform Comparison

| Platform | Screen | Input | Font | Key Pattern |
|----------|--------|-------|------|-------------|
| **iOS** | 4-7" | Touch | SF Pro | Tab Bar Navigation |
| **iPadOS** | 10-13" | Touch + Pencil | SF Pro | Split View + Sidebar |
| **macOS** | 13-32" | Mouse + Keyboard | SF Pro | Windows + Menu Bar |
| **watchOS** | 1-2" | Digital Crown + Touch | SF Compact | Vertical Scroll |
| **tvOS** | TV | Siri Remote | SF Pro Display | Focus-Driven Grid |
| **visionOS** | Spatial | Eyes + Hands | SF Pro | 3D Windows |

### When to Use Each Platform

**iOS:** Mobile apps, on-the-go tasks, touch-first interactions
**iPadOS:** Creative tools, productivity, larger touch interfaces
**macOS:** Professional tools, complex workflows, precision tasks
**watchOS:** Glanceable info, quick actions, health tracking
**tvOS:** Entertainment, casual browsing, living room
**visionOS:** Spatial computing, immersive experiences, 3D content

---

## 3. Typography & SF Symbols

### San Francisco Font Family

**SF Pro:** iOS, macOS, tvOS, visionOS
- Optimized for readability at all sizes
- Variable font weights (Ultralight to Black)
- Automatic optical sizing

**SF Compact:** watchOS
- Rounded, friendly appearance
- Optimized for small screens
- Slightly wider for legibility

**SF Mono:** Code and tabular data (all platforms)
- Fixed-width characters
- Clear distinction between similar characters (0/O, 1/l)

**SF Arabic, SF Hebrew:** Localized scripts

### Dynamic Type

**Text Styles (iOS/macOS):**
```
Large Title - 34pt (iOS), 26pt (macOS)
Title 1     - 28pt (iOS), 22pt (macOS)
Title 2     - 22pt (iOS), 17pt (macOS)
Title 3     - 20pt (iOS), 15pt (macOS)
Headline    - 17pt (iOS), 13pt (macOS) bold
Body        - 17pt (iOS), 13pt (macOS)
Callout     - 16pt (iOS), 12pt (macOS)
Subheadline - 15pt (iOS), 11pt (macOS)
Footnote    - 13pt (iOS), 10pt (macOS)
Caption 1   - 12pt (iOS), 10pt (macOS)
Caption 2   - 11pt (iOS), 10pt (macOS)
```

**Accessibility Sizes:**
- Standard: -3 to +7 (12 sizes)
- Accessibility: AX1 to AX5 (5 additional sizes)
- Always test at largest sizes

### SF Symbols

**6,000+ icons designed by Apple:**
- Match text weight automatically
- Variable color rendering modes
- Multicolor, hierarchical, palette, monochrome

**Usage (SwiftUI):**
```swift
Image(systemName: "star.fill")
Image(systemName: "heart.circle.fill")
  .symbolRenderingMode(.multicolor)
```

**Best Practices:**
- Match symbol weight to text weight
- Use filled variants for selected states
- Leverage multicolor for semantic meaning
- Custom symbols follow SF design

---

## 4. Color & Dark Mode

### System Colors (Semantic)

**Labels (Text):**
- `label` - Primary text
- `secondaryLabel` - Secondary text
- `tertiaryLabel` - Tertiary text/disabled
- `quaternaryLabel` - Watermarks

**Fills (Backgrounds):**
- `systemFill` - Thin fill
- `secondarySystemFill` - Medium fill
- `tertiarySystemFill` - Thick fill
- `quaternarySystemFill` - Thickest fill

**Backgrounds:**
- `systemBackground` - Main background
- `secondarySystemBackground` - Grouped content
- `tertiarySystemBackground` - Grouped in grouped

**Grouped Backgrounds:**
- `systemGroupedBackground`
- `secondarySystemGroupedBackground`
- `tertiarySystemGroupedBackground`

### Accent Colors

**System Accent:**
- Blue (default)
- User can change in Settings (iOS 14+)
- Use for interactive elements

**Custom Accent:**
- Define in Asset Catalog
- Adapts to light/dark automatically
- Use for brand identity

### Dark Mode Strategy

**Elevation, Not Brightness:**
```
Base:       oklch(0.145 0 0)   (darkest)
Elevated:   oklch(0.205 0 0)   (slightly lighter)
Elevated 2: oklch(0.255 0 0)   (more elevated)
```

**Avoid Pure Black:**
- Use dark gray instead (#1C1C1E, not #000000)
- Provides subtle elevation
- Reduces eye strain on OLED

**Test Both Modes:**
- Design in both simultaneously
- Use semantic colors when possible
- Provide light/dark variants for images

---

## 5. Layout Systems

### Safe Areas

**iOS Safe Areas:**
- **Top:** Status bar (44-59pt), notch, Dynamic Island
- **Bottom:** Home indicator (34pt)
- **Leading/Trailing:** 0pt (full bleed) to 20pt (margins)

**SwiftUI:**
```swift
.safeAreaInset(edge: .bottom) { /* toolbar */ }
.ignoresSafeArea() // when appropriate
```

**UIKit:**
```swift
view.safeAreaLayoutGuide
view.safeAreaInsets
```

### Size Classes

**iOS/iPadOS:**
- Compact Width: iPhone portrait, iPhone landscape (smaller)
- Regular Width: iPad, iPhone landscape (larger models)
- Compact Height: iPhone landscape
- Regular Height: iPhone portrait, iPad

**Adaptive Strategy:**
- Compact → Single column, stack vertically
- Regular → Multi-column, sidebars, split views

**SwiftUI:**
```swift
@Environment(\.horizontalSizeClass) var horizontal
@Environment(\.verticalSizeClass) var vertical
```

### Margins & Spacing

**Standard Margins:**
- iPhone: 16-20pt
- iPad: 20-24pt
- Mac: 20pt

**Component Spacing:**
- Tight: 4-8pt (related items)
- Standard: 12-16pt (grouped items)
- Loose: 20-32pt (sections)

**Grid System:**
- Base: 8pt grid
- Touch targets: 44×44pt minimum (iOS)
- macOS controls: 20pt height typical

---

## 6. Platform-Specific Deep Dives

### iOS/iPadOS Patterns
See [apple-ios.md](apple-ios.md) for:
- Navigation patterns (Tab Bar, Navigation Bar, Sidebar)
- Lists, grids, and cards
- Forms and input
- Modality (sheets, alerts, popovers)
- Gestures and haptics
- Widgets and Live Activities

### macOS Patterns
See [apple-macos.md](apple-macos.md) for:
- Windows and window management
- Sidebars and split views
- Toolbars and menu bar
- Keyboard shortcuts
- Drag and drop
- Preferences and settings

### watchOS Patterns
See [apple-watchos.md](apple-watchos.md) for:
- Glanceable design
- Digital Crown interaction
- Always-On Display
- Complications
- Notifications

---

## Accessibility Across Platforms

### VoiceOver (All Platforms)
- Descriptive labels for all interactive elements
- Logical focus order (top → bottom, left → right)
- Group related elements
- Announce dynamic changes

### Dynamic Type (iOS/macOS)
- Support all text sizes (-3 to AX5)
- Test at largest accessibility sizes
- Allow multi-line labels
- Scale layouts appropriately

### Keyboard Access (macOS/iPadOS)
- Full Keyboard Access in System Settings
- Tab order logical
- All actions keyboard-accessible
- Visible focus indicators

### Reduce Motion (All Platforms)
- Provide crossfade alternative to slides
- Check `UIAccessibility.isReduceMotionEnabled`
- Essential animations only
- No auto-playing videos

### Color & Contrast
- WCAG AA minimum (4.5:1 normal, 3:1 large)
- Test with grayscale
- Test with color blindness simulators
- Increase Contrast mode support

---

## Platform Integration Features

### iOS Features
- **Widgets:** Home Screen, Lock Screen, StandBy
- **Live Activities:** Dynamic Island, Lock Screen updates
- **App Clips:** Lightweight 10MB experiences
- **Shortcuts:** Siri Shortcuts, App Intents
- **Handoff:** Continue across devices
- **SharePlay:** Shared experiences

### macOS Features
- **Menu Bar:** Global app menus
- **Dock:** App launcher with badges
- **Finder Extensions:** Custom sidebar items, actions
- **Quick Look:** Preview files with Space
- **Spotlight:** ⌘Space universal search
- **Continuity:** Handoff, Universal Clipboard, AirDrop

### watchOS Features
- **Complications:** Watch face widgets
- **Always-On Display:** Simplified UI when down
- **Workout APIs:** Health and fitness integration
- **Notifications:** Short Look, Long Look

### tvOS Features
- **Top Shelf:** Featured content on home screen
- **Focus Engine:** Automatic focus management
- **Siri Integration:** Voice control
- **Game Controllers:** Extended gamepad support

### visionOS Features
- **Spatial Windows:** Float in 3D space
- **Volumes:** 3D content containers
- **Immersion Dial:** Environment blend control
- **Spatial Audio:** 3D positional audio
- **Eye Tracking:** Gaze-based targeting

---

## Cross-Platform Development

### SwiftUI (Recommended)
**Advantages:**
- Write once, deploy to all Apple platforms
- Automatic adaptations (size classes, input methods)
- Modern declarative syntax
- State management built-in

**Best For:**
- New projects
- Apps targeting iOS 14+
- Rapid prototyping
- Cross-platform apps

### UIKit (iOS) / AppKit (macOS)
**When to use:**
- Fine-grained control needed
- Supporting older OS versions (< iOS 13)
- Complex custom UI
- Performance-critical apps

### Platform-Specific Considerations
- Test on each platform's real devices
- Respect each platform's conventions
- Adapt navigation patterns appropriately
- Use platform-specific features when beneficial

---

## Design Resources

**Official:**
- [Apple HIG](https://developer.apple.com/design/human-interface-guidelines)
- [SF Symbols App](https://developer.apple.com/sf-symbols/)
- [Apple Design Resources](https://developer.apple.com/design/resources/)

**Tools:**
- Sketch, Figma, Adobe XD (design)
- SF Pro font download (Apple)
- Color Contrast Analyzer
- Accessibility Inspector (Xcode)

**Learning:**
- WWDC Design sessions
- Apple Developer Forums
- Human Interface Guidelines documentation

---

*For platform-specific patterns, see apple-ios.md, apple-macos.md, and apple-watchos.md*
