# Project Binding Persistence & Agent Context Injection

**Created:** 2026-03-08
**Completed:** 2026-03-08
**Status:** Done (Phases 1-4) — Phase 5 deferred
**Scope:** Gateway + Pi Runner + UI

---

## Summary

Implemented full project-session binding with persistence, agent context injection, UI system messages, and Telegram topic auto-binding.

## Completed Phases

### Phase 1: Persist Project Bindings on Session Records ✓

- Added `projectId?: string` to `SessionEntry` type (`src/config/sessions/types.ts`)
- `bindSession` / `unbindSession` now persist via session store (`sessions-patch.ts`)
- `getContext` rehydrates from persisted record after gateway restart
- Helper functions: `persistProjectId()`, `readPersistedProjectId()`

**Files changed:**
- `src/config/sessions/types.ts`
- `src/gateway/sessions-patch.ts`
- `src/gateway/server-methods/projects.ts`

---

### Phase 2: Inject Project Context into Agent System Prompt ✓

- Exported `getProjectContextForSession(sessionKey)` from `projects.ts`
- Added `buildProjectContextBlock()` helper in `attempt.ts`
- Project SOUL.md, AGENTS.md, TOOLS.md appended to `extraSystemPrompt` before prompt build
- Missing files gracefully skipped

**Files changed:**
- `src/gateway/server-methods/projects.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`

---

### Phase 3: Visible System Message on Bind/Unbind ✓

- `handleBindProject` appends system message: "Project bound: {name}"
- `handleUnbindProject` appends system message: "Project unbound"
- Existing `ChatMessageBubble` already renders `role: "system"` with centered muted styling

**Files changed:**
- `ui-next/src/components/chat/chat-header.tsx`

---

### Phase 4: Auto-Bind Telegram Topics to Projects ✓

- Extended PROJECTS.md parser to handle multi-line `- **Telegram:**` field with nested `- Group:` and `- Topic:` sub-items
- Added `telegram?: { group?: string; topicId?: number }` to `ProjectEntry` type
- `autoBindByTopicFromSessionKey()` extracts topic ID from session key, matches against PROJECTS.md metadata
- Auto-binding is persisted (match once, cached thereafter)
- Serializer updated to write Telegram metadata back to PROJECTS.md

**Files changed:**
- `src/gateway/server-methods/projects.types.ts`
- `src/gateway/server-methods/projects.ts`

---

### Phase 5: Auto-Detect Project from Conversation Context — DEFERRED

**Reason:** Low value vs complexity. Keyword matching is fuzzy/error-prone, manual binding is one click, and Telegram auto-bind covers the main automatic case.

**If revisited:**
- Parse early messages for PROJECTS.md `keywords` field matches
- Show non-intrusive toast "Bind to X?" with action button
- No silent auto-bind — user confirmation required

---

## Testing Notes

- Build verified: `pnpm build` clean, no compile errors
- Gateway restart tested: bindings survive restart via persisted `projectId` on session records
- Manual UI testing recommended for: project dropdown bind/unbind, system message display, agent prompt content verification
