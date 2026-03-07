# Command Center Help UI Layout

Full specification for info icon placement, tooltip content, hover card
design, and the onboarding walkthrough flow.

---

## Layout Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  ┌─ Logo ─┐   ┌──────── Ask OpenClaw anything... ────────┐  [☰][⚙] │
│  │OpenClaw│   │ placeholder + suggestions dropdown       │  Simple │
│  └────────┘   └──────────────────────────────────────────┘  Mode ↗ │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────────────────┐  ┌──────────────────────────────┐  │
│  │  Today                  ⓘ  │  │  Full Digital    CUTMV    ⓘ  │  │
│  │                             │  │  ┌──────┐  ┌──────┐         │  │
│  │  • Priority 1               │  │  │ $12K │  │ $8K  │  ...    │  │
│  │  • Priority 2               │  │  │ Rev  │  │ Rev  │         │  │
│  │  • Priority 3               │  │  └──────┘  └──────┘         │  │
│  │                             │  │  Brand KPI Chips             │  │
│  │  ┌─────────────────────┐   │  └──────────────────────────────┘  │
│  │  │ ▶ Start the Day     │   │                                     │
│  │  └─────────────────────┘   │  ┌──────────────────────────────┐  │
│  │                             │  │  System Health           ⓘ  │  │
│  └─────────────────────────────┘  │                              │  │
│                                    │  M1 ● Online                │  │
│  ┌─────────────────────────────┐  │  M4 ● Online                │  │
│  │  Schedule               ⓘ  │  │  Storage ● Healthy          │  │
│  │                             │  │                              │  │
│  │  09:00  Team standup        │  └──────────────────────────────┘  │
│  │  10:30  Client call         │                                     │
│  │  14:00  Content review      │  ┌──────────────────────────────┐  │
│  │  16:00  Grant deadline      │  │  Approvals              ⓘ  │  │
│  │                             │  │                              │  │
│  └─────────────────────────────┘  │  2 actions waiting           │  │
│                                    │  [Review]                    │  │
│                                    │                              │  │
│                                    └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 1. Persistent Prompt Bar

**Position:** Top center of the header, always visible.

```
┌──────────────────────────────────────────────┐
│  🔍  Ask OpenClaw anything...                │
└──────────────────────────────────────────────┘
```

**Behavior:**
- Placeholder text: "Ask OpenClaw anything..."
- On focus: show suggestion dropdown with 4 rotating examples
- Suggestions cycle through:
  - "What should I focus on today?"
  - "Can you find grants for Full Digital?"
  - "How do I scale ads safely?"
  - "What does this section do?"
  - "Run the start of day routine."
  - "Check website health."
  - "Generate 3 CUTMV ad concepts."
  - "What needs my approval?"
- On submit: routes to the Prompt Engine as a natural language request
- Width: 60% of header, centered

---

## 2. Info Icon Placement

Every panel gets an **ⓘ** icon in its top-right corner.

```
┌─────────────────────────────────┐
│  Panel Title                ⓘ  │
│                                 │
│  Panel content...               │
└─────────────────────────────────┘
```

