# ROLES 线程执行计划

## 目标

把 `OpenClaw` 角色体系从“谁会什么命令”改成“谁负责什么策略与协作”，并补出工程线最小角色集合。

## 当前范围

本轮只处理 owner 范围内内容：

- `souls/`
- `docs/roles/`
- `skills/`

## 分阶段计划

### Phase 1 - 现有角色审计

- 盘点 `executive-manager`、`knowledge-bot`、`operations-bot` 的职责表达
- 识别是否存在工具直连、执行事实源不清、Fabric 边界缺失
- 输出问题清单和改写方向

### Phase 2 - 轻策略化重写

- 重写上述三个角色，使其改为能力依赖而非命令依赖
- 为每个角色补充 `SOUL / TOOLS / SKILLS / ROLE NOTES`
- 在文档中明确 `OpenClaw / multi-agent-orchestrator / Linear / AionUI / Mem9 / LightRAG` 的边界

### Phase 3 - 工程角色补齐

- 草拟 `toolsmith-bot`
- 草拟 `coder-bot`
- 草拟 `reviewer-bot`
- 明确三者与 `executive-manager`、`operations-bot`、`knowledge-bot` 的协作链

### Phase 4 - 技能目录重构建议

- 给出 `shared / office / engineering / knowledge / ops` 五类目录建议
- 规定角色只能依赖能力型 skill，不直接依赖 provider / CLI 型 skill
- 标记现有技能的迁移方向与兼容期规则

### Phase 5 - 风险与仲裁项

- 标记需要 `OpenClaw` 总调度仲裁的边界
- 标记依赖 contract 稳定性的 `Assumption`
- 为下一轮 `sales-bot` / `delivery-bot` 重写留接口

## 当前交付物

- 现有角色问题盘点
- 三个核心角色的轻策略版 SOUL
- 工程角色草案
- 技能目录结构建议
- Fabric 依赖矩阵
