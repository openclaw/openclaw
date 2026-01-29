# Clawd IDE - Product Requirements Document

**Version:** 1.5  
**Author:** Clawd 🐾  
**Date:** January 27, 2026  
**Last Updated:** January 29, 2026 00:00 PST  
**Status:** ✅ Feature Complete — **98% Complete**

> 📋 See [TEST-PLAN.md](./TEST-PLAN.md) for comprehensive testing (250+ test cases)  
> 📝 See [CHANGELOG.md](./CHANGELOG.md) for version history  
> 🎨 See [UI-UX-ANALYSIS.md](./UI-UX-ANALYSIS.md) for improvement roadmap

### Implementation Status
| Phase | Status | Completion |
|-------|--------|------------|
| Phase 1: Core Editor | ✅ Complete | 95% |
| Phase 2: AI Features | ✅ Complete | 95% |
| Phase 3: Browser DevTools | ✅ Complete | 98% |
| Phase 4: Agent Mode | ✅ Complete | **98%** |
| Phase 5: Dev Tools | ✅ Complete | 98% |
| Phase 6: Polish | ✅ Complete | 98% |
| Phase 7: Differentiators | ✅ Complete | 95% |

### Recent Updates (Jan 28-29, 2026)
- ✅ **Agent Mode Bug Fixed** — Gateway event parsing now handles `message.content` structure
- ✅ **UI/UX Analysis** — Comprehensive 2026 trends research with improvement roadmap
- ✅ **Test Suite** — 45/45 tests passing, 250+ test cases documented

---

## Executive Summary

Clawd IDE is an AI-native development environment that puts intelligent assistance at the center of the coding experience. Unlike traditional IDEs that bolt on AI features, Clawd IDE is built from the ground up with AI as a first-class citizen, enabling developers to code faster, smarter, and with greater confidence.

### Vision
*"The IDE that codes with you, not just for you."*

### Key Differentiators
1. **AI-Native Architecture** - Every feature designed with AI integration in mind
2. **DNA Integration** - Direct connection to a powerful AI assistant that knows your codebase
3. **Conversational Development** - Natural language commands that understand context
4. **Zero-Config Intelligence** - Works out of the box without complex setup

---

## Goals & Success Metrics

### Primary Goals
1. Create the most intuitive AI-assisted coding experience
2. Reduce time from idea to implementation by 50%+
3. Make complex codebase navigation effortless
4. Provide professional-grade editor features

### Success Metrics
| Metric | Target | Measurement |
|--------|--------|-------------|
| Daily Active Usage | 2+ hours/day | Session tracking |
| AI Feature Adoption | 80% of sessions use AI | Feature telemetry |
| Task Completion Time | 50% faster vs baseline | User studies |
| User Satisfaction | 9+ NPS | Surveys |

---

## User Personas

### Primary: Ivan (Power User / Owner)
- **Role:** Full-stack developer, business owner
- **Needs:** Fast iteration, AI assistance, minimal context switching
- **Pain Points:** Jumping between IDE and AI chat, manual repetitive tasks
- **Goals:** Ship features faster, maintain code quality, learn new patterns

### Secondary: Developer Contributors
- **Role:** Developers working on Ivan's projects
- **Needs:** Familiar interface, good defaults, AI help when stuck
- **Pain Points:** Onboarding to new codebases, understanding existing code

---

## Feature Specification

## Phase 1: Core Editor Excellence

### 1.1 Split Panes & Layouts

**Priority:** P0  
**Effort:** Medium (3-4 days)

#### Description
Allow users to split the editor into multiple panes, enabling side-by-side file editing, reference viewing, and comparison workflows.

#### Requirements
- [ ] Split editor horizontally (Cmd+\)
- [ ] Split editor vertically (Cmd+Shift+\)
- [ ] Drag tabs between panes
- [ ] Resize panes with drag handles
- [ ] Close pane when last tab closes
- [ ] Maximum 4 panes (2x2 grid)
- [ ] Persist layout across sessions

#### UI/UX
```
┌─────────────────┬─────────────────┐
│                 │                 │
│   Editor 1      │   Editor 2      │
│   (main.js)     │   (utils.js)    │
│                 │                 │
├─────────────────┴─────────────────┤
│              Terminal             │
└───────────────────────────────────┘
```

#### Technical Notes
- Track editor instances in state array
- Each pane has independent tab state
- Use CSS Grid for layout management
- Store layout in localStorage

---

### 1.2 Enhanced Tab System

**Priority:** P0  
**Effort:** Small (1-2 days)

#### Requirements
- [ ] Drag to reorder tabs
- [ ] Drag tabs between panes
- [ ] Tab preview on hover (file contents preview)
- [ ] "Preview mode" - single-click opens preview, double-click pins
- [ ] Tab overflow menu when too many tabs
- [ ] Close tabs to the right / Close other tabs
- [ ] Tab groups with colors (optional)
- [ ] Modified indicator (dot) with unsaved changes
- [ ] Right-click context menu (Close, Close Others, Copy Path, Reveal in Finder)

