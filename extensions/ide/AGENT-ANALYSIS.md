# Agent Mode Analysis & Improvement Plan

**Date:** January 28, 2026  
**Author:** Clawd 🐾  

---

## Executive Summary

Agent Mode has strong foundations but needs fixes and UX enhancements to match industry leaders like Cursor, Windsurf, and Devin. The core architecture is solid - the main issues are in response parsing and UI feedback.

---

## Current State Assessment

### ✅ What Works Well
1. **Mode Selection** - Safe/Standard/Auto modes for different trust levels
2. **Rollback Support** - Git-based rollback point created on task start
3. **Verification Suite** - TypeScript, ESLint, Tests verification built-in
4. **Diff Preview** - Shows changes before applying (in Safe mode)
5. **Pause/Cancel** - Controls for stopping mid-execution

### 🔴 Critical Bug Found

**Bug: Agent responses not parsed correctly**

**Symptoms:**
- AI generates plan in chat (visible as JSON blocks)
- Agent UI stays stuck at "Creating plan..." 
- Plan count shows "0/0"
- No file previews or approval prompts appear

**Root Cause:**
The `parseAgentResponse()` function relies on matching `runId` between the task and incoming gateway events. The `runId` isn't being captured correctly from the initial `chat.send` response.

**Fix Required in `server/index.js`:**

```javascript
// Line ~193 - The runId might be nested differently
const response = await sendToGateway('chat.send', params);
const task = agentTasks.get(taskId);
if (task) {
  // Try multiple paths for runId
  task.runId = response.payload?.runId || 
               response.runId || 
               response.data?.runId ||
               idempotencyKey; // Fallback to idempotency key
  console.log('Agent task runId:', task.runId); // Debug
}

// Line ~580 - Also loosen the matching condition
for (const [taskId, task] of agentTasks) {
  // Match if: no runId set, OR runId matches, OR we just have one active task
  if (!task.runId || task.runId === payload.runId || agentTasks.size === 1) {
    const fullContent = task.buffer || payload.content;
    parseAgentResponse(fullContent, taskId);
    task.buffer = '';
  }
}
```

---

## UX/UI Analysis & Improvements

### 1. **Plan Visibility** (High Priority)

**Current:** Plan shown as simple text list
**Industry Standard:** Devin shows expandable plan with nested sub-tasks, Cursor shows inline annotations

**Improvement:**
```
┌─ 📋 PLAN ─────────────────────────────────────────┐
│ ▼ Step 1: Analyze existing code structure         │
│   └─ Read server/index.js                         │
│   └─ Identify patterns                            │
│                                                   │
│ ▼ Step 2: Create new endpoint                     │
│   └─ Add route handler                            │
│   └─ Add validation                               │
│   └─ Add tests                                    │
│                                                   │
│ ○ Step 3: Update documentation                    │
└───────────────────────────────────────────────────┘
```

**Implementation:**
- Add collapsible sub-steps
- Show estimated time per step
- Add progress bar for overall task

### 2. **Real-time Feedback** (High Priority)

**Current:** "Creating plan..." static text during AI thinking
**Industry Standard:** Cursor/Windsurf show streaming thought process

**Improvement:**
```javascript
// Add streaming indicator with actual content preview
<div class="agent-thinking">
  <div class="thinking-animation">🤔</div>
  <div class="thinking-preview">
    "Analyzing codebase structure..."
    "Found 15 relevant files..."
    "Creating 3-step plan..."
  </div>
</div>
```

### 3. **Diff Preview Enhancement** (Medium Priority)

**Current:** Basic red/green diff
**Industry Standard:** Monaco diff editor with syntax highlighting

**Improvement:**
- Use Monaco's built-in diff editor
- Add "View Full File" toggle
- Show line-by-line annotations
- Add "Edit Before Approving" inline

```javascript
// Use Monaco diff
const diffEditor = monaco.editor.createDiffEditor(container, {
  renderSideBySide: false, // Inline mode
  readOnly: false // Allow edits before approve
});
```

### 4. **Task Input UX** (Medium Priority)

**Current:** Simple textarea with placeholder
**Industry Standard:** 
- Devin: structured task with constraints
- Cursor: inline prompts in editor

**Improvements:**
```
┌─ 🎯 NEW TASK ───────────────────────────────────────┐
│ What do you want to build?                          │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Add user authentication with JWT                │ │
│ └─────────────────────────────────────────────────┘ │
│                                                     │
│ 📁 Context: @file:server/index.js @folder:src/auth │
│ ⚙️ Constraints: [Use Express] [No breaking changes] │
│                                                     │
│ [📎 Attach files] [🔗 Link PR/Issue]               │
│                                                     │
│              [▶ Start Task]                        │
└─────────────────────────────────────────────────────┘
```

### 5. **Progress Persistence** (Medium Priority)

**Current:** Task state lost on page refresh
**Industry Standard:** Devin persists tasks, can resume later

**Improvement:**
- Save task state to localStorage/IndexedDB
- Show "Resume" option for interrupted tasks
- Add task history panel

### 6. **Terminal Integration** (Medium Priority)

**Current:** Verification runs commands separately
**Industry Standard:** Windsurf shows terminal output inline

