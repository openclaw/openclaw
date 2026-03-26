---
summary: Harness 相关高信号文档、计划和技术债台账索引
read_when:
  - 你想最快找到 OpenClaw 的关键技术文档
  - 你在给人类或智能体做 harness / platform 工作引导
  - 你想知道执行计划和技术债记录放在哪里
owner: OpenClaw harness
freshness: monthly
last_reviewed: "2026-03-25"
title: 文档索引
---

# 文档索引

这份索引用来把 OpenClaw 最关键的 repo knowledge 串成最短路径，方便人和智能体优先读对地方。

## 核心概念

- [智能体工作区](/concepts/agent-workspace)
- [系统提示词](/concepts/system-prompt)
- [上下文](/concepts/context)
- [Harness Roadmap](/concepts/harness-roadmap)

## Harness 治理

- [Standing Orders](/automation/standing-orders)
- [Hooks](/automation/hooks)
- [Harness Engineering 对照清单](/zh-CN/concepts/harness-engineering-checklist)
- [Anthropic 长任务 Harness 对照清单](/zh-CN/concepts/anthropic-long-running-harness-checklist)

## 执行计划

- [Execution Plans 索引](/exec-plans/README)
- [Harness agent-first system plan](/exec-plans/harness-agent-first-system)
- [Role-scoped build loop](/exec-plans/role-scoped-build-loop)
- [Role-scoped build loop Phase 1 backlog](/exec-plans/role-scoped-build-loop-phase-1-backlog)

## 技术债

- [Tech debt 索引](/tech-debt/README)
- [Harness platform gaps](/tech-debt/harness-platform-gaps)

## 维护规则

当 harness 功能发生变化时，默认按这个顺序更新：

1. 先更新 `concepts/` 或 `automation/` 中的运行时文档
2. 再更新 [Harness Roadmap](/concepts/harness-roadmap)
3. 如果改变了长期方向，把结论沉淀到 `exec-plans/`
4. 如果留下已知缺口或权衡，把它记录到 `tech-debt/`
