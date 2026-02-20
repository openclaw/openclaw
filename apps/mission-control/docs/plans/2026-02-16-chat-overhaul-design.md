# Chat Interface Overhaul — Design

## Goal

Transform the chat from plain-text rendering to a modern AI chat experience with markdown rendering, syntax-highlighted code blocks, auto-generated session titles, agent progress visibility, and improved input UX.

## Approach: Component-Level Upgrade (A)

Create new focused components and plug them into the existing chat-panel.tsx. Keep session management, SSE streaming, API routes, and virtual scrolling untouched.

## Changes

### 1. ChatMarkdown Component (NEW)

**File:** `src/components/chat/chat-markdown.tsx`

- Wraps `react-markdown` v9+ with `remark-gfm` and `rehype-highlight`
- Custom renderers: code blocks with copy button and language label, tables with borders, links open in new tab
- Scoped CSS (`.chat-markdown` class) — NOT using @tailwindcss/typography to avoid side effects in learning-hub and web-sources
- Memoized per message content string for virtual scroll performance

**CRITICAL:** Only used for finalized messages. Streaming text stays as plain `whitespace-pre-wrap` to avoid jank from re-parsing markdown on every delta event.

### 2. Chat Session Titles

- Auto-generate title from first user message (first 60 chars, trimmed at word boundary)
- Store as `label` in session sidebar display
- Update session list to show generated title instead of raw session key
- Backend: already supports session labeling via the sessions API

### 3. Agent Progress Indicator

- Replace static "Agent is thinking..." with a live timer: "Agent is working... (15s)"
- Timer counts up every second while streaming/waiting
- Show "Agent is using tools..." when `stopReason === "toolUse"`
- Every 30 seconds, pulse the indicator to reassure the user

### 4. Message Actions

- Copy button (clipboard icon) on hover for each message
- Retry button on assistant messages (resends the previous user message)
- Compact action bar appears on message hover, right-aligned

### 5. Improved Composer

- Suggested prompts on empty chat state (3-4 starters based on context)
- Better visual styling for the send button
- Character count indicator for long messages

### 6. Code Block Enhancements

- Language label in top-right corner of code blocks
- Copy button in top-right corner
- Syntax highlighting via highlight.js (rehype-highlight)
- Dark theme code blocks matching the app's dark mode
- Horizontal scroll for wide code

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| react-markdown | ^9.0.0 | Markdown rendering (React 19 compatible) |
| remark-gfm | ^4.0.0 | GitHub-flavored markdown (tables, strikethrough) |
| rehype-highlight | ^7.0.0 | Syntax highlighting for code blocks |
| highlight.js | (peer dep) | Language grammars for syntax highlighting |

## Files to Modify

| File | Change |
|------|--------|
| `src/components/chat/chat-markdown.tsx` | NEW — markdown renderer component |
| `src/components/chat/chat-markdown.css` | NEW — scoped styles for markdown in chat |
| `src/components/views/chat-panel.tsx` | Replace plain text rendering with ChatMarkdown, add progress timer, add message actions, add session title generation, add empty state prompts |
| `package.json` | Add react-markdown, remark-gfm, rehype-highlight |

## Risk Mitigations

- Streaming text stays plain (no markdown during streaming) — avoids performance issues
- Scoped CSS instead of typography plugin — avoids side effects in other components
- cleanText() continues to run BEFORE markdown rendering
- Error/fallback branches NOT wrapped in markdown
- React.memo on ChatMarkdown to work well with virtual scrolling (80 message window)

## Audit Findings

- Current build: clean (0 TypeScript errors)
- File attachments: separate rendering path, no risk
- Council mode: will look better with markdown (bullet formatting)
- Virtual scrolling: 80 message window manageable with memoized markdown
- React Compiler enabled: needs testing but skipLibCheck helps
