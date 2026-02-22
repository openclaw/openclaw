# AI Specialists Page Overhaul — Design Document

**Date:** 2026-02-16
**Approach:** Command Center (filterable grid + slide-out detail panel)
**Scope:** Everything Maximum — 42 specialists, complete UI rebuild, new features

---

## 1. Specialist Roster (14 → 42)

### 10 Categories

| # | Category | Count | New Agents |
|---|----------|-------|------------|
| 1 | Quality & Testing | 4 | test-blitz-runner, data-quality-guardian, tdd-strategist |
| 2 | Frontend & Design | 4 | storybook-curator |
| 3 | Backend & APIs | 4 | middleware-engineer, feature-flags-specialist |
| 4 | Data & Database | 3 | database-migration-specialist, financial-data-integrity |
| 5 | Infrastructure & DevOps | 5 | zero-downtime-deployer, chaos-engineer, production-hardener |
| 6 | Observability & Reliability | 3 | sre-reliability-specialist |
| 7 | Security & Compliance | 5 | zero-trust-architect, compliance-officer, kyc-compliance-analyst, regulatory-compliance-specialist |
| 8 | Finance & Business | 6 | islamic-finance-advisor, banking-treasury-specialist, tax-reporting-analyst, deal-management-specialist, portfolio-analyst |
| 9 | Operations & Platform | 5 | onboarding-specialist, analytics-insights-analyst, ai-sentinel, operations-manager |
| 10 | Governance & Family Office | 3 | governance-voting-advisor, succession-planner, entity-management-specialist |

Each new agent follows the existing `SpecializedAgent` interface: `id`, `name`, `description`, `icon` (Lucide), `color`, `category`, `capabilities[]` (8-10), `systemPrompt`, `suggestedTasks[]` (3-5).

### Skill Sources

