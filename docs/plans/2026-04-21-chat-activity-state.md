# Chat Activity State Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a unified chat activity state so the web UI stops presenting false idle and false busy states during active chat runs.

**Architecture:** Keep Stage 1 inside the UI layer. Derive a single chat activity status from existing local run state, tool activity, session snapshots, and connection state. Render one persistent status strip in chat and stop using `stream !== null` as the sole source of truth for "busy".

**Tech Stack:** TypeScript, Lit, Vitest, existing Control UI state/controllers/views.

---

### Task 1: Add the design-time state shape

**Files:**
- Modify: `ui/src/ui/app-view-state.ts`
- Modify: `ui/src/ui/app.ts`

**Step 1: Write the failing test**

Add a render/helper test that expects a dedicated chat activity object to exist on app state and survive normal render wiring.

**Step 2: Run test to verify it fails**

Run: `pnpm test ui/src/ui/app-render.helpers.node.test.ts -t "chat activity"`

Expected: FAIL because the state field and render wiring do not exist.

**Step 3: Write minimal implementation**

Add a typed chat activity model and initialize it in app state.

**Step 4: Run test to verify it passes**

Run the same command and confirm PASS.

### Task 2: Capture live activity evidence

**Files:**
- Modify: `ui/src/ui/app-tool-stream.ts`
- Modify: `ui/src/ui/controllers/chat.ts`
- Test: `ui/src/ui/app-tool-stream.node.test.ts`
- Test: `ui/src/ui/controllers/chat.test.ts`

**Step 1: Write the failing tests**

Cover:

- tool activity updates last-activity metadata
- stream deltas update last-activity metadata
- terminal chat events clear active state cleanly

**Step 2: Run test to verify it fails**

Run:
- `pnpm test ui/src/ui/app-tool-stream.node.test.ts`
- `pnpm test ui/src/ui/controllers/chat.test.ts`

Expected: FAIL because no unified activity metadata is tracked.

**Step 3: Write minimal implementation**

Track:

- last agent activity timestamp
- active tool count or current tool activity timestamp
- recent completion timestamp for terminal states

Reset this metadata in the same places that reset tool stream or active run state.

**Step 4: Run tests to verify they pass**

Run the same commands and confirm PASS.

### Task 3: Derive the unified chat activity state

**Files:**
- Create: `ui/src/ui/chat-activity.ts`
- Test: `ui/src/ui/chat-activity.test.ts`

**Step 1: Write the failing tests**

Cover:

- sending => `submitting`
- stream text => `streaming`
- tool-only active run => `running_tool`
- active run + recent silence + session running => `silent_processing`
- disconnect while active => `reconnecting`
- stale local run without session evidence => `unknown`
- no active work => `idle`

**Step 2: Run test to verify it fails**

Run: `pnpm test ui/src/ui/chat-activity.test.ts`

Expected: FAIL because the module does not exist.

**Step 3: Write minimal implementation**

Implement a small pure resolver that accepts app/chat/session evidence and returns a display-ready state object.

**Step 4: Run test to verify it passes**

Run the same command and confirm PASS.

### Task 4: Render a persistent chat status strip

**Files:**
- Modify: `ui/src/ui/views/chat.ts`
- Test: `ui/src/ui/views/chat.test.ts`
- Modify: `ui/src/styles/chat/grouped.css` or the existing chat stylesheet used by the view

**Step 1: Write the failing tests**

Cover:

- tool activity with hidden tool calls still shows a visible "running tools" state
- disconnected active run shows reconnecting
- silent active run shows a visible "still processing" state
- completed/error states render the right message when provided

**Step 2: Run test to verify it fails**

Run: `pnpm test ui/src/ui/views/chat.test.ts -t "chat activity"`

Expected: FAIL because no persistent activity strip exists.

**Step 3: Write minimal implementation**

Render the status strip in chat and wire it to the derived activity state. Do not let the strip depend on tool-card visibility.

**Step 4: Run test to verify it passes**

Run the same command and confirm PASS.

### Task 5: Replace ad hoc busy checks

**Files:**
- Modify: `ui/src/ui/views/chat.ts`
- Modify: `ui/src/ui/chat/session-controls.ts`
- Test: `ui/src/ui/chat/session-controls.test.ts`

**Step 1: Write the failing tests**

Cover:

- model/thinking selectors stay disabled while `running_tool` or `silent_processing` is active
- send button only queues when unified activity is busy

**Step 2: Run test to verify it fails**

Run: `pnpm test ui/src/ui/chat/session-controls.test.ts`

Expected: FAIL because controls only inspect `chatRunId` and `chatStream`.

**Step 3: Write minimal implementation**

Switch these controls to the unified activity state or a shared `isChatBusy` equivalent derived from the same rules.

**Step 4: Run test to verify it passes**

Run the same command and confirm PASS.

### Task 6: Reconnect reconciliation

**Files:**
- Modify: `ui/src/ui/app-gateway.ts`
- Test: `ui/src/ui/app-gateway.node.test.ts`

**Step 1: Write the failing test**

Cover:

- reconnect after an active run does not immediately fall back to idle
- reconnect preserves enough evidence to render `reconnecting` or `silent_processing` until session data catches up

**Step 2: Run test to verify it fails**

Run: `pnpm test ui/src/ui/app-gateway.node.test.ts -t "reconnect"`

Expected: FAIL because reconnect currently clears stream state eagerly.

**Step 3: Write minimal implementation**

Keep reconnect-specific activity evidence and let the unified resolver decide the visible state instead of forcing idle semantics.

**Step 4: Run test to verify it passes**

Run the same command and confirm PASS.

### Task 7: Verify the touched surface

**Files:**
- Modify: `ui/src/ui/*` files touched above
- Test: touched test files

**Step 1: Run targeted tests**

Run:

- `pnpm test ui/src/ui/chat-activity.test.ts`
- `pnpm test ui/src/ui/views/chat.test.ts`
- `pnpm test ui/src/ui/controllers/chat.test.ts`
- `pnpm test ui/src/ui/app-tool-stream.node.test.ts`
- `pnpm test ui/src/ui/chat/session-controls.test.ts`
- `pnpm test ui/src/ui/app-gateway.node.test.ts`

**Step 2: Run the local gate for the touched area**

Run: `pnpm check`

Expected: PASS, or a clearly unrelated pre-existing failure that must be reported explicitly.

**Step 3: Summarize residual gaps**

Document any remaining ambiguity that requires protocol work, especially explicit waiting states such as approvals or interactive input.
