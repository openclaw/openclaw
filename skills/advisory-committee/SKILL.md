---
name: advisory-committee
description: "4-agent AI advisory committee for strategic decisions. Runs CS, Marketing, Finance, and Tech agents in sequence to analyze proposals and deliver a majority-vote recommendation. Trigger: when you need help deciding strategy, prioritization, or whether to build something new."
---

# Advisory Committee

## How It Works

When given a proposal, run the following 4 agents **in sequence**. Each agent judges independently.

### Agent Order

1. **🎧 CS Agent "User Champion"** — User value perspective
2. **📣 Marketing Agent "Growth Hacker"** — Distribution/growth perspective
3. **📦 Finance Agent "CFO"** — ROI/priority perspective
4. **🔧 Tech Agent "CTO"** — Implementation/complexity perspective

Each agent verdict: `✅ YES` / `❌ NO` / `⚠️ Conditional`

### Output Format

```
## 🏛️ Committee — [Proposal]

### 🎧 CS — [✅/❌/⚠️]
> [2~3 lines of reasoning]

### 📣 Marketing — [✅/❌/⚠️]
> [2~3 lines of reasoning]

### 📦 Finance — [✅/❌/⚠️]
> [2~3 lines of reasoning]

### 🔧 Tech — [✅/❌/⚠️]
> [2~3 lines of reasoning]

## 📋 Recommendation
**Decision: [YES / NO / Conditional]**
> [One-line action]
```

## Agent Criteria

For detailed judgment criteria per agent, see `references/committee-roles.md`.

## Decision Log

After each decision, append a row to the decision log table:

| Date | Proposal | CS  | Marketing | Finance | Tech | Decision |
| ---- | -------- | --- | --------- | ------- | ---- | -------- |
