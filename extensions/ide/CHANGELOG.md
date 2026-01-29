# Changelog

All notable changes to Clawd IDE are documented in this file.

## [1.0.3-beta] - 2026-01-29

### 🧠 Self-Learning System Phase 1 Implementation

#### Fixed
- **Brain Popover Positioning** — Popover now appears ABOVE status bar indicator instead of off-screen below it
  - Changed from top-based to bottom-based positioning
  - Added maxHeight constraint to prevent viewport overflow
  - Added scroll overflow for content that exceeds available space
  - See `knowledge/bugs/2026-01-29-006-brain-popover-offscreen.md`

#### Added - Core Infrastructure
- **knowledge/user-graph.json** — Knowledge graph with entities, relationships, preferences, decisions
- **modules/brain.js** — Frontend Brain module (19KB)
- **Brain API** — 8 new endpoints in server/index.js

#### Features Implemented
- **Status Bar Indicator** — Shows 🧠 confidence % and 🔥 streak
  - Green pulse: 90%+ confidence (actively learning)
  - Amber: 70-90% (learning phase)
  - Gray: <70% or insufficient data
- **Quick Popover** — Click brain icon to see:
  - Accuracy, Learned count, Entities count
  - Streak badge
  - Recent learnings (last 3)
  - Achievement progress bars
  - "Open Full Panel" button (Phase 3)
- **localStorage Cache** — Instant display with background refresh
- **Achievement System** — 6 achievements with progress tracking:
  - 🎯 First Memory (unlocked on init)
  - 📚 Quick Learner (10 observations/day)
  - 🔥 Week Warrior (7-day streak)
  - 🔍 Pattern Hunter (25 patterns)
  - 💻 Code Whisperer (50 coding prefs)
  - 💯 Century Club (100+ observations)

#### API Endpoints
```
GET  /api/brain/status     — Quick status for status bar
GET  /api/brain/graph      — Full knowledge graph
POST /api/brain/observe    — Record observation
PUT  /api/brain/confirm/:id — Confirm inference
DELETE /api/brain/forget/:id — Delete knowledge
GET  /api/brain/timeline   — Activity feed
GET  /api/brain/achievements — Achievement status
POST /api/brain/export     — Export data
PUT  /api/brain/settings   — Update settings
```