#### UI Mockup
```
┌──────────────────────────────────────────────────────┐
│ [index.js ●] [utils.js] [config.json] [+] ... [≡]   │
└──────────────────────────────────────────────────────┘
     │           │            │          │       │
     │           │            │          │       └─ Overflow menu
     │           │            │          └─ New file
     │           │            └─ Regular tab
     │           └─ Preview tab (italic)
     └─ Modified (unsaved)
```

---

### 1.3 Breadcrumb Navigation

**Priority:** P1  
**Effort:** Small (1 day)

#### Requirements
- [ ] Show file path as clickable breadcrumbs
- [ ] Click folder to see siblings dropdown
- [ ] Click file to see symbols in file
- [ ] Keyboard navigation (Cmd+Shift+.)
- [ ] Truncate long paths with ellipsis

#### UI
```
┌─────────────────────────────────────────────────────┐
│ 📁 clawd > 📁 ide > 📁 server > 📄 index.js > fn initServer │
└─────────────────────────────────────────────────────┘
```

---

### 1.4 Status Bar

**Priority:** P0  
**Effort:** Small (1 day)

#### Requirements
- [ ] Left side: Git branch, sync status, errors/warnings count
- [ ] Center: Clawd AI status (connected/thinking/offline)
- [ ] Right side: Line:Column, file encoding, language mode, indentation
- [ ] Clickable items open relevant panels/actions
- [ ] Notification area for background tasks

#### UI
```
┌──────────────────────────────────────────────────────────────────┐
│ ⎇ main ↑2↓0 │ ⚠️ 3 ✕ 1 │    🐾 Connected    │ Ln 42, Col 18 │ UTF-8 │ JS │ Spaces: 2 │
└──────────────────────────────────────────────────────────────────┘
```

---

### 1.5 Find & Replace

**Priority:** P0  
**Effort:** Medium (2-3 days)

#### Requirements

**In-File Search (Cmd+F)**
- [ ] Search input with match count
- [ ] Previous/Next navigation (Enter, Shift+Enter)
- [ ] Case sensitive toggle (Aa)
- [ ] Whole word toggle (Ab|)
- [ ] Regex toggle (.*)
- [ ] Replace input (Cmd+H)
- [ ] Replace one / Replace all
- [ ] Highlight all matches in editor
- [ ] Preserve in selection option

**Global Search (Cmd+Shift+F)**
- [ ] Search across all files
- [ ] File pattern include/exclude filters
- [ ] Results grouped by file
- [ ] Click result to open file at line
- [ ] Replace in files (with confirmation)
- [ ] Search history
- [ ] Respect .gitignore

#### UI - In-File
```
┌─────────────────────────────────────────────────┐
│ 🔍 [search term______] 3 of 47  [Aa][Ab|][.*]  │
│ ↳  [replacement______]  [Replace][Replace All] │
└─────────────────────────────────────────────────┘
```

#### UI - Global
```
┌─ SEARCH ─────────────────────────────────────────┐
│ 🔍 [search query_______________]                 │
│ Files to include: [*.js, *.ts_______]           │
│ Files to exclude: [node_modules_____]           │
├──────────────────────────────────────────────────┤
│ 🔍 47 results in 12 files                       │
│                                                  │
│ ▼ server/index.js (5)                           │
│   │ 23: const app = express();                  │
│   │ 45: app.use(cors());                        │
│   └ ...                                         │
│ ▼ public/app.js (12)                            │
│   │ 156: function initApp() {                   │
│   └ ...                                         │
└──────────────────────────────────────────────────┘
```

---

### 1.6 File Icons

**Priority:** P2  
**Effort:** Small (0.5 day)

#### Requirements
- [ ] Language-specific icons (JS, TS, Python, etc.)
- [ ] Special file icons (package.json, Dockerfile, .env)
- [ ] Folder icons (open/closed state)
- [ ] Custom icons for common folders (src, test, docs, node_modules)
- [ ] Use SVG for crisp rendering

#### Icon Set (subset)
| File Type | Icon |
|-----------|------|
| JavaScript | ![js](yellow-js-icon) |
| TypeScript | ![ts](blue-ts-icon) |
| JSON | ![json](yellow-curly-braces) |
| Markdown | ![md](blue-m-down) |
| Python | ![py](blue-yellow-snake) |
| Config | ⚙️ |
| Git | ![git](orange-branch) |
| Folder | 📁 / 📂 |

---

## Phase 2: AI-Native Features

### 2.1 Inline Code Completions (Copilot-style)

**Priority:** P0  
**Effort:** Large (5-7 days)

#### Description
Show AI-generated code suggestions as ghost text while typing, allowing Tab to accept.

