# Clawd IDE Modules

This directory contains modular components extracted from the main `app.js`.

## Current Status

**app.js** is currently ~5,500 lines. This modularization plan outlines how to break it into manageable pieces.

## Module Structure (Planned)

```
modules/
├── state.js          # Global state object (~100 lines)
├── icons.js          # File icons SVG definitions (~80 lines)
├── editor.js         # Monaco editor, panes, file operations (~800 lines)
├── tabs.js           # Tab management (~200 lines)
├── breadcrumbs.js    # Breadcrumb navigation + symbols (~300 lines)
├── find-replace.js   # Find & replace functionality (~200 lines)
├── search.js         # Global search (~150 lines)
├── terminal.js       # Terminal integration (~150 lines)
├── git.js            # Git status, commits (~150 lines)
├── ai-chat.js        # AI chat panel, streaming (~500 lines)
├── inline-edit.js    # Cmd+K inline edit (~200 lines)
├── command-palette.js# Command palette (~150 lines)
├── context-menu.js   # Right-click menus (~300 lines)
├── settings.js       # Settings modal (~200 lines)
├── agent-mode.js     # Agent mode UI (~600 lines)
├── notifications.js  # Toast notifications (~50 lines)
└── utils.js          # Shared utilities (~100 lines)
```

## Extraction Priority

1. **High Impact (do first):**
   - `agent-mode.js` - 600 lines, self-contained
   - `ai-chat.js` - 500 lines, mostly independent
   - `icons.js` - 80 lines, no dependencies

2. **Medium Impact:**
   - `git.js` - clean separation
   - `settings.js` - modal is self-contained
   - `terminal.js` - wraps xterm

3. **Complex (do later):**
   - `editor.js` - many dependencies
   - `tabs.js` - tied to editor
   - State management refactor

## How to Extract a Module

1. Identify section boundaries (look for `// ===` comments)
2. Copy functions to new file
3. Ensure shared state access via `window.state`
4. Export functions to `window` for backward compat
5. Add `<script src="modules/xxx.js"></script>` to index.html
6. Remove extracted code from app.js
7. Test thoroughly

## Example Module Pattern

```javascript
// modules/example.js
(function() {
  'use strict';
  
  // Access shared state
  const state = window.state;
  
  // Private functions
  function privateHelper() {
    // ...
  }
  
  // Public functions
  function publicFunction() {
    // ...
  }
  
  // Export to window for onclick handlers
  window.publicFunction = publicFunction;
})();
```

## Load Order in index.html

```html
<!-- Core (must be first) -->
<script src="modules/state.js"></script>
<script src="modules/icons.js"></script>
<script src="modules/utils.js"></script>

<!-- Features (order matters for dependencies) -->
<script src="modules/editor.js"></script>
<script src="modules/tabs.js"></script>
<!-- ... etc ... -->

<!-- Main app (initialization) -->
<script src="app.js"></script>
```

## Migration Notes

- Keep `window.*` exports for backward compatibility with onclick handlers
- Use IIFE pattern to avoid polluting global scope
- Access state via `window.state` not direct import
- Test each extraction independently before moving on

---

*This modularization is planned for Phase 6 (Polish) of the IDE roadmap.*
