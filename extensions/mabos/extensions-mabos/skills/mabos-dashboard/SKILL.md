# MABOS Dashboard — Stakeholder View

This skill generates the stakeholder dashboard — **decisions first, performance second**.

## Files

- `dashboard.html` — Interactive Canvas dashboard (dark theme, pure HTML/CSS/JS)
- `mock-data.js` — Realistic sample data for 3 businesses

## Presenting via Canvas

To show the dashboard:

```
canvas(action="present", url="file:///path/to/skills/mabos-dashboard/dashboard.html")
```

Or serve via the Canvas mount point if configured:

```
canvas(action="present", url="/__openclaw__/canvas/mabos-dashboard/dashboard.html")
```

## Live Data

When served via the OpenClaw gateway (e.g. `/__openclaw__/canvas/mabos-dashboard/dashboard.html`),
the dashboard automatically fetches from the MABOS API endpoints:

- `/mabos/api/status` — portfolio summary
- `/mabos/api/businesses` + `/mabos/api/businesses/:id/agents|goals|tasks` — per-business detail
- `/mabos/api/decisions` — pending decisions
- `/mabos/api/contractors` — workforce
- `/mabos/api/metrics/:business` — KPIs

If the API is unavailable (e.g. opened via `file://`), it falls back to `mock-data.js`.

Decision resolutions are also posted back to `/mabos/api/decisions/:id/resolve`.

## Injecting Data via Canvas Eval

You can also inject data manually before presenting:

```
canvas(action="eval", javaScript="window.MABOS_DATA = { portfolio: {...}, businesses: [...], decisions: [...], workforce: [...] }; renderPortfolio();")
```

### Data Schema

```javascript
{
  portfolio: {
    name: string,
    totalRevenue: number,
    totalBusinesses: number,
    activeAgents: number,
    openDecisions: number,
    workforceUtilization: number  // 0.0-1.0
  },
  businesses: [{
    id: string,
    name: string,
    type: "saas" | "ecommerce" | "consulting" | "marketplace" | "retail",
    status: "active" | "paused" | "onboarding",
    health: number,       // 0.0-1.0
    revenue: number,
    agentCount: number,
    activeGoals: number,
    kpis: [{ name, value, target, unit, inverse? }],
    agents: [{ role, status, pendingTasks, lastAction }],
    goals: [{ name, progress, priority, deadline }],
    recentActivity: [{ time, agent, action }]
  }],
  decisions: [{
    id: string,
    businessId: string,
    businessName: string,
    title: string,
    urgency: number,      // 0.0-1.0
    agent: string,
    raisedAt: ISO8601,
    summary: string,
    options: [{ label, impact, recommended? }],
    recommendation: string,
    category: string
  }],
  workforce: [{
    name: string,
    specialty: string,
    trust: number,        // 0.0-1.0
    activePackages: number,
    completedPackages: number,
    business: string
  }]
}
```

## Chat + Canvas Hybrid

The dashboard is the visual companion to conversation. When the stakeholder asks:

- **"Show me the dashboard"** → Present the Canvas
- **"What decisions are pending?"** → Chat summary + Canvas auto-scrolls to decisions
- **"How's TechFlow doing?"** → Chat analysis + Canvas shows TechFlow detail view
- **"Approve the 3PL switch"** → Process in chat, update Canvas via eval

Use `canvas(action="eval")` to drive the dashboard state from conversation:

```javascript
// Navigate to a specific business
showBusiness("techflow");

// Open a decision modal
openDecision("dec-001");

// Update data and re-render
window.MABOS_DATA.decisions = window.MABOS_DATA.decisions.filter((d) => d.id !== "dec-001");
renderPortfolio();
```

## When to Use

- Stakeholder asks for status update, dashboard, or portfolio view
- During decision review sessions
- Periodic health check presentations
- Business performance deep dives

## Design

- Dark theme (matrix green #00ff41 accent)
- Decisions-first layout (stakeholder sees what needs attention)
- Responsive (works on mobile)
- No external dependencies
- Smooth transitions and hover effects