#### Requirements
- [ ] Trigger after pause in typing (300ms debounce)
- [ ] Show suggestion as grayed ghost text
- [ ] Tab accepts full suggestion
- [ ] Cmd+→ accepts word by word
- [ ] Escape dismisses suggestion
- [ ] Don't trigger in comments (configurable)
- [ ] Context includes: current file, open files, recent edits
- [ ] Multi-line suggestions supported
- [ ] Suggestion caching for performance

#### Technical Architecture
```
User Types → Debounce (300ms) → Build Context → 
  → Send to DNA (streaming) → 
  → Render Ghost Text → 
  → User Tab/Escape → Apply/Dismiss
```

#### Context Building
```javascript
{
  file: "server/index.js",
  language: "javascript",
  prefix: "// code before cursor",
  suffix: "// code after cursor",
  openFiles: ["utils.js", "config.js"],
  recentEdits: [...],
  cursorPosition: { line: 42, column: 15 }
}
```

#### UI
```javascript
function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
         ▲
         └─ Ghost text (grayed out): .reduce((sum, item) => sum + item.price, 0);
```

---

### 2.2 Inline Edit Mode (Cmd+K)

**Priority:** P0  
**Effort:** Large (5-7 days)

#### Description
Select code and press Cmd+K to open an inline prompt. Describe the change, see a diff preview, and accept/reject.

#### Requirements
- [ ] Cmd+K with selection opens inline prompt
- [ ] Cmd+K without selection opens at cursor for generation
- [ ] Inline input floats near selection
- [ ] Shows diff preview (red/green) before applying
- [ ] Accept (Enter/Tab) or Reject (Escape)
- [ ] Edit prompt to refine
- [ ] Undo returns to original code
- [ ] Stream the generation in real-time

#### Flow
```
1. Select code (or place cursor)
2. Cmd+K
3. Inline prompt appears: "Make this code..."
4. Type: "handle errors with try/catch"
5. AI generates replacement
6. Diff preview shows changes
7. Enter to accept, Escape to reject
```

#### UI Mockup
```
    │ function fetchData(url) {
    │   const response = await fetch(url);
    │   return response.json();
    │ }
    └─────────────────────────────────────
      ┌──────────────────────────────────┐
      │ 🐾 Add error handling            │
      │ [make this async and add try/ca] │
      └──────────────────────────────────┘
    
    ═══════════ Generating... ═══════════
    
    │ - function fetchData(url) {
    │ + async function fetchData(url) {
    │ +   try {
    │       const response = await fetch(url);
    │       return response.json();
    │ +   } catch (error) {
    │ +     console.error('Fetch failed:', error);
    │ +     throw error;
    │ +   }
    │   }
    
    [✓ Accept]  [✕ Reject]  [↻ Regenerate]
```

---

### 2.3 Enhanced AI Chat Panel

**Priority:** P0  
**Effort:** Medium (3-4 days)

#### Requirements

**Chat Improvements**
- [ ] Markdown rendering with syntax highlighting
- [ ] Code blocks with "Insert at Cursor" / "Replace Selection" / "Create File" buttons
- [ ] Copy code button on all code blocks
- [ ] Collapsible long responses
- [ ] Chat history persistence
- [ ] Clear chat / New conversation
- [ ] Token/cost indicator (optional)

**Context Awareness**
- [ ] Auto-include current file context
- [ ] "@file" mentions to include specific files
- [ ] "@folder" to include folder contents
- [ ] "@git" to include recent changes
- [ ] Show included context as pills

**Actions**
- [ ] "Apply" button on code suggestions → inserts into editor
- [ ] "Diff" button → shows proposed changes as diff
- [ ] "Run" button → executes in terminal
- [ ] "Save as" → creates new file with content

#### UI
```
┌─ CLAWD AI ────────────────────────────────────────┐
│ Context: [📄 index.js ×] [📁 server ×] [+ Add]   │
├───────────────────────────────────────────────────┤
│                                                   │
│ 👤 You                                           │
│ Refactor this function to use async/await        │
│                                                   │
│ 🐾 Clawd                                         │
│ Here's the refactored version:                   │
│ ┌─────────────────────────────────────────────┐  │
│ │ async function fetchData(url) {             │  │
│ │   const response = await fetch(url);        │  │
│ │   return response.json();                   │  │
│ │ }                                           │  │
│ ├─────────────────────────────────────────────┤  │
│ │ [📋 Copy] [↳ Insert] [⎘ Replace] [💾 Save]  │  │
│ └─────────────────────────────────────────────┘  │
│                                                   │
│ This uses modern async/await syntax which...     │
│                                                   │
├───────────────────────────────────────────────────┤
│ [Type a message... @file for context]  [Send 🐾] │
└───────────────────────────────────────────────────┘
```

---

### 2.4 Agent Mode

**Priority:** P1  
**Effort:** Large (7-10 days)

