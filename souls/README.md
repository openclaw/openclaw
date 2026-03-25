# OpenClaw 角色 SOULs

这组文件用于 `Javis Team / ROLES` 线程中的角色定义。

当前方向：从“重工具耦合”重构为“轻策略编排”。

统一边界：

- `OpenClaw` 是前台大脑和总调度层。
- `multi-agent-orchestrator` 是唯一执行内核与执行事实源。
- `Linear` 是开发线程管理主面板。
- `AionUI` 是执行入口和工作台。
- ROLES 在 contract-facing 层只消费 ARCH 已冻结的 capability classes：`Action`、`Knowledge`、`MemorySync`、`Capture`
- 当前稳定的工程 capability surface 是 `knowledge.search`、`memory.sync` 以及 ARCH 冻结的 action seed set
- `Recall Fabric` 与 `Learning Fabric` 继续作为 role-side 协作语言，但它们不是 provider-facing capability taxonomy
- 角色层只依赖 canonical capability surface 与 capability class，不直接绑定 provider、CLI 或底层命令。

当前角色分层：

- 经营与协同：`executive-manager`、`operations-bot`、`knowledge-bot`
- 商业与交付：`sales-bot`、`delivery-bot`
- 工程线：`toolsmith-bot`、`coder-bot`、`reviewer-bot`

本轮状态：

- 已按轻策略边界重写：`executive-manager`、`operations-bot`、`knowledge-bot`
- 已新增工程角色草案：`toolsmith-bot`、`coder-bot`、`reviewer-bot`
- `sales-bot`、`delivery-bot` 仍保留旧版表达，待下一轮补齐 Fabric 边界
