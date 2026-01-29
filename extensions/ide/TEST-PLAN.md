# Clawd IDE - Comprehensive Test Plan

**Version:** 1.0  
**Created:** January 28, 2026  
**Author:** Clawd 🐾  
**Status:** Ready for Execution

---

## Table of Contents

1. [Test Strategy Overview](#1-test-strategy-overview)
2. [Test Environment Setup](#2-test-environment-setup)
3. [Phase 1: Core Editor Tests](#3-phase-1-core-editor-tests)
4. [Phase 2: AI Features Tests](#4-phase-2-ai-features-tests)
5. [Phase 3: Browser DevTools Tests](#5-phase-3-browser-devtools-tests)
6. [Phase 4: Agent Mode Tests](#6-phase-4-agent-mode-tests)
7. [Phase 5: Developer Tools Tests](#7-phase-5-developer-tools-tests)
8. [Phase 6: Polish & UX Tests](#8-phase-6-polish--ux-tests)
9. [Phase 7: Differentiators Tests](#9-phase-7-differentiators-tests)
10. [Cross-Cutting Concerns](#10-cross-cutting-concerns)
11. [Bug Tracking Template](#11-bug-tracking-template)
12. [Test Execution Log](#12-test-execution-log)

---

## 1. Test Strategy Overview

### 1.1 Testing Objectives

- **Functional Validation**: Verify all features work as specified in PRD
- **Bug Detection**: Find errors, crashes, and unexpected behaviors
- **Discrepancy Identification**: Document differences between PRD and implementation
- **Regression Prevention**: Ensure fixes don't break existing functionality
- **User Experience**: Validate intuitive, responsive interactions

### 1.2 Testing Approach

| Test Type | Coverage | Priority |
|-----------|----------|----------|
| Functional Testing | All features | P0 |
| UI/UX Testing | All interactions | P0 |
| Integration Testing | Module interactions | P1 |
| Error Handling | Edge cases, invalid inputs | P1 |
| Performance Testing | Load times, responsiveness | P2 |
| Cross-Browser Testing | Chrome, Firefox, Safari | P2 |
| Accessibility Testing | Keyboard nav, screen readers | P3 |
| Security Testing | XSS, injection, auth | P2 |

### 1.3 Test Execution Rules

1. **Before each test session**: Clear localStorage, refresh page
2. **Document everything**: Screenshot errors, note exact steps
3. **Test happy path first**: Then edge cases, then error cases
4. **Use real workspace**: Test with actual project files
5. **Test keyboard shortcuts**: Every feature with shortcuts must be tested both ways

### 1.4 Severity Classification

| Severity | Definition | Example |
|----------|------------|---------|
| 🔴 Critical | App crashes, data loss, feature completely broken | Editor won't load, files deleted |
| 🟠 Major | Feature significantly impaired, workaround exists | Save works but slow, search misses results |
| 🟡 Minor | Feature works but has issues | UI misalignment, wrong icon |
| 🟢 Cosmetic | Visual-only issues | Color slightly off, spacing issue |

---

## 2. Test Environment Setup

### 2.1 Prerequisites Checklist

- [ ] Node.js v18+ installed
- [ ] IDE server running (`cd ~/clawd/ide && npm start`)
- [ ] Browser DevTools accessible (F12)
- [ ] Test workspace with sample files ready
- [ ] localStorage cleared before first test
- [ ] Console open to monitor errors

### 2.2 Test Workspace Structure

Create a test workspace with:
```
test-workspace/
├── src/
│   ├── index.js          # Main JS file with functions
│   ├── utils.js          # Utility functions
│   ├── components/
│   │   └── Button.jsx    # React component
│   └── styles.css        # CSS file
├── server/
│   └── api.js            # Backend code
├── tests/
│   └── index.test.js     # Test file
├── package.json
├── README.md
├── .env                  # Environment file
├── .gitignore
└── node_modules/         # For testing large folder handling
```

### 2.3 Browser Versions to Test

| Browser | Version | Priority |
|---------|---------|----------|
| Chrome | Latest | P0 |
| Firefox | Latest | P1 |
| Safari | Latest | P1 |
| Edge | Latest | P2 |

---

## 3. Phase 1: Core Editor Tests

### 3.1 File Explorer

#### 3.1.1 Basic Navigation
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| FE-001 | Expand folder | Click folder arrow | Folder expands, shows contents | ⬜ |
| FE-002 | Collapse folder | Click expanded folder arrow | Folder collapses | ⬜ |
| FE-003 | Open file | Click file in explorer | File opens in editor tab | ⬜ |
| FE-004 | Double-click file | Double-click file | File opens (pinned, not preview) | ⬜ |
| FE-005 | File icons | Check various file types | Correct icons shown (.js, .json, .md, etc.) | ⬜ |
| FE-006 | Folder icons | Check folder state | Open/closed icon changes | ⬜ |
| FE-007 | Nested folders | Navigate 5+ levels deep | All levels accessible | ⬜ |
| FE-008 | Large folder | Open folder with 100+ files | Loads without freezing | ⬜ |
| FE-009 | Hidden files | Check .dotfiles display | .gitignore, .env visible | ⬜ |
| FE-010 | Recent files | Check recent files section | Last 5 files shown, clickable | ⬜ |

#### 3.1.2 File Operations
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| FE-011 | Create file | Right-click > New File | Input appears, file created | ⬜ |
| FE-012 | Create folder | Right-click > New Folder | Input appears, folder created | ⬜ |
| FE-013 | Rename file | Right-click > Rename | Inline edit, file renamed | ⬜ |
| FE-014 | Delete file | Right-click > Delete | Confirmation, file deleted | ⬜ |
| FE-015 | Delete folder | Right-click > Delete on folder | Deletes folder and contents | ⬜ |
| FE-016 | Duplicate file | Right-click > Duplicate | Creates file-copy.ext | ⬜ |
| FE-017 | Reveal in Finder | Right-click > Reveal | Opens Finder at location | ⬜ |
| FE-018 | Copy path | Right-click > Copy Path | Path copied to clipboard | ⬜ |

#### 3.1.3 Refresh & Sync
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| FE-019 | Refresh explorer | Click refresh button | Tree reloads, picks up external changes | ⬜ |
| FE-020 | External file add | Add file via terminal | File appears after refresh | ⬜ |
| FE-021 | External file delete | Delete file via terminal | File disappears after refresh | ⬜ |

---

### 3.2 Editor Tabs

#### 3.2.1 Tab Management
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| TAB-001 | Open multiple tabs | Click 5 different files | All open as tabs | ⬜ |
| TAB-002 | Switch tabs | Click different tabs | Editor shows selected file | ⬜ |
| TAB-003 | Close tab | Click X on tab | Tab closes, switches to adjacent | ⬜ |
| TAB-004 | Modified indicator | Edit file without saving | Dot appears on tab | ⬜ |
| TAB-005 | Close modified tab | Close unsaved file | Prompt to save appears | ⬜ |
| TAB-006 | Tab overflow | Open 20+ files | Overflow indicator/scroll appears | ⬜ |
| TAB-007 | Middle-click close | Middle-click tab | Tab closes | ⬜ |
| TAB-008 | Keyboard close | Cmd+W | Active tab closes | ⬜ |

#### 3.2.2 Tab Context Menu (Right-click)
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| TAB-009 | Close | Right-click > Close | Tab closes | ⬜ |
| TAB-010 | Close Others | Right-click > Close Others | All other tabs close | ⬜ |
| TAB-011 | Close to Right | Right-click > Close to Right | Tabs to right close | ⬜ |
| TAB-012 | Close All | Right-click > Close All | All tabs close | ⬜ |
| TAB-013 | Copy Path | Right-click > Copy Path | Path in clipboard | ⬜ |
| TAB-014 | Reveal in Explorer | Right-click > Reveal | Scrolls to file in explorer | ⬜ |

---

### 3.3 Editor Core (Monaco)

#### 3.3.1 Basic Editing
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| ED-001 | Type text | Type in editor | Text appears at cursor | ⬜ |
| ED-002 | Delete text | Select and delete | Text removed | ⬜ |
| ED-003 | Undo | Cmd+Z after edit | Edit reversed | ⬜ |
| ED-004 | Redo | Cmd+Shift+Z after undo | Edit restored | ⬜ |
| ED-005 | Copy/Paste | Cmd+C, Cmd+V | Text copied and pasted | ⬜ |
| ED-006 | Cut | Cmd+X | Text cut, clipboard updated | ⬜ |
| ED-007 | Select all | Cmd+A | All text selected | ⬜ |
| ED-008 | Multi-cursor | Cmd+Click multiple locations | Multiple cursors active | ⬜ |
| ED-009 | Column select | Alt+Shift+Drag | Column selection | ⬜ |
| ED-010 | Line duplicate | Alt+Shift+Down | Line duplicated below | ⬜ |
| ED-011 | Line move | Alt+Up/Down | Line moves up/down | ⬜ |
| ED-012 | Line delete | Cmd+Shift+K | Line deleted | ⬜ |

#### 3.3.2 Syntax Highlighting
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| ED-013 | JavaScript | Open .js file | Keywords, strings, comments colored | ⬜ |
| ED-014 | TypeScript | Open .ts file | Types highlighted | ⬜ |
| ED-015 | JSON | Open .json file | Keys, values, syntax highlighted | ⬜ |
| ED-016 | Markdown | Open .md file | Headers, links, code blocks styled | ⬜ |
| ED-017 | CSS | Open .css file | Selectors, properties colored | ⬜ |
| ED-018 | Python | Open .py file | Python syntax highlighted | ⬜ |
| ED-019 | HTML | Open .html file | Tags, attributes colored | ⬜ |

#### 3.3.3 IntelliSense & Autocomplete
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| ED-020 | Autocomplete trigger | Type partial word | Suggestions appear | ⬜ |
| ED-021 | Accept suggestion | Tab or Enter on suggestion | Text inserted | ⬜ |
| ED-022 | Dismiss suggestion | Escape | Dropdown closes | ⬜ |
| ED-023 | Parameter hints | Type function( | Param hints appear | ⬜ |
| ED-024 | Go to definition | Cmd+Click on function | Jumps to definition | ⬜ |

#### 3.3.4 Code Folding
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| ED-025 | Fold function | Click fold arrow | Function body hidden | ⬜ |
| ED-026 | Unfold | Click again | Body visible | ⬜ |
| ED-027 | Fold all | Cmd+K, Cmd+0 | All foldable regions collapsed | ⬜ |
| ED-028 | Unfold all | Cmd+K, Cmd+J | All expanded | ⬜ |

---

### 3.4 Find & Replace

#### 3.4.1 In-File Search (Cmd+F)
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| FR-001 | Open search | Cmd+F | Search bar appears | ⬜ |
| FR-002 | Basic search | Type search term | Matches highlighted, count shown | ⬜ |
| FR-003 | Next match | Enter or Down arrow | Jumps to next match | ⬜ |
| FR-004 | Previous match | Shift+Enter or Up | Jumps to previous match | ⬜ |
| FR-005 | Case sensitive | Toggle Aa button | Matches respect case | ⬜ |
| FR-006 | Whole word | Toggle Ab| button | Only full words matched | ⬜ |
| FR-007 | Regex mode | Toggle .* button | Regex patterns work | ⬜ |
| FR-008 | Close search | Escape | Search bar closes | ⬜ |
| FR-009 | No matches | Search for nonexistent | "0 results" shown | ⬜ |

#### 3.4.2 Replace (Cmd+H)
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| FR-010 | Open replace | Cmd+H | Replace input appears | ⬜ |
| FR-011 | Replace one | Click Replace | Single occurrence replaced | ⬜ |
| FR-012 | Replace all | Click Replace All | All occurrences replaced | ⬜ |
| FR-013 | Replace with empty | Replace with empty string | Text deleted | ⬜ |
| FR-014 | Undo replace all | Cmd+Z after Replace All | All replacements undone | ⬜ |

#### 3.4.3 Global Search (Cmd+Shift+F)
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| FR-015 | Open global search | Cmd+Shift+F | Search panel opens | ⬜ |
| FR-016 | Search all files | Enter search term | Results from multiple files | ⬜ |
| FR-017 | Click result | Click a search result | Opens file at that line | ⬜ |
| FR-018 | File filter include | Set "*.js" filter | Only JS files searched | ⬜ |
| FR-019 | File filter exclude | Exclude "node_modules" | Folder excluded | ⬜ |
| FR-020 | Collapse results | Click file header | Results collapse | ⬜ |
| FR-021 | Clear search | Click clear button | Results cleared | ⬜ |

---

### 3.5 File Save Operations

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| SAV-001 | Save file | Cmd+S | File saved, indicator cleared | ⬜ |
| SAV-002 | Save all | Cmd+Alt+S | All modified files saved | ⬜ |
| SAV-003 | Auto-save | Wait 30s after edit | File auto-saved (if enabled) | ⬜ |
| SAV-004 | Save new file | Create new, Cmd+S | Save dialog appears | ⬜ |
| SAV-005 | Save as | File > Save As | New file created | ⬜ |
| SAV-006 | Save read-only | Try to save read-only file | Error message shown | ⬜ |

---

### 3.6 Breadcrumb Navigation

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| BC-001 | Display path | Open nested file | Breadcrumb shows full path | ⬜ |
| BC-002 | Click folder | Click folder in breadcrumb | Dropdown shows siblings | ⬜ |
| BC-003 | Click file | Click file in breadcrumb | Shows symbols dropdown | ⬜ |
| BC-004 | Navigate sibling | Select sibling from dropdown | Opens that file | ⬜ |
| BC-005 | Jump to symbol | Select function from dropdown | Jumps to function | ⬜ |

---

### 3.7 Status Bar

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| SB-001 | Line/column display | Click around editor | Line:Col updates | ⬜ |
| SB-002 | Click line/column | Click on Ln:Col | Go to line dialog | ⬜ |
| SB-003 | Language mode | Check language indicator | Shows correct language | ⬜ |
| SB-004 | Change language | Click language > select new | Syntax highlighting changes | ⬜ |
| SB-005 | Encoding display | Check encoding | Shows UTF-8 or correct encoding | ⬜ |
| SB-006 | Indentation | Check spaces/tabs | Shows correct setting | ⬜ |
| SB-007 | Git branch | Check git indicator | Shows current branch | ⬜ |
| SB-008 | Memory indicator | Check if shown | Memory status visible | ⬜ |

---

## 4. Phase 2: AI Features Tests

### 4.1 AI Chat Panel

#### 4.1.1 Basic Chat
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| AI-001 | Open chat | Cmd+Shift+A or click icon | Chat panel opens | ⬜ |
| AI-002 | Send message | Type and Enter | Message sent, response appears | ⬜ |
| AI-003 | Streaming response | Send complex query | Response streams in real-time | ⬜ |
| AI-004 | Code blocks | Ask for code | Code blocks with syntax highlighting | ⬜ |
| AI-005 | Copy code | Click copy on code block | Code copied to clipboard | ⬜ |
| AI-006 | Insert code | Click insert button | Code inserted at cursor | ⬜ |
| AI-007 | Replace selection | Select code, click replace | Selection replaced | ⬜ |
| AI-008 | Create file | Click create file on code | New file created with code | ⬜ |
| AI-009 | Clear chat | Click clear button | Chat history cleared | ⬜ |
| AI-010 | Chat history | Close and reopen chat | Previous messages preserved | ⬜ |

#### 4.1.2 Context Integration
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| AI-011 | Auto file context | Ask about current file | AI knows file content | ⬜ |
| AI-012 | @file mention | Type @filename | File added to context | ⬜ |
| AI-013 | Context pills | Add context | Shows as removable pills | ⬜ |
| AI-014 | Remove context | Click X on context pill | Context removed | ⬜ |
| AI-015 | Memory integration | Check memory icon | Memory indicator shown | ⬜ |

### 4.2 Inline Edit (Cmd+K)

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| AI-016 | Open inline edit | Select code, Cmd+K | Inline prompt appears | ⬜ |
| AI-017 | Generate edit | Type instruction, Enter | AI generates changes | ⬜ |
| AI-018 | Diff preview | After generation | Red/green diff shown | ⬜ |
| AI-019 | Accept changes | Click Accept or Enter | Changes applied | ⬜ |
| AI-020 | Reject changes | Click Reject or Escape | Original code restored | ⬜ |
| AI-021 | Edit without selection | Cmd+K with cursor only | Generation at cursor | ⬜ |
| AI-022 | Cancel mid-generation | Escape while generating | Generation stops | ⬜ |

### 4.3 Code Completions

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| AI-023 | Ghost text appears | Pause while typing | AI suggestion as gray text | ⬜ |
| AI-024 | Accept with Tab | Press Tab | Suggestion accepted | ⬜ |
| AI-025 | Dismiss with Escape | Press Escape | Suggestion dismissed | ⬜ |
| AI-026 | Multi-line suggestion | Start function body | Multi-line completion | ⬜ |
| AI-027 | Context awareness | Reference nearby code | Suggestion uses context | ⬜ |

---

## 5. Phase 3: Browser DevTools Tests

### 5.1 Browser Panel

#### 5.1.1 Basic Navigation
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| BR-001 | Open browser | Click browser icon | Browser panel opens | ⬜ |
| BR-002 | Navigate to URL | Type URL, Enter | Page loads in iframe | ⬜ |
| BR-003 | Back button | Click back after navigation | Goes to previous page | ⬜ |
| BR-004 | Forward button | Click forward after back | Goes forward | ⬜ |
| BR-005 | Reload button | Click reload | Page refreshes | ⬜ |
| BR-006 | URL bar update | Navigate via links | URL bar updates | ⬜ |
| BR-007 | Localhost URL | Type localhost:3000 | Local server loads | ⬜ |

#### 5.1.2 Proxy Mode
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| BR-008 | Enable proxy | Click shield icon | Icon turns active/green | ⬜ |
| BR-009 | Load external site | Navigate to google.com | Page loads through proxy | ⬜ |
| BR-010 | Disable proxy | Click shield again | Proxy disabled | ⬜ |
| BR-011 | Proxy persistence | Reload page | Proxy setting preserved | ⬜ |
| BR-012 | Link clicks in proxy | Click link on proxied page | Navigation through proxy | ⬜ |

#### 5.1.3 Responsive Mode
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| BR-013 | Toggle responsive | Click responsive button | Controls appear | ⬜ |
| BR-014 | Device preset | Select iPhone 14 | Viewport resizes | ⬜ |
| BR-015 | Custom size | Enter 500x800 | Viewport matches | ⬜ |
| BR-016 | Scale dropdown | Select 50% | View scales down | ⬜ |

#### 5.1.4 Browser DevTools
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| BR-017 | Open devtools | Click devtools button | DevTools panel opens | ⬜ |
| BR-018 | Console tab | Switch to Console | Console output shown | ⬜ |
| BR-019 | Console input | Type JS and Enter | Executes in iframe | ⬜ |
| BR-020 | Network tab | Switch to Network | Network requests shown | ⬜ |
| BR-021 | Elements tab | Switch to Elements | DOM tree displayed | ⬜ |
| BR-022 | Clear console | Click clear button | Console cleared | ⬜ |

---

## 6. Phase 4: Agent Mode Tests

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| AG-001 | Enable agent mode | Toggle agent mode in chat | Agent UI appears | ⬜ |
| AG-002 | Submit task | Enter task description | Plan generated | ⬜ |
| AG-003 | View plan | After task submission | Steps listed | ⬜ |
| AG-004 | Step execution | Watch execution | Steps update status | ⬜ |
| AG-005 | Diff preview | File modification step | Shows proposed diff | ⬜ |
| AG-006 | Approve change | Click approve | Change applied | ⬜ |
| AG-007 | Reject change | Click reject | Change discarded | ⬜ |
| AG-008 | Pause agent | Click pause | Execution pauses | ⬜ |
| AG-009 | Resume agent | Click resume | Execution continues | ⬜ |
| AG-010 | Cancel agent | Click cancel | Task cancelled | ⬜ |
| AG-011 | Terminal commands | Task requires terminal | Commands shown for approval | ⬜ |

---

## 7. Phase 5: Developer Tools Tests

### 7.1 Terminal

#### 7.1.1 Basic Terminal
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| TM-001 | Open terminal | Cmd+` or click icon | Terminal panel opens | ⬜ |
| TM-002 | Run command | Type `ls`, Enter | Output displayed | ⬜ |
| TM-003 | Clear terminal | Type `clear` | Terminal cleared | ⬜ |
| TM-004 | Copy text | Select and Cmd+C | Text copied | ⬜ |
| TM-005 | Paste command | Cmd+V | Text pasted | ⬜ |
| TM-006 | Ctrl+C | Run long command, Ctrl+C | Command cancelled | ⬜ |
| TM-007 | Working directory | Check pwd | Correct workspace dir | ⬜ |

#### 7.1.2 Multiple Terminals
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| TM-008 | New terminal tab | Click + button | New terminal created | ⬜ |
| TM-009 | Switch terminals | Click different tabs | Switches active terminal | ⬜ |
| TM-010 | Close terminal | Click X on tab | Terminal closed | ⬜ |
| TM-011 | Rename terminal | Double-click tab name | Name editable | ⬜ |

#### 7.1.3 Split Terminals
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| TM-012 | Horizontal split | Click ⊟ button | Terminal splits horizontally | ⬜ |
| TM-013 | Vertical split | Click ⊞ button | Terminal splits vertically | ⬜ |
| TM-014 | Focus pane | Click on pane | Pane gets focus (highlighted) | ⬜ |
| TM-015 | Resize panes | Drag divider | Panes resize | ⬜ |
| TM-016 | Close split pane | Close all tabs in pane | Pane removed, unsplit | ⬜ |

#### 7.1.4 Terminal Profiles
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| TM-017 | Profile dropdown | Click profile dropdown | Shows zsh, bash, node, python, bun | ⬜ |
| TM-018 | Open zsh | Select zsh | Zsh terminal opens | ⬜ |
| TM-019 | Open node REPL | Select Node | Node REPL opens | ⬜ |
| TM-020 | Open python | Select Python | Python REPL opens | ⬜ |
| TM-021 | Profile icon | Check tab icon | Shows correct profile icon | ⬜ |

#### 7.1.5 Quick Commands
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| TM-022 | Open quick commands | Click ⚡ button | Command menu appears | ⬜ |
| TM-023 | Run preset command | Click "npm install" | Command runs in terminal | ⬜ |
| TM-024 | Custom command | Type custom command | Command runs | ⬜ |

### 7.2 Git Integration

#### 7.2.1 Git Status
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| GIT-001 | Open git panel | Click git icon | Git panel opens | ⬜ |
| GIT-002 | View changes | Check changes list | Modified files shown | ⬜ |
| GIT-003 | View diff | Click changed file | Diff displayed | ⬜ |
| GIT-004 | Staged vs unstaged | Check sections | Correctly categorized | ⬜ |

#### 7.2.2 Git Operations
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| GIT-005 | Stage file | Click + on file | File moves to staged | ⬜ |
| GIT-006 | Unstage file | Click - on staged file | File moves to unstaged | ⬜ |
| GIT-007 | Stage all | Click Stage All | All files staged | ⬜ |
| GIT-008 | Commit | Enter message, commit | Commit created | ⬜ |
| GIT-009 | Push | Click push | Commits pushed | ⬜ |
| GIT-010 | Pull | Click pull | Updates pulled | ⬜ |
| GIT-011 | Fetch | Click fetch | Remote updated | ⬜ |

#### 7.2.3 Branch Operations
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| GIT-012 | View branches | Check branch dropdown | Branches listed | ⬜ |
| GIT-013 | Switch branch | Select different branch | Branch switched | ⬜ |
| GIT-014 | Create branch | Click new branch | Branch created | ⬜ |
| GIT-015 | Delete branch | Delete local branch | Branch deleted | ⬜ |

#### 7.2.4 Stash
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| GIT-016 | Create stash | Click stash button | Changes stashed | ⬜ |
| GIT-017 | View stashes | Check stash list | Stashes shown | ⬜ |
| GIT-018 | Apply stash | Click apply on stash | Changes restored | ⬜ |
| GIT-019 | Drop stash | Click delete on stash | Stash removed | ⬜ |

### 7.3 Debugger

#### 7.3.1 Breakpoints
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| DBG-001 | Set breakpoint | Click gutter (line number) | Red dot appears | ⬜ |
| DBG-002 | Remove breakpoint | Click red dot | Breakpoint removed | ⬜ |
| DBG-003 | Breakpoints panel | Open debug panel | Breakpoints listed | ⬜ |
| DBG-004 | Click to jump | Click breakpoint in list | Editor jumps to line | ⬜ |
| DBG-005 | Clear all | Click clear all | All breakpoints removed | ⬜ |
| DBG-006 | Persist breakpoints | Reload page | Breakpoints preserved | ⬜ |

#### 7.3.2 Debug Session
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| DBG-007 | Launch debug | Click play, enter JS file | Debug session starts | ⬜ |
| DBG-008 | Hit breakpoint | Run code with breakpoint | Execution pauses | ⬜ |
| DBG-009 | Current line | When paused | Yellow highlight on line | ⬜ |
| DBG-010 | Continue | Click continue | Runs to next breakpoint | ⬜ |
| DBG-011 | Step over | Click step over | Moves to next line | ⬜ |
| DBG-012 | Step into | Click step into | Enters function | ⬜ |
| DBG-013 | Step out | Click step out | Exits function | ⬜ |
| DBG-014 | Stop debug | Click stop | Session ends | ⬜ |

#### 7.3.3 Variables & Watch
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| DBG-015 | View variables | When paused | Local variables shown | ⬜ |
| DBG-016 | Expand object | Click expand on object | Properties shown | ⬜ |
| DBG-017 | Add watch | Enter expression | Watch added | ⬜ |
| DBG-018 | Watch update | Step through code | Watch values update | ⬜ |
| DBG-019 | Remove watch | Click X on watch | Watch removed | ⬜ |

#### 7.3.4 Call Stack
| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| DBG-020 | View call stack | When paused | Stack frames shown | ⬜ |
| DBG-021 | Click frame | Click different frame | Editor jumps to that context | ⬜ |
| DBG-022 | Variables update | Click frame | Variables show that scope | ⬜ |

### 7.4 Problems Panel

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| PRB-001 | Open problems | Click problems icon | Problems panel opens | ⬜ |
| PRB-002 | View errors | Check error list | Errors shown with icons | ⬜ |
| PRB-003 | View warnings | Check warnings | Warnings listed | ⬜ |
| PRB-004 | Click problem | Click on problem | Jumps to file:line | ⬜ |
| PRB-005 | Filter by type | Toggle error/warning filter | List filters | ⬜ |

### 7.5 Semantic Search

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| IDX-001 | Toggle semantic | Toggle in search panel | Semantic search enabled | ⬜ |
| IDX-002 | Semantic query | Search "function that handles errors" | Relevant results | ⬜ |
| IDX-003 | Relevance score | Check results | Score percentage shown | ⬜ |
| IDX-004 | Click result | Click search result | Opens file at location | ⬜ |
| IDX-005 | Rebuild index | Click rebuild button | Index rebuilds | ⬜ |
| IDX-006 | Index status | Check status | Shows indexed file count | ⬜ |

---

## 8. Phase 6: Polish & UX Tests

### 8.1 Keyboard Shortcuts

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| KB-001 | Open shortcuts | Cmd+? | Shortcuts modal opens | ⬜ |
| KB-002 | All shortcuts listed | Review list | All major shortcuts shown | ⬜ |
| KB-003 | Category grouping | Check categories | Shortcuts grouped logically | ⬜ |
| KB-004 | Close modal | Press Escape | Modal closes | ⬜ |

### 8.2 Custom Keybindings

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| KB-005 | Open settings | Click keybindings in settings | Keybinding editor opens | ⬜ |
| KB-006 | Search bindings | Type in search | Filters shortcuts | ⬜ |
| KB-007 | Record new key | Click record, press keys | New combo recorded | ⬜ |
| KB-008 | Save binding | After recording | Binding saved | ⬜ |
| KB-009 | Reset binding | Click reset on custom | Reverts to default | ⬜ |
| KB-010 | Reset all | Click reset all | All bindings reset | ⬜ |
| KB-011 | Conflict detection | Set duplicate key | Warning shown | ⬜ |
| KB-012 | Persistence | Reload page | Custom bindings preserved | ⬜ |

### 8.3 Themes

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| TH-001 | Open theme settings | Click theme in settings | Theme options shown | ⬜ |
| TH-002 | Built-in themes | Select each theme | Theme applies correctly | ⬜ |
| TH-003 | Clawd Dark | Select Clawd Dark | Dark theme active | ⬜ |
| TH-004 | Clawd Light | Select Clawd Light | Light theme active | ⬜ |
| TH-005 | Dracula | Select Dracula | Dracula colors | ⬜ |
| TH-006 | Nord | Select Nord | Nord colors | ⬜ |
| TH-007 | Import VS Code theme | Import JSON | Theme applied | ⬜ |
| TH-008 | Theme persistence | Reload page | Theme preserved | ⬜ |

### 8.4 Sound Effects

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| SND-001 | Enable sounds | Toggle sounds on | Sounds enabled | ⬜ |
| SND-002 | Save sound | Save file | Sound plays | ⬜ |
| SND-003 | Error sound | Trigger error | Error sound plays | ⬜ |
| SND-004 | Notification sound | Show notification | Sound plays | ⬜ |
| SND-005 | Volume control | Adjust slider | Volume changes | ⬜ |
| SND-006 | Disable sounds | Toggle off | No sounds play | ⬜ |

### 8.5 Onboarding

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| ONB-001 | First launch | Clear localStorage, refresh | Onboarding starts | ⬜ |
| ONB-002 | Step through | Click Next on each step | Progress through all 12 steps | ⬜ |
| ONB-003 | Highlight elements | Each step | Target element highlighted | ⬜ |
| ONB-004 | Skip button | Click Skip | Onboarding ends | ⬜ |
| ONB-005 | Restart onboarding | Settings > Help > Restart | Onboarding restarts | ⬜ |
| ONB-006 | Complete flag | Finish onboarding | Doesn't show again | ⬜ |

### 8.6 Notifications

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| NOT-001 | Success notification | Save file | Green notification appears | ⬜ |
| NOT-002 | Error notification | Trigger error | Red notification appears | ⬜ |
| NOT-003 | Info notification | General action | Blue notification | ⬜ |
| NOT-004 | Auto dismiss | Wait 3-5 seconds | Notification fades | ⬜ |
| NOT-005 | Manual dismiss | Click X | Notification closes | ⬜ |

### 8.7 Dashboard

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| DSH-001 | Open dashboard | Click dashboard icon | Dashboard opens | ⬜ |
| DSH-002 | File stats | Check file section | Counts accurate | ⬜ |
| DSH-003 | Lines of code | Check LOC | Total lines shown | ⬜ |
| DSH-004 | Git activity | Check git section | Recent commits shown | ⬜ |
| DSH-005 | TODOs/FIXMEs | Check todos section | Found items listed | ⬜ |
| DSH-006 | Click TODO | Click on TODO item | Opens file at line | ⬜ |
| DSH-007 | Key files | Check key files | Important files listed | ⬜ |

---

## 9. Phase 7: Differentiators Tests

### 9.1 DNA Memory Integration

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| MEM-001 | Open memory panel | Cmd+M or click brain | Memory panel opens | ⬜ |
| MEM-002 | View memory files | Check file list | MEMORY.md, daily files shown | ⬜ |
| MEM-003 | Quick note | Type note, submit | Note added to daily file | ⬜ |
| MEM-004 | Search memory | Enter search term | Matching content found | ⬜ |
| MEM-005 | Click search result | Click result | Opens at that line | ⬜ |
| MEM-006 | Edit inline | Click edit on memory | Inline editing enabled | ⬜ |
| MEM-007 | Save edit | Save inline edit | Changes saved to file | ⬜ |
| MEM-008 | Cancel edit | Cancel inline edit | Original content | ⬜ |
| MEM-009 | Memory in AI | Ask AI, check context | Memory included in context | ⬜ |
| MEM-010 | Toggle memory | Disable in settings | Memory not included | ⬜ |

### 9.2 Voice Commands

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| VC-001 | Enable voice | Click microphone | Listening starts | ⬜ |
| VC-002 | Say "new file" | Speak command | New file created | ⬜ |
| VC-003 | Say "save" | Speak command | File saved | ⬜ |
| VC-004 | Say "search for X" | Speak command | Search opens with term | ⬜ |
| VC-005 | Stop listening | Click mic again | Listening stops | ⬜ |
| VC-006 | Visual feedback | While listening | Indicator shows active | ⬜ |

### 9.3 File Preview on Hover

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| FP-001 | Hover file | Hover over file 500ms | Preview tooltip appears | ⬜ |
| FP-002 | Preview content | Check tooltip | First 15 lines shown | ⬜ |
| FP-003 | Move away | Move mouse away | Preview disappears | ⬜ |
| FP-004 | Large file | Hover large file | Shows line count | ⬜ |
| FP-005 | Binary file | Hover image/binary | Appropriate message | ⬜ |

---

## 10. Cross-Cutting Concerns

### 10.1 Performance Tests

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| PERF-001 | Initial load | Fresh load with DevTools | < 3 seconds to usable | ⬜ |
| PERF-002 | Large file | Open 10,000 line file | Responsive within 1s | ⬜ |
| PERF-003 | Many files | Open 20+ tabs | No lag when switching | ⬜ |
| PERF-004 | Terminal output | Run command with 1000 lines | Scrolls smoothly | ⬜ |
| PERF-005 | Search large codebase | Search in 1000+ files | Results in < 5 seconds | ⬜ |
| PERF-006 | Memory usage | Check after 30 min use | No memory leak (< 500MB) | ⬜ |

### 10.2 Error Handling

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| ERR-001 | Network offline | Disconnect network | Graceful error message | ⬜ |
| ERR-002 | Server restart | Restart backend | Reconnects automatically | ⬜ |
| ERR-003 | Invalid file path | Try to open non-existent | Error notification | ⬜ |
| ERR-004 | Permission denied | Try to save read-only | Clear error message | ⬜ |
| ERR-005 | WebSocket disconnect | Kill WS connection | Reconnection attempt | ⬜ |
| ERR-006 | API error | Cause AI error | Error shown, recoverable | ⬜ |

### 10.3 Data Persistence

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| DAT-001 | Settings persist | Change settings, reload | Settings preserved | ⬜ |
| DAT-002 | Open files persist | Open tabs, reload | Same tabs reopen | ⬜ |
| DAT-003 | Theme persists | Change theme, reload | Theme preserved | ⬜ |
| DAT-004 | Breakpoints persist | Set breakpoints, reload | Breakpoints preserved | ⬜ |
| DAT-005 | Chat history | Chat, close, reopen | History preserved | ⬜ |
| DAT-006 | Terminal history | Run commands, reload | Command history available | ⬜ |

### 10.4 Security Tests

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| SEC-001 | XSS in file content | Create file with <script> | Script not executed | ⬜ |
| SEC-002 | Path traversal | Try to access ../../etc/passwd | Blocked | ⬜ |
| SEC-003 | Command injection | Try ; rm -rf / in terminal path | Sanitized | ⬜ |
| SEC-004 | Proxy security | Access sensitive URLs | Appropriate handling | ⬜ |

### 10.5 Accessibility Tests

| ID | Test Case | Steps | Expected Result | Status |
|----|-----------|-------|-----------------|--------|
| A11Y-001 | Keyboard navigation | Tab through UI | All interactive elements reachable | ⬜ |
| A11Y-002 | Focus visible | Tab around | Focus indicator visible | ⬜ |
| A11Y-003 | ARIA labels | Check with screen reader | Elements announced correctly | ⬜ |
| A11Y-004 | Color contrast | Check critical text | Meets WCAG AA | ⬜ |
| A11Y-005 | Escape closes modals | Press Escape on modal | Modal closes | ⬜ |

---

## 11. Bug Tracking Template

When a bug is found, document it using this template:

```markdown
### BUG-XXX: [Short Title]

**Severity:** 🔴 Critical / 🟠 Major / 🟡 Minor / 🟢 Cosmetic
**Test ID:** [From above tables]
**Found:** [Date]
**Status:** Open / Fixed / Won't Fix

**Description:**
[What happened]

**Steps to Reproduce:**
1. [Step 1]
2. [Step 2]
3. [Step 3]

**Expected Result:**
[What should happen]

**Actual Result:**
[What actually happened]

**Screenshot/Video:**
[Attach if helpful]

**Environment:**
- Browser: Chrome 120
- OS: macOS 14.0
- Screen: 1920x1080

**Notes:**
[Any additional context]
```

---

## 12. Test Execution Log

### Session Template

```markdown
## Test Session: [Date]

**Tester:** [Name]
**Duration:** [Time]
**Build:** [Commit hash or version]
**Focus Area:** [Phase/Module tested]

### Summary
- Tests Executed: X
- Passed: X
- Failed: X
- Blocked: X

### Bugs Found
1. BUG-XXX: [Title]
2. BUG-XXX: [Title]

### Notes
[Any observations, suggestions, or concerns]

### Next Session Focus
[What to test next]
```

---

## Appendix A: Quick Test Checklist

For rapid smoke testing after changes:

- [ ] Page loads without console errors
- [ ] File explorer shows files
- [ ] Can open file in editor
- [ ] Can edit and save file
- [ ] Terminal opens and runs commands
- [ ] AI chat sends/receives messages
- [ ] Git panel shows status
- [ ] Browser panel loads localhost
- [ ] Keyboard shortcuts work (Cmd+S, Cmd+P, Cmd+F)
- [ ] No JavaScript errors in console

---

## Appendix B: Browser-Specific Issues to Watch

| Issue | Chrome | Firefox | Safari |
|-------|--------|---------|--------|
| WebSocket reconnection | ✓ | Check | Check |
| Monaco performance | ✓ | Check | Check |
| Clipboard API | ✓ | Check | May need permission |
| Web Speech API | ✓ | Limited | Check |
| IndexedDB | ✓ | ✓ | Check quota |

---

**End of Test Plan**

*Total Test Cases: 250+*
*Estimated Full Execution Time: 8-12 hours*