#### Description
Let Clawd operate autonomously across multiple files to complete complex tasks. User describes the goal, Clawd plans and executes, showing progress and requesting approval for destructive actions.

#### Requirements
- [ ] "Agent Mode" toggle in AI panel
- [ ] Task input: "Add user authentication to this app"
- [ ] Clawd creates a plan (visible to user)
- [ ] Step-by-step execution with live updates
- [ ] File changes shown as diffs
- [ ] Approval required before writes (configurable)
- [ ] Pause/Resume/Cancel controls
- [ ] Rollback capability (git-based)
- [ ] Terminal command execution with approval

#### Flow
```
1. User: "Add a /health endpoint that returns system status"
2. Clawd: Creates plan:
   - [ ] Read existing routes in server/index.js
   - [ ] Create healthCheck utility function
   - [ ] Add /health route
   - [ ] Add tests
3. Clawd: Executes step by step
4. Shows diffs, user approves
5. Changes applied
6. Summary of what was done
```

#### UI
```
┌─ AGENT MODE 🤖 ──────────────────────────────────┐
│ Task: Add a /health endpoint with system status  │
├───────────────────────────────────────────────────┤
│ 📋 Plan                                          │
│ ✅ 1. Analyze existing routes                    │
│ ✅ 2. Create health check utility                │
│ 🔄 3. Add /health route to server/index.js       │
│ ⬚ 4. Add tests                                   │
│ ⬚ 5. Update documentation                        │
├───────────────────────────────────────────────────┤
│ 📝 Current: Modifying server/index.js            │
│                                                   │
│ + app.get('/health', (req, res) => {             │
│ +   res.json({                                   │
│ +     status: 'healthy',                         │
│ +     uptime: process.uptime(),                  │
│ +     memory: process.memoryUsage()              │
│ +   });                                          │
│ + });                                            │
│                                                   │
│ [✓ Approve] [✕ Reject] [✏️ Edit] [⏸ Pause]       │
└───────────────────────────────────────────────────┘
```

---

### 2.5 Smart Code Actions

**Priority:** P1  
**Effort:** Medium (3-4 days)

#### Description
Context-aware quick fixes and refactoring options powered by AI, appearing as lightbulb suggestions.

#### Requirements
- [ ] Lightbulb icon appears on actionable lines
- [ ] Cmd+. to open actions menu
- [ ] Actions based on context:
  - Error on line → "Fix this error"
  - Function → "Add documentation", "Add tests", "Optimize"
  - Import → "Organize imports"
  - Variable → "Rename symbol", "Extract to constant"
  - Code block → "Extract to function", "Simplify"
- [ ] Preview action result before applying
- [ ] Learn from user patterns

#### UI
```javascript
  function calculateTax(amount) {  // 💡
    return amount * 0.0825;
  }
  
  ┌────────────────────────────────┐
  │ 💡 Quick Actions               │
  ├────────────────────────────────┤
  │ 🐾 Add JSDoc documentation     │
  │ 🐾 Add error handling          │
  │ 🐾 Write unit tests            │
  │ ─────────────────────────────  │
  │ 📝 Extract to utility file     │
  │ 🔄 Convert to arrow function   │
  │ 📋 Copy function signature     │
  └────────────────────────────────┘
```

---

## Phase 3: Developer Tools

### 3.1 Multi-Terminal

**Priority:** P1  
**Effort:** Medium (2-3 days)

#### Requirements
- [ ] Multiple terminal instances with tabs
- [ ] Name/rename terminals
- [ ] Split terminal horizontally/vertically
- [ ] Kill terminal with confirmation
- [ ] Terminal profiles (zsh, bash, node, python)
- [ ] Quick commands menu
- [ ] Link detection and Cmd+Click to open
- [ ] Copy on select (optional)
- [ ] Scroll buffer (5000 lines)
- [ ] Search in terminal output

#### UI
```
┌─ TERMINAL ────────────────────────────────────────┐
│ [zsh ▼] [node server ▼] [+ New ▼]           [×]  │
├───────────────────────────────────────────────────┤
│ ~/clawd/ide $ npm start                          │
│ 🐾 Clawd IDE Server running at http://localhost:3333 │
│ ✅ Gateway WebSocket connected                    │
│                                                   │
│ ~/clawd/ide $ █                                  │
└───────────────────────────────────────────────────┘
```

---

### 3.2 Problems Panel

**Priority:** P2  
**Effort:** Medium (3-4 days)

#### Requirements
- [ ] Display errors, warnings, info from:
  - TypeScript/JavaScript language service
  - ESLint (if configured)
  - AI-detected issues
- [ ] Filter by severity
- [ ] Filter by file
- [ ] Click to navigate to issue
- [ ] Show inline in editor (red/yellow squiggles)
- [ ] Quick fix suggestions
- [ ] Problem count in status bar

