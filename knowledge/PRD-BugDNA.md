# BugDNA System — Product Requirements Document

**Version:** 1.0  
**Created:** 2026-01-28  
**Author:** Clawd (AI Assistant)  
**Status:** Draft  

---

## Executive Summary

BugDNA is an automatic bug capture, knowledge retention, and self-improvement system for AI-assisted development. It records significant bugs and their solutions, learns from patterns, and proactively warns before repeating past mistakes.

**Core Philosophy:** Turn every debugging session into permanent institutional knowledge.

---

## Problem Statement

### Current Pain Points
1. **Knowledge Loss** — Solutions discovered during debugging sessions are forgotten
2. **Repeated Mistakes** — Same bugs encountered multiple times across projects
3. **No Pattern Recognition** — Similar issues aren't connected or learned from
4. **Context Loss** — When bugs recur, original context and solution details are gone
5. **Manual Documentation** — Bug tracking requires explicit effort, so it doesn't happen

### Desired Outcome
- Automatic capture of significant bugs with full context
- Searchable knowledge base of problems and solutions
- Proactive warnings before repeating past mistakes
- Self-improving system that learns what's worth recording

---

## Goals & Non-Goals

### Goals
- ✅ Automatically capture bugs meeting significance threshold
- ✅ Record full context: files, commands, errors, stack traces
- ✅ Link problems to verified solutions
- ✅ Enable semantic search across bug knowledge
- ✅ Proactively warn when approaching known problem areas
- ✅ Learn user preferences on what's worth recording
- ✅ Cross-project pattern recognition

### Non-Goals
- ❌ Replace traditional issue trackers (Jira, GitHub Issues)
- ❌ Track feature requests or enhancements
- ❌ Production error monitoring (Sentry territory)
- ❌ Real-time alerting

---

## System Architecture

### Directory Structure

