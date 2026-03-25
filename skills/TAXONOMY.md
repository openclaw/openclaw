# 技能目录重构建议

## 目标

让角色层依赖“能力型技能”，而不是直接依赖 provider / CLI / 外部工具说明。

## 建议目录

```text
skills/
  shared/
  office/
  engineering/
  knowledge/
  ops/
```

说明：

- `shared/`：跨角色复用的策略技能
- `office/`：经营、销售、交付、管理沟通类技能
- `engineering/`：能力设计、实现、评审、测试类技能
- `knowledge/`：知识提炼、图谱治理、RAG 维护类技能
- `ops/`：线程推进、依赖协调、异常升级类技能

## 分类建议

### shared

建议放入：

- `work-intake`
- `decision-packet`
- `handoff-brief`
- `risk-escalation`
- `status-normalize`
- `artifact-publish`

适用原则：跨多个角色复用，且不绑定单一业务域。

### office

建议放入：

- `stakeholder-brief`
- `meeting-note`
- `customer-brief`
- `delivery-checkpoint`
- `priority-sync`

适用角色：`executive-manager`、`sales-bot`、`delivery-bot`

### engineering

建议放入：

- `capability-mapping`
- `skill-spec-draft`
- `implementation-plan`
- `code-change`
- `diff-review`
- `test-strategy`
- `migration-note`

适用角色：`toolsmith-bot`、`coder-bot`、`reviewer-bot`

### knowledge

建议放入：

- `decision-capture`
- `adr-distill`
- `sop-extract`
- `source-curation`
- `knowledge-graph-update`
- `retrieval-brief`

适用角色：`knowledge-bot`

### ops

建议放入：

- `thread-intake`
- `dependency-chase`
- `blocker-escalation`
- `runbook-brief`
- `rollout-checklist`
- `incident-brief`

适用角色：`operations-bot` 及未来运维协同角色

## 迁移规则

1. 角色文档只能直接引用上述能力型 skill。
2. 现有 provider / CLI 型 skill 暂视为 adapter 层，不直接出现在角色 SOUL 中。
3. 一个 skill 文档至少应声明：
   - 目标
   - 输入
   - 输出
   - 依赖的 Fabric
   - guardrails
   - `Assumption`
4. `multi-agent-orchestrator` 决定执行方式；skill 不直接规定底层命令。

## 当前存量技能的处理建议

现有像 `github`、`gh-issues`、`slack`、`discord`、`coding-agent` 这类技能，暂不直接迁入角色层。

建议后续分两层处理：

- 上层：能力型 skill，供角色引用
- 下层：adapter/reference，封装 provider / CLI 细节

这样可以让角色层保持轻策略，而不是再次回到“会哪个命令就由谁来做”。
