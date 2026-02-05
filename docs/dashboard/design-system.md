# OpenClaw Design System

## Overview

A developer-focused, terminal-native design system for the OpenClaw AI command center. Prioritizes information density, readability, and functional aesthetics.

---

## Colors

### Core Palette

```css
:root {
  /* Backgrounds */
  --bg-primary: #0d1117;      /* Main background */
  --bg-secondary: #161b22;    /* Panels, sidebar */
  --bg-tertiary: #21262d;     /* Hover states, elevated */
  --bg-card: #1c2128;         /* Cards, containers */

  /* Borders */
  --border: #30363d;          /* Standard borders */
  --border-muted: #21262d;    /* Subtle borders */

  /* Text */
  --text-primary: #c9d1d9;    /* Primary text */
  --text-secondary: #8b949e;  /* Secondary text, labels */
  --text-muted: #484f58;      /* Disabled, hints */

  /* Accent Colors */
  --accent: #58a6ff;          /* Links, primary actions */
  --accent-hover: #4c9aed;    /* Hover state */

  /* Status Colors */
  --success: #3fb950;         /* Active, complete, additions */
  --warning: #d29922;         /* Pending, caution */
  --error: #f85149;           /* Error, deletions */
  --purple: #a371f7;          /* Review, special states */
}
```

### Usage Guidelines

| Context | Color | Example |
|---------|-------|---------|
| Page background | `--bg-primary` | Main content area |
| Sidebar/panels | `--bg-secondary` | Left/right panels |
| Hover states | `--bg-tertiary` | List item hover |
| Cards | `--bg-card` | Content cards |
| Primary text | `--text-primary` | Headings, body |
| Secondary text | `--text-secondary` | Labels, metadata |
| Muted text | `--text-muted` | Timestamps, hints |
| Links/actions | `--accent` | Buttons, links |
| Running/active | `--success` | Worker status dots |
| Pending/queued | `--warning` | Queue indicators |
| Errors/deletions | `--error` | Error states, -lines |
| Review states | `--purple` | Review badges |

---

## Typography

### Font Stack

```css
font-family: 'JetBrains Mono', monospace;
```

**Why JetBrains Mono:**
- Designed for code, excellent for developer tools
- Clear distinction between similar characters (0/O, 1/l/I)
- Good readability at small sizes
- Ligature support (optional)

### Type Scale

| Name | Size | Weight | Use |
|------|------|--------|-----|
| `heading-lg` | 16px | 600 | Page titles |
| `heading-md` | 14px | 600 | Section headers |
| `heading-sm` | 13px | 600 | Card titles |
| `body` | 14px | 400 | Main content |
| `body-sm` | 13px | 400 | Secondary content |
| `caption` | 12px | 400 | Metadata, labels |
| `micro` | 11px | 400 | Timestamps, badges |
| `section-label` | 11px | 600 | Section headers (uppercase) |

### Section Labels

```css
.section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
```

---

## Spacing

### Base Unit: 4px

| Token | Value | Use |
|-------|-------|-----|
| `space-1` | 4px | Tight gaps |
| `space-2` | 8px | Icon gaps, small padding |
| `space-3` | 12px | Standard padding |
| `space-4` | 16px | Section padding |
| `space-5` | 20px | Large padding |
| `space-6` | 24px | Content spacing |
| `space-8` | 32px | Section gaps |

### Common Patterns

```css
/* Sidebar item */
padding: 8px 12px;

/* Card */
padding: 16px;

/* Panel section */
padding: 16px;
border-bottom: 1px solid var(--border);

/* Message spacing */
margin-bottom: 24px;
```

---

## Layout

### Three-Column Layout

Standard layout for most views:

```
┌─────────────────────────────────────────────────┐
│ Header (48px)                                   │
├──────────┬────────────────────────┬─────────────┤
│ Sidebar  │     Main Content       │   Context   │
│ (240px)  │        (flex)          │   (300px)   │
│          │                        │             │
└──────────┴────────────────────────┴─────────────┘
```

```css
.main {
  display: grid;
  grid-template-columns: 240px 1fr 300px;
  overflow: hidden;
}
```

### Header

- Height: 48px
- Background: `--bg-secondary`
- Border: 1px solid `--border` on bottom

### Sidebar

- Width: 240px (collapsible to 60px for icons)
- Background: `--bg-secondary`
- Border: 1px solid `--border` on right

### Context Panel (Right)

- Width: 300-320px
- Background: `--bg-secondary`
- Border: 1px solid `--border` on left

---

## Components

### Buttons

**Primary Button**
```css
.btn-primary {
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.btn-primary:hover {
  background: var(--accent-hover);
}
```

**Secondary Button**
```css
.btn-secondary {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
}

.btn-secondary:hover {
  background: var(--border);
}
```

### Cards

```css
.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}

.card:hover {
  border-color: var(--accent);
}
```

### Sidebar Items

```css
.sidebar-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  border-left: 2px solid transparent;
}

.sidebar-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.sidebar-item.active {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border-left-color: var(--accent);
}
```

