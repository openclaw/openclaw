# DNA IDE 🧬

**An AI-Native Development Environment**

DNA IDE is a modern, browser-based IDE built from the ground up with AI as a first-class citizen. Unlike traditional IDEs that bolt on AI features, every aspect of DNA IDE is designed for intelligent, conversational development.

![Status](https://img.shields.io/badge/status-98%25%20complete-brightgreen)
![Version](https://img.shields.io/badge/version-1.0.2--beta-blue)

> 📋 [PRD.md](./PRD.md) — Full product specification  
> 🧪 [TEST-PLAN.md](./TEST-PLAN.md) — 250+ test cases  
> 🎨 [UI-UX-ANALYSIS.md](./UI-UX-ANALYSIS.md) — Improvement roadmap

## ✨ Features

### Core Editor
- **Monaco Editor** — VS Code's editor with full IntelliSense
- **Multi-tab editing** with modified indicators and context menus
- **File Explorer** with create, rename, delete, duplicate operations
- **Global Search** (Cmd+Shift+F) with file filters and regex support
- **Find & Replace** (Cmd+F / Cmd+H) with case/word/regex toggles
- **Breadcrumb Navigation** with symbol jumping
- **Syntax Highlighting** for 20+ languages
- **Code Folding** and minimap

### AI Features
- **AI Chat Panel** — Conversational coding with DNA integration
- **Inline Edit** (Cmd+K) — Select code, describe changes, see diff preview
- **Code Completions** — Ghost text suggestions while typing
- **Context Awareness** — @file and @folder mentions for targeted assistance
- **Agent Mode** — Autonomous multi-file task execution with approval workflow
- **Memory Integration** — AI knows your project context from DNA memory

### Browser DevTools
- **Embedded Browser** — Preview web apps without leaving the IDE
- **Proxy Mode** — Load external sites by bypassing iframe restrictions
- **Responsive Mode** — Device presets (iPhone, iPad, Android, Desktop)
- **Built-in DevTools** — Console, Network, and Elements panels
- **Element Inspector** — Click-to-inspect mode with CSS editing

### Terminal
- **Integrated Terminal** — Full shell access with xterm.js
- **Multiple Terminals** — Tabbed interface for parallel sessions
- **Split Panes** — Horizontal and vertical terminal splits
- **Terminal Profiles** — Quick launch zsh, bash, Node REPL, Python, Bun
- **Quick Commands** — Preset commands (npm install, git status, etc.)

### Git Integration
- **Source Control Panel** — Stage, unstage, commit, push, pull
- **Diff Viewer** — Inline and split diff views
- **Branch Management** — Switch, create, delete branches
- **Stash Support** — Create, apply, and drop stashes
- **Status Bar** — Current branch and sync status

### Debugger
- **Breakpoints** — Click gutter to set, persisted across sessions
- **Debug Sessions** — Launch Node.js scripts with --inspect
- **Step Controls** — Continue, Step Over, Step Into, Step Out
- **Variables Panel** — Expandable tree view of local/global scope
- **Watch Expressions** — Add custom expressions to monitor
- **Call Stack** — Navigate stack frames with variable context

### Developer Experience
- **Project Dashboard** — File stats, git activity, TODOs/FIXMEs
- **Semantic Search** — AI-powered code search with embeddings
- **Problems Panel** — Centralized error and warning view
- **Custom Keybindings** — Record and remap any shortcut
- **Themes** — Built-in themes + VS Code theme import
- **Sound Effects** — Audio feedback for actions (optional)
- **Onboarding Tutorial** — Interactive 12-step walkthrough
- **Diagnostic Test Suite** — 70+ tests across 15 categories (Settings → Developer)

### Testing & Quality
- **Security Tests** — XSS, path traversal, CORS, sensitive data
- **Accessibility Tests** — ARIA, keyboard nav, color contrast
- **Performance Tests** — DOM, memory, API response times
- **Stress Tests** — Rapid API calls, large data handling
- **Quick Diagnostics** — Run core tests with one click

### Differentiators
- **DNA Memory** — Quick notes, memory search, AI context integration
- **Voice Commands** — Hands-free file operations and navigation
- **File Preview** — Hover to preview file contents

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/clawd-ide.git
cd clawd-ide

# Install dependencies
npm install

# Start the server
npm start
```

Open http://localhost:3333 in your browser.

### Configuration

Set your workspace path in the URL or configure in settings:
```
http://localhost:3333?workspace=/path/to/your/project
```

### Optional: AI Features

For AI features to work, ensure DNA Gateway is running and configured.

## ⌨️ Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Command Palette | Cmd+Shift+P |
| Quick Open File | Cmd+P |
| Save | Cmd+S |
| Find in File | Cmd+F |
| Find in Files | Cmd+Shift+F |
| AI Chat | Cmd+Shift+A |
| Inline Edit | Cmd+K |
| Toggle Terminal | Cmd+` |
| Toggle Sidebar | Cmd+B |
| Keyboard Shortcuts | Cmd+? |
| Memory Panel | Cmd+M |
| Metacognitive Dashboard | Cmd+Shift+M |
| Session History | Cmd+Shift+H |
| Cycle Layouts | Cmd+Option+Tab |

## 📁 Project Structure

```
clawd-ide/
├── public/
│   ├── app.js              # Main application logic
│   ├── browser.js          # Browser panel module
│   ├── index.html          # Entry point
│   ├── styles.css          # Core styles
│   └── modules/
│       ├── agent.js        # Agent mode
│       ├── dashboard.js    # Project dashboard
│       ├── debugger.js     # Debug integration
│       ├── git.js          # Git operations
│       ├── keybindings.js  # Custom shortcuts
│       ├── memory.js       # DNA memory
│       ├── onboarding.js   # Tutorial system
│       ├── sounds.js       # Audio feedback
│       ├── terminal.js     # Terminal emulator
│       ├── themes.js       # Theme management
│       └── voice.js        # Voice commands
├── server/
│   ├── index.js            # Express server + API
│   ├── dap-client.js       # Debug Adapter Protocol
│   └── indexer.js          # Semantic search indexer
├── PRD.md                  # Product Requirements
├── TEST-PLAN.md            # Comprehensive test plan
└── CHANGELOG.md            # Version history
```

## 📊 Status

| Phase | Completion |
|-------|------------|
| Core Editor | 95% |
| AI Features | 95% |
| Browser DevTools | 98% |
| Agent Mode | 92% |
| Developer Tools | 98% |
| Polish & UX | 98% |
| Differentiators | 95% |
| **Overall** | **97%** |

## 🧪 Testing

See [TEST-PLAN.md](./TEST-PLAN.md) for the comprehensive test plan with 250+ test cases.

```bash
# Quick smoke test
npm start
# Open http://localhost:3333
# Verify: file explorer, editor, terminal, AI chat work
```

## 🛠️ Tech Stack

- **Frontend**: Vanilla JS, Monaco Editor, xterm.js
- **Backend**: Node.js, Express, WebSocket
- **AI**: DNA Gateway integration
- **Search**: SQLite + sqlite-vec for embeddings
- **Debug**: Node.js Inspector Protocol (CDP)

## 📝 License

MIT

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run the test plan
5. Submit a pull request

---

Built with 🐾 by Clawd