#### Initial Knowledge Import
Auto-imported from profile/*.md:
- 9 entities (Ivan, family, businesses)
- 10 relationships (married_to, owns, works_with, etc.)
- Coding preferences (camelCase, single quotes, async/await)
- Work patterns (night sessions, phased approach)
- Recent decisions (3)
- Goals (4)

---

## [1.0.2-beta] - 2026-01-29

### 🧠 Self-Learning & User Knowledge System PRD

#### Added
- **PRD-SELF-LEARNING-SYSTEM.md** — Comprehensive 1000+ line product requirements document
- **SELF-LEARNING-PANEL-PROPOSAL.md** — UI/UX design proposal with mockups

#### PRD Covers
- Memory architecture (Factual, Behavioral, Coding, Temporal, Relational)
- Recording mechanisms (real-time extraction, session consolidation, scheduled analysis)
- Agent responsibilities (Main Agent vs Subagent)
- 6-layer storage architecture (cache → graph → archive)
- Knowledge graph schema with confidence levels
- Privacy & security controls
- Full UI specifications (status bar, popover, 7-tab panel)
- Gamification system (15 achievements, streaks, weekly digests)
- 6-phase implementation plan (~65-77 hours)

#### Research Incorporated
- **Mem0** (2025) — Extraction → Evaluation → Storage pipeline
- **AWS AgentCore** — Hierarchical memory architecture  
- **A2UI Framework** (2026) — "Agentic Knowledge Graphs" dynamic visualization

#### All Decisions Finalized
- Scope: All channels (IDE, WhatsApp, Discord)
- Verification: Hybrid (ask if <90% confidence, silent if ≥90%)
- Graph visualization: Optional toggle with JSON Crack + A2UI patterns
- Migration: Graph = source of truth, generate profile files weekly
- Estimated monthly cost: ~$3.50 for subagent tasks

---

### 🧪 Comprehensive Diagnostic Test Suite v2.0

#### Added - Test Categories (8 New)
- **Security Tests** — XSS protection, path traversal prevention, CORS headers, CSP, sensitive data detection
- **Accessibility Tests** — Alt text, form labels, keyboard navigation, ARIA roles, color contrast
- **Error Recovery Tests** — Global error handlers, unhandled rejection handling, graceful API failures
- **WebSocket Stability Tests** — Connection state, reconnection logic, offline message queue, heartbeat
- **File Operations Tests** — CRUD operations, binary files, special characters, deep paths
- **Agent Reliability Tests** — Response times, endpoint availability, JSON error formats
- **State Persistence Tests** — Theme, tabs, editor settings, sidebar state, recent files
- **Stress Tests** — Rapid API calls, large localStorage writes, DOM manipulation, JSON performance

#### Added - Settings Panel
- **Developer Section** — New section in Settings modal
  - 🔍 "Run Tests" — Opens visual test runner in new tab
  - ⚡ "Quick Check" — Runs core diagnostics inline with toast results
  - 🐛 "Console" — Shows DevTools keyboard shortcut

#### Fixed
- **Agent List API Timeout** — Changed gateway message format from `api:request`/`requestId` to `req`/`id`
- **Lint Test** — Now uses real file path instead of non-existent test file

#### Improved
- Test suite now has ~70 tests across 15 categories (up from 36 tests in 7 categories)
- Added `runQuick()` for fast core-only testing
- Added `runCategory(name)` for targeted testing
- Added critical issue tracking separate from warnings
- Added timeout wrapper on all tests to prevent hanging
- Added p50/p95/p99 percentiles to performance measurements

#### Technical
- Fixed all 3 agent API endpoints (`/api/agents/list`, `/api/agents/spawn`, `/api/agents/history`)
- Diagnostic script auto-loads when "Quick Check" is used
- Toast notifications for diagnostic results

---

## [1.0.1-beta] - 2026-01-29

### 🐛 Critical Bug Fix: Agent Mode

#### Fixed
- **Agent Mode Event Parsing** — Gateway events now correctly parsed from `payload.message.content[0].text` structure
- Plan parsing and file preview now work correctly
- Agent lifecycle events properly trigger response parsing

#### Added
- **UI/UX Analysis Document** — Comprehensive 2026 trends research with improvement roadmap
- Research-based recommendations for calm UI, typography, color refinement
- Competitive analysis vs Cursor, Windsurf, Devin
- Implementation priority phases with CSS examples

#### Documentation
- Updated PRD to v1.5, 98% complete
- Added UI-UX-ANALYSIS.md with 450+ lines of recommendations
- Memory notes for session continuity

---

## [1.0.0-beta] - 2026-01-28

### 🎉 Major Milestone: 97% Feature Complete

This release marks the IDE as feature-complete and ready for daily use.

### Added

#### Core Editor
- Monaco Editor integration with full IntelliSense
- Multi-tab editing with modified indicators
- File Explorer with full CRUD operations
- Global search with file filters and regex
- Find & Replace with case/word/regex toggles
- Breadcrumb navigation with symbol jumping
- Syntax highlighting for 20+ languages
- Recent files quick access

#### AI Features
- AI Chat panel with DNA integration
- Inline Edit mode (Cmd+K) with diff preview
- Ghost text code completions
- @file and @folder context mentions
- Agent Mode for autonomous multi-file tasks
- Memory integration for project context

#### Browser DevTools
- Embedded browser panel with iframe preview
- **Proxy Mode** - bypass iframe restrictions for external sites
- Responsive mode with device presets
- Built-in DevTools (Console, Network, Elements)
- Element inspector with click-to-select

#### Terminal
- Integrated terminal with xterm.js
- Multiple terminal tabs
- **Split terminal panes** (horizontal/vertical)
- **Terminal profiles** (zsh, bash, Node, Python, Bun)
- Quick command presets

#### Git Integration
- Source control panel with staging
- Inline and split diff viewer
- Branch switching and creation
- Stash management (create, apply, drop)
- Push, pull, fetch operations

#### Debugger
- **Breakpoint UI** - click gutter to toggle
- **Debug sessions** - launch Node.js with --inspect
- **Step controls** - continue, step over/into/out
- **Variables panel** - expandable tree view
- **Watch expressions** - custom expression monitoring
- **Call stack** - navigate frames with context

#### Developer Tools
- **Project Dashboard** - stats, TODOs, git activity
- **Semantic Search** - embeddings-based code search
- Problems panel with error/warning aggregation
- **Custom Keybindings** - record and remap shortcuts

#### Polish & UX
- **Theme system** with VS Code theme import
- Built-in themes: Clawd Dark, Clawd Light, Dracula, Nord, Monokai, GitHub
- **Sound effects** - Web Audio synthesis (optional)
- **Onboarding tutorial** - 12-step interactive walkthrough
- Keyboard shortcuts cheatsheet (Cmd+?)
- Tab context menu (Close Others, Close to Right, Copy Path)
- File preview on hover

#### Differentiators
- **DNA Memory Integration** - quick notes, search, AI context
- **Voice Commands** - hands-free file operations
- Notification system with auto-dismiss

### Technical
- Express server with WebSocket support
- Debug Adapter Protocol (DAP) client for Node.js
- SQLite + sqlite-vec for semantic indexing
- Modular frontend architecture (15 JS modules)
- ~21,000 lines of code across 18 JS files

---

## [0.9.0] - 2026-01-27

### Added
- Initial editor implementation
- Basic file operations
- Terminal integration
- AI chat prototype
- Git status display

---

## Development Notes

### Architecture Decisions
- **Vanilla JS** chosen over frameworks for simplicity and control
- **Monaco Editor** for VS Code-quality editing experience
- **WebSocket** for real-time terminal and file watching
- **SQLite** for embeddings storage (no external DB required)

### Known Limitations
- Real-time collaboration not yet implemented (requires CRDT)
- Editor split panes not yet implemented (tabs only)
- Some proxy mode sites with heavy JS may not work perfectly

### Performance Targets
- Initial load: < 3 seconds
- Large file open (10K lines): < 1 second
- Search in 1000+ files: < 5 seconds

---

[1.0.0-beta]: https://github.com/yourusername/clawd-ide/releases/tag/v1.0.0-beta
[0.9.0]: https://github.com/yourusername/clawd-ide/releases/tag/v0.9.0