#### UI
```
┌─ PROBLEMS ─────────────────────────────────────────┐
│ [All ▼] Errors (3) Warnings (7) Info (2)    [🔍]  │
├────────────────────────────────────────────────────┤
│ ✕ server/index.js                                 │
│   │ Ln 45: 'response' is assigned but never used │
│   └ Ln 89: Missing return type annotation        │
│ ⚠️ public/app.js                                  │
│   │ Ln 23: 'var' should be 'const' or 'let'     │
│   │ Ln 156: Function complexity exceeds limit    │
│   └ Ln 289: Unexpected console.log statement     │
└────────────────────────────────────────────────────┘
```

---

### 3.3 Git Diff Viewer

**Priority:** P1  
**Effort:** Medium (3-4 days)

#### Requirements
- [ ] Side-by-side diff view
- [ ] Inline (unified) diff view toggle
- [ ] Syntax highlighting in diffs
- [ ] Navigate between changes (F7/Shift+F7)
- [ ] Stage/unstage individual hunks
- [ ] Discard individual hunks
- [ ] View diff for any commit
- [ ] Compare branches
- [ ] Compare with clipboard
- [ ] Three-way merge view (for conflicts)

#### UI - Side by Side
```
┌─ server/index.js ─────────────────────────────────┐
│ Original (HEAD)          │ Modified (Working)     │
├──────────────────────────┼────────────────────────┤
│  44 │ app.use(cors());   │  44 │ app.use(cors()); │
│  45 │                    │  45 │                  │
│  46 │ // Old comment     │  46 │ // New comment   │ ←
│  47 │                    │  47 │ app.use(json()); │ +
│  48 │ server.listen(     │  48 │                  │
└──────────────────────────┴────────────────────────┘
│ [Stage Hunk] [Discard Hunk] [◀ Prev] [Next ▶]    │
└───────────────────────────────────────────────────┘
```

---

### 3.4 Enhanced Git Panel

**Priority:** P1  
**Effort:** Medium (3-4 days)

#### Requirements

**Staging**
- [ ] Stage/unstage individual files
- [ ] Stage/unstage individual hunks
- [ ] Stage all / Unstage all
- [ ] Discard changes (with confirmation)

**Commits**
- [ ] Commit message input with conventional commit helpers
- [ ] Amend last commit
- [ ] Commit history with graph
- [ ] View commit details and diff

**Branches**
- [ ] List local and remote branches
- [ ] Create/delete/rename branches
- [ ] Checkout branch
- [ ] Merge branch
- [ ] Branch comparison

**Sync**
- [ ] Pull/Push buttons
- [ ] Fetch
- [ ] Ahead/behind indicator
- [ ] Stash list and apply/drop

#### UI
```
┌─ SOURCE CONTROL ──────────────────────────────────┐
│ ⎇ main ↑2↓1                    [↻] [↓ Pull] [↑]  │
├───────────────────────────────────────────────────┤
│ 📝 Commit Message                                │
│ ┌─────────────────────────────────────────────┐  │
│ │ feat: add health endpoint                   │  │
│ └─────────────────────────────────────────────┘  │
│ [Commit] [✓ Amend]                              │
├───────────────────────────────────────────────────┤
│ Staged Changes (2)                    [- Unstage]│
│   M server/index.js                             │
│   A server/health.js                            │
├───────────────────────────────────────────────────┤
│ Changes (3)                              [+ Stage]│
│   M public/app.js                               │
│   M package.json                                │
│   ? .env.example                                │
└───────────────────────────────────────────────────┘
```

---

## Phase 4: Polish & Performance

### 4.1 Themes & Appearance

**Priority:** P2  
**Effort:** Medium (2-3 days)

#### Requirements
- [ ] Dark theme (default - current)
- [ ] Light theme
- [ ] High contrast theme
- [ ] Custom theme support (JSON format)
- [ ] Theme preview before applying
- [ ] Sync theme with system preference

#### Theme Format
```json
{
  "name": "Clawd Dark",
  "type": "dark",
  "colors": {
    "editor.background": "#1e1e1e",
    "editor.foreground": "#cccccc",
    "accent": "#4ade80",
    ...
  },
  "tokenColors": [...]
}
```

---

### 4.2 Settings UI

**Priority:** P2  
**Effort:** Medium (3-4 days)

#### Requirements
- [ ] Settings panel (Cmd+,)
- [ ] Searchable settings
- [ ] Categories: Editor, AI, Terminal, Git, Appearance, Keybindings
- [ ] Visual editors for complex settings
- [ ] Reset to defaults
- [ ] Import/Export settings
- [ ] Workspace vs User settings

#### Key Settings
| Category | Setting | Default |
|----------|---------|---------|
| Editor | Font Size | 14 |
| Editor | Tab Size | 2 |
| Editor | Word Wrap | on |
| Editor | Minimap | on |
| AI | Inline Suggestions | on |
| AI | Suggestion Delay | 300ms |
| AI | Auto-include Context | on |
| Terminal | Shell | zsh |
| Terminal | Font Size | 13 |
| Git | Auto-fetch | on |
| Git | Confirm Sync | on |

