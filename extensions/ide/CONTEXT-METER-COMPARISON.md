# Context Meter: Clawd IDE vs Vercel AI SDK

## Comparison Table

| Feature | Vercel AI SDK | Clawd IDE | Notes |
|---------|---------------|-----------|-------|
| **Visual Progress Ring** | ✅ SVG circular | ✅ SVG circular | Same approach |
| **Token Breakdown** | ✅ Input/Output/Reasoning/Cache | ✅ Input/Output/Cached | Added reasoning later if needed |
| **Intelligent Formatting** | ✅ K/M/B suffixes | ✅ K/M suffixes | Same approach |
| **Interactive Hover Card** | ✅ | ✅ | Position above status bar |
| **Color-Coded Thresholds** | ❌ | ✅ Green→Amber→Red | Clawd-specific |
| **Cost Estimation** | ✅ via tokenlens | ❌ N/A | Self-hosted = no cost |
| **Compaction Suggestions** | ❌ | ✅ `/compact` `/new` | DNA-specific |
| **Compaction Status** | ❌ | ✅ Available/Blocked/Failed | DNA-specific |
| **Session Duration** | ❌ | ✅ Time tracking | Useful for long sessions |
| **Auto-Refresh** | ❌ Manual | ✅ 30-second interval | Proactive monitoring |
| **Keyboard Shortcut** | ❌ | ✅ Cmd+Shift+C | Quick access |
| **Pulse Animation** | ❌ | ✅ At 80%+ | Visual urgency |

## Architecture Differences

### Vercel AI SDK
- **React-based** compound component system
- **Context Provider** pattern for data flow
- **Client-side only** — data passed via props
- **Cost-focused** — integrates tokenlens for pricing

### Clawd IDE
- **Vanilla JS** module with class pattern
- **Server API** for session data
- **File-based estimation** when API unavailable
- **Action-focused** — suggests `/compact` and `/new`

## Key Innovations in Clawd IDE

### 1. Proactive Warning System
Instead of just displaying data, Clawd actively suggests actions:
```
90%+ → "🚨 Critical! /new now"
80%+ → "⚠️ Recommend /new"
70%+ → "💡 Consider /compact or /new"
```

### 2. Compaction Status Integration
Tracks whether compaction is available or blocked:
```
✅ Available — can run /compact
🚫 Blocked — already compacted (need /new)
❌ Failed — compaction error
```

### 3. Server-Side Token Estimation
Reads actual session file to estimate tokens:
```javascript
// File size / 4 ≈ token count
const tokens = Math.round(fileSizeBytes / 4);
```

### 4. Bottom-Positioned Popover
Fixed positioning bug where status bar elements need popovers above them:
```javascript
popover.style.bottom = `${window.innerHeight - rect.top + 8}px`;
```

## Room for Improvement

### From Vercel (TODO)
- [ ] **Reasoning tokens** — Track chain-of-thought separately
- [ ] **Cache tokens** — Show what's being reused
- [ ] **Per-model context windows** — Dynamic max based on model

### Clawd-Specific (TODO)
- [ ] **Real token counts from gateway** — Hook into actual API response
- [ ] **Compaction history** — Show when last compacted
- [ ] **Warning notifications** — Toast at thresholds
- [ ] **Integration with Brain module** — Unified status bar

## Files

| File | Size | Purpose |
|------|------|---------|
| `modules/context-meter.js` | 19KB | Frontend module |
| `server/index.js` (API) | +70 lines | `/api/context/usage` endpoint |
| `hooks/context-monitor/` | ~5KB | Server-side hook for warnings |

## Usage

### Status Bar
Shows `[ring] 72%` — click for details

### Keyboard Shortcut
`Cmd+Shift+C` — Toggle popover

### Auto-Refresh
Every 30 seconds, or click "↻ Refresh"

---

**Conclusion:** Clawd IDE's context meter is equivalent to Vercel's for visualization but adds DNA-specific functionality (compaction status, action suggestions, session tracking) that makes it more actionable for long coding sessions.