**Improvement:**
- Show live terminal output during verification
- Allow agent to run arbitrary commands (with approval)
- Stream npm install, test runs, etc.

### 7. **Multi-File Overview** (Low Priority)

**Current:** Shows one file at a time
**Industry Standard:** Devin shows all affected files in tree

**Improvement:**
```
┌─ 📂 FILES AFFECTED (3) ─────────────────────────────┐
│ ✏️  server/index.js          +45 -12  [View Diff]  │
│ ➕  server/auth.js           +120     [View Diff]  │
│ ✏️  package.json             +2       [View Diff]  │
│                                                     │
│ [Approve All] [Review Each]                        │
└─────────────────────────────────────────────────────┘
```

---

## Industry Comparison

| Feature | Clawd IDE | Cursor | Windsurf | Devin |
|---------|-----------|--------|----------|-------|
| Plan visualization | Basic | Inline | Tree | Rich |
| Streaming feedback | ❌ | ✅ | ✅ | ✅ |
| Diff editor | Basic | Monaco | Monaco | Custom |
| Multi-file preview | ❌ | ✅ | ✅ | ✅ |
| Task persistence | ❌ | ❌ | ✅ | ✅ |
| Terminal integration | Partial | ✅ | ✅ | ✅ |
| Rollback support | ✅ | ❌ | ✅ | ✅ |
| Verification suite | ✅ | ❌ | ❌ | ✅ |
| Approval modes | ✅ | ❌ | ✅ | ✅ |

**Key Insight:** Clawd IDE has unique strengths (rollback, verification) but lacks polish in feedback and multi-file handling.

---

## Recommended Implementation Order

### Phase 1: Critical Fixes (1-2 hours)
1. Fix runId tracking bug
2. Add debug logging to trace response flow
3. Test agent task lifecycle end-to-end

### Phase 2: Quick Wins (2-3 hours)
1. Add streaming thought preview
2. Improve diff viewer with Monaco
3. Add multi-file overview panel

### Phase 3: UX Polish (4-6 hours)
1. Collapsible plan steps with sub-tasks
2. Task persistence to localStorage
3. Enhanced task input with context chips
4. Progress bar and time estimates

### Phase 4: Advanced Features (1-2 days)
1. Full terminal integration
2. Task history and resume
3. Collaborative review mode
4. Custom constraints/rules

---

## Code Changes Required

### 1. Fix runId Bug (server/index.js)

```javascript
// Around line 193
async function sendAgentMessage(taskId, prompt, ws, mode = 'safe') {
  const idempotencyKey = crypto.randomBytes(8).toString('hex');
  
  agentTasks.set(taskId, {
    plan: [],
    currentStep: 0,
    pendingStep: null,
    paused: false,
    mode,
    ws,
    buffer: '',
    runId: idempotencyKey, // Use idempotency key as fallback runId
    createdAt: Date.now()
  });
  
  // ... rest of function
}

// Around line 580 - improve matching
for (const [taskId, task] of agentTasks) {
  // Match by runId, or if task was created recently (within 30s)
  const isRecent = Date.now() - task.createdAt < 30000;
  if (task.runId === payload.runId || 
      (!task.runId && isRecent) ||
      agentTasks.size === 1) {
    const fullContent = task.buffer || payload.content;
    console.log('Parsing agent response for task:', taskId);
    parseAgentResponse(fullContent, taskId);
    task.buffer = '';
  }
}
```

### 2. Add Streaming Preview (public/modules/agent.js)

```javascript
// Add new function
function updateAgentThinking(text) {
  const el = document.getElementById('agentStepDescription');
  if (!el) return;
  
  // Show last 3 lines of thinking
  const lines = text.split('\n').filter(l => l.trim()).slice(-3);
  el.innerHTML = `
    <div class="agent-thinking">
      <span class="thinking-dots">●●●</span>
      <span class="thinking-text">${lines.map(l => escapeHtml(l)).join('<br>')}</span>
    </div>
  `;
}

// Update handleAgentMessage to stream
case 'agent:thinking':
  updateAgentThinking(msg.text);
  break;
```

### 3. Multi-file Preview (public/modules/agent.js)

```javascript
function showAgentFilesAffected(files) {
  const container = document.getElementById('agentFilesAffected');
  container.innerHTML = files.map(f => `
    <div class="agent-file-row ${f.type}">
      <span class="file-icon">${f.type === 'create' ? '➕' : f.type === 'delete' ? '❌' : '✏️'}</span>
      <span class="file-name">${escapeHtml(f.path)}</span>
      <span class="file-diff">${f.additions ? `+${f.additions}` : ''} ${f.deletions ? `-${f.deletions}` : ''}</span>
      <button onclick="showFileDiff('${f.path}')">View Diff</button>
    </div>
  `).join('');
  container.classList.remove('hidden');
}
```

---

## Summary

The Agent Mode has a solid foundation but needs:

1. **Bug fix** - runId tracking for response matching
2. **Streaming feedback** - show thinking process
3. **Better diffs** - use Monaco diff editor  
4. **Multi-file view** - see all changes at once
5. **Persistence** - don't lose state on refresh

With these improvements, Clawd IDE's Agent Mode would be competitive with Cursor and Windsurf, while offering unique features like the verification suite and git rollback.

---

*Analysis complete. Ready to implement fixes.*
