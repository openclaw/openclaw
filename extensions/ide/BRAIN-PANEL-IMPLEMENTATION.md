# Brain Panel Implementation Plan

**Version:** 1.0  
**Date:** 2026-01-29  
**Status:** Ready for Implementation

---

## Overview

Complete the Brain Panel for Clawd IDE — making AI learning visible, interactive, and gamified.

---

## Current State

### ✅ Phase 1 Complete
- `modules/brain.js` (22KB) — Core module
- Status bar indicator with confidence %
- Quick popover with metrics
- localStorage cache layer
- API endpoints in `server/`

### ✅ Backend Automation Complete
- 5 hooks for real-time learning
- 3 cron jobs for scheduled analysis
- `knowledge/user-graph.json` — Knowledge storage

---

## Implementation Phases

### Phase 2A: Sync Protocol (2-3 hours)

**Goal:** Real-time sync between files and UI

#### Tasks

| # | Task | File | Est |
|---|------|------|-----|
| 2A.1 | Add file watcher for user-graph.json | server/index.js | 30m |
| 2A.2 | WebSocket event for graph updates | server/index.js | 30m |
| 2A.3 | Listen for WS updates in brain.js | modules/brain.js | 30m |
| 2A.4 | Debounce rapid updates (500ms) | modules/brain.js | 15m |
| 2A.5 | Add sync status indicator | modules/brain.js | 15m |
| 2A.6 | Test sync with manual file edits | manual | 30m |

#### API Changes

```javascript
// server/index.js — Add file watcher
const chokidar = require('chokidar');

const graphPath = path.join(workspace, 'knowledge/user-graph.json');
const watcher = chokidar.watch(graphPath);

watcher.on('change', () => {
  const data = JSON.parse(fs.readFileSync(graphPath));
  io.emit('brain:updated', data);
});
```

```javascript
// modules/brain.js — Listen for updates
socket.on('brain:updated', (data) => {
  brainCache = data;
  updateStatusBar();
  if (panelOpen) refreshPanel();
});
```

---

### Phase 2B: Confidence Engine (2 hours)

**Goal:** Calculate and display confidence metrics

#### Tasks

| # | Task | File | Est |
|---|------|------|-----|
| 2B.1 | Confidence calculation function | modules/brain.js | 45m |
| 2B.2 | Per-category confidence (facts/prefs/patterns) | modules/brain.js | 30m |
| 2B.3 | Overall confidence aggregation | modules/brain.js | 15m |
| 2B.4 | Streak calculation from activity | modules/brain.js | 30m |

#### Confidence Formula

```javascript
function calculateConfidence(graph) {
  const weights = { validated: 1.0, inferred: 0.7, tentative: 0.4 };
  
  let total = 0, count = 0;
  
  for (const category of ['facts', 'preferences', 'patterns']) {
    for (const entry of Object.values(graph[category] || {})) {
      total += weights[entry.confidence] || 0.5;
      count++;
    }
  }
  
  return count > 0 ? Math.round((total / count) * 100) : 0;
}
```

---

### Phase 3A: Panel Framework (3 hours)

**Goal:** Dockable side panel with tab navigation

#### Tasks

| # | Task | File | Est |
|---|------|------|-----|
| 3A.1 | Panel container component | modules/brain-panel.js | 45m |
| 3A.2 | Tab navigation (7 tabs) | modules/brain-panel.js | 30m |
| 3A.3 | Panel open/close animation | self-improvement.css | 20m |
| 3A.4 | Keyboard shortcut (Cmd+Shift+B) | modules/keybindings.js | 15m |
| 3A.5 | Panel resize handle | modules/brain-panel.js | 30m |
| 3A.6 | Panel state persistence | modules/brain-panel.js | 20m |
| 3A.7 | Integration with layout system | app.js | 20m |

#### Panel Structure

```html
<div id="brain-panel" class="side-panel right">
  <div class="panel-header">
    <h2>🧠 Clawd's Brain</h2>
    <button class="panel-close">×</button>
  </div>
  
  <nav class="panel-tabs">
    <button data-tab="overview" class="active">🏠</button>
    <button data-tab="timeline">📜</button>
    <button data-tab="coding">👨‍💻</button>
    <button data-tab="profile">👤</button>
    <button data-tab="decisions">🧭</button>
    <button data-tab="preferences">🎨</button>
    <button data-tab="achievements">🏆</button>
  </nav>
  
  <div class="panel-content">
    <!-- Tab content loads here -->
  </div>
</div>
```

---

### Phase 3B: Overview Tab (3 hours)

**Goal:** Dashboard with progress rings and key metrics

#### Tasks

