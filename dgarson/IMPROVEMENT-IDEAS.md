# Clawdbot UI Polish Improvement Ideas

> Generated from deep scan of `/ui/src/ui` codebase on 2026-01-25

---

## Table of Contents

1. [Toast Notification System](#1-toast-notification-system)
2. [Confirmation Dialogs](#2-confirmation-dialogs)
3. [Command Palette](#3-command-palette)
4. [Loading States](#4-loading-states)
5. [Tooltip System](#5-tooltip-system)
6. [Animations & Transitions](#6-animations--transitions)
7. [Empty States](#7-empty-states)
8. [Accessibility](#8-accessibility)
9. [Micro-interactions](#9-micro-interactions)
10. [Error Handling UX](#10-error-handling-ux)
11. [Search & Filtering](#11-search--filtering)
12. [Keyboard Navigation](#12-keyboard-navigation)
13. [Visual Consistency](#13-visual-consistency)
14. [Component Gaps](#14-component-gaps)

---

## 1. Toast Notification System

**Status**: ✅ Core copy operations wired up, WebSocket connection toasts added

**File**: `ui/src/ui/components/toast.ts`

### What Exists
- Global `toast()` function
- Convenience methods: `toast.success()`, `toast.error()`, `toast.warning()`, `toast.info()`
- Auto-dismiss with configurable duration (default 5s)
- Progress bar animation
- Slide-in/out animations with spring easing
- Stacking support for multiple toasts
- Dismissible with close button

### ✅ COMPLETED: Wire Up Copy Operations

| File | Status |
|------|--------|
| `views/sessions.ts` | ✅ `toast.success("Session key copied")` |
| `views/logs.ts` | ✅ `toast.success("Log entry copied")` |
| `views/config.ts` | ✅ `toast.success("Copied to clipboard")` |
| `views/debug.ts` | ✅ `toast.success("Response copied")` |
| `chat/copy-as-markdown.ts` | ✅ `toast.success("Copied as markdown")` / `toast.error("Copy failed")` |

### ✅ COMPLETED: WebSocket Connection Toasts

| Event | Status |
|-------|--------|
| Connected | ✅ `toast.success("Connected to gateway")` |
| Disconnected | ✅ `toast.warning("Disconnected from gateway")` |

### ✅ COMPLETED: Add Toasts for Operations

| Operation | Status |
|-----------|--------|
| Config save success | ✅ `toast.success("Configuration saved")` |
| Config save failure | ✅ `toast.error("Failed to save configuration")` |
| Config apply success | ✅ `toast.success("Configuration applied")` |
| Config apply failure | ✅ `toast.error("Failed to apply configuration")` |
| Session deletion success | ✅ `toast.success("Session deleted")` |
| Session deletion failure | ✅ `toast.error("Failed to delete session")` |
| Log export complete | ✅ `toast.success("Logs exported (N entries)")` |

### ✅ COMPLETED: Add Toasts for Remaining Operations

- ✅ Channel probe success: `toast.success("Channels probed successfully")`
- ✅ Channel probe failure: `toast.error("Channel probe failed")`
- ✅ Skill installation: `toast.success("Skill installed")`
- ✅ Device pairing rejected: `toast.success("Device pairing rejected")`
- ✅ Device token revoked: `toast.success("Token revoked")`
- [ ] RPC call success: `toast.success("RPC call completed")`
- [ ] RPC call failure: `toast.error("RPC call failed")`

### Improvement: Toast Positioning Options

Current: Bottom-right only

Suggested additions:
- [ ] Add position prop: `top-right`, `top-center`, `bottom-center`
- [ ] Add `toast.promise()` for async operations with loading/success/error states

---

## 2. Confirmation Dialogs

**Status**: ✅ ConfirmDialog component created

### ✅ COMPLETED: Create ConfirmDialog Component

**File**: `ui/src/ui/components/confirm-dialog.ts`

API implemented:
```typescript
type ConfirmDialogOptions = {
  title: string;
  message: string | TemplateResult;
  confirmText?: string;  // default: "Confirm"
  cancelText?: string;   // default: "Cancel"
  variant?: "default" | "danger";
};

function showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
function showDangerConfirmDialog(title, message, confirmText?): Promise<boolean>;
```

Features:
- ✅ Promise-based API (returns true/false)
- ✅ Danger variant for destructive actions
- ✅ Keyboard support (Escape to cancel, Enter to confirm)
- ✅ Focus management
- ✅ ARIA attributes (role="dialog", aria-modal, aria-labelledby)

### ✅ COMPLETED: Wire ConfirmDialog to Existing Usages

Replace `window.confirm()` calls:
- ✅ `controllers/sessions.ts` - Delete session confirmation
- ✅ `controllers/devices.ts` - Reject device pairing
- ✅ `controllers/devices.ts` - Revoke device token

### ✅ COMPLETED: Add Confirmation for Destructive Actions

- ✅ Clear all logs (with count)
- [ ] Reset config to defaults
- ✅ Delete cron job (with job name)
- [ ] Disconnect channel
- [ ] Clear chat history

---

## 3. Command Palette

**Status**: Full implementation with navigation, context-aware commands, domain-specific commands, and system commands

**File**: `ui/src/ui/components/command-palette.ts`

### Current Commands (14 base + context-aware per tab + 3 system)

Navigation (11):
- Go to Chat, Overview, Channels, Sessions, Instances, Cron, Skills, Nodes, Config, Debug, Logs

Actions (3):
- Refresh Current View
- New Chat Session
- Toggle Theme

System (3):
- Keyboard Shortcuts
- Open Documentation
- Copy Gateway URL

Context-Aware (per tab):
- Chat: New Session, Clear History, Abort Response
- Sessions: Refresh Sessions
- Channels: Refresh Channels
- Cron: Add Job, Refresh Jobs
- Overseer: Create Goal, Refresh Overseer
- Config: Save Configuration
- Nodes: Refresh Nodes
- Skills: Refresh Skills
- Debug: Refresh Debug
- Instances: Refresh Instances
- Overview: Refresh Overview
- Agents: Refresh Agents
- Logs: Clear Logs, Refresh Logs, Export Logs, Toggle Auto-Follow, Jump to Bottom

### Improvement: Add Domain-Specific Commands

**Chat Commands**:
- [ ] `Send message` - Cmd+Enter
- [ ] `Clear input` - Escape
- [ ] `Focus chat input` - /
- [ ] `Copy last response` - Cmd+Shift+C

**Config Commands**:
- [ ] `Save config` - Cmd+S
- [ ] `Reload config` - Cmd+Shift+R
- [ ] `Search config` - Focus config search
- [ ] `Reset to defaults` - With confirmation
- [ ] `Export config` - Download as JSON
- [ ] `Import config` - Upload JSON

**Logs Commands**:
- [x] `Clear logs` - With confirmation
- [x] `Export logs` - Download as file
- [x] `Toggle auto-follow` - Toggle scroll lock
- [ ] `Filter by level` - Quick filter to error/warn/info
- [x] `Jump to bottom` - Scroll to latest
- [x] `Refresh logs` - Reload logs

**Sessions Commands**:
- [x] `New session` - Already exists
- [ ] `Delete current session` - With confirmation
- [ ] `Duplicate session` - Clone current
- [ ] `Switch session` - Quick session picker
- [x] `Refresh sessions` - Reload sessions list

**Skills Commands**:
- [x] `Refresh skills` - Reload skills list
- [ ] `Install skill` - Open install dialog
- [ ] `Toggle skill` - Enable/disable

**Channels Commands**:
- [ ] `Probe all channels` - Health check
- [ ] `Probe channel...` - Select channel to probe
- [ ] `Configure channel...` - Quick config access

**Debug Commands**:
- [x] `Refresh debug` - Reload debug info
- [ ] `Clear RPC result` - Clear output
- [ ] `Copy RPC result` - Copy to clipboard
- [ ] `Run last RPC` - Re-execute

**System Commands**:
- [x] `Show keyboard shortcuts` - ? key
- [x] `Open documentation` - External link
- [x] `Copy gateway URL` - Copy to clipboard
- [ ] `Report issue` - GitHub link

### Improvement: Search Enhancements

- [x] Fuzzy search (typo-tolerant) — implemented with fuzzy-search.ts
- [x] Command history / recents section — persisted to localStorage
- [ ] Weighted results (frequently used first)
- [x] Category-based filtering (Tab/Shift+Tab to cycle categories)

### ✅ COMPLETED: Visual Enhancements

- [ ] Show command category badges
- ✅ Keyboard shortcut hints for navigation commands (⌘1-4, ⌘,, ⌘R, ⌘N, ⌘T)
- [ ] Add "recently used" section at top
- [ ] Animate selected item indicator

---

## 4. Loading States

**Status**: All views have loading state, but UI is inconsistent

### Current Loading Patterns

| View | Current UI | File:Line |
|------|-----------|-----------|
| Chat | "Loading chat…" text | `views/chat.ts:125` |
| Sessions | "Loading..." button text | `views/sessions.ts:114` |
| Skills | "Loading..." button text | `views/skills.ts:55` |
| Config | Spinner + "Loading schema…" | `views/config.ts:920-922` |
| Logs | Button with spinner class | `views/logs.ts:447-451` |
| Channels | Dot animation on cards | `views/channels.ts:240` |
| Debug | "Refreshing..." button text | `views/debug.ts:411` |
| Nodes | "Loading..." button text | `views/nodes.ts:91` |
| Instances | "Loading…" button text | `views/instances.ts:23` |
| Cron | "Refreshing..." button text | `views/cron.ts:104` |
| Overseer | "Loading..." button + graph | `views/overseer.ts:187,365` |

### Available Helpers (Underused)

```typescript
// From components/design-utils.ts
skeleton({ width, height, rounded, className })  // Line 198
skeletonList(count, itemHeight)                  // Line 217
```

### Improvement: Skeleton Loaders by View

**Chat View**: ✅ COMPLETED
- ✅ Message bubble skeletons while loading
- ✅ 4 stacked bubble shapes
- ✅ Alternate left/right alignment (user/assistant)

**Sessions View**: ✅ COMPLETED
- ✅ Table row skeletons (5 rows)
- ✅ Column-aligned placeholders
- ✅ Staggered animation with `aria-busy`

**Skills View**: ✅ COMPLETED
- ✅ Skill card skeletons (6 cards)
- ✅ Icon + text placeholders
- ✅ Staggered animation with `aria-busy`

**Logs View**: ✅ COMPLETED
- ✅ Log entry skeletons
- ✅ Timestamp + message shapes
- ✅ Level indicator placeholders

**Config View**:
- [ ] Form field skeletons (already good)
- [ ] Section header skeletons
- [ ] Toggle row skeletons

**Nodes View**: ✅ COMPLETED
- ✅ Node card skeletons
- ✅ Device card skeletons
- ✅ Status indicator placeholders

### Improvement: Loading Component

Create unified loading spinner component:
```typescript
type LoadingSpinnerProps = {
  size?: "sm" | "md" | "lg";
  label?: string;
  inline?: boolean;
};
```

### Improvement: Progress Indicators

For long operations:
- [ ] Config apply progress
- [ ] Log export progress
- [ ] Skill installation progress
- [ ] Batch operations progress

---

## 5. Tooltip System

**Status**: CSS exists, no JavaScript component

**CSS Location**: `design-system.css:662-692`

### Current Implementation

Uses `data-tooltip` attribute with CSS `::after` pseudo-element:
```css
.tooltip::after {
  content: attr(data-tooltip);
  /* positioning, animation */
}
```

### Current Native Tooltips

~54 uses of `title=""` attribute across views

### Improvement: Create Tooltip Component

```typescript
type TooltipProps = {
  content: string | TemplateResult;
  position?: "top" | "bottom" | "left" | "right";
  delay?: number;
  children: TemplateResult;
};

function tooltip(props: TooltipProps): TemplateResult;
```

### Improvement: Add Tooltips Throughout

**Icon-only buttons** (need `aria-label` too):
- [ ] Refresh buttons
- [ ] Copy buttons
- [ ] Close buttons
- [ ] Toggle buttons
- [ ] Action buttons in tables

**Truncated content**:
- [ ] Session names
- [ ] Log messages
- [ ] Config values
- [ ] Channel descriptions

**Status indicators**:
- [ ] Connection status dots
- [ ] Skill status badges
- [ ] Channel state indicators

**Form fields**:
- [ ] Help text on hover
- [ ] Validation error details

---

## 6. Animations & Transitions

**Status**: Good foundation, inconsistent application

### Available Animations

From `design-system.css`:
```css
--animate-fade-in: fadeIn 0.2s var(--ease-out);
--animate-fade-in-up: fadeInUp 0.3s var(--ease-out);
--animate-fade-in-down: fadeInDown 0.3s var(--ease-out);
--animate-slide-in-right: slideInRight 0.3s var(--ease-out);
--animate-slide-in-left: slideInLeft 0.3s var(--ease-out);
--animate-scale-in: scaleIn 0.2s var(--ease-out);
--animate-pulse-glow: pulseGlow 2s ease-in-out infinite;
--animate-shimmer: shimmer 2s linear infinite;
```

### Available Helper

```typescript
// From components/design-utils.ts:164
staggerDelay(index: number, baseDelay = 50): string
```

### ✅ COMPLETED: View Transitions

- ✅ Added `view-fade-in` animation when switching tabs (in `layout.css`)
- ✅ Respects `prefers-reduced-motion` media query
- [ ] Use View Transitions API for smooth tab changes (future)
- [ ] Preserve scroll position on tab return

### Improvement: List Item Animations

- [ ] Staggered `fadeInUp` for list items on load
- [ ] Exit animation when items are removed
- [ ] Reorder animation when sorting

### Improvement: Card Animations

- [ ] `fadeIn` on card mount
- [ ] Hover lift with shadow (already exists for `.card-interactive`)
- [ ] Expand/collapse animation for collapsible cards

### Improvement: Feedback Animations

- [ ] Success checkmark animation after save
- [ ] Error shake animation on validation failure
- [ ] Pulse animation for new/updated items
- [ ] Ripple effect on button click (optional)

### Improvement: Loading Animations

- [ ] Skeleton shimmer (exists, apply consistently)
- [ ] Spinner rotation (exists)
- [ ] Progress bar animation (exists in design system)
- [ ] Pulsing dot indicator

### Improvement: Respect Reduced Motion

```typescript
// From components/design-utils.ts:314
prefersReducedMotion(): boolean
```

- [ ] Check this before applying animations
- [ ] Provide instant alternatives

---

## 7. Empty States

**Status**: Contextual action buttons added to all empty states; illustrations and animations still pending

### Current Pattern

Most views use:
```html
<div class="data-table__empty">
  <icon>
  <span class="title">No items found</span>
  <span class="description">Helpful message</span>
</div>
```

### Available Helper

```typescript
// From components/design-utils.ts:175
emptyState({ icon, title, description, action }): TemplateResult
```

### Improvement: Add Illustrations

- [ ] Custom SVG illustrations for each empty state
- [ ] Themed to match dark/light mode
- [ ] Subtle animation (float, pulse)

### Improvement: Contextual Actions

- [x] Refresh / Clear search buttons in Sessions empty state (both list and table views)
- [x] Refresh / Clear filter buttons in Skills empty state
- [x] Refresh button in Instances empty state with descriptive text
- [x] Refresh button in Nodes empty state with CLI hint
- [x] Refresh devices button in Nodes devices empty state
- [x] Refresh / Clear filters buttons in Logs empty state
- [x] Improved description text in Debug models empty state
- [ ] "Configure a channel" button in Channels

### Improvement: Helpful Links

- [ ] Link to documentation in empty states
- [ ] "Learn more" links
- [ ] Quick-start guides

### Improvement: Animation

- [ ] Fade in animation on empty state appearance
- [ ] Subtle float animation on icon

---

## 8. Accessibility

**Status**: Limited implementation (~46 ARIA usages)

### Current ARIA Usage

| Pattern | Count | Files |
|---------|-------|-------|
| `role="log"` | 1 | chat.ts |
| `role="alert"` | 1 | toast.ts |
| `aria-live` | 1 | chat.ts |
| `aria-label` | ~20 | various |
| `aria-hidden` | ~10 | icons |

### Improvement: Command Palette Accessibility

- [ ] Add `role="listbox"` to command list
- [ ] Add `role="option"` to command items
- [ ] Add `aria-activedescendant` for selection
- [ ] Add `aria-expanded` for open state
- [ ] Trap focus within palette when open

### ✅ COMPLETED: Modal/Dialog Accessibility

- ✅ Add `role="dialog"` or `role="alertdialog"`
- ✅ Add `aria-modal="true"`
- ✅ Add `aria-labelledby` pointing to title
- ✅ Implement focus trap (Tab cycles within modal)
- ✅ Return focus on close

### Improvement: Form Accessibility

- [ ] Add `aria-required="true"` for required fields
- [ ] Add `aria-invalid="true"` for validation errors
- [ ] Add `aria-describedby` for error messages
- [ ] Ensure all inputs have labels

### ✅ COMPLETED: Button Accessibility (Chat Controls)

Icon-only buttons in chat controls now have aria-labels:
- ✅ Refresh button: `aria-label="Refresh chat history"`
- ✅ Thinking toggle: `aria-label` with descriptive text
- ✅ Focus mode toggle: `aria-label` with descriptive text

### ✅ COMPLETED: More aria-labels

Sessions view:
- ✅ Copy session key button
- ✅ Open chat button
- ✅ Delete session button

Skills view:
- ✅ Enable/disable skill button
- ✅ Install skill button

Remaining icon-only buttons need:
- ✅ Copy buttons in logs view (`aria-label="Copy log entry to clipboard"`)
- ✅ Close button in confirm dialog
- [ ] Copy buttons in other views (debug, config)
- [ ] Close buttons in other modals/dialogs

### ✅ COMPLETED: Loading State Accessibility

- ✅ Added `aria-busy` to Sessions table body during loading
- ✅ Added `aria-busy` to Skills grid during loading
- [ ] Add `aria-live="polite"` for status updates
- [ ] Announce loading completion to screen readers

### ✅ COMPLETED: Navigation Accessibility

- ✅ Added `aria-current="page"` to active nav tab (in `app-render.helpers.ts`)
- [ ] Add skip link to main content
- [ ] Use semantic landmarks (`<main>`, `<nav>`, `<aside>`)

### Improvement: Data Table Accessibility

- [ ] Add `role="grid"` or use `<table>`
- [ ] Add column headers with `scope="col"`
- [ ] Add row headers where applicable
- [ ] Announce sort state changes

### Improvement: Color Contrast

- [ ] Verify all text meets WCAG AA contrast ratio
- [ ] Test with color blindness simulators
- [ ] Ensure focus indicators are visible

---

## 9. Micro-interactions

**Status**: Good button states, inconsistent elsewhere

### Existing Good Interactions

- Button hover: background change + translateY(-1px)
- Button focus: focus ring
- Card hover: border color change + background change
- Toggle switch: smooth transition
- Input focus: border color + shadow

### Improvement: Copy Button Feedback

Current: Inconsistent (CSS class toggle, sometimes silent)

Suggested pattern:
```typescript
async function copyWithFeedback(text: string, label: string) {
  await navigator.clipboard.writeText(text);
  toast.success(`${label} copied to clipboard`);
  // Optional: swap icon to checkmark briefly
}
```

### Improvement: Save Button States

- [ ] Idle: "Save"
- [ ] Saving: Spinner + "Saving..."
- [ ] Success: Checkmark + "Saved!" (2s) → back to "Save"
- [ ] Error: "Failed" + toast with details

### Improvement: Form Validation Feedback

- [ ] Red border on invalid fields
- [ ] Shake animation on submit with errors
- [ ] Inline error messages with fade-in
- [ ] Success checkmark on valid fields (optional)

### Improvement: Selection Feedback

- [ ] More prominent selected state in lists
- [ ] Checkbox/radio animations
- [ ] Multi-select visual feedback

### Improvement: Drag Feedback

- [ ] Cursor change on draggable elements
- [ ] Shadow/lift effect while dragging
- [ ] Drop zone highlighting

### Improvement: Hover Revelations

- [ ] Show action buttons on row hover
- [ ] Reveal secondary info on hover
- [ ] Expand truncated text on hover

---

## 10. Error Handling UX

**Status**: Implemented but inconsistent patterns

### Current Error Display

- `.callout.danger` - Red bordered callout
- `.callout--danger` - Alternative class
- Direct text in some places
- No toast usage for errors

### Improvement: Error Categories

**Transient errors** (use toast):
- [ ] Network timeout
- [ ] Rate limiting
- [ ] Clipboard failure

**Persistent errors** (use inline callout):
- [ ] Configuration validation
- [ ] Missing credentials
- [ ] Invalid input

**Critical errors** (use modal):
- [ ] Authentication failure
- [ ] Server unavailable
- [ ] Data corruption

### Improvement: Error Recovery

- [ ] Add "Retry" button for failed operations
- [ ] Add "Learn more" link to error docs
- [ ] Provide suggested fixes

### Improvement: Error Details

- [ ] Collapsible technical details
- [ ] Copy error details button
- [ ] Error codes for support

---

## 11. Search & Filtering

**Status**: Basic implementations in logs, skills, config

### Current Search Features

| View | Feature | Location |
|------|---------|----------|
| Logs | Filter text | `views/logs.ts` |
| Skills | Filter by name | `views/skills.ts` |
| Config | Section search | `views/config.ts` |
| Command Palette | Command search | `components/command-palette.ts` |

### Improvement: Search Highlighting

- [ ] Highlight matched text in results
- [ ] Use `<mark>` element with styling
- [ ] Show match count

### Improvement: Advanced Filters

**Logs**:
- [ ] Filter by level (error, warn, info, debug)
- [ ] Filter by time range
- [ ] Filter by source/category
- [ ] Regex support

**Sessions**:
- [ ] Filter by agent
- [ ] Filter by date
- [ ] Filter by kind

**Skills**:
- [ ] Filter by source (core, custom)
- [ ] Filter by status (enabled, disabled)
- [ ] Filter by requirements

### ✅ COMPLETED: Search UX

- ✅ Clear button in Skills search input (with aria-label)
- ✅ Clear button in Logs search input
- ✅ Clear button in Config search input
- ✅ Clear button in Diagnostics filter dialog
- ✅ CSS for `.field__clear` button added
- [ ] Search debouncing
- [ ] Empty search results state
- [ ] Recent searches (optional)

---

## 12. Keyboard Navigation

**Status**: Command palette (Cmd+K), limited elsewhere

### Current Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd/Ctrl+K | Open command palette |
| Escape | Close command palette |
| Arrow keys | Navigate command palette |
| Enter | Select command |

### Improvement: Global Shortcuts

| Shortcut | Action |
|----------|--------|
| `?` | Show keyboard shortcuts help |
| `Cmd+S` | Save (in config) |
| `Cmd+Enter` | Send (in chat) |
| `Cmd+/` | Toggle sidebar (if applicable) |
| `Cmd+1-9` | Switch to tab by number |
| `Escape` | Close modal/palette/cancel |

### Improvement: View-Specific Shortcuts

**Chat**:
- [ ] `Cmd+Enter` - Send message
- [ ] `Escape` - Clear input
- [ ] `Cmd+Shift+C` - Copy last response

**Logs**:
- [ ] `Cmd+F` - Focus filter
- [ ] `G` then `B` - Go to bottom
- [ ] `G` then `T` - Go to top

**Config**:
- [ ] `Cmd+S` - Save
- [ ] `Cmd+Z` - Undo (if implemented)
- [ ] `/` - Focus search

### Improvement: Keyboard Shortcuts Help Modal

- [ ] Triggered by `?` key
- [ ] Shows all available shortcuts
- [ ] Grouped by category
- [ ] Searchable

### Improvement: Focus Management

- [ ] Visible focus indicators everywhere
- [ ] Logical tab order
- [ ] Focus restoration after modal close
- [ ] Skip links for main content

---

## 13. Visual Consistency

**Status**: Excellent design system, minor inconsistencies

### Design System Strengths

- Comprehensive color tokens (dark/light)
- Typography scale with 3 font families
- Spacing scale
- Border radius tokens
- Shadow tokens
- Component base styles

### Improvement: Icon Consistency

- [ ] Ensure all icons use 2px stroke width
- [ ] Consistent icon sizes (16px default, 20px for emphasis)
- [ ] Use icon component consistently

### Improvement: Spacing Consistency

- [ ] Audit spacing usage against design tokens
- [ ] Replace magic numbers with tokens
- [ ] Consistent padding in cards/sections

### Improvement: Typography Consistency

- [ ] Limit to defined scale sizes
- [ ] Consistent heading hierarchy
- [ ] Consistent label styling

### Improvement: Color Usage

- [ ] Audit for hardcoded colors
- [ ] Replace with CSS variables
- [ ] Test both themes thoroughly

---

## 14. Component Gaps

**Status**: Some components have CSS but no JS implementation

### Missing Components

**Confirm Dialog**: ✅ COMPLETED
- CSS exists: `design-system.css:811-864`
- ✅ JS component: `components/confirm-dialog.ts` with promise-based API

**Tooltip**:
- CSS exists: `design-system.css:662-692`
- JS needed: Component for rich tooltips

**Progress Bar**:
- CSS exists: `design-system.css:694-707`
- Not used anywhere

**Avatar**:
- CSS exists: `design-system.css:709-731`
- Not used anywhere

**Dropdown Menu**:
- CSS exists: `design-system.css:605-660`
- Partial usage

### Improvement: Component Documentation

- [ ] Document available components
- [ ] Show usage examples
- [ ] List props/variants

---

## Implementation Priority Matrix

### Quick Wins (Do First)

| Item | Impact | Effort | Category | Status |
|------|--------|--------|----------|--------|
| Wire up toast for copy ops | High | Low | Toast | ✅ Done |
| Add aria-labels to icon buttons | High | Low | Accessibility | ✅ Done (Sessions/Skills) |
| Use skeleton loaders | Medium | Low | Loading | ✅ Done (Sessions/Skills) |
| Add view fade-in animation | Medium | Low | Animation | ✅ Done |
| WebSocket connection toasts | Medium | Low | Toast | ✅ Done |
| aria-current on active nav | Medium | Low | Accessibility | ✅ Done |
| Toast for save operations | Medium | Low | Toast | ✅ Done |
| Toast for session deletion | Medium | Low | Toast | ✅ Done |
| Toast for log export | Medium | Low | Toast | ✅ Done |
| Clear button in search inputs | Medium | Low | UX | ✅ Done (Skills) |
| aria-busy for loading states | Medium | Low | Accessibility | ✅ Done |
| Keyboard shortcut hints | Medium | Low | Command Palette | ✅ Done |
| ConfirmDialog component | High | Medium | Components | ✅ Done |

### Medium Priority

| Item | Impact | Effort | Category | Status |
|------|--------|--------|----------|--------|
| Wire ConfirmDialog to usages | High | Low | Components | ✅ Done |
| Expand command palette | High | Medium | Command Palette | |
| Add global keyboard shortcuts | Medium | Medium | Navigation | |
| Skeleton for Logs view | Medium | Low | Loading | ✅ Done |
| Skeleton for Nodes view | Medium | Low | Loading | ✅ Done |
| Clear button in search inputs | Medium | Low | UX | ✅ Done |
| Focus trap for modals | Medium | Medium | Accessibility | ✅ Done |
| Toast for channel/skill ops | Medium | Low | Toast | ✅ Done |
| aria-label for copy buttons | Medium | Low | Accessibility | ✅ Done |

### Lower Priority

| Item | Impact | Effort | Category |
|------|--------|--------|----------|
| Tooltip component | Medium | Medium | Components |
| Advanced log filtering | Medium | Medium | Search |
| Empty state illustrations | Low | Medium | Empty States |
| Keyboard shortcuts help modal | Medium | Medium | Navigation |

---

## File Reference

| File | Purpose | Key Changes Needed |
|------|---------|-------------------|
| `components/toast.ts` | Toast system | Wire up to operations |
| `components/command-palette.ts` | Command launcher | Add more commands |
| `components/design-utils.ts` | UI helpers | Use skeleton helpers |
| `styles/design-system.css` | Design tokens | Reference only |
| `controllers/*.ts` | Business logic | Add toasts, replace confirm |
| `views/*.ts` | View rendering | Add skeletons, ARIA, toasts |
| `app.ts` | Main app | Add keyboard shortcuts |
| `app-render.ts` | Render logic | View transitions |

---

## Notes

- The design system is comprehensive and well-designed
- Most improvements are about **using existing features**, not building new ones
- Toast system is the biggest quick win - fully implemented, zero usage
- Accessibility improvements are important for compliance and UX
- Animation foundation is solid, just needs consistent application
