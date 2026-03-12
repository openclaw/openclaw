---
name: advisory-committee
description: "Run a 4-agent AI advisory committee (CS, Marketing, Finance, Tech) for strategic decisions. Produces independent verdicts + majority-vote recommendation. Use when: strategic decision, prioritization, build-vs-skip analysis, proposal evaluation. Triggers: '전략적 결정', '어드바이저리', 'advisory committee', 'should we build', '이거 할까 말까', 'proposal review', '우선순위 정하자'. NOT for: tactical/implementation decisions, code review, simple yes/no questions."
---

# Advisory Committee

Run 4 agents **in sequence** for independent judgment on a proposal.

## Agent Order

1. **🎧 CS "User Champion"** — User value, onboarding, retention
2. **📣 Marketing "Growth Hacker"** — Distribution, CAC, GTM
3. **📦 Finance "CFO"** — ROI, opportunity cost, timing
4. **🔧 Tech "CTO"** — Reuse, tech debt, complexity

Each verdict: `✅ YES` / `❌ NO` / `⚠️ Conditional`

Detailed judgment criteria per agent: `references/committee-roles.md`

## Output Format

```
## 🏛️ Committee — [Proposal]

### 🎧 CS — [✅/❌/⚠️]
> [2~3 lines]

### 📣 Marketing — [✅/❌/⚠️]
> [2~3 lines]

### 📦 Finance — [✅/❌/⚠️]
> [2~3 lines]

### 🔧 Tech — [✅/❌/⚠️]
> [2~3 lines]

## 📋 Recommendation
**Decision: [YES / NO / Conditional]**
> [One-line action]
```

## Decision Log

After each decision, append a row:

| Date | Proposal | CS  | Marketing | Finance | Tech | Decision |
| ---- | -------- | --- | --------- | ------- | ---- | -------- |