**Icon spec:**
- Size: 16px, muted gray (#999), opacity 0.6
- Hover: opacity 1.0, color shifts to brand blue
- Click: opens hover card (see below)
- Position: 12px from top edge, 12px from right edge

---

## 3. Hover Card Design

When the ⓘ icon is clicked (or hovered on desktop), a card appears:

```
┌──────────────────────────────────────┐
│  Today Panel                         │
│                                      │
│  Shows what matters right now:       │
│  priorities, schedule, deadlines,    │
│  and action items.                   │
│                                      │
│  ─────────────────────────────────   │
│                                      │
│  What you can do here:               │
│    • start the day routine           │
│    • review priorities               │
│    • check overdue work              │
│    • see schedule for next 10 hours  │
│                                      │
│  ─────────────────────────────────   │
│                                      │
│  Try asking:                         │
│    "What should I focus on today?"   │
│    "Run the start of day routine."   │
│    "Show me what's overdue."         │
│                                      │
│  ─────────────────────────────────   │
│                                      │
│  ℹ Starting the day routine is       │
│    safe and doesn't need approval.   │
└──────────────────────────────────────┘
```

**Card spec:**
- Width: 320px
- Background: white, 1px border #E5E7EB, 8px border-radius
- Shadow: 0 4px 12px rgba(0,0,0,0.1)
- Sections separated by thin horizontal rules
- Close on click outside or Escape
- Animation: fade in 150ms

**Content sections (in order):**
1. **Title** — bold, 16px
2. **Description** — regular, 14px, #666
3. **Divider**
4. **What you can do here** — label 12px uppercase #999, list 14px
5. **Divider**
6. **Try asking** — label 12px uppercase #999, prompts in quotes, 14px, clickable (fills prompt bar)
7. **Divider**
8. **Approval note** — italic, 13px, #888, info icon prefix

**Clickable prompts:** When a user clicks a suggested prompt in the hover
card, it auto-fills the prompt bar and focuses it. One click to ask.

---

## 4. Panel-Specific Hover Cards

### Today Panel ⓘ

| Field | Content |
|-------|---------|
| Title | Today Panel |
| Description | Shows what matters right now: priorities, schedule, deadlines, and action items. |
| Can do | start the day routine, review priorities, check overdue work, see schedule for next 10 hours |
| Prompts | "What should I focus on today?" · "Run the start of day routine." · "Show me what's overdue." |
| Approval | Starting the day routine is safe and doesn't need approval. |

### Schedule Panel ⓘ

| Field | Content |
|-------|---------|
| Title | Schedule Panel |
| Description | Shows your upcoming events, deadlines, and time blocks for the next 10 hours. |
| Can do | view upcoming events, check deadline proximity, see today's time blocks |
| Prompts | "What's on the schedule today?" · "Show me upcoming deadlines." · "What's next?" |
| Approval | Viewing the schedule is always safe. |

### Brand KPI Chips ⓘ

| Field | Content |
|-------|---------|
| Title | Brand KPI Chips |
| Description | At-a-glance performance indicators for Full Digital and CUTMV. Tap any chip for details. |
| Can do | view brand KPIs, drill into performance, compare brands |
| Prompts | "How is CUTMV performing?" · "Show me Full Digital KPIs." · "Compare both brands." |
| Approval | Viewing KPIs is always safe. |

### System Health ⓘ

| Field | Content |
|-------|---------|
| Title | System Health Panel |
| Description | Quick status of your cluster nodes, services, and shared storage. Green means healthy. |
| Can do | check node status, view service health, inspect shared storage, run a deep health check |
| Prompts | "Are all nodes online?" · "Run a full health check." · "What's the cluster status?" |
| Approval | Health checks are read-only. Restarts need approval. |

### Pending Approvals ⓘ

| Field | Content |
|-------|---------|
| Title | Pending Approvals |
| Description | Actions waiting for your review. OpenClaw never executes sensitive changes without your say-so. |
| Can do | review pending actions, approve safe changes, reject risky changes, see what's waiting |
| Prompts | "What needs my approval?" · "Show me pending actions." · "Approve the top item." |
| Approval | This panel IS the approval layer. |

---

## 5. Section Nav Info Icons

The left sidebar navigation also gets subtle info on hover:

```
┌──────────────┐
│ ◉ Dashboard  │  ← "Your main operating view"
│ ○ Finance    │  ← "Cash, invoices, grants"
│ ○ Marketing  │  ← "Ads, campaigns, scaling"
│ ○ WebOps     │  ← "Sites, health, deploys"
│ ○ GrantOps   │  ← "Grant discovery & drafts"
│ ○ Cluster    │  ← "Nodes, services, storage"
│ ○ Telegram   │  ← "Mobile control"
└──────────────┘
```

These are simple native tooltips (title attribute), not full hover cards.
Short — 3-5 words max.

---

## 6. Onboarding Walkthrough Flow

### Trigger
- First time the user opens the Command Center
- Also accessible via: Menu > "Take the tour" or /guide in Telegram

### Format
- Modal overlay with spotlight highlighting
- Dark backdrop (opacity 0.6) with the current panel spotlighted
- Navigation: Back / Next / Skip Tour
- Progress: step dots at the bottom

### Screen-by-Screen Flow

---

#### Screen 1 of 11: Welcome

```
┌──────────────────────────────────────────┐
│                                          │
│          Welcome to OpenClaw             │
│                                          │
│  This is your operating system for       │
│  Full Digital and CUTMV. You can talk    │
│  to it in plain English to get things    │
│  done — no commands to memorize, no      │
│  manuals to read.                        │
│                                          │
│  Tip: Try typing:                        │
│  "What should I focus on today?"         │
│                                          │
│           [Get Started →]                │
│                                          │
│              ● ○ ○ ○ ○ ○ ○ ○ ○ ○ ○      │
└──────────────────────────────────────────┘
```

- **Spotlight:** None (full screen overlay)
- **CTA:** "Get Started"

---

#### Screen 2 of 11: Prompt Bar

```
         ↓ spotlight on prompt bar ↓
┌──────────────────────────────────────────┐
│                                          │
│          Ask OpenClaw Anything           │
│                                          │
│  This is your main input. Type any       │
│  question or request in plain English    │
│  and OpenClaw will understand.           │
│                                          │
│  You don't need special commands.        │
│  Just ask.                               │
│                                          │
│           [← Back]  [Next →]             │
│              ○ ● ○ ○ ○ ○ ○ ○ ○ ○ ○      │
└──────────────────────────────────────────┘
```

- **Spotlight:** Prompt bar highlighted

---

#### Screen 3 of 11: Today Panel

```
         ↓ spotlight on today panel ↓
┌──────────────────────────────────────────┐
│                                          │
│            Command Center                │
│                                          │
│  This is your main dashboard. It shows   │
│  today's priorities, your schedule,      │
│  system health, and what needs action.   │
│  Everything starts here.                 │
│                                          │
│  Tip: The Today panel shows what         │
│  matters right now.                      │
│                                          │
│           [← Back]  [Next →]             │
│              ○ ○ ● ○ ○ ○ ○ ○ ○ ○ ○      │
└──────────────────────────────────────────┘
```

- **Spotlight:** Today panel highlighted

---

#### Screen 4 of 11: Finance

```
         ↓ spotlight on Finance nav ↓
┌──────────────────────────────────────────┐
│                                          │
│              Finance                     │
│                                          │
│  Finance tracks cash, invoices,          │
│  expenses, and forecasts. It also        │
│  includes GrantOps — your grant          │
│  discovery and drafting engine.          │
│                                          │
│  Tip: Ask "Show me the finance summary." │
│                                          │
│           [← Back]  [Next →]             │
│              ○ ○ ○ ● ○ ○ ○ ○ ○ ○ ○      │
└──────────────────────────────────────────┘
```

- **Spotlight:** Finance nav item

---

#### Screen 5 of 11: Marketing

```
         ↓ spotlight on Marketing nav ↓
┌──────────────────────────────────────────┐
│                                          │
│             Marketing                    │
│                                          │
│  Marketing helps generate ads, evaluate  │
│  performance, and prepare safe scaling   │
│  actions. It will never spend money      │
│  without your approval.                  │
│                                          │
│  Tip: Ask "Generate 3 CUTMV ad          │
│  concepts."                              │
│                                          │
│           [← Back]  [Next →]             │
│              ○ ○ ○ ○ ● ○ ○ ○ ○ ○ ○      │
└──────────────────────────────────────────┘
```

- **Spotlight:** Marketing nav item

---

#### Screen 6 of 11: WebOps

```
         ↓ spotlight on WebOps nav ↓
┌──────────────────────────────────────────┐
│                                          │
│              WebOps                      │
│                                          │
│  WebOps monitors your websites,          │
│  deployments, tracking pixels, and       │
│  webhooks. When something breaks, it     │
│  generates a repair plan for your        │
│  review.                                 │
│                                          │
│  Tip: Ask "Check website health."        │
│                                          │
│           [← Back]  [Next →]             │
│              ○ ○ ○ ○ ○ ● ○ ○ ○ ○ ○      │
└──────────────────────────────────────────┘
```

- **Spotlight:** WebOps nav item

---

#### Screen 7 of 11: GrantOps

```
         ↓ spotlight on GrantOps nav ↓
┌──────────────────────────────────────────┐
│                                          │
│             GrantOps                     │
│                                          │
│  GrantOps finds grant opportunities,     │
│  scores them by fit, and drafts          │
│  applications. You review and approve    │
│  before anything is submitted.           │
│                                          │
│  Tip: Ask "Find grants for Full          │
│  Digital."                               │
│                                          │
│           [← Back]  [Next →]             │
│              ○ ○ ○ ○ ○ ○ ● ○ ○ ○ ○      │
└──────────────────────────────────────────┘
```

- **Spotlight:** GrantOps nav item

---

#### Screen 8 of 11: Cluster

```
         ↓ spotlight on health panel ↓
┌──────────────────────────────────────────┐
│                                          │
│           Your Cluster                   │
│                                          │
│  OpenClaw runs on your own hardware —    │
│  M1 Mac Studio for AI, M4 for the       │
│  gateway. Shared storage keeps           │
│  everything in sync. You can check       │
│  health anytime.                         │
│                                          │
│  Tip: Ask "Are all nodes online?"        │
│                                          │
│           [← Back]  [Next →]             │
│              ○ ○ ○ ○ ○ ○ ○ ● ○ ○ ○      │
└──────────────────────────────────────────┘
```

- **Spotlight:** System Health panel

---

#### Screen 9 of 11: Telegram

```
┌──────────────────────────────────────────┐
│                                          │
│         Telegram Control                 │
│                                          │
│  Telegram is your mobile control layer.  │
│  You get alerts, approve actions, and    │
│  run prompts — all from your phone.      │
│  Same capabilities as the Command        │
│  Center.                                 │
│                                          │
│  Tip: Send /help in the OpenClaw         │
│  Telegram bot.                           │
│                                          │
│           [← Back]  [Next →]             │
│              ○ ○ ○ ○ ○ ○ ○ ○ ● ○ ○      │
└──────────────────────────────────────────┘
```

- **Spotlight:** None (info screen)

---

#### Screen 10 of 11: Approvals

```
         ↓ spotlight on approvals panel ↓
┌──────────────────────────────────────────┐
│                                          │
│            Approvals                     │
│                                          │
│  Sensitive actions — launching           │
│  campaigns, increasing budgets,          │
│  infrastructure changes — always         │
│  require your approval. OpenClaw never   │
│  spends money or makes risky changes     │
│  on its own.                             │
│                                          │
│  Tip: Approvals appear in Telegram       │
│  and the Command Center.                 │
│                                          │
│           [← Back]  [Next →]             │
│              ○ ○ ○ ○ ○ ○ ○ ○ ○ ● ○      │
└──────────────────────────────────────────┘
```

- **Spotlight:** Approvals panel

---

#### Screen 11 of 11: You're Ready

```
┌──────────────────────────────────────────┐
│                                          │
│           You're Ready                   │
│                                          │
│  That's the tour. You can always ask     │
│  OpenClaw:                               │
│                                          │
│    "What can I do here?"                 │
│    "How do I do this?"                   │
│    "What does this section do?"          │
│                                          │
│  and it will guide you step by step.     │
│                                          │
│  Tip: Start with "Run the start of      │
│  day routine."                           │
│                                          │
│           [Start Using OpenClaw →]       │
│              ○ ○ ○ ○ ○ ○ ○ ○ ○ ○ ●      │
└──────────────────────────────────────────┘
```

- **Spotlight:** None (full overlay)
- **CTA:** "Start Using OpenClaw" (dismisses walkthrough, focuses prompt bar)

---

## 7. Simple Mode Layout

When Simple Mode is active, the layout reduces to:

```
┌──────────────────────────────────────────────────┐
│  OpenClaw   ┌─ Ask OpenClaw anything... ─┐  [☰] │
├──────────────────────────────────────────────────┤
│                                                   │
│  ┌───────────────────────────────────────────┐   │
│  │  Today                                ⓘ  │   │
│  │  • Priority 1                             │   │
│  │  • Priority 2                             │   │
│  │  • Priority 3                             │   │
│  │  [▶ Start the Day]                        │   │
│  └───────────────────────────────────────────┘   │
│                                                   │
│  ┌───────────────────────────────────────────┐   │
│  │  Schedule                             ⓘ  │   │
│  │  09:00  Team standup                      │   │
│  │  10:30  Client call                       │   │
│  └───────────────────────────────────────────┘   │
│                                                   │
│  ┌───────────────────────────────────────────┐   │
│  │  2 approvals waiting          [Review →]  │   │
│  └───────────────────────────────────────────┘   │
│                                                   │
└──────────────────────────────────────────────────┘
```

- Prompt bar stays
- Info icons stay
- KPI chips, health panel hidden (still accessible via prompt)
- Single-column, mobile-friendly

---

## 8. Three Levels of Help

| Level | Trigger | What happens |
|-------|---------|-------------|
| **Passive** | Always visible | ⓘ icons, nav tooltips, section descriptions |
| **Reactive** | User asks | "How do I...?" → step-by-step plan via Guide Engine |
| **Guided** | First run / menu | Walkthrough overlay, screen-by-screen tour |

All three levels use the same data from `openclaw/guide/` — the UI just
renders it differently depending on context.

---

## 9. Implementation Checklist

- [ ] Add ⓘ icon component to all Command Center panels
- [ ] Build hover card component with standard layout
- [ ] Wire hover card content from `openclaw.guide.adapters.ui`
- [ ] Build walkthrough overlay component
- [ ] Wire walkthrough steps from `openclaw.guide.walkthrough`
- [ ] Add prompt bar with suggestion dropdown
- [ ] Wire prompt bar to Prompt Engine
- [ ] Add "Take the tour" to menu
- [ ] Store walkthrough completion in user preferences
- [ ] Add nav tooltips
- [ ] Build Simple Mode toggle and layout