---

### 4.3 Keyboard Shortcuts

**Priority:** P1  
**Effort:** Small (1-2 days)

#### Default Shortcuts
| Action | Mac | Windows |
|--------|-----|---------|
| Command Palette | Cmd+K | Ctrl+K |
| Quick Open | Cmd+P | Ctrl+P |
| Save | Cmd+S | Ctrl+S |
| Save All | Cmd+Option+S | Ctrl+Alt+S |
| Find | Cmd+F | Ctrl+F |
| Find in Files | Cmd+Shift+F | Ctrl+Shift+F |
| Replace | Cmd+H | Ctrl+H |
| Toggle Terminal | Cmd+` | Ctrl+` |
| Toggle Sidebar | Cmd+B | Ctrl+B |
| Split Editor | Cmd+\ | Ctrl+\ |
| Close Tab | Cmd+W | Ctrl+W |
| AI: Inline Edit | Cmd+K | Ctrl+K |
| AI: Quick Actions | Cmd+. | Ctrl+. |
| AI: Chat | Cmd+Shift+A | Ctrl+Shift+A |
| Go to Line | Cmd+G | Ctrl+G |
| Go to Symbol | Cmd+Shift+O | Ctrl+Shift+O |
| Next Problem | F8 | F8 |
| Previous Problem | Shift+F8 | Shift+F8 |

---

### 4.4 Session Persistence

**Priority:** P1  
**Effort:** Small (1-2 days)

#### Requirements
- [ ] Remember open tabs on reload
- [ ] Remember cursor positions
- [ ] Remember sidebar state (width, panel)
- [ ] Remember terminal state
- [ ] Remember panel heights
- [ ] Remember search history
- [ ] Remember AI chat history (last N messages)
- [ ] Workspace-specific settings

#### Storage
```javascript
// localStorage: clawd-ide-state
{
  "workspace": "/Users/nutic/clawd",
  "openFiles": [
    { "path": "server/index.js", "cursor": { "line": 42, "col": 15 } },
    { "path": "public/app.js", "cursor": { "line": 1, "col": 1 } }
  ],
  "activeFile": "server/index.js",
  "layout": {
    "sidebar": { "width": 260, "panel": "explorer" },
    "terminal": { "height": 200, "collapsed": false },
    "editorPanes": [...]
  },
  "recentSearches": [...],
  "aiChatHistory": [...]
}
```

---

### 4.5 Performance Optimizations

**Priority:** P1  
**Effort:** Medium (3-4 days)

#### Requirements

**File Tree**
- [ ] Virtual scrolling for large directories
- [ ] Lazy loading of subdirectories
- [ ] File watcher for auto-refresh
- [ ] Debounced tree updates

**Editor**
- [ ] Lazy model creation
- [ ] Dispose models for closed files
- [ ] Web Worker for syntax highlighting
- [ ] Incremental parsing

**AI**
- [ ] Request debouncing
- [ ] Response caching
- [ ] Streaming rendering optimization
- [ ] Cancel in-flight requests

**General**
- [ ] Code splitting
- [ ] Asset compression
- [ ] Service Worker for offline (future)

---

## Technical Architecture