### Badges

```css
.badge {
  padding: 2px 8px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
}

.badge-success {
  background: rgba(63, 185, 80, 0.2);
  color: var(--success);
}

.badge-warning {
  background: rgba(210, 153, 34, 0.2);
  color: var(--warning);
}

.badge-error {
  background: rgba(248, 81, 73, 0.2);
  color: var(--error);
}

.badge-purple {
  background: rgba(163, 113, 247, 0.2);
  color: var(--purple);
}

.badge-muted {
  background: var(--bg-tertiary);
  color: var(--text-muted);
}
```

### Status Dots

```css
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-dot.active {
  background: var(--success);
  box-shadow: 0 0 8px var(--success);
}

.status-dot.pending {
  background: var(--warning);
}

.status-dot.idle {
  background: var(--text-muted);
}
```

### Progress Bars

```css
.progress-bar {
  height: 4px;
  background: var(--bg-tertiary);
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
}
```

### Input Fields

```css
.input {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  color: var(--text-primary);
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  outline: none;
}

.input:focus {
  border-color: var(--accent);
}

.input::placeholder {
  color: var(--text-muted);
}
```

### Avatars

```css
.avatar {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: white;
}

.avatar-user {
  background: var(--purple);
}

.avatar-lead {
  background: linear-gradient(135deg, var(--accent), var(--purple));
}

.avatar-worker {
  background: var(--success);
}

.avatar-idle {
  background: var(--text-muted);
}
```

---

## Patterns

### Header with Tabs

```html
<header class="header">
  <div class="logo">OpenClaw</div>
  <div class="project-selector">myapp ▼</div>
  <nav class="header-tabs">
    <div class="header-tab active">Chat</div>
    <div class="header-tab">Board</div>
    <div class="header-tab">Git</div>
  </nav>
  <div class="header-spacer"></div>
  <div class="header-stats">...</div>
</header>
```

### Sidebar Section

```html
<div class="sidebar-section">
  <div class="section-header">
    Section Title
    <span class="section-count">3</span>
  </div>
  <div class="sidebar-item active">
    <span class="item-icon">◐</span>
    <span class="item-label">Item name</span>
    <span class="badge badge-success">3</span>
  </div>
</div>
```

### Message with Card

```html
<div class="message">
  <div class="message-header">
    <div class="avatar avatar-lead">L</div>
    <span class="message-sender">Lead Agent</span>
    <span class="message-time">2:31 PM</span>
  </div>
  <div class="message-content">
    <p>Message text here...</p>
    <div class="card">
      <!-- Embedded content -->
    </div>
  </div>
</div>
```

### Context Panel Section

```html
<div class="context-section">
  <div class="section-header">Section Title</div>
  <div class="context-row">
    <span class="context-label">Label</span>
    <span class="context-value">Value</span>
  </div>
</div>
```

---

## Icons

Use simple Unicode symbols for consistency:

| Icon | Symbol | Use |
|------|--------|-----|
| Active track | ◐ | In-progress state |
| Pending track | ○ | Not started |
| Complete track | ✓ | Done state |
| Branch | ⎇ | Git branches |
| Tag | 🏷 | Git tags |
| Lightning | ⚡ | Active/quick actions |
| Folder | 📁 | Files/projects |

For more complex icons, use a minimal icon set like Lucide or Heroicons (outline style).

---

## Responsive Behavior

### Breakpoints

| Name | Width | Behavior |
|------|-------|----------|
| Desktop | > 1200px | Full three-column layout |
| Tablet | 768-1200px | Collapsible right panel |
| Mobile | < 768px | Single column, bottom nav |

### Sidebar Collapse

At narrower widths, sidebar collapses to 60px showing only icons.

---

## Animation

### Transitions

```css
/* Default transition */
transition: all 0.15s ease;

/* Background/border color changes */
transition: background 0.15s ease, border-color 0.15s ease;
```

### Status Pulse

```css
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.status-dot.active {
  animation: pulse 2s ease-in-out infinite;
}
```

Keep animations subtle and functional - no gratuitous motion.

---

## File Structure (React)

```
src/
├── styles/
│   ├── variables.css    # CSS custom properties
│   ├── reset.css        # CSS reset
│   └── global.css       # Global styles
├── components/
│   ├── ui/
│   │   ├── Button.tsx
│   │   ├── Card.tsx
│   │   ├── Badge.tsx
│   │   ├── Avatar.tsx
│   │   ├── Input.tsx
│   │   ├── Progress.tsx
│   │   └── StatusDot.tsx
│   ├── layout/
│   │   ├── Header.tsx
│   │   ├── Sidebar.tsx
│   │   ├── ContextPanel.tsx
│   │   └── ThreeColumnLayout.tsx
│   └── features/
│       ├── chat/
│       ├── git/
│       ├── board/
│       └── workers/
└── views/
    ├── ChatView.tsx
    ├── GitView.tsx
    ├── BoardView.tsx
    └── ...
```