- **family-office-os-2/.agent/skills/**: 52 skill folders providing domain knowledge for new specialists
- **openclaw-agent-system/backend/agents/**: OperationsManager pattern for operations-manager
- **Existing 14 agents**: Preserved exactly, may get minor capability additions

---

## 2. Page Layout

```
┌─────────────────────────────────────────────────────────────┐
│ HEADER BAR                                                   │
│ [Title] [Search input] [Grid|List|Compare toggle]            │
│ [Category chips] [Status: All|Available|Busy]                │
│ [Quality: Any|70+|85+] [Sort: Quality|Name|Tasks|Trend]      │
├─────────────────────────────────────────────────────────────┤
│ STATS RIBBON (6 KPIs in glass-panel cards)                   │
│ Total | Available | Busy | Tasks Done | Avg Quality | Top    │
├─────────────────────────────────────────────────────────────┤
│ ADVISORY PANEL (3 channels, collapsible)                     │
│ [Learning Hub] [Workspace] [OpenClaw]                        │
├─────────────────────────────────────────────────────────────┤
│ MAIN CONTENT (view-mode dependent)                           │
│                                                              │
│ Grid: Cards grouped by category, responsive columns          │
│ List: Compact table rows with inline actions                 │
│ Compare: Side-by-side stats for 2-3 selected agents          │
├─────────────────────────────────────────────────────────────┤
│ DETAIL PANEL (slide-in from right, 480px)                    │
│ Header + quality ring + sparkline                            │
│ Capabilities + performance stats                             │
│ Recent tasks + feedback history                              │
│ [Assign Task] [Start Chat] [Compare] [Favorite]             │
├─────────────────────────────────────────────────────────────┤
│ BULK DISPATCH BAR (appears when 2+ agents selected)          │
│ "Dispatch to N specialists" → orchestrator                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Component Architecture

All components remain inside `ai-specialists.tsx` (no new files).

### Rebuilt Components

| Component | Lines (est.) | Changes |
|-----------|-------------|---------|
| `FilterBar` | ~80 | **New** — search + chips + dropdowns |
| `StatsRibbon` | ~60 | **Rewrite** — 6 KPIs (was 4) |
| `AdvisoryPanel` | ~120 | **Rewrite** — collapsible, better cards |
| `AgentCard` | ~140 | **Rewrite** — quality ring, sparkline, favorite, checkbox |
| `AgentDetailPanel` | ~350 | **Rewrite** — feedback history, comparison, better layout |
| `ComparisonView` | ~150 | **New** — side-by-side stats table |
| `BulkDispatchBar` | ~50 | **New** — bottom bar for multi-select dispatch |

### Preserved Components (polish only)

| Component | Changes |
|-----------|---------|
| `QuickAssignDialog` | Styling refresh, same logic |
| `SmartSuggestion` | Styling refresh, same logic |
| `AssignTaskDialog` | Styling refresh, same logic |
| `StatusBadge` | Keep as-is |

### Main Component Logic

Same patterns preserved:
- `useAgentStatuses()` hook — 15s polling from `/api/agents/specialists`
- `refreshSuggestions()` — 20s refresh from `/api/agents/specialists/suggestions`
- `useGatewayEvents` / `useGatewayConnectionState` hooks
- `useMemo` for filtered/sorted agent list
- `useCallback` for event handlers

New state additions:
```typescript
viewMode: "grid" | "list" | "comparison"     // localStorage persisted
categoryFilter: string | null                  // selected category chip
statusFilter: "all" | "available" | "busy"     // status dropdown
qualityFilter: [number, number]                // range [0,100]
sortBy: "name" | "quality" | "tasks" | "trend" // sort dropdown
compareList: string[]                          // max 3 agent IDs
favorites: Set<string>                         // localStorage persisted
```

---

## 4. New Features

### 4.1 FilterBar
- Fuzzy search across agent name, description, capabilities
- Category chips with counts (click to filter, click again to clear)
- Status filter: All / Available / Busy
- Quality presets: Any / 70+ / 85+
- Sort: Quality (default) / Name / Tasks Completed / Trend
- All filters combine (AND logic)

### 4.2 View Modes
- **Grid** (default): Cards in responsive grid, grouped by category headers
- **List**: Compact rows — icon, name, quality, status, capabilities count, quick actions
- **Comparison**: Side-by-side table for 2-3 selected agents
- Persisted to localStorage

### 4.3 Comparison View
- Select agents via checkbox on card or "Compare" button in detail panel
- Max 3 agents compared simultaneously
- Metrics: quality score, approval rate, rework rate, avg cycle time, feedback rating, task count, trend, capabilities overlap
- Clear comparison button to reset

### 4.4 Favorites
- Star icon on each card (top-right corner)
- Persisted to localStorage (`mc-specialist-favorites`)
- When favorites exist, a "Favorites" section appears at top of grid
- No API changes — purely client-side

### 4.5 Bulk Dispatch Bar
- Checkboxes on each agent card (visible in grid/list modes)
- When 2+ checked, fixed bottom bar slides up
- "Dispatch to N specialists" button → opens orchestrator flow
- Uses existing orchestrator API endpoint

### 4.6 Quality Score Ring
- Small SVG circular progress (32x32px)
- Score 0-100 displayed in center
- Ring color: green (80+), yellow (60-79), red (<60)
- Appears on AgentCard and AgentDetailPanel header

### 4.7 Trend Sparkline
- 5-point mini SVG line chart (48x16px)
- Based on recent task quality/cycle-time trend
- Green stroke if improving, yellow if steady, red if needs_attention
- Appears on AgentCard next to trend badge

---

## 5. Preserved Features

Every existing feature is kept and rebuilt with better UX:

- Agent status tracking (useAgentStatuses, 15s refresh)
- Advisory panel (3 suggestion channels, 20s refresh)
- AgentCard (status badge, capabilities, quality score, trend indicator)
- AgentDetailPanel (description, capabilities, quality signals, strengths, improvement focus, system prompt with copy, suggested tasks, recent tasks)
- QuickAssignDialog (bulk task assignment, select all/deselect, smart suggestion)
- AssignTaskDialog (create + assign, quick suggestions from agent)
- SmartSuggestion (API recommend + local fallback)
- Search functionality
- Stats overview
- Keyboard accessibility + ARIA labels
- Gateway event integration

---

## 6. Design System Usage

- **Glass panels**: `glass-panel` class for cards, panels, dialogs
- **OKLCH colors**: Status colors (success/warning/danger), agent accent colors
- **Glow effects**: `glow-shadow` on hover, `glow-border` for selected/active states
- **Animations**: `scale-in` for cards, `slide-in-right` for detail panel, `breathe` for status dots
- **Typography**: Space Grotesk headings, JetBrains Mono for system prompts
- **Components**: Radix Dialog, ScrollArea, Select, Tooltip, Popover
- **Responsive**: 1-col mobile, 2-col tablet, 3-4 col desktop grid

---

## 7. Files Modified

| File | Change | Size Impact |
|------|--------|-------------|
| `src/lib/agent-registry.ts` | Add 28 new agents, 4 new categories | ~1,200 → ~4,000 lines |
| `src/components/views/ai-specialists.tsx` | Full UI rebuild + new features | ~1,740 → ~2,200 lines |
| `src/app/api/agents/specialists/route.ts` | No changes | — |
| `src/app/api/agents/specialists/recommend/route.ts` | No changes | — |
| `src/app/api/agents/specialists/suggestions/route.ts` | No changes | — |
| `src/app/api/agents/specialists/feedback/route.ts` | No changes | — |
| `src/lib/specialist-intelligence.ts` | No changes | — |
| `src/lib/specialist-suggestions.ts` | No changes | — |

---

## 8. Verification

- `npx tsc --noEmit` — zero type errors
- All 42 agents render in grid view with correct icons and categories
- Filters narrow results correctly (category + status + quality + search combine)
- View mode toggle works (grid/list/comparison), persists to localStorage
- Detail panel slides in with all sections populated
- Favorites persist across page reloads
- Comparison view shows side-by-side stats for 2-3 agents
- Advisory panel loads suggestions from all 3 channels
- Quick assign and smart suggestion work with new agents
- Keyboard navigation works throughout
- Responsive layout adapts to mobile/tablet/desktop