| # | Task | File | Est |
|---|------|------|-----|
| 3B.1 | Progress ring component (SVG) | modules/brain-panel.js | 45m |
| 3B.2 | Three rings (Accuracy/Learning/Calibration) | modules/brain-panel.js | 30m |
| 3B.3 | Streak display with flame animation | modules/brain-panel.js | 20m |
| 3B.4 | "Just learned" feed (last 5) | modules/brain-panel.js | 30m |
| 3B.5 | Weekly activity heatmap | modules/brain-panel.js | 45m |
| 3B.6 | Quick stats (total facts/prefs/patterns) | modules/brain-panel.js | 20m |

#### Progress Ring Component

```javascript
function ProgressRing({ percent, label, color }) {
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;
  
  return `
    <div class="progress-ring">
      <svg width="100" height="100">
        <circle cx="50" cy="50" r="${radius}" 
          stroke="#333" stroke-width="8" fill="none"/>
        <circle cx="50" cy="50" r="${radius}"
          stroke="${color}" stroke-width="8" fill="none"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${offset}"
          transform="rotate(-90 50 50)"/>
      </svg>
      <div class="ring-label">
        <span class="percent">${percent}%</span>
        <span class="name">${label}</span>
      </div>
    </div>
  `;
}
```

---

### Phase 3C: Timeline Tab (2 hours)

**Goal:** Activity feed of all learnings

#### Tasks

| # | Task | File | Est |
|---|------|------|-----|
| 3C.1 | Timeline component with virtual scroll | modules/brain-panel.js | 45m |
| 3C.2 | Entry types (learned/confirmed/corrected) | modules/brain-panel.js | 20m |
| 3C.3 | Date grouping (Today/Yesterday/This Week) | modules/brain-panel.js | 30m |
| 3C.4 | Filter by type dropdown | modules/brain-panel.js | 20m |
| 3C.5 | Click to expand entry details | modules/brain-panel.js | 25m |

#### Data Source
- Read from `knowledge/user-graph.json` (sources array)
- Read from `memory/*.md` for activity dates

---

### Phase 3D: Profile Tab (2 hours)

**Goal:** Display user identity and facts

#### Tasks

| # | Task | File | Est |
|---|------|------|-----|
| 3D.1 | Profile header (name, avatar placeholder) | modules/brain-panel.js | 20m |
| 3D.2 | Facts list with categories | modules/brain-panel.js | 30m |
| 3D.3 | Edit/delete buttons per fact | modules/brain-panel.js | 30m |
| 3D.4 | Add new fact form | modules/brain-panel.js | 30m |
| 3D.5 | Save changes to user-graph.json | modules/brain-panel.js | 30m |

---

### Phase 3E: Remaining Tabs (4 hours)

| Tab | Content | Est |
|-----|---------|-----|
| Coding | Style preferences, patterns, tech stack | 1h |
| Decisions | Decision history, risk profile | 1h |
| Preferences | Communication, work patterns | 1h |
| Achievements | Badges, milestones, gamification | 1h |

---

### Phase 4: Gamification (3 hours)

#### Tasks

| # | Task | Est |
|---|------|-----|
| 4.1 | Achievement badge system | 45m |
| 4.2 | Streak tracking with rewards | 30m |
| 4.3 | Level system (Novice → Expert) | 30m |
| 4.4 | Confetti animation for milestones | 20m |
| 4.5 | Achievement toast notifications | 20m |
| 4.6 | Progress towards next badge | 25m |

---

## File Changes Summary

| File | Changes |
|------|---------|
| `server/index.js` | +file watcher, +WebSocket events |
| `modules/brain.js` | +confidence engine, +sync listener |
| `modules/brain-panel.js` | **NEW** — Full panel component |
| `self-improvement.css` | +panel styles, +progress rings |
| `modules/keybindings.js` | +Cmd+Shift+B binding |
| `app.js` | +panel integration |
| `index.html` | +panel container div |

---

## Estimated Timeline

| Phase | Hours | Priority |
|-------|-------|----------|
| 2A: Sync Protocol | 2-3h | P0 |
| 2B: Confidence Engine | 2h | P0 |
| 3A: Panel Framework | 3h | P0 |
| 3B: Overview Tab | 3h | P1 |
| 3C: Timeline Tab | 2h | P1 |
| 3D: Profile Tab | 2h | P1 |
| 3E: Remaining Tabs | 4h | P2 |
| 4: Gamification | 3h | P2 |
| **Total** | **21-24h** | |

---

## Dependencies

```json
{
  "chokidar": "^3.5.3"  // File watching (if not already installed)
}
```

---

## Testing Checklist

- [ ] Panel opens/closes smoothly
- [ ] Tabs switch without flicker
- [ ] Progress rings animate on load
- [ ] Real-time sync works (edit file → UI updates)
- [ ] Streak calculates correctly
- [ ] Achievements unlock properly
- [ ] Mobile responsive (if applicable)

---

## Next Action

Start with **Phase 2A: Sync Protocol** — foundation for real-time updates.

```bash
# First step
cd ide && npm install chokidar --save
```
