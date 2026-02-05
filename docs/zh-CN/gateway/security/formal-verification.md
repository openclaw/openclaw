---
permalink: /security/formal-verification/
summary: 针对 OpenClaw 最高风险路径的机器检查安全模型。
title: 形式化验证（安全模型）
x-i18n:
  generated_at: "2026-02-03T07:49:03Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 8dff6ea41a37fb6b870424e4e788015c3f8a6099075eece5dbf909883c045106
  source_path: gateway/security/formal-verification.md
  workflow: 15
---

# 形式化验证（安全模型）

本页跟踪 OpenClaw 的**形式化安全模型**（目前是 TLA+/TLC；根据需要会增加更多）。

> 注意：一些较旧的链接可能引用以前的项目名称。

**目标（北极星）：** 在明确的假设下，提供机器检查的论证，证明 OpenClaw 执行其预期的安全策略（授权、会话隔离、工具限制和错误配置安全）。

**目前是什么：** 一个可执行的、攻击者驱动的**安全回归套件**：

- 每个声明都有一个在有限状态空间上运行的模型检查。
- 许多声明有一个配对的**负面模型**，为现实的错误类别生成反例轨迹。

**目前还不是什么：** 证明"OpenClaw 在所有方面都是安全的"或完整的 TypeScript 实现是正确的。

## 模型存放位置

模型维护在单独的仓库中：[vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models)。

## 重要注意事项

- 这些是**模型**，不是完整的 TypeScript 实现。模型和代码之间可能存在偏差。
- 结果受 TLC 探索的状态空间限制；"绿色"并不意味着超出建模假设和边界的安全性。
- 一些声明依赖于明确的环境假设（例如，正确的部署、正确的配置输入）。

## 重现结果

目前，通过在本地克隆模型仓库并运行 TLC 来重现结果（见下文）。未来的迭代可能提供：

- 带有公开产物（反例轨迹、运行日志）的 CI 运行模型
- 用于小型有界检查的托管"运行此模型"工作流

入门：

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# 需要 Java 11+（TLC 在 JVM 上运行）。
# 仓库附带一个固定版本的 `tla2tools.jar`（TLA+ 工具）并提供 `bin/tlc` + Make 目标。

make <target>
```

### Gateway 网关暴露和开放 Gateway 网关错误配置

**声明：** 在没有认证的情况下绑定到 loopback 之外可能导致远程攻击 / 增加暴露；令牌/密码阻止未授权攻击者（根据模型假设）。

- 绿色运行：
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- 红色（预期）：
  - `make gateway-exposure-v2-negative`

另请参阅：模型仓库中的 `docs/gateway-exposure-matrix.md`。

### Nodes.run 管道（最高风险能力）

**声明：** `nodes.run` 需要 (a) 节点命令允许列表加上声明的命令，以及 (b) 配置时的实时批准；批准是令牌化的以防止重放（在模型中）。

- 绿色运行：
  - `make nodes-pipeline`
  - `make approvals-token`
- 红色（预期）：
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### 配对存储（私信限制）

**声明：** 配对请求遵守 TTL 和待处理请求上限。

- 绿色运行：
  - `make pairing`
  - `make pairing-cap`
- 红色（预期）：
  - `make pairing-negative`
  - `make pairing-cap-negative`

### 入站限制（提及 + 控制命令绕过）

**声明：** 在需要提及的群组上下文中，未授权的"控制命令"无法绕过提及限制。

- 绿色：
  - `make ingress-gating`
- 红色（预期）：
  - `make ingress-gating-negative`

### 路由/会话键隔离

**声明：** 来自不同对等方的私信不会合并到同一会话中，除非明确链接/配置。

- 绿色：
  - `make routing-isolation`
- 红色（预期）：
  - `make routing-isolation-negative`

## v1++：额外的有界模型（并发、重试、轨迹正确性）

这些是后续模型，围绕真实世界的故障模式（非原子更新、重试和消息扇出）提高保真度。

### 配对存储并发/幂等性

**声明：** 即使在交错执行下，配对存储也应强制执行 `MaxPending` 和幂等性（即"检查后写入"必须是原子/锁定的；刷新不应创建重复项）。

这意味着：

- 在并发请求下，你不能超过渠道的 `MaxPending`。
- 对同一 `(channel, sender)` 的重复请求/刷新不应创建重复的活动待处理行。

- 绿色运行：
  - `make pairing-race`（原子/锁定上限检查）
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- 红色（预期）：
  - `make pairing-race-negative`（非原子 begin/commit 上限竞争）
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### 入站轨迹关联/幂等性

**声明：** 摄取应在扇出时保留轨迹关联，并在提供商重试下保持幂等。

这意味着：

- 当一个外部事件变成多个内部消息时，每个部分保持相同的轨迹/事件标识。
- 重试不会导致重复处理。
- 如果缺少提供商事件 ID，去重会回退到安全键（例如轨迹 ID）以避免丢弃不同的事件。

- 绿色：
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- 红色（预期）：
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### 路由 dmScope 优先级 + identityLinks

**声明：** 路由必须默认保持私信会话隔离，仅在明确配置时合并会话（渠道优先级 + 身份链接）。

这意味着：

- 渠道特定的 dmScope 覆盖必须优先于全局默认值。
- identityLinks 应仅在明确链接的组内合并，而不是跨不相关的对等方。

- 绿色：
  - `make routing-precedence`
  - `make routing-identitylinks`
- 红色（预期）：
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
