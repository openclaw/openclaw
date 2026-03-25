# 现有角色问题盘点

## 总体观察

现有 `souls/` 中的角色已经有比较清晰的业务职责，但仍存在三类共性缺口：

1. 没有显式声明谁是执行事实源，容易把聊天状态误认成执行状态。
2. 没有显式区分 `Knowledge Fabric`、`Recall Fabric`、`Learning Fabric`，容易出现影子知识与影子记忆。
3. 没有把工程协作拆成“能力定义 / 实现 / 审查”三段，也没有显式挂到稳定的 capability class，后续容易重新耦合回工具层。

## 角色审计

| 角色                | 现状优点                           | 主要问题                                                                           | 本轮调整                                       |
| ------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| `executive-manager` | 管理口径、升级链、汇报结构清楚     | 没有显式声明执行事实源；容易在工程问题上滑向万能管理者；缺少 Fabric 依赖表达       | 增加系统边界、Fabric 依赖、工程角色协作链      |
| `knowledge-bot`     | 纪要、SOP、决策状态区分已经较成熟  | 没有区分共享 recall surface 与 authoritative knowledge surface；容易形成影子知识库 | 明确 recall/knowledge 边界，增加来源与状态治理 |
| `operations-bot`    | 节奏推进、阻塞管理、owner 意识较强 | 容易被误用为直接执行者或线程事实源；缺少 `Linear` / `AionUI` 边界                  | 增加线程主面板、执行入口、执行事实源说明       |

## 仍然存在的结构风险

### 1. 工程角色缺位

在旧结构中，工程事务可能落到 `operations-bot` 或 `executive-manager` 身上，导致：

- 能力定义与代码实现混在一起
- 评审责任缺失
- 工具细节被直接写进角色层

### 2. 技能目录仍偏 provider / CLI 心智

当前 `skills/` 以外部工具名和集成名为主，适合作为 adapter 层，不适合作为角色层的直接依赖。

同时，工程角色虽然已经转向轻策略表达，但还缺一层明确对齐：

- 哪些 role 消费 `Action` capability class
- 哪些 role 消费 `Knowledge` capability class
- 哪些 class 目前仍属于 blocked / deferred，例如 `MemorySync`、`Capture`

### 3. 角色缺少 Fabric 矩阵

旧版角色文档更像岗位说明，没有明确说明：

- 哪些能力是主依赖
- 哪些能力只能辅助使用
- 哪些能力仍处于 `Assumption`

## 本轮结论

- `executive-manager`、`knowledge-bot`、`operations-bot` 已适合转向轻策略表达。
- 工程线必须最少补 `toolsmith-bot`、`coder-bot`、`reviewer-bot` 三个角色。
- 工程角色下一步不是自造新的能力 taxonomy，而是显式对齐 ARCH 已冻结的 capability classes，并只消费 canonical dotted capability surface。
- `sales-bot`、`delivery-bot` 可在下一轮沿用同样方法补齐 Fabric 边界。