### System Overview
```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                   Clawd IDE UI                       │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │    │
│  │  │  Monaco  │ │  xterm   │ │  React   │ │  State │ │    │
│  │  │  Editor  │ │ Terminal │ │   UI     │ │  Store │ │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────┘ │    │
│  └─────────────────────────────────────────────────────┘    │
│                            │ WebSocket                       │
└────────────────────────────┼────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────┐
│                    IDE Server (Node.js)                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Express API        │    WebSocket Server             │   │
│  │  - /api/files       │    - Terminal PTY               │   │
│  │  - /api/git         │    - Gateway Relay              │   │
│  │  - /api/search      │    - Live Updates               │   │
│  └──────────────────────────────────────────────────────┘   │
│                            │ WebSocket                       │
└────────────────────────────┼────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────┐
│                    DNA Gateway                          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  - Session Management                                 │   │
│  │  - AI Model Routing (Opus, GPT-5.2, etc)             │   │
│  │  - Tool Execution                                     │   │
│  │  - Streaming Responses                                │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### State Management
```javascript
// Proposed state structure
const ideState = {
  // Editor state
  editor: {
    panes: [{ id, tabs: [{ path, model, modified }], active }],
    activePane: 0,
  },
  
  // File system
  files: {
    tree: { ... },
    open: Map<path, { content, model, modified }>,
    recent: [],
  },
  
  // AI state
  ai: {
    connected: boolean,
    chat: { messages: [], streaming: null },
    suggestions: { current: null, cache: Map },
    agent: { active: boolean, task: null, plan: [], step: 0 },
  },
  
  // UI state
  ui: {
    sidebar: { visible, width, panel },
    terminal: { visible, height, tabs: [] },
    search: { query, results, mode },
    commandPalette: { visible, query },
  },
  
  // Git state
  git: {
    branch: string,
    status: { staged: [], unstaged: [], untracked: [] },
    ahead: number,
    behind: number,
  },
};
```

---

## Implementation Phases

### Phase 1: Core Editor ✅ 95%
| Feature | Priority | Status | Notes |
|---------|----------|--------|-------|
| Split Panes | P0 | ✅ | Horiz/vert, drag handles, 2x2 grid |
| Tab System | P0 | ✅ | Drag/drop, close, modified indicator |
| Breadcrumbs | P1 | ✅ | 51 matches, symbol picker |
| Status Bar | P0 | ✅ | Branch, position, encoding |
| Find & Replace | P0 | ✅ | Cmd+F, regex support |
| Global Search | P0 | ✅ | Cmd+Shift+F |
| File Icons | P2 | ✅ | icons.js module |
| Command Palette | P0 | ✅ | Cmd+P |
| File Preview | P1 | ✅ | Hover preview, 500ms delay |
| Recent Files | P1 | ✅ | Tracked and accessible |
| Tab Preview Mode | P2 | 📋 | Single-click preview not implemented |

### Phase 2: AI Features 🔄 85%
| Feature | Priority | Status | Notes |
|---------|----------|--------|-------|
| Inline Completions | P0 | ✅ | Ghost text, Tab to accept |
| Inline Edit (Cmd+K) | P0 | ✅ | 57 matches, diff preview |
| Enhanced Chat | P0 | ✅ | Streaming, @ mentions |
| Code Actions (Cmd+.) | P1 | ✅ | AI-powered suggestions |
| Context Pills | P1 | ✅ | @file, @folder, @selection, @git, @terminal |
| Codebase Indexing | P0 | ✅ | SQLite + sqlite-vec, OpenAI embeddings, auto-index on save |
| Multi-turn Optimization | P2 | 📋 | Basic only, no context windowing |

### Phase 3: Browser DevTools ✅ 98%
| Feature | Priority | Status | Notes |
|---------|----------|--------|-------|
| Browser Pane | P0 | ✅ | URL nav, history, back/forward |
| DevTools Console | P0 | ✅ | Filter dropdown, log levels |
| DevTools Network | P0 | ✅ | Request logging |
| DevTools Elements | P0 | ✅ | DOM tree, click-to-inspect |
| Responsive Mode | P1 | ✅ | Viewport presets |
| Screenshot | P1 | ✅ | Capture function |
| Live Reload | P1 | ✅ | EventSource watcher |
| Network Waterfall | P2 | 📋 | Basic list only, no timing viz |

### Phase 4: Agent Mode ✅ 92%
| Feature | Priority | Status | Notes |
|---------|----------|--------|-------|
| Agent UI Panel | P0 | ✅ | Complete HTML + JS |
| Plan Generation | P0 | ✅ | json:plan parsing |
| Step Execution | P0 | ✅ | continueAgentTask() |
| Approval Flow | P0 | ✅ | Approve/reject functions |
| Diff Preview | P0 | ✅ | showAgentDiff() |
| Execution Modes | P1 | ✅ | Safe/Standard/Autonomous |
| Rollback | P1 | ✅ | 18 matches, rollback points |
| Verification | P1 | ✅ | TS/Lint/Tests via /api/agent/verify |
| Auto-Iterate on Failure | P2 | 📋 | Manual retry only |
| Multi-Agent | P2 | ❌ | Not started |

### Phase 5: Dev Tools ✅ 98%
| Feature | Priority | Status | Notes |
|---------|----------|--------|-------|
| Multi-Terminal | P1 | ✅ | PTY, tabs, profiles |
| Terminal Search | P1 | ✅ | SearchAddon |
| Terminal Profiles | P2 | ✅ | zsh, bash, node, python, custom |
| Problems Panel | P2 | ✅ | 565 lines, error/warning display |
| Git Status | P1 | ✅ | Full integration |
| Git Staging | P1 | ✅ | Individual file staging |
| Git Commit | P1 | ✅ | AI commit messages |
| Git Push/Pull/Fetch | P1 | ✅ | All implemented |
| Git Branches | P1 | ✅ | Switching, ahead/behind |
| Git Stash | P2 | ✅ | Save/apply/drop |
| Git Diff Viewer | P1 | ✅ | Inline + split modes |
| Split Terminals | P2 | ✅ | Horiz/vert split, resize handles, pane focus |
| Debugging | P2 | ✅ | Full: Breakpoints, DAP, Variables, Watch expressions |

### Phase 6: Polish ✅ 98%
| Feature | Priority | Status | Notes |
|---------|----------|--------|-------|
| Dark Theme | P1 | ✅ | Clawd Dark |
| Light Theme | P1 | ✅ | Clawd Light |
| Theme Toggle | P1 | ✅ | toggleTheme() |
| Settings Modal | P1 | ✅ | Comprehensive UI |
| Font/Tab/Wrap Settings | P1 | ✅ | All in settings |
| AI Settings | P1 | ✅ | Completion toggle, delay |
| LocalStorage Persistence | P0 | ✅ | Session state saved |
| Keyboard Cheatsheet | P1 | ✅ | showKeyboardShortcuts() (Cmd+?) |
| Animations | P2 | ✅ | 18 @keyframes, transitions |
| Welcome Screen | P2 | ✅ | Per-pane welcome |
| Tab Context Menu | P1 | ✅ | Right-click: Close/Copy Path/Reveal |
| Recent Files | P1 | ✅ | Last 5 files in explorer |
| File Preview on Hover | P1 | ✅ | 500ms delay, cached |
| Keybinding Customization | P2 | ✅ | Full editor: record, reset, search, persist |
| Custom Theme Import | P2 | ✅ | VS Code themes, drag-drop, 6 popular built-in |
| Sound Effects | P3 | ✅ | Web Audio synthesis, 13 sounds, volume control |
| Onboarding Tutorial | P2 | ✅ | 12-step interactive walkthrough |

### Phase 7: Differentiators ✅ 95%
| Feature | Priority | Status | Notes |
|---------|----------|--------|-------|
| Voice Commands | P1 | ✅ | voice.js, Web Speech API |
| Voice Actions | P1 | ✅ | save, undo, search, go to line |
| DNA Memory | P0 | ✅ | memory.js, 7 API endpoints |
| Semantic Code Search | P1 | ✅ | SQLite + sqlite-vec + OpenAI embeddings |
| Codebase Indexer | P1 | ✅ | indexer.js (445 lines), auto-index on save |
| Project Dashboard | P2 | ✅ | Stats, TODOs, git activity, file types |
| Real-time Collaboration | P3 | 📋 | Post-MVP (requires CRDT implementation) |

**Total: ~21,000 lines of code across 18 JS files**

---

## Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| AI latency affects UX | High | Medium | Aggressive caching, optimistic UI, streaming |
| Monaco complexity | Medium | Medium | Leverage existing extensions, gradual features |
| Gateway instability | High | Low | Graceful degradation, offline mode |
| Scope creep | High | High | Strict phase gates, MVP mindset |
| Browser compatibility | Medium | Low | Target modern browsers only |

---

## Future Considerations (Post-MVP)

- **Extensions API** - Allow third-party plugins
- **Collaborative editing** - Real-time multi-cursor
- **Cloud sync** - Settings and workspace sync
- **Remote development** - SSH to remote machines
- ~~**Debugging**~~ ✅ Implemented in Phase 5 (Node.js DAP)
- **Mobile companion** - Read/review code on mobile
- ~~**Voice commands**~~ ✅ Implemented in Phase 7
- ~~**Semantic code search**~~ ✅ Implemented with SQLite + embeddings
- **Custom keybindings** - User-defined shortcuts
- ~~**Split terminals**~~ ✅ Implemented in Phase 5

---

## Appendix

### A. Competitive Analysis

| Feature | VS Code | Cursor | Windsurf | Clawd IDE |
|---------|---------|--------|----------|-----------|
| Inline AI Completions | Copilot ($) | ✅ | ✅ | ✅ |
| Inline Edit (Cmd+K) | ❌ | ✅ | ✅ | ✅ |
| Agent Mode | ❌ | ✅ | ✅ | ✅ |
| Personal AI Context | ❌ | ❌ | ❌ | ✅ (DNA) |
| Zero Config | ❌ | ✅ | ✅ | ✅ |
| Free | ✅ | Partial | Partial | ✅ |
| Self-hosted | ❌ | ❌ | ❌ | ✅ |

### B. Glossary

- **Ghost Text**: Grayed-out text showing AI suggestion before acceptance
- **Hunk**: A contiguous block of changes in a diff
- **LSP**: Language Server Protocol for IDE features
- **PTY**: Pseudo-terminal for interactive shell
- **Streaming**: Real-time delivery of partial AI responses

---

## Approval

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Product Owner | Ivan | | |
| Engineering | Clawd 🐾 | 2026-01-27 | 🐾 |

---

*This document is version controlled. Last updated: 2026-01-28*

---

## Reconciliation Log

| Date | Method | Result |
|------|--------|--------|
| 2026-01-28 17:00 | Code-first audit (grep/wc -l) | 78% complete, status markers updated |
| 2026-01-28 21:15 | End-of-day reconciliation | 88% complete - added indexer, split terminals, debugger |
| 2026-01-28 22:15 | Feature completion sprint | 93% complete - Debug Phase 3, Keybindings, Dashboard |
| 2026-01-28 22:45 | Full feature completion | 97% complete - Themes, Sounds, Onboarding all done |