```
~/clawd/knowledge/
├── bugs/                          # Individual bug records
│   ├── 2026-01-28-terminal-css-overflow.md
│   ├── 2026-01-28-port-already-in-use.md
│   └── ...
├── patterns/                      # Reusable pattern knowledge
│   ├── css-overflow-issues.md
│   ├── node-port-conflicts.md
│   └── ...
├── solutions/                     # Standalone solution recipes
│   ├── xterm-height-fix.md
│   ├── kill-process-on-port.md
│   └── ...
├── index/                         # Machine-readable indexes
│   ├── bugs.jsonl                 # Bug fingerprints & metadata
│   ├── patterns.jsonl             # Pattern signatures
│   └── confidence.yaml            # Learning data
└── PRD-BugDNA.md                  # This document
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        CAPTURE LAYER                            │
├─────────────────────────────────────────────────────────────────┤
│  Session Errors  │  Console Logs  │  Failed Commands  │  Gotchas│
└────────┬─────────┴───────┬────────┴─────────┬─────────┴────┬────┘
         │                 │                  │              │
         ▼                 ▼                  ▼              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     DETECTION ENGINE                            │
│  • Error pattern matching                                       │
│  • Time-spent heuristic (>5 min debugging)                      │
│  • Investigation depth detection                                │
│  • Confidence scoring                                           │
└────────────────────────────┬────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         ┌────────┐    ┌──────────┐   ┌──────────┐
         │ AUTO   │    │   ASK    │   │  SKIP    │
         │ RECORD │    │  USER    │   │          │
         └───┬────┘    └────┬─────┘   └──────────┘
             │              │
             ▼              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     KNOWLEDGE BASE                              │
│  bugs/*.md  │  patterns/*.md  │  solutions/*.md  │  index/*    │
└────────────────────────────┬────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ SEMANTIC SEARCH │ │ PROACTIVE WARN  │ │ PATTERN LEARN   │
│ (memory_search) │ │ (before action) │ │ (consolidate)   │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

## File Formats

### Bug Record (`bugs/*.md`)

```markdown
---
id: bug-2026-01-28-001
title: Terminal CSS overflow causing invisible content
severity: medium          # low | medium | high | critical
category: [css, layout, xterm]
project: clawd-ide
tags: [terminal, overflow, height, xterm.js]
fingerprint: "xterm height > 50000"
first_seen: 2026-01-28T09:30:00-08:00
resolved_at: 2026-01-28T09:45:00-08:00
resolution_time_min: 15
status: resolved          # open | resolved | wontfix | duplicate
source: session           # session | console | ci | logs | manual
confidence: high          # low | medium | high
verified: true            # solution confirmed working
related_bugs: []
related_patterns: [css-overflow-issues]
---

# Terminal CSS Overflow Bug

## Symptom
Terminal in Clawd IDE appears empty/collapsed. No shell prompt visible despite 
server running and WebSocket connected.

## Error Signature
```
termSize.h = 59545   # Abnormally large (should be ~200)
panelSize.h = 200    # Container much smaller than content
hasXterm = true      # Terminal initialized correctly
```

## Context
- **File:** `/Users/nutic/clawd/ide/public/styles.css`
- **Component:** Bottom panel terminal container
- **Environment:** Clawd IDE, xterm.js 5.3.0, Monaco Editor
- **Trigger:** Page load / terminal initialization

## Investigation Steps
1. Verified server running (`lsof -i :3333`)
2. Checked API endpoints working (`curl localhost:3333/api/file`)
3. Browser console showed no errors
4. DOM inspection revealed terminal element had content
5. Computed styles showed massive height on terminal element

## Root Cause
xterm.js calculates container height based on scrollback buffer 
(5000 lines × ~12px = ~60000px) when parent container doesn't have 
explicit height constraints.

The CSS classes `.bottom-panel-container` and `.bottom-panel-content` 
were referenced in HTML but **never defined in styles.css**.

## Solution
Added missing CSS rules with proper height constraints:

```css
.bottom-panel-container {
  display: flex;
  flex-direction: column;
  height: 220px;
  min-height: 100px;
  max-height: 500px;
  background: var(--bg-primary);
  border-top: 1px solid var(--border);
}

.bottom-panel-content {
  flex: 1;
  overflow: hidden;
}

.bottom-panel-content #terminal {
  flex: 1;
  height: 100%;
  overflow: hidden;
}
```

## Prevention Checklist
- [ ] Always define CSS for classes referenced in HTML
- [ ] Set explicit height constraints on xterm containers
- [ ] Test terminal visibility after any CSS changes
- [ ] Use browser DevTools to check computed dimensions

## Lessons Learned
- DOM element having content ≠ content being visible
- Flex containers need height constraints to contain children
- xterm.js is sensitive to container sizing

## References
- xterm.js fit addon: https://github.com/xtermjs/xterm.js/tree/master/addons/xterm-addon-fit
```

### Pattern Record (`patterns/*.md`)

```markdown
---
id: pattern-css-overflow
title: CSS Overflow / Invisible Content Issues
category: css
frequency: common
bugs_linked: [bug-2026-01-28-001]
---

# CSS Overflow Issues

## Description
Child element calculates size based on content (scrollback, dynamic lists, etc.) 
but parent doesn't constrain it, causing content to overflow and become invisible.

## Detection Signals
- Element exists in DOM with content but appears empty
- Computed height/width much larger than viewport
- `overflow: hidden` on ancestor clips everything
- Flex child without constraints

## Common Causes
1. Missing explicit height/width on container
2. Flex container without `overflow: hidden`
3. Child uses percentage height but parent has no height
4. Dynamic content libraries (xterm, virtual scroll) calculating unbounded sizes

## General Solution Pattern
```css
.container {
  height: [explicit value];    /* or max-height */
  overflow: hidden;            /* or auto */
}

.child {
  height: 100%;
  max-height: 100%;
}
```

## Quick Diagnosis
```javascript
// Check if element is rendering outside viewport
const el = document.querySelector('.suspect');
console.log({
  offset: { w: el.offsetWidth, h: el.offsetHeight },
  computed: getComputedStyle(el).height,
  parent: el.parentElement.offsetHeight
});
```

## Related Bugs
- [[bug-2026-01-28-001]] — Terminal CSS overflow in Clawd IDE
```

### Solution Recipe (`solutions/*.md`)

