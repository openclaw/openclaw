# Command Palette Enhancement Design

> Comprehensive design document for expanding the Clawdbot Control UI command palette

---

## Table of Contents

1. [Overview](#overview)
2. [Current State](#current-state)
3. [Design Goals](#design-goals)
4. [UX Patterns & Inspiration](#ux-patterns--inspiration)
5. [Architecture](#architecture)
6. [Command Categories](#command-categories)
7. [Search & Filtering](#search--filtering)
8. [Keyboard Navigation](#keyboard-navigation)
9. [Visual Design](#visual-design)
10. [Implementation Plan](#implementation-plan)
11. [API Reference](#api-reference)

---

## Overview

The command palette is a keyboard-driven interface for quickly executing actions and navigating the application. This enhancement expands the current basic implementation to include domain-specific commands, intelligent search, recent/favorite commands, and a polished visual experience.

### Key Features

- **100+ commands** across all application domains
- **Fuzzy search** with typo tolerance
- **Recents & Favorites** sections for quick access
- **Category filtering** with sidebar tabs
- **Keyboard shortcut hints** displayed inline
- **Context-aware commands** based on current view
- **Nested command menus** for complex actions
- **Command history** persisted to localStorage

---

## Current State

**File**: `ui/src/ui/components/command-palette.ts`

### Existing Commands (14 total)

| Category | Commands |
|----------|----------|
| Navigation | Chat, Overview, Channels, Sessions, Instances, Cron, Skills, Nodes, Config, Debug, Logs |
| Actions | Refresh Current View, New Chat Session, Toggle Theme |

### Current Limitations

1. No fuzzy search (exact `string.includes()` only)
2. No command history or recents
3. No favorites system
4. Limited keyboard shortcuts (Cmd+1-4, Cmd+K only)
5. No context-aware commands
6. No nested/sub-commands
7. No category filtering in search

---

## Design Goals

### Primary Goals

1. **Speed** - Commands should be accessible within 2-3 keystrokes
2. **Discoverability** - Users can explore available actions
3. **Consistency** - Same patterns across all domains
4. **Accessibility** - Full keyboard navigation, ARIA compliance

### Secondary Goals

1. **Personalization** - Learn from user behavior (recents)
2. **Extensibility** - Easy to add new commands
3. **Visual Polish** - Modern, delightful animations

---

## UX Patterns & Inspiration

### Best Practices from Modern Command Palettes

Based on analysis of leading command palette implementations (VS Code, Linear, Raycast, Vercel):

#### 1. Search Input Design

```
┌─────────────────────────────────────────────────────────┐
│  🔍  Search commands...                          ⌘K    │
└─────────────────────────────────────────────────────────┘
```

- Large, prominent search input
- Placeholder shows keyboard shortcut hint
- Icon on left, shortcut badge on right
- Auto-focus on open

#### 2. Category Tabs/Pills

```
┌──────────────────────────────────────────────────────────┐
│  [ All ]  [ Navigation ]  [ Chat ]  [ Config ]  [ ... ] │
└──────────────────────────────────────────────────────────┘
```

- Horizontal scrolling pill buttons
- "All" selected by default
- Active state with accent color
- Keyboard navigable with arrow keys

#### 3. Command List Structure

```
┌──────────────────────────────────────────────────────────┐
│  RECENTS                                                 │
│  ─────────────────────────────────────────────────────   │
│  ◎  Go to Chat                                    ⌘1    │
│  ◎  Save Configuration                            ⌘S    │
│                                                          │
│  SUGGESTIONS                                             │
│  ─────────────────────────────────────────────────────   │
│  ▸  Go to Overview                               ⌘2    │
│  ▸  Refresh Current View                         ⌘R    │
│  ▸  New Chat Session                             ⌘N    │
└──────────────────────────────────────────────────────────┘
```

- Grouped sections with headers
- Visual indicator for recently used
- Keyboard shortcut aligned right
- Selected item highlight

#### 4. Selected State Animation

```css
/* Smooth selection indicator */
.command-item--selected {
  background: linear-gradient(
    90deg,
    var(--accent-muted) 0%,
    transparent 100%
  );
  border-left: 2px solid var(--accent);
}
```

- Subtle gradient background
- Left border accent indicator
- Spring animation on selection change

#### 5. Empty/No Results State

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│               🔍                                         │
│         No results found                                 │
│    Try a different search term                          │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

- Friendly illustration/icon
- Helpful suggestion text
- Consider "Did you mean...?" suggestions

---

## Architecture

### Type Definitions

```typescript
type CommandCategory =
  | "Navigation"
  | "Chat"
  | "Config"
  | "Logs"
  | "Sessions"
  | "Skills"
  | "Channels"
  | "Cron"
  | "Debug"
  | "System";

type CommandSection = "recents" | "favorites" | "suggestions";

interface CommandItem {
  id: string;
  title: string;
  description?: string;
  category: CommandCategory;
  section?: CommandSection;
  icon?: string;
  shortcut?: string[];
  keywords?: string[];
  tags?: string[];
  action: () => void | Promise<void>;
  when?: () => boolean; // Context predicate
  disabled?: () => boolean;
  children?: CommandItem[]; // Nested commands
}

interface CommandPaletteState {
  open: boolean;
  searchTerm: string;
  activeCategory: CommandCategory | "All";
  selectedIndex: number;
  commandHistory: string[]; // Command IDs
  favorites: string[]; // Command IDs
}
```

### Command Registry Pattern

```typescript
// Central command registry
const commandRegistry = new Map<string, CommandItem>();

function registerCommand(command: CommandItem): void {
  commandRegistry.set(command.id, command);
}

function getCommand(id: string): CommandItem | undefined {
  return commandRegistry.get(id);
}

function getAllCommands(): CommandItem[] {
  return Array.from(commandRegistry.values());
}

// Usage
registerCommand({
  id: "nav.chat",
  title: "Go to Chat",
  category: "Navigation",
  icon: "messageSquare",
  shortcut: ["⌘", "1"],
  keywords: ["conversation", "message", "talk"],
  action: () => navigateTo("chat"),
});
```

### History & Favorites Persistence

```typescript
const STORAGE_KEY_HISTORY = "clawdbot:command-history";
const STORAGE_KEY_FAVORITES = "clawdbot:command-favorites";
const MAX_HISTORY_ITEMS = 10;

function recordCommandUsage(commandId: string): void {
  const history = loadHistory();
  const filtered = history.filter((id) => id !== commandId);
  const updated = [commandId, ...filtered].slice(0, MAX_HISTORY_ITEMS);
  localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(updated));
}

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY) || "[]");
  } catch {
    return [];
  }
}
```

---

## Command Categories

### Navigation Commands (11)

| Command | Shortcut | Description |
|---------|----------|-------------|
| Go to Chat | `⌘1` | Open chat view |
| Go to Overview | `⌘2` | Open overview dashboard |
| Go to Channels | `⌘3` | Open channels view |
| Go to Sessions | `⌘4` | Open sessions view |
| Go to Skills | | Open skills view |
| Go to Cron | | Open cron jobs view |
| Go to Nodes | | Open nodes view |
| Go to Config | `⌘,` | Open configuration |
| Go to Debug | | Open debug/RPC view |
| Go to Logs | | Open logs view |
| Go to Instances | | Open instances view |

### Chat Commands (8)

| Command | Shortcut | Context |
|---------|----------|---------|
| Send Message | `⌘↵` | Chat view, has draft |
| Clear Input | `Esc` | Chat view, has draft |
| Focus Input | `/` | Chat view |
| Copy Last Response | `⌘⇧C` | Chat view, has response |
| New Session | `⌘N` | Any |
| Refresh Chat | `⌘R` | Chat view |
| Toggle Focus Mode | | Chat view |
| Toggle Read Aloud | | Chat view |

### Config Commands (8)

| Command | Shortcut | Context |
|---------|----------|---------|
| Save Configuration | `⌘S` | Config view, has changes |
| Apply Configuration | | Config view |
| Reload Configuration | `⌘⇧R` | Config view |
| Search Settings | `/` | Config view |
| Reset to Defaults | | Config view, confirmation |
| Export Config | | Config view |
| Import Config | | Config view |
| Run Diagnostics | | Config view |

### Logs Commands (7)

| Command | Shortcut | Context |
|---------|----------|---------|
| Focus Filter | `⌘F` | Logs view |
| Clear Logs | | Logs view, confirmation |
| Export Logs | | Logs view, has entries |
| Toggle Auto-Follow | `F` | Logs view |
| Jump to Bottom | `G` | Logs view |
| Refresh Logs | `R` | Logs view |
| Filter by Error | | Logs view |

### Sessions Commands (5)

| Command | Shortcut | Context |
|---------|----------|---------|
| Refresh Sessions | | Sessions view |
| Delete Session | | Has selection |
| Duplicate Session | | Has selection |
| Open in Chat | | Has selection |
| Copy Session Key | | Has selection |

### Skills Commands (4)

| Command | Shortcut | Context |
|---------|----------|---------|
| Refresh Skills | | Skills view |
| Install Skill | | Skills view |
| Toggle Skill | | Has selection |
| Filter Skills | `/` | Skills view |

### Channels Commands (5)

| Command | Shortcut | Context |
|---------|----------|---------|
| Probe All Channels | | Channels view |
| Probe Channel... | | Channels view |
| Configure Channel... | | Channels view |
| Refresh Channels | | Channels view |
| Start WhatsApp Login | | Channels view |

### Cron Commands (4)

| Command | Shortcut | Context |
|---------|----------|---------|
| Refresh Cron Jobs | | Cron view |
| Add Cron Job | | Cron view |
| Run Job Now | | Has selection |
| Delete Job | | Has selection, confirmation |

### Debug Commands (4)

| Command | Shortcut | Context |
|---------|----------|---------|
| Clear RPC Result | | Debug view |
| Copy RPC Result | | Debug view, has result |
| Run Last RPC | | Debug view, has history |
| Refresh Methods | | Debug view |

### System Commands (8)

| Command | Shortcut | Context |
|---------|----------|---------|
| Toggle Theme | `⌘T` | Any |
| Show Keyboard Shortcuts | `?` | Any |
| Open Documentation | | Any |
| Report Issue | | Any |
| Copy Gateway URL | | Connected |
| Toggle Command Palette | `⌘K` | Any |
| Disconnect Gateway | | Connected |
| Connect Gateway | | Disconnected |

---

## Search & Filtering

### Fuzzy Search Algorithm

```typescript
/**
 * Fuzzy match score calculation
 * Higher score = better match
 */
function fuzzyScore(query: string, text: string): number {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  // Exact match gets highest score
  if (textLower === queryLower) return 1000;

  // Starts with query
  if (textLower.startsWith(queryLower)) return 500;

  // Contains query as substring
  if (textLower.includes(queryLower)) return 200;

  // Fuzzy character matching
  let score = 0;
  let queryIndex = 0;
  let consecutiveMatches = 0;

  for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) {
    if (textLower[i] === queryLower[queryIndex]) {
      score += 10 + consecutiveMatches * 5;
      consecutiveMatches++;
      queryIndex++;
    } else {
      consecutiveMatches = 0;
    }
  }

  // All query characters must be found
  if (queryIndex < queryLower.length) return 0;

  return score;
}

/**
 * Search commands with fuzzy matching
 */
function searchCommands(
  commands: CommandItem[],
  query: string,
  category?: CommandCategory
): CommandItem[] {
  const results = commands
    .filter((cmd) => !category || cmd.category === category)
    .map((cmd) => {
      const titleScore = fuzzyScore(query, cmd.title);
      const descScore = fuzzyScore(query, cmd.description || "") * 0.5;
      const keywordScore = Math.max(
        0,
        ...(cmd.keywords || []).map((k) => fuzzyScore(query, k) * 0.8)
      );
      const tagScore = Math.max(
        0,
        ...(cmd.tags || []).map((t) => fuzzyScore(query, t) * 0.6)
      );

      return {
        command: cmd,
        score: Math.max(titleScore, descScore, keywordScore, tagScore),
      };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  return results.map((r) => r.command);
}
```

### Category Filtering

```typescript
type CategoryFilter = CommandCategory | "All";

function filterByCategory(
  commands: CommandItem[],
  filter: CategoryFilter
): CommandItem[] {
  if (filter === "All") return commands;
  return commands.filter((cmd) => cmd.category === filter);
}
```

### Prefix-Based Filtering

Support special prefixes for power users:

| Prefix | Filter |
|--------|--------|
| `>` | Commands only (no navigation) |
| `@` | Sessions/agents |
| `#` | Channels |
| `/` | Chat commands |
| `:` | Config settings |
| `!` | System commands |

```typescript
function parseSearchQuery(query: string): {
  prefix: string | null;
  term: string;
} {
  const prefixes = [">", "@", "#", "/", ":", "!"];
  const firstChar = query[0];

  if (prefixes.includes(firstChar)) {
    return { prefix: firstChar, term: query.slice(1).trim() };
  }

  return { prefix: null, term: query };
}
```

---

## Keyboard Navigation

### Global Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘K` | Toggle command palette |
| `?` | Show keyboard shortcuts modal |
| `Esc` | Close command palette |

### Within Command Palette

| Shortcut | Action |
|----------|--------|
| `↑` / `↓` | Navigate commands |
| `⌘↑` / `⌘↓` | Jump to section start/end |
| `Enter` | Execute selected command |
| `Tab` | Next category |
| `⇧Tab` | Previous category |
| `Esc` | Close palette or clear search |
| `Backspace` (empty) | Reset category to "All" |

### Focus Management

```typescript
function handleKeyDown(event: KeyboardEvent, state: CommandPaletteState): void {
  const { key, metaKey, shiftKey } = event;
  const commands = getFilteredCommands(state);
  const maxIndex = commands.length - 1;

  switch (key) {
    case "ArrowDown":
      event.preventDefault();
      state.selectedIndex = Math.min(state.selectedIndex + 1, maxIndex);
      scrollSelectedIntoView();
      break;

    case "ArrowUp":
      event.preventDefault();
      state.selectedIndex = Math.max(state.selectedIndex - 1, 0);
      scrollSelectedIntoView();
      break;

    case "Enter":
      event.preventDefault();
      const selected = commands[state.selectedIndex];
      if (selected && !selected.disabled?.()) {
        executeCommand(selected);
      }
      break;

    case "Tab":
      event.preventDefault();
      const categories = getAllCategories();
      const currentIdx = categories.indexOf(state.activeCategory);
      const nextIdx = shiftKey
        ? (currentIdx - 1 + categories.length) % categories.length
        : (currentIdx + 1) % categories.length;
      state.activeCategory = categories[nextIdx];
      state.selectedIndex = 0;
      break;

    case "Escape":
      event.preventDefault();
      if (state.searchTerm) {
        state.searchTerm = "";
        state.selectedIndex = 0;
      } else {
        closePalette();
      }
      break;
  }
}
```

---

## Visual Design

### Color Tokens

```css
/* Command Palette specific tokens */
--cp-bg: var(--panel-strong);
--cp-border: var(--border);
--cp-item-hover: rgba(255, 255, 255, 0.05);
--cp-item-selected: var(--accent-muted);
--cp-section-header: var(--muted);
--cp-shortcut-bg: var(--surface-2);
--cp-shortcut-border: var(--border);
```

### Layout Dimensions

```css
.command-palette {
  width: min(640px, 90vw);
  max-height: min(480px, 70vh);
  border-radius: 16px;
  box-shadow: var(--shadow-elevated-lg);
}

.command-palette__input {
  height: 56px;
  font-size: 16px;
}

.command-palette__item {
  height: 44px;
  padding: 0 16px;
}

.command-palette__shortcut {
  padding: 4px 8px;
  font-size: 11px;
  border-radius: 6px;
}
```

### Animation Specifications

```css
/* Palette entrance */
@keyframes palette-enter {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.command-palette {
  animation: palette-enter 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* Item selection */
.command-palette__item {
  transition: background 0.15s ease, transform 0.1s ease;
}

.command-palette__item--selected {
  transform: translateX(2px);
}

/* Staggered list animation */
.command-palette__item:nth-child(1) { animation-delay: 0ms; }
.command-palette__item:nth-child(2) { animation-delay: 20ms; }
.command-palette__item:nth-child(3) { animation-delay: 40ms; }
/* ... */
```

### Responsive Design

```css
@media (max-width: 640px) {
  .command-palette {
    width: 100%;
    max-height: 100%;
    border-radius: 0;
    position: fixed;
    inset: 0;
  }

  .command-palette__categories {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
}
```

---

## Implementation Plan

### Phase 1: Core Infrastructure (2-3 hours)

1. **Command Registry**
   - Create `CommandRegistry` class
   - Define `CommandItem` interface
   - Implement registration/lookup methods

2. **State Management**
   - Add history/favorites persistence
   - Implement state update functions
   - Wire up localStorage

3. **Search Engine**
   - Implement fuzzy search algorithm
   - Add category filtering
   - Support search prefixes

### Phase 2: Commands (3-4 hours)

1. **Navigation Commands**
   - Register all navigation commands
   - Wire up to router/navigation

2. **Domain Commands**
   - Chat commands
   - Config commands
   - Logs commands
   - Sessions commands
   - Skills commands
   - Channels commands
   - Cron commands
   - Debug commands

3. **System Commands**
   - Theme toggle
   - Keyboard shortcuts modal
   - Documentation links

### Phase 3: UI Polish (2-3 hours)

1. **Visual Design**
   - Update CSS for new design
   - Add category tabs
   - Implement section headers

2. **Animations**
   - Entrance animation
   - Selection animation
   - Staggered list items

3. **Accessibility**
   - ARIA attributes
   - Focus management
   - Screen reader announcements

### Phase 4: Integration (1-2 hours)

1. **Global Shortcuts**
   - Wire up new shortcuts
   - Integrate with `global-shortcuts.ts`

2. **Context Awareness**
   - Implement `when` predicates
   - Filter commands by current view

3. **Testing**
   - Unit tests for search
   - Integration tests for commands
   - Accessibility testing

---

## API Reference

### Public API

```typescript
// Open/close the command palette
function openCommandPalette(): void;
function closeCommandPalette(): void;
function toggleCommandPalette(): void;

// Check if open
function isCommandPaletteOpen(): boolean;

// Register commands dynamically
function registerCommand(command: CommandItem): void;
function unregisterCommand(id: string): void;

// Execute a command by ID
function executeCommand(id: string): Promise<void>;

// Favorites management
function addFavorite(id: string): void;
function removeFavorite(id: string): void;
function isFavorite(id: string): boolean;

// History
function getRecentCommands(limit?: number): CommandItem[];
function clearHistory(): void;
```

### Events

```typescript
// Custom events dispatched on document
interface CommandPaletteEvents {
  "command-palette:open": CustomEvent<void>;
  "command-palette:close": CustomEvent<void>;
  "command-palette:execute": CustomEvent<{ command: CommandItem }>;
}
```

### Usage Example

```typescript
import {
  registerCommand,
  openCommandPalette,
} from "./components/command-palette";

// Register a custom command
registerCommand({
  id: "custom.hello",
  title: "Say Hello",
  description: "Display a greeting message",
  category: "System",
  icon: "smile",
  keywords: ["greeting", "hi", "welcome"],
  action: () => {
    toast.success("Hello, world!");
  },
});

// Open palette programmatically
document.addEventListener("keydown", (e) => {
  if (e.key === "p" && e.ctrlKey) {
    openCommandPalette();
  }
});
```

---

## File Structure

```
ui/src/ui/
├── components/
│   ├── command-palette/
│   │   ├── index.ts           # Main component
│   │   ├── registry.ts        # Command registry
│   │   ├── search.ts          # Search engine
│   │   ├── history.ts         # History/favorites
│   │   ├── commands/
│   │   │   ├── navigation.ts  # Navigation commands
│   │   │   ├── chat.ts        # Chat commands
│   │   │   ├── config.ts      # Config commands
│   │   │   ├── logs.ts        # Logs commands
│   │   │   ├── sessions.ts    # Sessions commands
│   │   │   ├── skills.ts      # Skills commands
│   │   │   ├── channels.ts    # Channels commands
│   │   │   ├── cron.ts        # Cron commands
│   │   │   ├── debug.ts       # Debug commands
│   │   │   └── system.ts      # System commands
│   │   └── styles.css         # Scoped styles
```

---

## Notes

- The design draws inspiration from VS Code, Linear, Raycast, and Vercel command palettes
- Magic MCP provided React/Framer Motion patterns that were adapted to Lit/CSS
- The fuzzy search algorithm prioritizes exact matches, prefix matches, and substring matches
- All animations respect `prefers-reduced-motion` media query
- The implementation should be fully keyboard accessible with proper ARIA attributes
