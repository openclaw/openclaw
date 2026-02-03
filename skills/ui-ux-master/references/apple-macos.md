# macOS Design Patterns

Complete guide to macOS-specific design patterns, windows, and interactions.

## Table of Contents
1. Windows & Window Management
2. Navigation & Layout
3. Toolbars & Menus
4. Controls & Input
5. Keyboard & Mouse Interaction

---

## 1. Windows & Window Management

### Window Types
**Standard Window:**
- Resizable
- Minimize, maximize, close buttons (traffic lights)
- Title bar with app name
- Optional toolbar

**Utility Window:**
- Smaller title bar
- Floats above standard windows
- For palettes, inspectors

**Panel:**
- No title bar decorations
- Typically attached to main window
- For transient UI (color picker, find panel)

### Window Controls
**Traffic Lights (left side):**
- 🔴 Close: Closes window (not app, unless last window)
- 🟡 Minimize: Sends to Dock
- 🟢 Zoom: Toggles full screen or maximizes

**Full Screen:**
- Green button (hold for options)
- Hides menu bar and Dock
- Swipe between full screen apps

### Title Bar Styles
**Standard:**
- Opaque title bar
- Clear separation from content

**Unified:**
- Toolbar and title bar merged
- Content extends to top

**Transparent:**
- Content visible through title bar
- For immersive experiences

---

## 2. Navigation & Layout

### Sidebar
**Use when:** Multiple sections or categories

**Characteristics:**
- Leading edge of window
- List or outline of navigation items
- Collapsible with ⌘⌃S
- Icon + text or text-only items

**Best Practices:**
- Use SF Symbols for icons
- Highlight selected item
- Support keyboard navigation (↑↓)

### Split View
**Use when:** Master-detail relationship

**Types:**
- **2-pane:** Sidebar + content (Mail, Notes)
- **3-pane:** Sidebar + list + detail (Mail)

**Interaction:**
- Resize divider (drag)
- Collapse/expand panes
- Persist user preferences

### Tabs
**Use when:** Multiple documents or views in one window

**Characteristics:**
- Below title bar
- Draggable to reorder
- Drag out to create new window
- Close button on each tab

**Keyboard:**
- ⌘T: New tab
- ⌘W: Close tab
- ⌘⇧[ / ⌘⇧]: Previous/next tab

---

## 3. Toolbars & Menus

### Toolbar
**Use when:** Primary actions for current context

**Items:**
- Buttons (icon, text, or both)
- Segmented controls (view switchers)
- Search fields
- Pop-up buttons (menus)

**Customization:**
- Right-click → Customize Toolbar
- User can add/remove/rearrange items

**Best Practices:**
- Use SF Symbols
- Show icon + text by default
- Group related actions

### Menu Bar
**Always present** at top of screen

**Standard Menus:**
- **App Menu:** About, Preferences, Quit
- **File:** New, Open, Save, Print, Close
- **Edit:** Undo, Cut, Copy, Paste
- **View:** Show/Hide UI elements
- **Window:** Minimize, Zoom, Bring All to Front
- **Help:** App help and search

**Keyboard Shortcuts:**
- ⌘: Command (primary)
- ⌥: Option (alternative)
- ⌃: Control (context-specific)
- ⇧: Shift (modifier)

### Context Menus
**Trigger:** Right-click or Control+click

**Content:**
- Relevant actions for clicked item
- Cut, copy, paste when applicable
- Open, rename, delete for files

---

## 4. Controls & Input

### Buttons
**Types:**
- **Push Button:** Standard action (rounded rect)
- **Default Button:** Primary action (blue, ↩ activates)
- **Bevel Button:** Icon-only, toolbar style
- **Help Button:** Small (?) for contextual help

**Sizes:**
- Regular (System default)
- Small (compact UIs)
- Mini (very compact, avoid if possible)

### Pop-Up Buttons
**Use when:** Selecting from a list (dropdown)

**Styles:**
- Standard (with arrows)
- Pull-down (menu style)

**Items:**
- Checkmark for selected item
- Dividers between groups
- Icons (optional)

### Segmented Control
**Use when:** 2-5 mutually exclusive view modes

**Styles:**
- **Automatic:** Adapts to context
- **Rounded:** Modern, iOS-like
- **Textured:** Toolbar style (legacy)

### Text Fields & Search
**Text Field:**
- Single-line input
- Optional placeholder
- Clear button (×)

**Search Field:**
- Magnifying glass icon
- Rounded appearance
- Recent searches menu
- Cancel button appears when typing