```markdown
---
id: solution-xterm-height-fix
title: Fix xterm.js Container Height Issues
applies_to: [xterm.js, terminal emulators]
difficulty: easy
time_estimate: 5min
---

# Fix xterm.js Container Height

## Problem
xterm.js terminal appears empty or has wrong dimensions.

## Quick Fix

### 1. Ensure container has explicit height
```css
#terminal-container {
  height: 300px;  /* or 100%, but parent must have height */
  overflow: hidden;
}
```

### 2. Call fit() after container is sized
```javascript
const fitAddon = new FitAddon.FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(container);

// Wait for container to have dimensions
requestAnimationFrame(() => fitAddon.fit());

// Re-fit on resize
new ResizeObserver(() => fitAddon.fit()).observe(container);
```

### 3. Verify dimensions
```javascript
const dims = fitAddon.proposeDimensions();
console.log('Terminal dimensions:', dims);  // Should show reasonable cols/rows
```

## Common Mistakes
- Calling `fit()` before container has dimensions
- Container using `height: auto` (xterm needs explicit height)
- Missing `overflow: hidden` causing scrollbar issues
```

### Bug Index (`index/bugs.jsonl`)

```jsonl
{"id":"bug-2026-01-28-001","fingerprint":"xterm height > 50000","title":"Terminal CSS overflow","severity":"medium","project":"clawd-ide","tags":["css","xterm","overflow"],"status":"resolved","created":"2026-01-28T09:30:00-08:00"}
{"id":"bug-2026-01-28-002","fingerprint":"EADDRINUSE.*3333","title":"Port 3333 already in use","severity":"low","project":"clawd-ide","tags":["node","server","port"],"status":"resolved","created":"2026-01-28T09:25:00-08:00"}
```

### Confidence Learning (`index/confidence.yaml`)

```yaml
# Learning data for automatic capture decisions
version: 1
last_updated: 2026-01-28T10:00:00-08:00

# Patterns that should always be recorded
always_record:
  - pattern: "stack trace"
    reason: "Always significant"
  - pattern: "took .* minutes"
    reason: "Time investment indicates significance"
  - pattern: "finally figured out"
    reason: "Breakthrough moment"

# Patterns to always skip
always_skip:
  - pattern: "typo"
    reason: "Too minor"
  - pattern: "forgot to save"
    reason: "Not a real bug"

# Learned decisions (from asking user)
learned:
  - context: "CSS class missing"
    decision: record
    learned_at: 2026-01-28T09:45:00-08:00
    bug_id: bug-2026-01-28-001
  
  - context: "port already in use"
    decision: record
    learned_at: 2026-01-28T09:25:00-08:00
    bug_id: bug-2026-01-28-002

# Confidence thresholds
thresholds:
  auto_record: 0.8      # Record without asking
  ask_user: 0.4         # Ask for confirmation
  auto_skip: 0.2        # Skip without asking
```

---

## Detection Engine

### Trigger Conditions

A potential bug is detected when ANY of these occur:

| Trigger | Detection Method | Confidence Boost |
|---------|------------------|------------------|
| Error keyword | Regex: `error\|exception\|failed\|crash` | +0.2 |
| Stack trace | Regex: `at .+:\d+:\d+` or `Traceback` | +0.3 |
| Time spent | >5 minutes on same issue | +0.4 |
| Investigation depth | Multiple diagnostic commands | +0.3 |
| Explicit debugging | Terms: "debug", "investigate", "figure out" | +0.2 |
| Aha moment | Terms: "found it", "that was", "the issue was" | +0.3 |
| Root cause identified | Terms: "root cause", "the problem was" | +0.4 |

### Confidence Scoring

```
base_confidence = 0.3

for each trigger matched:
    confidence += trigger.boost

if matches_learned_pattern(context):
    confidence = learned_decision.confidence

final_decision:
    if confidence >= 0.8: AUTO_RECORD
    if confidence >= 0.4: ASK_USER
    else: SKIP
```

### Capture Context

When recording, automatically capture:

```yaml
context:
  timestamp: ISO8601
  session_id: current session
  
  # What was happening
  active_file: path to file being edited
  recent_commands: last 5 shell commands
  recent_tool_calls: last 5 tool invocations
  
  # Error details
  error_message: full error text
  stack_trace: if available
  
  # Environment
  project: detected from workspace
  git_branch: current branch
  git_status: clean/dirty
  
  # Resolution
  solution_applied: description of fix
  files_modified: list of changed files
  verification: how we confirmed it worked
```

