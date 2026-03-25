# 角色与 Fabric 依赖矩阵

## Fabric 定义

- `Action Fabric`：线程、执行请求、状态、handoff、升级
- `Knowledge Fabric`：文档、知识图谱、RAG、结构化背景
- `Recall Fabric`：共享 recall、历史上下文、先前线索
- `Learning Fabric`：模式总结、复盘提炼、能力缺口信号

## Capability Class Baseline

- ROLES 在 contract-facing 层只消费 ARCH 已冻结的 capability classes：`Action`、`Knowledge`、`MemorySync`、`Capture`
- `Recall Fabric` 与 `Learning Fabric` 继续保留为 role-side 辅助 fabric，不生成 provider-facing capability 名
- 角色文档如果需要引用 dotted capability surface，只能引用 ARCH 已冻结的 canonical names

## 工程角色 capability-class 对齐

| 角色            | 主 capability class    | 辅助 capability class      | 当前 frozen surface                             | 说明                                                              |
| --------------- | ---------------------- | -------------------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| `toolsmith-bot` | `Action` / `Knowledge` | `MemorySync`               | `knowledge.search`；ARCH 冻结的 action seed set | 负责把 role / skill / handoff 对齐到 canonical capability surface |
| `coder-bot`     | `Action`               | `Knowledge` / `MemorySync` | ARCH 冻结的 action seed set；`knowledge.search` | 负责实现，不定义新的 capability name                              |
| `reviewer-bot`  | `Knowledge` / `Action` | `MemorySync`               | `knowledge.search`；ARCH 冻结的 action seed set | 负责审查和核对，不新增第二套 taxonomy                             |

## 依赖矩阵

| 角色                | 主依赖                               | 辅助依赖                                                 | 说明                                 |
| ------------------- | ------------------------------------ | -------------------------------------------------------- | ------------------------------------ |
| `executive-manager` | `Action Fabric`                      | `Knowledge Fabric` / `Recall Fabric` / `Learning Fabric` | 负责经营编排与升级，不下沉执行       |
| `operations-bot`    | `Action Fabric`                      | `Knowledge Fabric` / `Recall Fabric` / `Learning Fabric` | 负责线程推进和 handoff 质量          |
| `knowledge-bot`     | `Knowledge Fabric`                   | `Recall Fabric` / `Action Fabric` / `Learning Fabric`    | 负责知识治理，不替管理层拍板         |
| `toolsmith-bot`     | `Action Fabric` / `Knowledge Fabric` | `Recall Fabric` / `Learning Fabric`                      | 负责能力抽象与 skill contract        |
| `coder-bot`         | `Action Fabric` / `Knowledge Fabric` | `Recall Fabric` / `Learning Fabric`                      | 负责工程实现                         |
| `reviewer-bot`      | `Knowledge Fabric` / `Action Fabric` | `Recall Fabric` / `Learning Fabric`                      | 负责审查和风险识别                   |
| `sales-bot`         | `Action Fabric`                      | `Knowledge Fabric` / `Recall Fabric`                     | `Assumption`：下一轮补齐 Fabric 边界 |
| `delivery-bot`      | `Action Fabric`                      | `Knowledge Fabric` / `Recall Fabric`                     | `Assumption`：下一轮补齐 Fabric 边界 |

## 当前 Assumption

- `Learning Fabric` 仍视为建议层，不自动修改 role policy、skill contract 或执行器行为。
- `MemorySync` capability class 已冻结，但 active `memory.sync` rollout 仍受 downstream blocker 约束。
- `Capture` capability class 在工程角色层仍视为 deferred，等待 vocabulary 冻结后再挂接。
- `sales-bot` 与 `delivery-bot` 先保留旧版 SOUL，后续补齐轻策略表达。
