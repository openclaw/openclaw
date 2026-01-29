# Clawd IDE v2.0 - Product Requirements Document

**Version:** 2.0  
**Author:** Clawd 🐾 with Ivan  
**Date:** January 27, 2026  
**Status:** Living Document  
**Classification:** Internal / Confidential

---

```
   ██████╗██╗      █████╗ ██╗    ██╗██████╗     ██╗██████╗ ███████╗
  ██╔════╝██║     ██╔══██╗██║    ██║██╔══██╗    ██║██╔══██╗██╔════╝
  ██║     ██║     ███████║██║ █╗ ██║██║  ██║    ██║██║  ██║█████╗  
  ██║     ██║     ██╔══██║██║███╗██║██║  ██║    ██║██║  ██║██╔══╝  
  ╚██████╗███████╗██║  ██║╚███╔███╔╝██████╔╝    ██║██████╔╝███████╗
   ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═════╝     ╚═╝╚═════╝ ╚══════╝
                                                            v2.0
          "The IDE that codes with you, not just for you."
```

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Vision & Philosophy](#2-vision--philosophy)
3. [Competitive Analysis Deep Dive](#3-competitive-analysis-deep-dive)
4. [User Personas & Jobs to Be Done](#4-user-personas--jobs-to-be-done)
5. [Feature Specification by Phase](#5-feature-specification-by-phase)
   - [Phase 1: Core Editor Excellence](#phase-1-core-editor-excellence)
   - [Phase 2: AI-Native Features](#phase-2-ai-native-features)
   - [Phase 3: Embedded Web Browser](#phase-3-embedded-web-browser)
   - [Phase 4: Advanced AI & Agent Mode](#phase-4-advanced-ai--agent-mode)
   - [Phase 5: Developer Tools](#phase-5-developer-tools)
   - [Phase 6: Polish & Experience](#phase-6-polish--experience)
   - [Phase 7: Differentiators & Innovation](#phase-7-differentiators--innovation)
6. [Technical Architecture](#6-technical-architecture)
7. [UI/UX Design System](#7-uiux-design-system)
8. [Implementation Timeline](#8-implementation-timeline)
9. [Success Metrics & KPIs](#9-success-metrics--kpis)
10. [Risks & Mitigations](#10-risks--mitigations)
11. [Appendices](#11-appendices)

---

# 1. Executive Summary

## 1.1 The Vision

Clawd IDE is not just another code editor—it's a **work of art** designed to fundamentally transform how developers create software. In an era where AI is becoming integral to development, most IDEs treat AI as an afterthought—a plugin, an extension, a bolt-on feature. Clawd IDE is different.

**Clawd IDE is AI-native from its core.**

Every pixel, every interaction, every feature has been designed with a singular question in mind: *"How can AI and human collaborate here?"*

### The Three Pillars

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│   ╔═══════════════╗   ╔═══════════════╗   ╔═══════════════╗       │
│   ║   BEAUTIFUL   ║   ║   INTELLIGENT ║   ║   PERSONAL    ║       │
│   ║               ║   ║               ║   ║               ║       │
│   ║  Typography   ║   ║  AI-Native    ║   ║  DNA     ║       │
│   ║  Animations   ║   ║  Thoughtful   ║   ║  Memory       ║       │
│   ║  Micro-details║   ║  Context-Aware║   ║  Personality  ║       │
│   ╚═══════════════╝   ╚═══════════════╝   ╚═══════════════╝       │
│                                                                    │
│              "Code is poetry. The editor should be too."           │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## 1.2 Why Now?

The development tools landscape in 2025 is at an inflection point:

- **AI coding assistants** are becoming mainstream but feel disconnected from the IDE
- **Context windows** have expanded dramatically (1M+ tokens), enabling true codebase understanding
- **Agent capabilities** are maturing, allowing AI to take autonomous action
- **Developer expectations** have shifted—they want AI that truly understands their project

Yet the major players are stuck:

| Editor | Problem |
|--------|---------|
| **VS Code** | Bloated, extension hell, AI bolted on |
| **Cursor** | Great AI, but generic—no personalization |
| **Windsurf** | Good UX, but lacks depth |
| **Zed** | Fast but feature-sparse, AI coming slowly |

**Clawd IDE's unique advantage:** Direct integration with **DNA**, a self-hosted AI assistant with:
- Persistent memory across sessions
- Knowledge of your projects, preferences, and patterns
- Personality and voice (not a generic assistant)
- Tool use capabilities (browser, file system, shell, APIs)

No competitor can match this level of personalization. This is our moat.

## 1.3 Product Principles

### Think Before Doing
Unlike assistants that generate code immediately, Clawd thinks first. It analyzes the request, considers the codebase context, proposes a plan, and only then acts. This matches how senior engineers work.

### Code WITH You, Not FOR You
Clawd IDE is not about replacing developers—it's about amplifying them. Every suggestion is a collaboration. You're always in control.

### Keyboard-First, Mouse-Welcome
Power users live on the keyboard. Every feature is accessible via keyboard shortcuts with discoverable, consistent patterns. Mouse users are never punished—everything is equally accessible.

### Progressive Disclosure
The interface starts simple and reveals complexity as needed. A beginner sees a clean editor. A power user unlocks agent mode, multi-file refactoring, and voice commands.

### Honest Defaults
Default settings are chosen for real-world use, not demos. Sensible line lengths, readable font sizes, non-distracting colors. Everything should feel "right" without configuration.

---

# 2. Vision & Philosophy

## 2.1 The Art Piece Manifesto

> *"A great IDE is like a great instrument. It should disappear in your hands, letting you focus on the music you're making—the code. But when you look closely, every detail should delight you."*

### What "Art Piece" Means

**Typography that Breathes**
- Carefully chosen font stack: JetBrains Mono for code, Inter for UI
- Perfect line height (1.6) for readability
- Optical kerning for variable-width UI text
- Font weight variations that guide the eye

**Animation with Purpose**
- Every animation serves a function: confirming action, showing state, guiding attention
- Spring-based physics for natural feel (not linear easing)
- Animations respect `prefers-reduced-motion`
- Loading states are informative, not just spinners

**Color Theory in Practice**
- Primary accent (Clawd Green `#4ade80`) used sparingly for emphasis
- Semantic colors: red for errors, yellow for warnings, blue for info
- Sufficient contrast (WCAG AA minimum)
- Dark theme default with smooth light theme transition

**Micro-Interactions**
- Button press states that feel tactile
- Hover previews that anticipate needs
- Toast notifications that don't interrupt
- Progress bars that tell the truth

**Sound Design (Optional)**
- Subtle audio cues for completions, errors, AI responses
- Never intrusive, always configurable
- Satisfying "click" for successful actions
- Gentle alerts that don't startle

### The Details That Matter

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  ✦ Tabs have a subtle glow when modified                          │
│  ✦ The cursor blinks with a custom easing curve                   │
│  ✦ File icons have micro-shadows that respond to theme            │
│  ✦ Error squiggles pulse gently to draw attention                 │
│  ✦ The sidebar resizes with a satisfying "snap" to standard widths│
│  ✦ Code folding has a smooth collapse animation                    │
│  ✦ The AI thinking indicator is a calming, organic animation      │
│  ✦ Scrollbars fade when not in use                                │
│  ✦ Selection highlighting has a subtle gradient                   │
│  ✦ The command palette opens with a subtle scale animation        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## 2.2 Design Philosophy

### Brutalist Simplicity with Hidden Depth

The surface is clean, almost minimal. But depth reveals itself:
- Right-click exposes context menus with power features
- Modifier keys unlock alternate actions
- Edge cases are handled gracefully

### Information Density Without Overwhelm

Developers need information. Good design shows what's needed, hides what's not:
- Status bar: essential info, expandable for details
- Sidebar: collapsible sections, smart defaults
- Editor: code is hero, everything else supports it

### Consistent Mental Models

Once you learn one pattern, you know them all:
- `Cmd+P` always opens "Quick Open" (files, commands, symbols)
- `Cmd+Shift+*` variants go to "global" version of command
- `Cmd+K` prefix means "AI action"
- Escape always dismisses/cancels

---

# 3. Competitive Analysis Deep Dive

## 3.1 VS Code (Microsoft)

**Market Position:** Dominant incumbent (~70% market share)

### Strengths
- Massive extension ecosystem (40,000+ extensions)
- Language server protocol (LSP) standardization
- Free and open source (mostly)
- Remote development capabilities
- Familiar to most developers

### Weaknesses
| Issue | Impact | Our Opportunity |
|-------|--------|-----------------|
| Extension bloat | Memory usage 2-4GB common | Lightweight, integrated features |
| AI feels bolted on | Copilot is a separate product | AI-native from core |
| Configuration complexity | settings.json is intimidating | Visual settings, smart defaults |
| Startup time | 3-8 seconds typical | Sub-second cold start |
| Update fatigue | Monthly updates, extension conflicts | Stable, curated experience |
| Generic experience | Same for everyone | Personalized via DNA |

### Copilot Limitations (2025)
- Context limited to current file + few related files
- No persistent memory of your coding patterns
- Cannot take autonomous action (read/write other files)
- Generic suggestions—doesn't know your project conventions
- Subscription required ($10/month individual, $19/month business)

**Our Wedge:** Personal AI that knows your codebase deeply.

## 3.2 Cursor

**Market Position:** AI-native challenger (~5% among AI-focused developers)

### Strengths
- Built AI-first on VS Code foundation
- Excellent `Cmd+K` inline editing UX
- Composer for multi-file generation
- `@` mentions for context control
- Clean, modern UI aesthetic

### Weaknesses
| Issue | Impact | Our Opportunity |
|-------|--------|-----------------|
| Subscription model | $20/month for full features | Self-hosted, unlimited |
| No memory persistence | Context resets each session | DNA memory |
| Agent doesn't verify | Changes aren't tested | Agent with verification |
| Long session context loss | Gets confused after hours | Robust context management |
| Generic AI personality | No personalization | DNA personality |
| No browser integration | Must switch apps for preview | Embedded browser |

### Cursor's UX Patterns to Adopt
- **Ghost text completion** - Tab to accept, word-by-word with Cmd+→
- **Inline edit popup** - Floating prompt near cursor/selection
- **Diff preview** - Green/red diff before accepting changes
- **@ mentions** - `@file`, `@folder`, `@codebase` for context

### Cursor's UX Patterns to Improve
- **Agent mode feedback** - More detailed progress, pause/resume
- **Context visualization** - Show exactly what AI sees
- **Verification step** - Test/lint after agent changes
- **Rollback UX** - One-click undo of AI session changes

## 3.3 Windsurf (Codeium)

**Market Position:** Free alternative to Cursor

### Strengths
- Free tier is generous
- "Cascade" for autonomous workflows
- "Supercomplete" context-aware suggestions
- Clean, minimal UI
- Fast performance

### Weaknesses
| Issue | Impact | Our Opportunity |
|-------|--------|-----------------|
| Less mature than Cursor | Feature gaps | Polish from day one |
| Codeium's AI quality | Sometimes weaker than Claude/GPT | Claude Opus backend |
| Limited customization | One-size-fits-all | Deep personalization |
| No self-hosting | Cloud dependency | Fully local option |

## 3.4 Zed

**Market Position:** Performance-focused, collaboration-first

### Strengths
- Blazing fast (Rust-based, GPU-rendered)
- Real-time collaboration built-in
- Beautiful default typography
- Native Apple Silicon performance
- Low memory footprint

### Weaknesses
| Issue | Impact | Our Opportunity |
|-------|--------|-----------------|
| Limited extension ecosystem | Missing language support | Integrated essentials |
| AI features still early | Not competitive yet | AI leadership |
| Smaller community | Less documentation | Strong docs, tutorials |
| Mac/Linux only (2025) | No Windows | Browser-based = universal |

## 3.5 Competitive Matrix

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          COMPETITIVE POSITIONING                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│                    AI Capability                                              │
│                         ▲                                                     │
│                         │                                                     │
│                         │         ★ Clawd IDE v2.0                           │
│                         │           (Target Position)                         │
│                         │                                                     │
│                         │    ● Cursor                                        │
│                         │         ● Windsurf                                 │
│                         │                                                     │
│                         │                           ● Zed                    │
│                         │  ● VS Code + Copilot                               │
│                         │                                                     │
│                         │                                                     │
│         ────────────────┼────────────────────────► Performance               │
│                         │                                                     │
│          Bloated        │                        Lightweight                  │
│                                                                               │
│  Legend:                                                                      │
│  ★ = Our target position                                                     │
│  ● = Current competitors                                                      │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 3.6 Our Unfair Advantages

### 1. DNA Integration
No competitor has access to a personal AI assistant with:
- **Long-term memory** - Remembers your preferences, past conversations, project context
- **Personality** - Not a generic assistant, but a character you've built rapport with
- **Tool access** - Can browse the web, run commands, interact with APIs
- **Multi-session context** - Picks up where you left off

### 2. Self-Hosted Control
- No subscription fees for AI usage
- Data never leaves your machine (privacy)
- Unlimited usage with your own API keys
- Customizable to your exact needs

### 3. Browser-Based Architecture
- Runs anywhere (Mac, Windows, Linux, even iPad)
- Easy remote development (just port forward)
- Lower barrier to entry (no install)
- Instant updates (refresh = latest version)

### 4. Embedded Browser
**No competitor offers this.** Live preview, DevTools, network inspection, all integrated.

---

# 4. User Personas & Jobs to Be Done

## 4.1 Primary Persona: Ivan (Power User / Owner)

```
┌─────────────────────────────────────────────────────────────────────┐
│ PERSONA: Ivan                                                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  👤 Demographics                                                    │
│  ─────────────────                                                  │
│  • Full-stack developer, 15+ years experience                      │
│  • Business owner / entrepreneur                                    │
│  • macOS user, keyboard-centric workflow                           │
│  • Uses multiple monitors                                           │
│                                                                     │
│  🎯 Goals                                                           │
│  ─────────────────                                                  │
│  • Ship features faster than competitors                           │
│  • Maintain high code quality without slowing down                 │
│  • Minimize context switching between tools                         │
│  • Learn new patterns and technologies efficiently                  │
│                                                                     │
│  😤 Pain Points                                                     │
│  ─────────────────                                                  │
│  • Jumping between IDE, browser, terminal, AI chat                 │
│  • AI assistants that don't know his codebase                      │
│  • Repetitive refactoring tasks                                     │
│  • Losing context when switching projects                          │
│                                                                     │
│  💬 Quotes                                                          │
│  ─────────────────                                                  │
│  "I want the IDE to feel like an extension of my brain."           │
│  "Why can't I just preview the webpage right here?"                │
│  "The AI should know I always use async/await, not .then()"       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Jobs to Be Done

| Job | Current Solution | Desired Solution |
|-----|------------------|------------------|
| Write new feature quickly | Manual coding + Copilot | AI generates scaffold, I refine |
| Understand unfamiliar code | Read + Google + ChatGPT | `Cmd+K`: "Explain this function" |
| Debug styling issue | Switch to browser + DevTools | Embedded browser with live edit |
| Refactor across files | Manual find/replace | Agent mode: "Rename this pattern everywhere" |
| Remember project context | Notes in Notion | DNA remembers, IDE surfaces |

## 4.2 Secondary Persona: Developer Contributor

```
┌─────────────────────────────────────────────────────────────────────┐
│ PERSONA: Alex (Contributor)                                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  👤 Demographics                                                    │
│  ─────────────────                                                  │
│  • Mid-level developer, 3-5 years experience                       │
│  • Works on Ivan's projects occasionally                           │
│  • Comfortable with VS Code                                        │
│  • Values good documentation                                        │
│                                                                     │
│  🎯 Goals                                                           │
│  ─────────────────                                                  │
│  • Quickly understand new codebase                                 │
│  • Make changes without breaking things                            │
│  • Learn from AI suggestions                                        │
│  • Not feel lost in an unfamiliar tool                             │
│                                                                     │
│  😤 Pain Points                                                     │
│  ─────────────────                                                  │
│  • Onboarding to new projects is slow                              │
│  • Unsure about project conventions                                 │
│  • AI suggestions don't match project style                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## 4.3 Tertiary Persona: Learner

```
┌─────────────────────────────────────────────────────────────────────┐
│ PERSONA: Jordan (Learner)                                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  👤 Demographics                                                    │
│  ─────────────────                                                  │
│  • Learning to code, 0-2 years experience                          │
│  • Watching tutorials, following along                             │
│  • Not opinionated about tools yet                                  │
│  • Needs more guidance than experienced devs                        │
│                                                                     │
│  🎯 Goals                                                           │
│  ─────────────────                                                  │
│  • Write working code                                              │
│  • Understand what the code does                                    │
│  • Not get stuck on tooling issues                                  │
│  • Feel productive, not frustrated                                  │
│                                                                     │
│  😤 Pain Points                                                     │
│  ─────────────────                                                  │
│  • Error messages are cryptic                                       │
│  • Don't know what features exist                                   │
│  • AI suggestions assume too much knowledge                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

# 5. Feature Specification by Phase

---

## Phase 1: Core Editor Excellence

**Status:** ✅ ~90% Complete  
**Goal:** Match VS Code's core editing experience

### 1.1 Split Panes & Layouts

**Priority:** P0 | **Status:** ✅ Implemented

#### Specification
- Split editor horizontally (`Cmd+\`) or vertically (`Cmd+Shift+\`)
- Drag tabs between panes
- Resize panes with drag handles (min width: 200px)
- Close pane when last tab closes
- Maximum 4 panes (2x2 grid)
- Persist layout across sessions

#### Layout Presets
```
Single        │    Side-by-Side    │    Three Column    │    2x2 Grid
              │                    │                    │
┌──────────┐  │  ┌─────┬─────┐    │  ┌───┬───┬───┐    │  ┌─────┬─────┐
│          │  │  │     │     │    │  │   │   │   │    │  │     │     │
│          │  │  │     │     │    │  │   │   │   │    │  ├─────┼─────┤
│          │  │  │     │     │    │  │   │   │   │    │  │     │     │
└──────────┘  │  └─────┴─────┘    │  └───┴───┴───┘    │  └─────┴─────┘
```

### 1.2 Enhanced Tab System

**Priority:** P0 | **Status:** ✅ Implemented

#### Features
- [x] Drag to reorder tabs
- [x] Drag tabs between panes
- [x] Modified indicator (●) for unsaved changes
- [x] Close button on hover
- [x] Middle-click to close
- [ ] Tab preview on hover (deferred)
- [ ] Preview mode - single-click preview, double-click pins
- [x] Tab overflow menu (scroll + dropdown)
- [x] Right-click context menu

#### Context Menu Options
```
┌────────────────────────────┐
│ Close                 ⌘W   │
│ Close Others               │
│ Close to the Right         │
│ Close All                  │
├────────────────────────────┤
│ Copy Path                  │
│ Copy Relative Path         │
│ Reveal in Finder           │
├────────────────────────────┤
│ Pin Tab                    │
│ Split Right           ⌘\   │
│ Split Down           ⇧⌘\   │
└────────────────────────────┘
```

### 1.3 Breadcrumb Navigation

**Priority:** P1 | **Status:** 🔄 Partial

#### UI
```
┌─────────────────────────────────────────────────────────────────────┐
│ 📁 clawd › 📁 ide › 📁 server › 📄 index.js › ƒ initializeServer   │
└─────────────────────────────────────────────────────────────────────┘
      │                               │                    │
      │                               │                    └─ Click: show symbols
      │                               └─ Click: show file siblings
      └─ Click: show folder siblings
```

#### Requirements
- [x] Show file path as clickable breadcrumbs
- [ ] Click folder segment → dropdown of sibling folders/files
- [ ] Click file segment → dropdown of symbols in file
- [ ] Keyboard navigation (`Cmd+Shift+.`)
- [x] Truncate long paths with ellipsis

### 1.4 Status Bar

**Priority:** P0 | **Status:** ✅ Implemented

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ⎇ main ↑2↓1 │ ⚠3 ✕1 │ │     🐾 Connected     │ │ Ln 42, Col 18 │ UTF-8 │ JS │ ⇥2 │
└────────────────────────────────────────────────────────────────────────────────┘
     │     │       │              │                    │          │     │     │
     │     │       │              │                    │          │     │     └─ Indentation
     │     │       │              │                    │          │     └─ Language mode
     │     │       │              │                    │          └─ Encoding
     │     │       │              │                    └─ Cursor position
     │     │       │              └─ AI connection status
     │     │       └─ Problems count (click → Problems panel)
     │     └─ Sync status (ahead/behind)
     └─ Current branch (click → branch picker)
```

### 1.5 Find & Replace

**Priority:** P0 | **Status:** ✅ Implemented

#### In-File Search (`Cmd+F`)
```
┌─────────────────────────────────────────────────────────────────────┐
│ 🔍 │ searchTerm                        │ 3 of 47 │ ▲ │ ▼ │ × │    │
├─────────────────────────────────────────────────────────────────────┤
│    │ replacement                       │ [Replace] [Replace All]   │
├─────────────────────────────────────────────────────────────────────┤
│ [Aa] Case │ [Ab|] Word │ [.*] Regex │ [⊂⊃] In Selection           │
└─────────────────────────────────────────────────────────────────────┘
```

#### Global Search (`Cmd+Shift+F`)
```
┌─ SEARCH ────────────────────────────────────────────────────────────┐
│ 🔍 │ searchQuery                                             │     │
│ ↳ Replace: │                                                 │     │
├─────────────────────────────────────────────────────────────────────┤
│ Files to include: │ *.js, *.ts                               │     │
│ Files to exclude: │ node_modules, dist                       │     │
├─────────────────────────────────────────────────────────────────────┤
│ [Aa] [Ab|] [.*]                              47 results in 12 files │
├─────────────────────────────────────────────────────────────────────┤
│ ▼ server/index.js (5 matches)                                       │
│   23:   const app = express();                                      │
│   45:   app.use(cors());                                            │
│   67:   app.listen(PORT, () => {                                   │
│   89:   // app configuration                                        │
│   102:  app.get('/health', ...                                      │
│                                                                     │
│ ▼ public/app.js (12 matches)                                        │
│   ...                                                               │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.6 File Icons

**Priority:** P2 | **Status:** ✅ Implemented

Uses custom SVG icon set based on Material Icons with modifications.

| Extension | Icon | Color |
|-----------|------|-------|
| `.js` | JS badge | `#f7df1e` (yellow) |
| `.ts` | TS badge | `#3178c6` (blue) |
| `.jsx/.tsx` | React atom | `#61dafb` (cyan) |
| `.vue` | Vue logo | `#42b883` (green) |
| `.py` | Snake | `#3776ab` (blue) |
| `.rs` | Gear | `#dea584` (rust) |
| `.go` | Gopher | `#00add8` (cyan) |
| `.json` | Braces | `#cbcb41` (yellow) |
| `.md` | M↓ | `#519aba` (blue) |
| `.html` | < > | `#e34c26` (orange) |
| `.css` | # | `#563d7c` (purple) |
| `package.json` | npm box | `#cb3837` (red) |
| `Dockerfile` | Docker whale | `#2496ed` (blue) |
| `.env*` | Lock | `#ecd53f` (yellow) |
| `.git*` | Branch | `#f05032` (orange) |

---

## Phase 2: AI-Native Features

**Status:** 🔄 ~60% Complete  
**Goal:** Best-in-class AI coding assistance

### 2.1 Inline Code Completions

**Priority:** P0 | **Status:** ✅ Implemented (needs refinement)

#### How It Works
```
User types:     function calculateTax(
Wait:           300ms debounce
Build context:  Current file + imports + recent edits
Request:        POST /api/complete → DNA Gateway
Stream:         Response streams back
Render:         Ghost text appears

  function calculateTax(amount) {
    return amount * 0.0825;░░░░░░░░░░░░░░░░░░
  }                        └── Ghost text (grayed)
```

#### Keyboard Controls
| Key | Action |
|-----|--------|
| `Tab` | Accept full suggestion |
| `Cmd+→` | Accept word-by-word |
| `Escape` | Dismiss suggestion |
| `Cmd+]` | Next suggestion (if multiple) |
| `Cmd+[` | Previous suggestion |

#### Context Building (v2.0 Enhancement)
```javascript
// Current approach: file + recent edits
// v2.0 approach: Rich context object

const completionContext = {
  // Current file
  file: {
    path: "server/routes/auth.js",
    content: "// full file content",
    cursor: { line: 42, column: 15 },
    language: "javascript",
  },
  
  // Related files (by import graph)
  relatedFiles: [
    { path: "server/utils/crypto.js", relevance: 0.9 },
    { path: "server/models/user.js", relevance: 0.85 },
  ],
  
  // Recent edits (last 5 minutes)
  recentEdits: [
    { file: "server/routes/auth.js", timestamp: 1706400000, diff: "..." },
  ],
  
  // Open tabs (likely relevant)
  openTabs: ["package.json", "server/index.js"],
  
  // Project info
  project: {
    type: "node",
    framework: "express",
    testFramework: "jest",
  },
  
  // User preferences (from DNA memory)
  preferences: {
    codeStyle: "async/await over promises",
    errorHandling: "try/catch with custom errors",
    naming: "camelCase for functions, PascalCase for classes",
  }
};
```

### 2.2 Inline Edit Mode (Cmd+K)

**Priority:** P0 | **Status:** 🔄 Partial

#### The Experience

**Step 1: Invoke**
- With selection: `Cmd+K` opens edit prompt for selection
- Without selection: `Cmd+K` opens generation prompt at cursor

**Step 2: Prompt**
```
┌─────────────────────────────────────────────────────────────────────┐
│ function calculateTotal(items) {                                    │
│   let total = 0;                                                    │
│   for (const item of items) {                                       │
│     total += item.price * item.quantity;█                           │
│   }                                                                 │
│   return total;                                                     │
│ }                                                                   │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ 🐾 Edit: add tax calculation and handle empty array            │ │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**Step 3: Preview (Diff View)**
```
┌─────────────────────────────────────────────────────────────────────┐
│ ━━━━━━━━━━━━━━━━━━━ Proposed Changes ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                                     │
│   function calculateTotal(items) {                                  │
│ +   if (!items?.length) return 0;                                  │
│ +                                                                   │
│ +   const TAX_RATE = 0.0825;                                       │
│     let total = 0;                                                  │
│     for (const item of items) {                                     │
│       total += item.price * item.quantity;                          │
│     }                                                               │
│ -   return total;                                                   │
│ +   return total * (1 + TAX_RATE);                                 │
│   }                                                                 │
│                                                                     │
│ ┌───────────────────────────────────────────────────────────────┐   │
│ │ [✓ Accept]  [✕ Reject]  [✏ Edit Prompt]  [↻ Regenerate]      │   │
│ └───────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

**Step 4: Accept/Reject**
- `Enter` or `Tab` → Accept changes
- `Escape` → Reject, return to original
- `Cmd+Z` after accept → Undo to pre-AI state

#### Smart Prompt Suggestions
When `Cmd+K` is opened, show contextual suggestions:
```
┌─────────────────────────────────────────────────────────────────────┐
│ 🐾 What would you like to do?                                      │
│                                                                     │
│ Recent:                                                             │
│   ↻ "add error handling"                                           │
│   ↻ "convert to TypeScript"                                        │
│                                                                     │
│ Suggestions for this selection:                                     │
│   💡 Add documentation                                              │
│   💡 Add error handling                                             │
│   💡 Optimize for performance                                       │
│   💡 Add unit tests                                                 │
│                                                                     │
│ Type your instruction...                                            │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.3 Enhanced AI Chat Panel

**Priority:** P0 | **Status:** 🔄 Partial

#### Full Specification

```
┌─ CLAWD AI 🐾 ────────────────────────────────────────── ⚙ ─ □ ─ × ─┐
│                                                                     │
│ Context: [📄 index.js ×] [📁 server ×] [@ Add context...]          │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ 👤 You                                              10:42 AM        │
│ ────────────────────────────────────────────────────────────────    │
│ Refactor the auth middleware to use JWT tokens instead of          │
│ session-based auth                                                  │
│                                                                     │
│                                                                     │
│ 🐾 Clawd                                            10:42 AM        │
│ ────────────────────────────────────────────────────────────────    │
│ I'll help you migrate from session-based auth to JWT. Here's       │
│ the refactored middleware:                                          │
│                                                                     │
│ ┌─ server/middleware/auth.js ───────────────────────────────────┐  │
│ │                                                               │  │
│ │ import jwt from 'jsonwebtoken';                               │  │
│ │                                                               │  │
│ │ export const authenticate = (req, res, next) => {             │  │
│ │   const token = req.headers.authorization?.split(' ')[1];     │  │
│ │                                                               │  │
│ │   if (!token) {                                               │  │
│ │     return res.status(401).json({ error: 'No token' });       │  │
│ │   }                                                           │  │
│ │                                                               │  │
│ │   try {                                                       │  │
│ │     req.user = jwt.verify(token, process.env.JWT_SECRET);     │  │
│ │     next();                                                   │  │
│ │   } catch {                                                   │  │
│ │     res.status(401).json({ error: 'Invalid token' });         │  │
│ │   }                                                           │  │
│ │ };                                                            │  │
│ │                                                               │  │
│ ├───────────────────────────────────────────────────────────────┤  │
│ │ [📋 Copy] [↳ Insert] [⎘ Diff] [💾 Create] [▶ Apply All]      │  │
│ └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│ You'll also need to:                                                │
│ 1. Install `jsonwebtoken`: `npm install jsonwebtoken`              │
│ 2. Add `JWT_SECRET` to your `.env` file                            │
│ 3. Update your login route to generate tokens                      │
│                                                                     │
│ Would you like me to help with any of these steps?                  │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ ┌───────────────────────────────────────────────────────────────┐   │
│ │ Type a message... (@file @folder @codebase for context)       │   │
│ └───────────────────────────────────────────────────────────────┘   │
│                                                                     │
│ [🎤 Voice] [📎 Attach] [🔧 Agent Mode]              [Send 🐾]      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### Code Block Actions

| Action | Description |
|--------|-------------|
| **Copy** | Copy code to clipboard |
| **Insert** | Insert at cursor position in active editor |
| **Diff** | Show diff vs current file (if applicable) |
| **Create** | Create new file with this content (prompts for path) |
| **Apply All** | Apply this code block and all related blocks |

#### @ Mention System

| Mention | Description | Example |
|---------|-------------|---------|
| `@file` | Include specific file | `@server/index.js` |
| `@folder` | Include folder contents | `@server/routes/` |
| `@codebase` | Include project overview | `@codebase` |
| `@git` | Include git status/history | `@git status` |
| `@terminal` | Include recent terminal output | `@terminal` |
| `@selection` | Include current selection | `@selection` |
| `@error` | Include current error | `@error` |
| `@browser` | Include browser console/network | `@browser console` |

#### Conversation Modes

**Chat Mode (Default)**
- Free-form conversation
- Context from @ mentions and open files
- Best for questions, exploration, learning

**Edit Mode (Cmd+K)**
- Focused on code changes
- Shows diff preview
- One change at a time

**Agent Mode (Toggle)**
- Multi-step autonomous execution
- Creates plans, asks for approval
- Can modify multiple files
- More in Phase 4

### 2.4 Smart Code Actions (Lightbulb)

**Priority:** P1 | **Status:** 📋 Planned

#### Trigger Conditions
- Error on current line → Show fix suggestions
- Warning on current line → Show improvement suggestions
- Cursor on function → Show refactoring options
- Selection → Show transformation options

```javascript
  function getData(url) {  // 💡
    return fetch(url).then(r => r.json());
  }
  
  ┌───────────────────────────────────────────────────┐
  │ 💡 Quick Actions                       Cmd+.     │
  ├───────────────────────────────────────────────────┤
  │ 🐾 AI Suggestions                                │
  │   ├─ Convert to async/await                      │
  │   ├─ Add error handling                          │
  │   ├─ Add JSDoc documentation                     │
  │   └─ Generate unit tests                         │
  ├───────────────────────────────────────────────────┤
  │ 🔧 Refactoring                                   │
  │   ├─ Extract to utility function                 │
  │   ├─ Rename symbol                               │
  │   └─ Convert to arrow function                   │
  ├───────────────────────────────────────────────────┤
  │ 📋 Quick Fixes                                   │
  │   └─ (none detected)                             │
  └───────────────────────────────────────────────────┘
```

---

## Phase 3: Embedded Web Browser

**Status:** 🔄 ~75% Complete  
**Goal:** Never leave the IDE to preview web content

### 3.1 Overview

The embedded browser is a **major differentiator**. No other AI IDE offers this. It enables:

- Live preview of HTML/CSS/JS projects
- API response inspection without Postman
- Documentation reading without context switching
- CSS debugging with live DOM inspection
- Screenshot and recording for documentation
- Responsive design testing

### 3.2 Browser Panel Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Clawd IDE                                                                       │
├──────────────────────────────┬──────────────────────────────────────────────────┤
│                              │                                                  │
│  📁 EXPLORER                 │  ┌─ index.html ─┬─ 🌐 Preview ─┬─ styles.css ─┐ │
│  ▼ 📁 my-project            │  │              │              │              │ │
│    ├─ 📄 index.html         │  │  <html>      │ ┌──────────────────────────┐ │ │
│    ├─ 📄 styles.css         │  │  <head>      │ │ ← → ↻  localhost:3000   │ │ │
│    ├─ 📄 app.js             │  │    <link...  │ ├──────────────────────────┤ │ │
│    └─ 📁 assets             │  │  </head>     │ │                          │ │ │
│                              │  │  <body>      │ │   [Live Preview of       │ │ │
│                              │  │    <div...   │ │    your webpage]         │ │ │
│                              │  │  </body>     │ │                          │ │ │
│                              │  │  </html>     │ │   Welcome to my site!    │ │ │
│                              │  │              │ │                          │ │ │
│                              │  │              │ │   [Button] [Link]        │ │ │
│                              │  │              │ │                          │ │ │
│                              │  │              │ └──────────────────────────┘ │ │
│                              │  │              │ ┌──────────────────────────┐ │ │
│                              │  │              │ │ Elements │ Console │ Net │ │ │
│                              │  │              │ ├──────────────────────────┤ │ │
│                              │  │              │ │ <html>                   │ │ │
│                              │  │              │ │  └ <body>                │ │ │
│                              │  │              │ │     └ <div.container>    │ │ │
│                              │  │              │ └──────────────────────────┘ │ │
│                              │  └──────────────┴──────────────────────────────┘ │
├──────────────────────────────┴──────────────────────────────────────────────────┤
│ TERMINAL                                                                        │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Browser Tab Types

**Status:** ✅ Implemented

#### Preview Tab (Live Reload)
```
┌─ 🌐 Preview: index.html ──────────────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────────────────────────────────┐   │
│ │ ← │ → │ ↻ │ http://localhost:3000/                    │ 📱 │ 🖥 │ 🔧 │ ⋮ │   │
│ └─────────────────────────────────────────────────────────────────────────────┘   │
│ ┌─────────────────────────────────────────────────────────────────────────────┐   │
│ │                                                                             │   │
│ │                     [Your rendered webpage]                                 │   │
│ │                                                                             │   │
│ │                                                                             │   │
│ └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                   │
│ 🔄 Auto-refresh: ON │ Last updated: 10:42:35 AM │ Linked to: index.html          │
└───────────────────────────────────────────────────────────────────────────────────┘
```

#### External URL Tab
```
┌─ 🌐 MDN Web Docs ─────────────────────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────────────────────────────────┐   │
│ │ ← │ → │ ↻ │ https://developer.mozilla.org/en-US/docs/Web  │ ⭐ │ 📋 │ ⋮ │   │
│ └─────────────────────────────────────────────────────────────────────────────┘   │
│ ┌─────────────────────────────────────────────────────────────────────────────┐   │
│ │                                                                             │   │
│ │                     [MDN Documentation]                                     │   │
│ │                                                                             │   │
│ └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                   │
│ Reader Mode: OFF │ Bookmarked │ Copy URL │ Open in External Browser              │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Browser Toolbar

**Status:** ✅ Implemented

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│  [←]  [→]  [↻]  │  http://localhost:3000/auth/login          │  [🔍]  [⋮]        │
│   │    │    │                    │                                │     │          │
│   │    │    │                    │                                │     └─ Menu    │
│   │    │    │                    │                                └─ Find in page  │
│   │    │    │                    └─ URL bar (editable)                             │
│   │    │    └─ Reload (Cmd+R reloads browser, not IDE)                            │
│   │    └─ Forward                                                                  │
│   └─ Back                                                                          │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Toolbar Menu (⋮)
```
┌────────────────────────────────────────┐
│ 📱 Responsive Presets              ▶  │
│   ├─ iPhone 14 (390×844)              │
│   ├─ iPad (768×1024)                  │
│   ├─ Desktop (1280×800)               │
│   └─ Custom...                        │
├────────────────────────────────────────┤
│ 🔧 DevTools                           │
│   ├─ Elements                         │
│   ├─ Console                          │
│   ├─ Network                          │
│   └─ Detach DevTools                  │
├────────────────────────────────────────┤
│ 📸 Capture                            │
│   ├─ Screenshot (viewport)            │
│   ├─ Screenshot (full page)           │
│   └─ Start Recording                  │
├────────────────────────────────────────┤
│ 🔗 Share                              │
│   ├─ Copy URL                         │
│   ├─ Copy as cURL                     │
│   └─ Open in External Browser         │
├────────────────────────────────────────┤
│ ⚙ Settings                            │
│   ├─ Disable JavaScript               │
│   ├─ Disable Cache                    │
│   ├─ Throttle Network...              │
│   └─ User Agent...                    │
└────────────────────────────────────────┘
```

### 3.5 DevTools Integration

**Status:** 🔄 Partial (Console ✅, Network ✅, Elements 📋)

#### Elements Panel
```
┌─ Elements ─────────────────────────────────────────────────────────────────────────┐
│                                                                                    │
│ ▼ <html>                                                                          │
│   ▼ <head>                                                                        │
│       <title>My App</title>                                                       │
│       <link rel="stylesheet" href="styles.css">                                   │
│     </head>                                                                       │
│   ▼ <body>                                                                        │
│     ▼ <div class="container">                                     ← [selected]   │
│         <h1>Welcome</h1>                                                          │
│         <p>This is my app.</p>                                                    │
│       </div>                                                                      │
│     </body>                                                                       │
│   </html>                                                                         │
│                                                                                    │
├────────────────────────────────────────────────────────────────────────────────────┤
│ Styles │ Computed │ Layout │ Event Listeners                                      │
├────────────────────────────────────────────────────────────────────────────────────┤
│ element.style {                                                                   │
│                                                                                    │
│ }                                                                                  │
│                                                                                    │
│ .container {                                           styles.css:15              │
│   max-width: 1200px;                                                              │
│   margin: 0 auto;                                                                 │
│   padding: 20px;                                                                  │
│ }                                                                                  │
│                                     [Edit] [→ Go to source]                       │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Key Features:**
- Click element in preview → highlights in Elements panel
- Click element in panel → highlights in preview
- Edit CSS inline → live updates preview
- "Go to source" → opens corresponding CSS file in editor

#### Console Panel
```
┌─ Console ──────────────────────────────────────────────────────────────────────────┐
│ [🔍 Filter] [All ▾] [Default levels ▾]                        [🗑 Clear] [⚙]     │
├────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                    │
│ ⓘ [Info] Application initialized                                   app.js:42     │
│ ▶ {user: {name: "Ivan", id: 123}}                                  app.js:67     │
│ ⚠ [Warning] Deprecated API usage                                   utils.js:15   │
│ ✕ [Error] Failed to fetch: /api/data                               app.js:89     │
│     at fetchData (app.js:89)                                                      │
│     at init (app.js:42)                                                           │
│                                                                                    │
├────────────────────────────────────────────────────────────────────────────────────┤
│ > │                                                                    [Run]      │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Key Features:**
- Click source link → opens file in editor at that line
- Execute JavaScript in console
- Filter by log level
- Preserve logs across navigations (optional)
- "Send to AI" button → includes console output in AI context

#### Network Panel
```
┌─ Network ──────────────────────────────────────────────────────────────────────────┐
│ [🔍 Filter] [All ▾] [🔴 Recording] [🗑 Clear]                    67 requests     │
├────────────────────────────────────────────────────────────────────────────────────┤
│ Name                    │ Status │ Type   │ Size   │ Time    │ Waterfall         │
├────────────────────────────────────────────────────────────────────────────────────┤
│ localhost               │ 200    │ doc    │ 2.3 KB │ 45ms    │ ████              │
│ styles.css              │ 200    │ css    │ 1.2 KB │ 12ms    │  ██               │
│ app.js                  │ 200    │ js     │ 15 KB  │ 23ms    │   ███             │
│ api/user                │ 200    │ json   │ 156 B  │ 89ms    │     ███████       │
│ api/products            │ 500    │ json   │ 52 B   │ 234ms   │        ██████████ │
│ logo.png                │ 200    │ img    │ 45 KB  │ 67ms    │     █████         │
├────────────────────────────────────────────────────────────────────────────────────┤
│ ▼ api/products                                                                    │
│   Headers │ Preview │ Response │ Timing                                           │
│   ─────────────────────────────────────────                                       │
│   Request URL: http://localhost:3000/api/products                                 │
│   Request Method: GET                                                             │
│   Status Code: 500 Internal Server Error                                          │
│                                                                                    │
│   Response:                                                                        │
│   {"error": "Database connection failed"}                                         │
│                                                                        [Copy cURL]│
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Key Features:**
- Request/response inspection
- Timing waterfall visualization
- Copy as cURL for API testing
- "Replay request" button
- Filter by type (XHR, JS, CSS, etc.)
- Export HAR file

### 3.6 Live Preview Mode

**Status:** ✅ Implemented

#### Auto-Refresh Behavior
```javascript
// File watcher configuration
const livePreviewConfig = {
  // Files that trigger refresh
  watchPatterns: [
    "**/*.html",
    "**/*.css", 
    "**/*.js",
    "**/*.jsx",
    "**/*.vue",
    "**/*.svelte",
  ],
  
  // Debounce to prevent refresh spam
  debounceMs: 300,
  
  // Hot reload for CSS (no full refresh)
  hotReload: {
    css: true,
    enabled: true,
  },
  
  // Preserve scroll position on refresh
  preserveScroll: true,
  
  // Preserve form data on refresh
  preserveFormData: true,
};
```

#### Framework Detection
| Framework | Detection | Dev Server | Hot Reload |
|-----------|-----------|------------|------------|
| Vanilla HTML | `*.html` in root | Built-in server | Full reload |
| React (CRA) | `react-scripts` in package.json | `npm start` | HMR via webpack |
| React (Vite) | `vite` + `@vitejs/plugin-react` | `npm run dev` | HMR via Vite |
| Vue | `vue` in package.json | `npm run dev` | HMR via Vite |
| Next.js | `next` in package.json | `npm run dev` | Fast Refresh |
| SvelteKit | `@sveltejs/kit` | `npm run dev` | HMR |
| Static | No framework | Built-in server | Full reload |

### 3.7 Responsive Testing

**Status:** ✅ Implemented (viewport/device selection)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ ┌─ Responsive Mode ────────────────────────────────────────────────────────────┐   │
│ │                                                                              │   │
│ │ Device: [iPhone 14 Pro ▾]  │  [390] × [844]  │  [Portrait ▾]  │  [1x ▾]    │   │
│ │                                                                              │   │
│ │ ┌─────────────────────────────────────────────────────────────────────────┐ │   │
│ │ │ ┌─────────────────────────────────────────────────────────────────┐     │ │   │
│ │ │ │                                                                 │     │ │   │
│ │ │ │                                                                 │     │ │   │
│ │ │ │              [Phone-sized viewport]                             │     │ │   │
│ │ │ │                                                                 │     │ │   │
│ │ │ │                                                                 │     │ │   │
│ │ │ │                                                                 │     │ │   │
│ │ │ │                                                                 │     │ │   │
│ │ │ │                                                                 │     │ │   │
│ │ │ │                                                                 │     │ │   │
│ │ │ └─────────────────────────────────────────────────────────────────┘     │ │   │
│ │ └─────────────────────────────────────────────────────────────────────────┘ │   │
│ │                                                                              │   │
│ └──────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Device Presets
| Device | Width | Height | Scale | User Agent |
|--------|-------|--------|-------|------------|
| iPhone SE | 375 | 667 | 2x | Mobile Safari |
| iPhone 14 | 390 | 844 | 3x | Mobile Safari |
| iPhone 14 Pro Max | 430 | 932 | 3x | Mobile Safari |
| iPad | 768 | 1024 | 2x | Mobile Safari |
| iPad Pro 12.9" | 1024 | 1366 | 2x | Mobile Safari |
| Android Small | 360 | 640 | 2x | Chrome Mobile |
| Android Medium | 412 | 915 | 2.6x | Chrome Mobile |
| Laptop | 1280 | 800 | 1x | Desktop |
| Desktop | 1920 | 1080 | 1x | Desktop |

### 3.8 CSS/JS Injection

**Status:** 📋 Planned

For debugging and prototyping, inject custom CSS or JavaScript:

```
┌─ Inject CSS/JS ─────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│ ┌─ CSS ──────────────────────────────────────────────────────────────────────────┐ │
│ │ /* Your injected styles */                                                     │ │
│ │ body {                                                                         │ │
│ │   outline: 1px solid red;                                                      │ │
│ │ }                                                                              │ │
│ │ * {                                                                            │ │
│ │   outline: 1px solid rgba(255,0,0,0.1) !important;                            │ │
│ │ }                                                                              │ │
│ └────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                     │
│ ┌─ JavaScript ───────────────────────────────────────────────────────────────────┐ │
│ │ // Your injected scripts                                                       │ │
│ │ console.log('Injected!');                                                      │ │
│ └────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                     │
│ [☑ Inject on every page load]  [Apply Now]  [Save as Snippet]  [Clear]            │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.9 Screenshot & Recording

**Status:** 🔄 Partial (Screenshot ✅, Recording 📋)

#### Screenshot Options
```
┌─ Screenshot ──────────────────────────────────────────────────────────────────┐
│                                                                               │
│ Capture:  ○ Viewport only                                                    │
│           ○ Full page (scrolling)                                            │
│           ○ Selected element                                                  │
│                                                                               │
│ Format:   ○ PNG  ○ JPEG  ○ WebP                                              │
│                                                                               │
│ Options:  ☑ Include device frame                                             │
│           ☐ Hide scrollbars                                                   │
│           ☐ Add timestamp                                                     │
│                                                                               │
│ [Capture]                                                                     │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

#### Recording Options
```
┌─ Screen Recording ────────────────────────────────────────────────────────────┐
│                                                                               │
│ 🔴 Recording... 00:00:45                                                     │
│                                                                               │
│ Options:  ☑ Include mouse cursor                                             │
│           ☑ Include clicks (visual feedback)                                 │
│           ☐ Include audio                                                     │
│                                                                               │
│ Format:   ○ WebM  ○ GIF  ○ MP4                                               │
│                                                                               │
│ [⏹ Stop] [⏸ Pause]                                                           │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 3.10 Technical Implementation

**Status:** ✅ Implemented (iframe-based with DevTools bridge)

#### Architecture
```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                               Browser Panel Architecture                            │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │                           Clawd IDE (Main Window)                            │   │
│  │                                                                              │   │
│  │  ┌─────────────────────────────────────────────────────────────────────┐    │   │
│  │  │                    BrowserPanel Component (React)                    │    │   │
│  │  │                                                                      │    │   │
│  │  │  ┌───────────────────────────────────────────────────────────────┐  │    │   │
│  │  │  │                         <iframe>                              │  │    │   │
│  │  │  │         (sandboxed, src = proxy URL)                          │  │    │   │
│  │  │  │                                                               │  │    │   │
│  │  │  │     postMessage API for communication                         │  │    │   │
│  │  │  │                                                               │  │    │   │
│  │  │  └───────────────────────────────────────────────────────────────┘  │    │   │
│  │  │                              │                                       │    │   │
│  │  │                              │ postMessage                           │    │   │
│  │  │                              ▼                                       │    │   │
│  │  │  ┌───────────────────────────────────────────────────────────────┐  │    │   │
│  │  │  │                     DevTools Bridge                           │  │    │   │
│  │  │  │                                                               │  │    │   │
│  │  │  │   - Element inspection                                        │  │    │   │
│  │  │  │   - Console interception                                      │  │    │   │
│  │  │  │   - Network request logging                                   │  │    │   │
│  │  │  │   - CSS rule editing                                          │  │    │   │
│  │  │  │                                                               │  │    │   │
│  │  │  └───────────────────────────────────────────────────────────────┘  │    │   │
│  │  │                                                                      │    │   │
│  │  └─────────────────────────────────────────────────────────────────────┘    │   │
│  │                                      │                                       │   │
│  │                                      │ HTTP                                  │   │
│  │                                      ▼                                       │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│                                         │                                           │
│                                         │                                           │
│  ┌──────────────────────────────────────▼───────────────────────────────────────┐   │
│  │                           IDE Server (Node.js)                               │   │
│  │                                                                              │   │
│  │  ┌────────────────────────┐  ┌────────────────────────┐                     │   │
│  │  │   Static File Server   │  │   Proxy Server         │                     │   │
│  │  │   (for local preview)  │  │   (for external URLs)  │                     │   │
│  │  │                        │  │                        │                     │   │
│  │  │   - Serves workspace   │  │   - CORS handling      │                     │   │
│  │  │   - Injects scripts    │  │   - Cookie forwarding  │                     │   │
│  │  │   - Hot reload         │  │   - SSL termination    │                     │   │
│  │  │                        │  │                        │                     │   │
│  │  └────────────────────────┘  └────────────────────────┘                     │   │
│  │                                                                              │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Injected DevTools Script
```javascript
// Injected into every previewed page
(function() {
  const PARENT = window.parent;
  
  // Console interception
  const originalConsole = { ...console };
  ['log', 'warn', 'error', 'info', 'debug'].forEach(method => {
    console[method] = (...args) => {
      originalConsole[method](...args);
      PARENT.postMessage({
        type: 'console',
        method,
        args: args.map(serialize),
        stack: new Error().stack,
        timestamp: Date.now(),
      }, '*');
    };
  });
  
  // Network interception (fetch)
  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const startTime = performance.now();
    const requestId = crypto.randomUUID();
    
    PARENT.postMessage({
      type: 'network',
      phase: 'start',
      requestId,
      url: args[0],
      options: args[1],
    }, '*');
    
    try {
      const response = await originalFetch(...args);
      const clone = response.clone();
      const body = await clone.text();
      
      PARENT.postMessage({
        type: 'network',
        phase: 'complete',
        requestId,
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body,
        duration: performance.now() - startTime,
      }, '*');
      
      return response;
    } catch (error) {
      PARENT.postMessage({
        type: 'network',
        phase: 'error',
        requestId,
        error: error.message,
        duration: performance.now() - startTime,
      }, '*');
      throw error;
    }
  };
  
  // Element hover detection
  document.addEventListener('mouseover', (e) => {
    if (e.ctrlKey || e.metaKey) {
      PARENT.postMessage({
        type: 'element-hover',
        path: getElementPath(e.target),
        rect: e.target.getBoundingClientRect(),
        styles: getComputedStyles(e.target),
      }, '*');
    }
  });
  
  // Receive commands from parent
  window.addEventListener('message', (e) => {
    if (e.data.type === 'inspect-element') {
      const el = document.querySelector(e.data.selector);
      if (el) highlightElement(el);
    }
    if (e.data.type === 'inject-css') {
      const style = document.createElement('style');
      style.textContent = e.data.css;
      document.head.appendChild(style);
    }
    if (e.data.type === 'execute-js') {
      try {
        eval(e.data.code);
      } catch (error) {
        console.error('Injected script error:', error);
      }
    }
  });
})();
```

### 3.11 Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+P` | Open new browser tab (URL prompt) |
| `Cmd+Shift+L` | Open live preview of current HTML file |
| `Cmd+R` (in browser tab) | Reload browser |
| `Cmd+Opt+I` (in browser tab) | Toggle DevTools |
| `Cmd+Opt+C` (in browser tab) | Toggle Console |
| `Cmd+Opt+N` (in browser tab) | Toggle Network |
| `Cmd+Opt+M` (in browser tab) | Toggle responsive mode |
| `Escape` (in responsive mode) | Exit responsive mode |

---

## Phase 4: Advanced AI & Agent Mode

**Status:** 📋 Planned  
**Goal:** True autonomous coding assistance with verification

### 4.1 Agent Mode Overview

Agent Mode transforms Clawd from an assistant into an autonomous developer that can:
- Read and understand your codebase
- Create multi-step plans for complex tasks
- Execute changes across multiple files
- Run tests to verify changes
- Fix issues and iterate until task is complete

#### The Key Differentiator: Verification

Other AI coding agents (Cursor, Windsurf) generate code but **don't verify it**. Clawd's agent:
1. Makes changes
2. Runs relevant tests/linters
3. If failures → analyzes and fixes
4. Repeats until passing

This is how senior engineers work. AI should too.

### 4.2 Agent Mode UI

```
┌─ AGENT MODE 🤖 ─────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│ Task: "Add user authentication with JWT tokens"                                    │
│                                                                                     │
│ ┌─ Plan ──────────────────────────────────────────────────────────────────────────┐│
│ │                                                                                 ││
│ │ ✅ 1. Analyze existing codebase structure                                      ││
│ │      Identified: Express app, MongoDB, existing User model                     ││
│ │                                                                                 ││
│ │ ✅ 2. Install required dependencies                                            ││
│ │      Added: jsonwebtoken, bcryptjs                                             ││
│ │                                                                                 ││
│ │ 🔄 3. Create authentication middleware                                         ││
│ │      Creating: server/middleware/auth.js                                       ││
│ │      ├─ verifyToken function                                                   ││
│ │      └─ refreshToken function                                                  ││
│ │                                                                                 ││
│ │ ⬚ 4. Add login/register routes                                                 ││
│ │ ⬚ 5. Protect existing routes                                                   ││
│ │ ⬚ 6. Add tests for auth flow                                                   ││
│ │ ⬚ 7. Verify: Run test suite                                                    ││
│ │ ⬚ 8. Update documentation                                                      ││
│ │                                                                                 ││
│ └─────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                     │
│ ┌─ Current Step: Creating auth middleware ─────────────────────────────────────────┐│
│ │                                                                                   ││
│ │ 📄 server/middleware/auth.js (new file)                                         ││
│ │                                                                                   ││
│ │ + import jwt from 'jsonwebtoken';                                                ││
│ │ +                                                                                 ││
│ │ + export const verifyToken = (req, res, next) => {                               ││
│ │ +   const authHeader = req.headers.authorization;                                ││
│ │ +   const token = authHeader && authHeader.split(' ')[1];                        ││
│ │ +                                                                                 ││
│ │ +   if (!token) {                                                                ││
│ │ +     return res.status(401).json({                                              ││
│ │ +       error: 'Access denied. No token provided.'                               ││
│ │ +     });                                                                        ││
│ │ +   }                                                                            ││
│ │ +                                                                                 ││
│ │ +   try {                                                                        ││
│ │ +     const verified = jwt.verify(token, process.env.JWT_SECRET);                ││
│ │ +     req.user = verified;                                                       ││
│ │ +     next();                                                                    ││
│ │ +   } catch (error) {                                                            ││
│ │ +     res.status(401).json({ error: 'Invalid token' });                          ││
│ │ +   }                                                                            ││
│ │ + };                                                                             ││
│ │                                                                                   ││
│ └───────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                     │
│ ┌───────────────────────────────────────────────────────────────────────────────────┐│
│ │ [✓ Approve & Continue]  [✏ Edit]  [✕ Reject]  [⏸ Pause]  [⏹ Cancel]             ││
│ └───────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Agent Execution Modes

#### Safe Mode (Default)
- Asks for approval before each file change
- Shows diff preview
- User can edit before applying
- Best for: Learning, critical code, unfamiliar projects

#### Standard Mode
- Auto-approves read operations
- Asks for approval on writes/deletes
- Groups related changes for batch approval
- Best for: Regular development

#### Autonomous Mode
- Minimal intervention needed
- Only pauses on errors or uncertainty
- Auto-runs tests after changes
- Best for: Trusted tasks, experienced users

### 4.4 Verification System

```
┌─ Verification Results ──────────────────────────────────────────────────────────────┐
│                                                                                     │
│ 🔍 Running verification suite...                                                   │
│                                                                                     │
│ ┌─ TypeScript ────────────────────────────────────────────────────────────────────┐│
│ │ ✅ No type errors                                                               ││
│ └─────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                     │
│ ┌─ ESLint ─────────────────────────────────────────────────────────────────────────┐│
│ │ ⚠️ 2 warnings                                                                   ││
│ │    server/middleware/auth.js:12 - Prefer const over let                         ││
│ │    server/middleware/auth.js:18 - Unexpected console statement                  ││
│ │                                                                                  ││
│ │ [🔧 Auto-fix] [Skip]                                                            ││
│ └─────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                     │
│ ┌─ Tests ──────────────────────────────────────────────────────────────────────────┐│
│ │ ⏳ Running: npm test                                                             ││
│ │                                                                                  ││
│ │  PASS  tests/auth.test.js                                                       ││
│ │    ✓ should return 401 if no token (12ms)                                       ││
│ │    ✓ should return 401 if invalid token (8ms)                                   ││
│ │    ✓ should call next() if valid token (15ms)                                   ││
│ │                                                                                  ││
│ │  FAIL  tests/routes.test.js                                                     ││
│ │    ✕ should protect /api/users route (23ms)                                     ││
│ │      Expected: 401                                                               ││
│ │      Received: 200                                                               ││
│ │                                                                                  ││
│ │ 🐾 Analyzing failure...                                                         ││
│ │ → Detected: Auth middleware not applied to /api/users route                     ││
│ │ → Suggested fix: Add verifyToken to route handler                               ││
│ │                                                                                  ││
│ │ [🔧 Apply Fix] [View Details] [Skip]                                            ││
│ └─────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.5 Agent Memory & Context

The agent maintains context about the task:

```javascript
const agentContext = {
  task: {
    id: "auth-implementation",
    description: "Add JWT authentication",
    started: "2026-01-27T10:42:00Z",
    status: "in_progress",
  },
  
  plan: {
    steps: [
      { id: 1, description: "Analyze codebase", status: "complete" },
      { id: 2, description: "Install deps", status: "complete" },
      { id: 3, description: "Create middleware", status: "in_progress" },
      // ...
    ],
    currentStep: 3,
  },
  
  changes: [
    { file: "package.json", type: "modify", hunks: [...] },
    { file: "server/middleware/auth.js", type: "create", content: "..." },
  ],
  
  verification: {
    lastRun: "2026-01-27T10:45:00Z",
    typescript: { passed: true },
    eslint: { passed: false, errors: 0, warnings: 2 },
    tests: { passed: false, failures: 1 },
  },
  
  rollback: {
    available: true,
    commitId: "abc123",
    description: "Pre-agent state",
  },
};
```

### 4.6 Rollback Capability

If something goes wrong, one-click rollback:

```
┌─ Rollback ──────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│ ⚠️ This will undo all changes made by the agent in this session.                  │
│                                                                                     │
│ Changes to be reverted:                                                             │
│   📄 package.json (modified)                                                       │
│   📄 server/middleware/auth.js (created → deleted)                                 │
│   📄 server/routes/auth.js (created → deleted)                                     │
│   📄 server/index.js (modified)                                                    │
│                                                                                     │
│ [Confirm Rollback]  [Cancel]                                                        │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.7 Multi-File Refactoring

Beyond single-file edits, the agent can perform codebase-wide refactoring:

```
Task: "Rename all instances of 'userId' to 'user_id' across the codebase"

Agent Plan:
1. Scan codebase for 'userId' usage (147 instances in 23 files)
2. Categorize: variables, parameters, object keys, database columns
3. Show impact preview
4. Apply changes file by file
5. Run tests
6. Fix any breaking changes
```

```
┌─ Refactoring Preview ───────────────────────────────────────────────────────────────┐
│                                                                                     │
│ Renaming: userId → user_id                                                         │
│                                                                                     │
│ Impact Summary:                                                                     │
│   📁 server/routes/      32 occurrences in 8 files                                 │
│   📁 server/models/      15 occurrences in 3 files                                 │
│   📁 server/utils/       12 occurrences in 2 files                                 │
│   📁 tests/              88 occurrences in 10 files                                │
│                                                                                     │
│ ⚠️ Potential Issues:                                                               │
│   - Database column 'userId' may need migration                                    │
│   - API responses use 'userId' (breaking change for clients)                       │
│                                                                                     │
│ Recommendation: Create API compatibility layer for gradual migration              │
│                                                                                     │
│ [Proceed] [Modify Scope] [Cancel]                                                   │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 5: Developer Tools

**Status:** 📋 Planned  
**Goal:** Professional-grade dev tools, integrated

### 5.1 Multi-Terminal

```
┌─ TERMINAL ──────────────────────────────────────────────────────────────────────────┐
│ [zsh] [node server ✕] [npm test 🔴] [+ ▾]                              [↕] [□] [×] │
├─────────────────────────────────────────────────────────────────────────────────────┤
│ ~/clawd/ide $ npm start                                                            │
│                                                                                     │
│ 🐾 Clawd IDE Server v2.0                                                           │
│ ├─ HTTP:  http://localhost:3333                                                    │
│ ├─ WS:    ws://localhost:3333/ws                                                   │
│ └─ Files: /Users/ivan/projects/my-app                                              │
│                                                                                     │
│ [10:42:15] Watching for changes...                                                 │
│ [10:42:18] Change detected: server/routes/auth.js                                  │
│ [10:42:18] Reloading...                                                            │
│                                                                                     │
│ ~/clawd/ide $ █                                                                    │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Terminal Features
- [x] Multiple terminal instances
- [x] Tab bar with naming
- [ ] Split terminals (horizontal/vertical)
- [x] Kill process (Ctrl+C)
- [x] Clear terminal (Cmd+K)
- [ ] Search in terminal output (Cmd+F)
- [ ] Quick commands dropdown
- [x] Link detection (Cmd+click to open)
- [ ] Terminal profiles (zsh, bash, node, python REPL)

### 5.2 Problems Panel

```
┌─ PROBLEMS ─────────────────────────────────────────── 3 Errors │ 7 Warnings │ 2 Info ┐
│ Filter: [All ▾] [🔍                    ]                                            │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│ ▼ Errors (3)                                                                        │
│   ├─ ✕ server/routes/auth.js                                                       │
│   │     Ln 23: Cannot find name 'jwt'                                   [TS2304]    │
│   │     💡 Quick fix: Add import statement                                          │
│   │                                                                                 │
│   └─ ✕ server/utils/validate.js                                                    │
│         Ln 45: Type 'string' is not assignable to type 'number'         [TS2322]    │
│         Ln 67: Property 'email' does not exist on type '{}'             [TS2339]    │
│                                                                                     │
│ ▼ Warnings (7)                                                                      │
│   ├─ ⚠ server/routes/auth.js                                                       │
│   │     Ln 12: 'response' is assigned but never used                    [no-unused] │
│   │                                                                                 │
│   └─ ⚠ public/app.js (6 warnings)                                                  │
│         Click to expand...                                                          │
│                                                                                     │
│ ▶ Info (2)                                                                          │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Integration Points
- TypeScript language service errors
- ESLint warnings/errors
- AI-detected issues ("This looks like it could cause a null reference")
- Click to navigate to issue
- Quick fix suggestions
- Auto-fix all of type

### 5.3 Git Integration

#### Source Control Panel
```
┌─ SOURCE CONTROL ────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│ ⎇ main ↑2 ↓1                                              [↻ Fetch] [↓ Pull] [↑ Push]│
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│ 📝 Commit Message                                                                  │
│ ┌─────────────────────────────────────────────────────────────────────────────────┐│
│ │ feat: add JWT authentication                                                    ││
│ │                                                                                  ││
│ │ - Add auth middleware                                                           ││
│ │ - Add login/register routes                                                     ││
│ └─────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                     │
│ [Commit]  [☑ Amend]  [🐾 Generate Message]                                         │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│ Staged Changes (2)                                                    [− Unstage All]│
│   M server/middleware/auth.js                          [View] [−]                   │
│   A server/routes/auth.js                              [View] [−]                   │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│ Changes (4)                                                             [+ Stage All]│
│   M server/index.js                                    [View] [+] [↩]               │
│   M package.json                                       [View] [+] [↩]               │
│   M package-lock.json                                  [View] [+] [↩]               │
│   ? .env.example                                       [View] [+] [🗑]               │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│ Stashes (1)                                                                        │
│   stash@{0}: WIP on main: experimental feature                    [Apply] [Drop]    │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### AI-Generated Commit Messages

Click "🐾 Generate Message" and Clawd analyzes the diff:

```
┌─ Generated Commit Message ──────────────────────────────────────────────────────────┐
│                                                                                     │
│ Based on your changes, here's a suggested commit message:                          │
│                                                                                     │
│ ┌─────────────────────────────────────────────────────────────────────────────────┐│
│ │ feat(auth): implement JWT-based authentication                                  ││
│ │                                                                                  ││
│ │ - Add verifyToken middleware for protected routes                               ││
│ │ - Create login endpoint with password hashing                                   ││
│ │ - Create register endpoint with validation                                      ││
│ │ - Add JWT token generation with 24h expiry                                      ││
│ │                                                                                  ││
│ │ Closes #42                                                                       ││
│ └─────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                     │
│ [Use This] [Regenerate] [Edit]                                                      │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Diff Viewer

Side-by-side and inline diff views:

```
┌─ server/index.js ────────────────────────────────────────────────────── Inline Diff ┐
│                                                                                     │
│   40 │   app.use(express.json());                                                  │
│   41 │   app.use(cors());                                                          │
│   42 │                                                                              │
│ - 43 │   // Routes                                                                 │
│ + 43 │   // Auth middleware                                                        │
│ + 44 │   import { verifyToken } from './middleware/auth.js';                       │
│ + 45 │                                                                              │
│ + 46 │   // Routes                                                                 │
│   47 │   app.use('/api/auth', authRoutes);                                         │
│ - 48 │   app.use('/api/users', userRoutes);                                        │
│ + 48 │   app.use('/api/users', verifyToken, userRoutes);                           │
│   49 │                                                                              │
│                                                                                     │
│ [Side-by-Side ▾] [◀ Previous Change] [Next Change ▶] [Stage Hunk] [Discard Hunk]   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.4 Debugging (Future)

Integrated debugging with AI assistance:

```
┌─ DEBUG ─────────────────────────────────────────────────────────────────────────────┐
│ [▶ Continue] [⏸ Pause] [→ Step Over] [↓ Step Into] [↑ Step Out] [↻ Restart] [⏹ Stop]│
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│ ▼ BREAKPOINTS                                                                       │
│   ○ server/routes/auth.js:42                                                       │
│   ● server/utils/validate.js:15  (hit)                                             │
│   ○ server/index.js:89                                                             │
│                                                                                     │
│ ▼ VARIABLES                                                                         │
│   Local                                                                             │
│     user: { name: "Ivan", email: "ivan@..." }                                      │
│     isValid: false                                                                  │
│     error: "Email format invalid"                                                  │
│   Closure                                                                           │
│     config: { ... }                                                                │
│                                                                                     │
│ ▼ WATCH                                                                             │
│   user.email: "ivan@somovselect.com"                                               │
│   isValid: false                                                                    │
│   [+ Add expression]                                                                │
│                                                                                     │
│ ▼ CALL STACK                                                                        │
│   validateEmail @ validate.js:15                                                    │
│   validateUser @ validate.js:42                                                     │
│   register @ auth.js:67                                                             │
│   (anonymous) @ auth.js:12                                                          │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│ 🐾 AI Analysis: The validation is failing because the email regex doesn't allow    │
│    subdomains. Consider using a more permissive pattern or the 'validator' library.│
│    [View suggested fix]                                                             │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 6: Polish & Experience

**Status:** 📋 Planned  
**Goal:** Beautiful, refined, professional

### 6.1 Themes

#### Dark Theme (Default)
```
┌─ Theme: Clawd Dark ─────────────────────────────────────────────────────────────────┐
│                                                                                     │
│ Background:    #0d1117                                                             │
│ Surface:       #161b22                                                             │
│ Border:        #30363d                                                             │
│ Text:          #c9d1d9                                                             │
│ Text Muted:    #8b949e                                                             │
│ Accent:        #4ade80 (Clawd Green)                                               │
│ Error:         #f85149                                                             │
│ Warning:       #d29922                                                             │
│ Info:          #58a6ff                                                             │
│                                                                                     │
│ Syntax Highlighting:                                                                │
│   Keywords:    #ff7b72                                                             │
│   Strings:     #a5d6ff                                                             │
│   Comments:    #8b949e                                                             │
│   Functions:   #d2a8ff                                                             │
│   Variables:   #ffa657                                                             │
│   Numbers:     #79c0ff                                                             │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Light Theme
```
┌─ Theme: Clawd Light ────────────────────────────────────────────────────────────────┐
│                                                                                     │
│ Background:    #ffffff                                                             │
│ Surface:       #f6f8fa                                                             │
│ Border:        #d0d7de                                                             │
│ Text:          #1f2328                                                             │
│ Text Muted:    #656d76                                                             │
│ Accent:        #16a34a (Clawd Green Dark)                                          │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Theme System
```json
// Custom theme format
{
  "name": "My Custom Theme",
  "type": "dark",
  "colors": {
    "editor.background": "#1e1e1e",
    "editor.foreground": "#d4d4d4",
    "editor.lineHighlightBackground": "#2d2d2d",
    "editor.selectionBackground": "#264f78",
    "editorCursor.foreground": "#4ade80",
    "editorLineNumber.foreground": "#858585",
    "editorLineNumber.activeForeground": "#c6c6c6",
    // ... full color definition
  },
  "tokenColors": [
    {
      "scope": "comment",
      "settings": { "foreground": "#6a737d", "fontStyle": "italic" }
    },
    // ... token color definitions
  ]
}
```

### 6.2 Settings UI

```
┌─ Settings ─────────────────────────────────────────────────────────────── ⌘, ─────┐
│                                                                                     │
│ 🔍 Search settings...                                                              │
│                                                                                     │
├──────────────────┬──────────────────────────────────────────────────────────────────┤
│                  │                                                                  │
│ ▼ Editor         │  EDITOR SETTINGS                                                │
│   Text           │  ─────────────────────────────────────────────                   │
│   Cursor         │                                                                  │
│   Minimap        │  Font Family                                                     │
│                  │  ┌─────────────────────────────────────────────────────────────┐│
│ ▼ AI             │  │ JetBrains Mono, Menlo, Monaco, monospace                    ││
│   Completions    │  └─────────────────────────────────────────────────────────────┘│
│   Chat           │                                                                  │
│   Agent          │  Font Size                                                       │
│                  │  [14] px                                                         │
│ ▼ Terminal       │                                                                  │
│                  │  Line Height                                                     │
│ ▼ Git            │  [1.6]                                                           │
│                  │                                                                  │
│ ▼ Browser        │  Tab Size                                                        │
│                  │  [2] spaces                                                      │
│ ▼ Appearance     │                                                                  │
│   Theme          │  ☑ Insert spaces when pressing Tab                              │
│   Font           │  ☑ Word wrap                                                    │
│   Layout         │  ☐ Render whitespace                                            │
│                  │  ☑ Show minimap                                                  │
│ ▼ Keybindings    │                                                                  │
│                  │  ─────────────────────────────────────────────                   │
│                  │                                                                  │
│                  │  CURSOR                                                          │
│                  │  ─────────────────────────────────────────────                   │
│                  │                                                                  │
│                  │  Cursor Style                                                    │
│                  │  [Line ▾]  Line │ Block │ Underline                             │
│                  │                                                                  │
│                  │  Cursor Blinking                                                 │
│                  │  [Blink ▾]  Blink │ Smooth │ Solid                              │
│                  │                                                                  │
└──────────────────┴──────────────────────────────────────────────────────────────────┘
```

### 6.3 Keyboard Shortcuts

#### Core Shortcuts
| Category | Action | Mac | Windows/Linux |
|----------|--------|-----|---------------|
| **General** | Command Palette | `Cmd+Shift+P` | `Ctrl+Shift+P` |
| | Quick Open (files) | `Cmd+P` | `Ctrl+P` |
| | Settings | `Cmd+,` | `Ctrl+,` |
| | Toggle Sidebar | `Cmd+B` | `Ctrl+B` |
| | Toggle Terminal | `` Cmd+` `` | `` Ctrl+` `` |
| **File** | New File | `Cmd+N` | `Ctrl+N` |
| | Save | `Cmd+S` | `Ctrl+S` |
| | Save All | `Cmd+Opt+S` | `Ctrl+Alt+S` |
| | Close Tab | `Cmd+W` | `Ctrl+W` |
| **Edit** | Undo | `Cmd+Z` | `Ctrl+Z` |
| | Redo | `Cmd+Shift+Z` | `Ctrl+Shift+Z` |
| | Find | `Cmd+F` | `Ctrl+F` |
| | Find in Files | `Cmd+Shift+F` | `Ctrl+Shift+F` |
| | Replace | `Cmd+H` | `Ctrl+H` |
| | Go to Line | `Cmd+G` | `Ctrl+G` |
| | Go to Symbol | `Cmd+Shift+O` | `Ctrl+Shift+O` |
| **Editor** | Split Right | `Cmd+\` | `Ctrl+\` |
| | Split Down | `Cmd+Shift+\` | `Ctrl+Shift+\` |
| | Focus Next Pane | `Cmd+Opt+→` | `Ctrl+Alt+→` |
| | Focus Previous Pane | `Cmd+Opt+←` | `Ctrl+Alt+←` |
| **AI** | Inline Edit | `Cmd+K` | `Ctrl+K` |
| | Quick Actions | `Cmd+.` | `Ctrl+.` |
| | Toggle AI Chat | `Cmd+Shift+A` | `Ctrl+Shift+A` |
| | Agent Mode | `Cmd+Shift+G` | `Ctrl+Shift+G` |
| **Browser** | New Browser Tab | `Cmd+Shift+B` | `Ctrl+Shift+B` |
| | Live Preview | `Cmd+Shift+L` | `Ctrl+Shift+L` |
| | Toggle DevTools | `Cmd+Opt+I` | `Ctrl+Alt+I` |

### 6.4 Onboarding Experience

First-time users see a welcoming experience:

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│                           🐾 Welcome to Clawd IDE                                   │
│                                                                                     │
│              The AI-native code editor that codes with you.                        │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  Let's get you set up in 30 seconds:                                               │
│                                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │  ○ Theme                                                                    │   │
│  │    ┌───────────────┐  ┌───────────────┐                                    │   │
│  │    │   ▓▓▓▓▓▓▓▓   │  │   ░░░░░░░░   │                                    │   │
│  │    │   ▓▓ Dark    │  │   ░░ Light   │                                    │   │
│  │    │   ▓▓▓▓▓▓▓▓   │  │   ░░░░░░░░   │                                    │   │
│  │    └───────────────┘  └───────────────┘                                    │   │
│  │                 ▲ Selected                                                  │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │  ○ Key bindings                                                             │   │
│  │    [Default] [VS Code] [Vim] [Emacs]                                       │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │  ○ Open a project                                                           │   │
│  │    [📁 Open Folder...]  [📋 Clone Repository...]                           │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
│                          [Get Started →]                                            │
│                                                                                     │
│  ─────────────────────────────────────────────────────────────────────────────     │
│                                                                                     │
│  Quick Tips:                                                                        │
│  • Cmd+K for AI inline edit                                                        │
│  • Cmd+Shift+A for AI chat                                                          │
│  • Cmd+P to quickly open files                                                     │
│  • Cmd+Shift+P for all commands                                                    │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.5 Performance Optimization

#### Targets
| Metric | Target | Current |
|--------|--------|---------|
| Cold start | <2s | ~3s |
| Time to interactive | <3s | ~4s |
| File open (large file) | <200ms | ~400ms |
| AI completion latency | <500ms | ~800ms |
| Memory usage (idle) | <200MB | ~350MB |
| Memory usage (10 files) | <400MB | ~600MB |

#### Optimization Strategies

**File Tree**
```javascript
// Virtual scrolling for large directories
const FileTree = () => {
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 50 });
  
  return (
    <VirtualList
      itemCount={files.length}
      itemSize={24}
      onRangeChange={setVisibleRange}
    >
      {({ index }) => <FileTreeItem file={files[index]} />}
    </VirtualList>
  );
};
```

**Editor Models**
```javascript
// Lazy model creation - only create Monaco models when file is opened
const openFile = async (path) => {
  // Check cache first
  if (modelCache.has(path)) {
    return modelCache.get(path);
  }
  
  // Fetch content
  const content = await fetchFileContent(path);
  
  // Create model with language detection
  const model = monaco.editor.createModel(
    content,
    detectLanguage(path),
    monaco.Uri.file(path)
  );
  
  modelCache.set(path, model);
  return model;
};

// Dispose unused models after 30 minutes
const cleanupModels = () => {
  const now = Date.now();
  for (const [path, model] of modelCache) {
    if (!isFileOpen(path) && model.lastAccess < now - 30 * 60 * 1000) {
      model.dispose();
      modelCache.delete(path);
    }
  }
};
```

**AI Requests**
```javascript
// Aggressive debouncing and caching
const completionCache = new LRUCache({ max: 100 });

const getCompletion = debounce(async (context) => {
  const cacheKey = hashContext(context);
  
  if (completionCache.has(cacheKey)) {
    return completionCache.get(cacheKey);
  }
  
  const completion = await requestCompletion(context);
  completionCache.set(cacheKey, completion);
  
  return completion;
}, 300);
```

---

## Phase 7: Differentiators & Innovation

**Status:** 📋 Planned  
**Goal:** Features no other IDE has

### 7.1 DNA Memory Integration

The killer feature: **Your AI remembers you.**

```
┌─ DNA Context ──────────────────────────────────────────────────────────────────┐
│                                                                                     │
│ 🧠 What Clawd Knows About This Project:                                            │
│                                                                                     │
│ ┌─────────────────────────────────────────────────────────────────────────────────┐│
│ │ Project: clawd-ide                                                              ││
│ │ Type: Node.js + Express server, Vanilla JS frontend                            ││
│ │ Last worked on: 2 hours ago                                                     ││
│ │                                                                                  ││
│ │ Recent Context:                                                                  ││
│ │ • You were implementing the embedded browser feature                            ││
│ │ • DevTools integration was partially complete                                   ││
│ │ • You mentioned wanting to add network request logging                          ││
│ │                                                                                  ││
│ │ Preferences (learned):                                                           ││
│ │ • Always use async/await, never .then()                                         ││
│ │ • Prefer const over let                                                          ││
│ │ • Error handling with try/catch + custom error classes                          ││
│ │ • JSDoc comments on exported functions                                          ││
│ │                                                                                  ││
│ │ Known Issues:                                                                    ││
│ │ • Terminal resize sometimes breaks on window resize                             ││
│ │ • AI chat panel loses scroll position on new messages                           ││
│ │                                                                                  ││
│ └─────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                     │
│ [Edit Memory] [Clear Project Context] [Add Note]                                   │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### How It Works

```javascript
// Context sent with every AI request
const dnaContext = {
  // From MEMORY.md and memory files
  user: {
    name: "Ivan",
    preferences: {
      codeStyle: ["async/await", "const-over-let", "early-returns"],
      documentation: "JSDoc for exports, inline comments for complex logic",
      testing: "Jest with describe/it pattern",
    },
    expertise: ["Node.js", "JavaScript", "Express", "MongoDB"],
    learning: ["TypeScript", "Rust"],
  },
  
  // From workspace context
  project: {
    name: "clawd-ide",
    stack: ["Node.js", "Express", "Monaco Editor", "xterm.js"],
    currentFocus: "Embedded browser feature",
    recentConversations: [
      "2h ago: Discussed DevTools architecture",
      "1d ago: Fixed terminal resize bug",
    ],
    knownIssues: [
      "Terminal resize breaks on window resize",
      "AI chat loses scroll position",
    ],
  },
  
  // From daily notes
  recent: {
    filesModified: ["server/browser.js", "public/devtools.js"],
    tasksCompleted: ["Implement element inspector"],
    tasksInProgress: ["Network request logging"],
  },
};
```

### 7.2 Voice Commands

Hands-free coding:

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│  🎤 "Hey Clawd..."                                                                  │
│                                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │                                                                              │   │
│  │   Listening...                           [Cancel]                            │   │
│  │                                                                              │   │
│  │   ▁ ▂ ▃ ▄ ▅ ▆ ▇ █ ▇ ▆ ▅ ▄ ▃ ▂ ▁                                          │   │
│  │                                                                              │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
│  Examples:                                                                          │
│  • "Open the auth routes file"                                                     │
│  • "Add error handling to this function"                                            │
│  • "Run the tests"                                                                  │
│  • "Commit these changes with message 'fix auth bug'"                              │
│  • "Search for all usages of userId"                                               │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Voice Command Categories

| Category | Example Commands |
|----------|------------------|
| **Navigation** | "Open file server/index.js", "Go to line 42", "Show auth functions" |
| **Editing** | "Add error handling", "Convert to async", "Extract to function" |
| **Git** | "Show changes", "Commit with message...", "Create branch feature-x" |
| **Terminal** | "Run npm test", "Stop server", "Clear terminal" |
| **AI** | "Explain this code", "Write tests for this", "Refactor to use..." |
| **Browser** | "Open preview", "Reload browser", "Take screenshot" |

### 7.3 Collaborative Features (Future)

Real-time collaboration with AI awareness:

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                     │
│  👥 Collaborators Online                                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │  🟢 Ivan (you)     - server/index.js:42                                    │    │
│  │  🟢 Alex           - server/routes/auth.js:15                              │    │
│  │  🟡 Clawd 🐾       - Reviewing changes...                                  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │                                                                              │   │
│  │   // server/routes/auth.js                                                  │   │
│  │                                                                              │   │
│  │   export const login = async (req, res) => {                                │   │
│  │     const { email, password } = req.body;█                                  │   │
│  │                        ▲                                                    │   │
│  │                        └─ Alex is typing here                               │   │
│  │                                                                              │   │
│  │     try {                                                                    │   │
│  │       const user = await User.findOne({ email });░░░░░░░░░░░░              │   │
│  │                                                  └─ Clawd suggestion        │   │
│  │                                                                              │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 7.4 Semantic Code Search

Beyond text search—understand intent:

```
┌─ Semantic Search ───────────────────────────────────────────────────────────────────┐
│                                                                                     │
│ 🔍 "where do we validate user input"                                               │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│ 🎯 Best Matches (by intent):                                                        │
│                                                                                     │
│ ┌─────────────────────────────────────────────────────────────────────────────────┐│
│ │ 1. server/utils/validate.js - validateUser()                           98% ││
│ │    Contains: email format, password strength, required fields checks         ││
│ │    Ln 15-42                                                                   ││
│ └─────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                     │
│ ┌─────────────────────────────────────────────────────────────────────────────────┐│
│ │ 2. server/middleware/sanitize.js - sanitizeInput()                      89% ││
│ │    Contains: XSS prevention, SQL injection protection                        ││
│ │    Ln 5-28                                                                    ││
│ └─────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                     │
│ ┌─────────────────────────────────────────────────────────────────────────────────┐│
│ │ 3. server/routes/auth.js - register()                                   76% ││
│ │    Uses: validateUser before user creation                                   ││
│ │    Ln 67-89                                                                   ││
│ └─────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                     │
│ Related concepts: input sanitization, form validation, schema validation           │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 7.5 Project Intelligence Dashboard

```
┌─ Project Intelligence ──────────────────────────────────────────────────────────────┐
│                                                                                     │
│ ┌─ Health Score ─────────┐  ┌─ Recent Activity ────────────────────────────────┐   │
│ │                        │  │                                                   │   │
│ │    ┌───────┐           │  │  Today                                           │   │
│ │    │  87   │ /100      │  │  ├─ 10:42 - Modified server/index.js            │   │
│ │    │       │           │  │  ├─ 10:38 - Created server/middleware/auth.js   │   │
│ │    └───────┘           │  │  └─ 10:15 - Installed jsonwebtoken              │   │
│ │                        │  │                                                   │   │
│ │  ● Type coverage: 72%  │  │  Yesterday                                       │   │
│ │  ● Test coverage: 85%  │  │  ├─ 16:30 - Merged PR #42                        │   │
│ │  ● Lint errors: 3      │  │  └─ 14:15 - Fixed terminal resize bug           │   │
│ │  ● TODOs: 12           │  │                                                   │   │
│ │                        │  │                                                   │   │
│ └────────────────────────┘  └───────────────────────────────────────────────────┘   │
│                                                                                     │
│ ┌─ AI Insights ────────────────────────────────────────────────────────────────────┐│
│ │                                                                                   ││
│ │ 💡 Suggestions:                                                                  ││
│ │ • Consider adding types to server/utils/helpers.js (3 untyped exports)          ││
│ │ • The fetchUserData function is duplicated in 3 files - extract to util?        ││
│ │ • auth.js has grown to 400+ lines - consider splitting routes                   ││
│ │                                                                                   ││
│ │ 🔍 Patterns detected:                                                            ││
│ │ • You prefer error-first callbacks → Consider switching to async/await          ││
│ │ • Inconsistent naming: userId vs user_id (23 occurrences each)                  ││
│ │                                                                                   ││
│ └───────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                     │
│ ┌─ Dependency Health ─────────────────────────────────────────────────────────────┐ │
│ │                                                                                  │ │
│ │ 🟢 14 packages up to date                                                       │ │
│ │ 🟡 3 packages have minor updates available                                      │ │
│ │ 🔴 1 package has security vulnerability (jsonwebtoken < 9.0.0)                  │ │
│ │                                                                                  │ │
│ │ [View Details] [Auto-Update Safe]                                               │ │
│ │                                                                                  │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

# 6. Technical Architecture

## 6.1 System Overview

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                  CLAWD IDE ARCHITECTURE                              │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│                              ┌────────────────────────┐                              │
│                              │       Browser          │                              │
│                              │    (Clawd IDE UI)      │                              │
│                              │                        │                              │
│                              │  ┌──────────────────┐  │                              │
│                              │  │  React App       │  │                              │
│                              │  │  ├─ Monaco       │  │                              │
│                              │  │  ├─ xterm.js     │  │                              │
│                              │  │  ├─ Browser      │  │                              │
│                              │  │  │   Panel       │  │                              │
│                              │  │  └─ AI Chat      │  │                              │
│                              │  └──────────────────┘  │                              │
│                              │           │            │                              │
│                              └───────────┼────────────┘                              │
│                                          │                                           │
│                                          │ HTTP + WebSocket                          │
│                                          │ (localhost:3333)                          │
│                                          ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────────────────┐  │
│  │                           IDE Server (Node.js + Express)                       │  │
│  │                                                                                 │  │
│  │  ┌─────────────────────────────────────────────────────────────────────────┐   │  │
│  │  │                              REST API                                    │   │  │
│  │  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐    │   │  │
│  │  │  │ /api/files   │ │ /api/git     │ │ /api/search  │ │ /api/browser │    │   │  │
│  │  │  │              │ │              │ │              │ │              │    │   │  │
│  │  │  │ • read       │ │ • status     │ │ • find       │ │ • proxy      │    │   │  │
│  │  │  │ • write      │ │ • diff       │ │ • replace    │ │ • preview    │    │   │  │
│  │  │  │ • delete     │ │ • commit     │ │ • grep       │ │ • screenshot │    │   │  │
│  │  │  │ • list       │ │ • branch     │ │              │ │              │    │   │  │
│  │  │  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘    │   │  │
│  │  └─────────────────────────────────────────────────────────────────────────┘   │  │
│  │                                                                                 │  │
│  │  ┌─────────────────────────────────────────────────────────────────────────┐   │  │
│  │  │                          WebSocket Server                                │   │  │
│  │  │                                                                          │   │  │
│  │  │  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐         │   │  │
│  │  │  │ Terminal Channel │ │ AI Channel       │ │ File Watch       │         │   │  │
│  │  │  │                  │ │                  │ │ Channel          │         │   │  │
│  │  │  │ • PTY spawn      │ │ • Chat relay     │ │                  │         │   │  │
│  │  │  │ • Input/output   │ │ • Completions    │ │ • File changes