---

## Retrieval System

### Semantic Search Integration

BugDNA integrates with existing `memory_search` tool:

```javascript
// When searching memory, also search knowledge base
memory_search({ query: "terminal not showing" })
// Returns matches from:
// - memory/*.md (existing)
// - knowledge/bugs/*.md (new)
// - knowledge/patterns/*.md (new)
```

### Proactive Warning System

Before executing actions, check knowledge base:

```
┌─────────────────────────────────────────────────────────┐
│ PROACTIVE CHECK FLOW                                    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. Extract action context                              │
│     - Files being modified                              │
│     - Commands being run                                │
│     - Technologies involved                             │
│                                                         │
│  2. Search knowledge base                               │
│     - Fingerprint matching                              │
│     - Tag/category matching                             │
│     - Semantic similarity                               │
│                                                         │
│  3. If match found with confidence > 0.6:               │
│     → Show brief warning                                │
│     "FYI: Similar issue in bug-xxx — [title]"          │
│                                                         │
│  4. Continue with action                                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Warning Format

Non-intrusive, inline with conversation:

```
> About to modify styles.css for the terminal panel...

💡 FYI: Similar issue in bug-2026-01-28-001 — Terminal CSS overflow. 
   Key lesson: Always set explicit height on xterm containers.

[continues with action]
```

---

## Learning System

### Feedback Loop

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   DETECT     │────▶│     ASK      │────▶│    LEARN     │
│   potential  │     │    USER      │     │   decision   │
│     bug      │     │              │     │              │
└──────────────┘     └──────┬───────┘     └──────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
        ┌──────────┐              ┌──────────┐
        │  RECORD  │              │   SKIP   │
        │  + save  │              │  + save  │
        │  context │              │  reason  │
        └──────────┘              └──────────┘
```

### Pattern Consolidation

Periodically (weekly or on-demand):

1. Review bugs with similar tags/categories
2. Extract common patterns
3. Create/update pattern documents
4. Link bugs to patterns
5. Update confidence learning data

---

## Implementation Phases

### Phase 1: Foundation (Week 1)
- [ ] Create `knowledge/` directory structure
- [ ] Define YAML/Markdown schemas
- [ ] Implement manual bug recording (`/bug record`)
- [ ] Add knowledge files to memory_search scope
- [ ] Record first bug: Terminal CSS overflow

### Phase 2: Detection (Week 2)
- [ ] Implement trigger detection in conversation flow
- [ ] Build confidence scoring system
- [ ] Add "ask user" flow for medium-confidence detections
- [ ] Create index/bugs.jsonl auto-update

### Phase 3: Proactive (Week 3)
- [ ] Implement pre-action knowledge base check
- [ ] Add inline warning system
- [ ] Build fingerprint matching for similar bugs
- [ ] Test with real debugging sessions

### Phase 4: Learning (Week 4)
- [ ] Implement confidence learning from user decisions
- [ ] Build pattern consolidation workflow
- [ ] Add periodic review/cleanup
- [ ] Metrics: bugs recorded, warnings shown, time saved

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Bugs captured | 10+ per month | Count of bugs/*.md |
| Repeat prevention | 50% reduction | Warnings shown / bugs recurring |
| Search utility | 80% helpful | User feedback on search results |
| False positive rate | <20% | Skipped suggestions / total suggestions |
| Recording overhead | <30 sec | Time from resolution to recorded |

---

## Open Questions

1. **Retention policy** — Should old bugs be archived/deleted after N months?
2. **Sharing** — Could patterns be shared across Clawdbot users anonymously?
3. **Severity auto-detection** — Can we infer severity from time spent + error type?
4. **IDE integration** — Should Clawd IDE show warnings inline in code?

---

## Appendix: First Bug Record

See `bugs/2026-01-28-terminal-css-overflow.md` for the first recorded bug 
using this system (the CSS issue we just solved).

---

*This PRD is a living document. Update as the system evolves.*