### Sliders & Steppers
**Slider:**
- Continuous value selection
- Optional tick marks
- Label showing current value

**Stepper:**
- Increment/decrement numeric values
- + and – buttons
- Typically paired with text field

---

## 5. Keyboard & Mouse Interaction

### Keyboard Shortcuts
**Universal:**
- ⌘N: New
- ⌘O: Open
- ⌘S: Save
- ⌘P: Print
- ⌘Z: Undo
- ⌘⇧Z: Redo
- ⌘C/X/V: Copy/Cut/Paste
- ⌘Q: Quit

**Window Management:**
- ⌘M: Minimize
- ⌘W: Close window/tab
- ⌘⌃F: Full screen
- ⌘`: Switch windows of app

**Tab Navigation:**
- ⇥ (Tab): Next field
- ⇧⇥: Previous field
- ⌘⇥: Switch apps
- ⌘⇧⇥: Switch apps (reverse)

### Mouse & Trackpad
**Mouse:**
- Left click: Select
- Right click: Context menu
- Scroll wheel: Vertical scroll

**Trackpad Gestures:**
- Two-finger scroll: Vertical/horizontal scroll
- Two-finger tap: Right-click
- Pinch: Zoom
- Swipe (3 fingers): Navigate back/forward
- Swipe up (3 fingers): Mission Control
- Swipe up (4 fingers): App Exposé

### Drag & Drop
**System-wide:**
- Files between Finder and apps
- Text between apps
- Images from web to desktop

**In-app:**
- Reorder lists
- Move items between views
- Copy/move with modifier keys (⌥ = copy)

---

## macOS-Specific Features

### Preferences
**Standard window:**
- ⌘, (Command-comma) shortcut
- Toolbar with icons for sections
- No OK/Cancel buttons (apply immediately)

### Notifications
**Notification Center:**
- Right side of screen
- Banners (auto-dismiss) or Alerts (require action)
- Do Not Disturb mode

### Quick Look
**Preview without opening:**
- Select file, press Space
- Arrow keys to navigate
- Markup tools (annotation)

### Spotlight
**⌘Space:** Universal search
- Apps, documents, contacts, definitions
- Calculator, unit conversions
- Web search

### Extensions
**Share Extension:**
- Share button in toolbar/menu
- Send to other apps or services

**Finder Extension:**
- Add items to Finder sidebar
- Custom actions in Finder

---

## Layout Guidelines

### Window Sizing
**Minimum:**
- 600×400pt for document windows
- 400×300pt for utility windows

**Default:**
- Reasonable size for content
- Remember user's last size

**Maximum:**
- No artificial limits
- Scale content appropriately

### Margins & Spacing
**Standard spacing:**
- **20pt:** Window edges to content
- **12pt:** Between controls (standard)
- **8pt:** Between controls (compact)
- **24pt:** Between groups

### Alignment
- **Left-align** labels and text
- **Right-align** numeric data
- **Center** only for single, prominent elements

---

## Accessibility (macOS)

### VoiceOver
- Full keyboard navigation
- Descriptive labels for all controls
- Announce state changes
- Logical focus order

### Keyboard Access
- **Full Keyboard Access:** Enable in System Settings
- All controls accessible via Tab
- Space to activate buttons
- Arrow keys for lists

### Reduce Motion
- Minimize animations
- Use crossfades instead of slides
- Respect `NSWorkspace.shared.accessibilityDisplayShouldReduceMotion`

### Contrast
- Increase Contrast mode (System Settings)
- Test UI with Increased Contrast enabled
- Avoid low-contrast text

---

## Design Checklist

✅ **Window Management**
- Resizable windows (with min/max sizes)
- Remembers window position and size
- Full screen support (if appropriate)

✅ **Navigation**
- Clear hierarchy (sidebar or tabs)
- Keyboard shortcuts for common actions
- Context menus for quick access

✅ **Toolbars**
- Customizable toolbar
- Relevant actions visible
- Icon + text labels

✅ **Menu Bar**
- Standard menus (File, Edit, View, Window, Help)
- Keyboard shortcuts documented
- Disabled items when not applicable

✅ **Input**
- Tab order logical
- Keyboard shortcuts intuitive
- Drag & drop supported

✅ **Accessibility**
- VoiceOver labels on all controls
- Full keyboard access
- Reduce Motion respected
- High contrast support

✅ **macOS Integration**
- Uses system font (SF Pro)
- Supports Light and Dark mode
- Respects system preferences
- Native look and feel

---

*For component-specific details, see [macos-components.md](macos-components.md)*
