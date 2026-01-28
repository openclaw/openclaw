---
permalink: /security/formal-verification/
summary: OpenClaw 最高风险路径的机器验证安全模型。
title: 形式化验证（安全模型）
x-i18n:
  generated_at: "2026-02-01T21:38:31Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 8dff6ea41a37fb6b870424e4e788015c3f8a6099075eece5dbf909883c045106
  source_path: security/formal-verification.md
  workflow: 15
---

# 形式化验证（安全模型）

本页面跟踪 OpenClaw 的**形式化安全模型**（目前使用 TLA+/TLC；后续按需扩展）。

> 注意：一些较旧的链接可能引用的是之前的项目名称。

**目标（北极星）：** 提供机器验证的论证，证明 OpenClaw 在明确假设下执行了其预期的安全策略（授权、会话隔离、工具门控和错误配置安全性）。

**当前状态：** 一个可执行的、以攻击者为驱动的**安全回归测试套件**：

- 每个声明都有一个在有限状态空间上运行的模型检查。
- 许多声明都有一个配对的**负面模型**，为现实的漏洞类别生成反例追踪。

**尚未实现的：** 证明"OpenClaw 在所有方面都是安全的"或完整的 TypeScript 实现是正确的。

## 模型存放位置

模型维护在一个独立的仓库中：[vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models)。

## 重要注意事项

- 这些是**模型**，而非完整的 TypeScript 实现。模型与代码之间可能存在偏差。
- 结果受限于 TLC 探索的状态空间；"绿色"并不意味着超出建模假设和边界之外的安全性。
- 一些声明依赖于明确的环境假设（例如，正确的部署、正确的配置输入）。

## 复现结果

目前，通过在本地克隆模型仓库并运行 TLC 来复现结果（见下文）。未来的迭代可能提供：

- 带有公开产物（反例追踪、运行日志）的 CI 运行模型
- 用于小规模有界检查的托管"运行此模型"工作流

开始使用：

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Gateway网关暴露与开放 Gateway网关错误配置

**声明：** 在没有认证的情况下绑定到非本地 local loopback 可能导致远程入侵/增加暴露面；令牌/密码可以阻止未经授权的攻击者（在模型假设下）。

- 绿色运行：
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- 红色（预期）：
  - `make gateway-exposure-v2-negative`

另见：模型仓库中的 `docs/gateway-exposure-matrix.md`。

### Nodes.run 管道（最高风险能力）

**声明：** `nodes.run` 需要 (a) 节点命令允许列表加上已声明的命令，以及 (b) 配置后的实时审批；审批使用令牌化以防止重放（在模型中）。

- 绿色运行：
  - `make nodes-pipeline`
  - `make approvals-token`
- 红色（预期）：
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### 配对存储（私信门控）

**声明：** 配对请求遵守 TTL 和待处理请求上限。

- 绿色运行：
  - `make pairing`
  - `make pairing-cap`
- 红色（预期）：
  - `make pairing-negative`
  - `make pairing-cap-negative`

### 入口门控（提及 + 控制命令绕过）

**声明：** 在需要提及的群组上下文中，未经授权的"控制命令"无法绕过提及门控。

- 绿色：
  - `make ingress-gating`
- 红色（预期）：
  - `make ingress-gating-negative`

### 路由/会话密钥隔离

**声明：** 来自不同对等方的私信不会合并到同一个会话中，除非明确链接/配置。

- 绿色：
  - `make routing-isolation`
- 红色（预期）：
  - `make routing-isolation-negative`

## v1++：额外的有界模型（并发、重试、追踪正确性）

这些是后续模型，围绕真实世界的故障模式（非原子更新、重试和消息扇出）提高保真度。

### 配对存储并发/幂等性

**声明：** 配对存储应在交错执行下也能执行 `MaxPending` 和幂等性（即"检查后写入"必须是原子的/加锁的；刷新不应创建重复项）。

含义：

- 在并发请求下，不能超过渠道的 `MaxPending` 限制。
- 对同一 `(channel, sender)` 的重复请求/刷新不应创建重复的活跃待处理行。

- 绿色运行：
  - `make pairing-race`（原子/加锁的上限检查）
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- 红色（预期）：
  - `make pairing-race-negative`（非原子的 begin/commit 上限竞争）
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### 入口追踪关联/幂等性

**声明：** 摄入应在扇出过程中保持追踪关联，并在提供商重试下保持幂等性。

含义：

- 当一个外部事件变成多个内部消息时，每个部分都保持相同的追踪/事件标识。
- 重试不会导致重复处理。
- 如果缺少提供商事件 ID，去重将回退到安全的键（例如追踪 ID），以避免丢弃不同的事件。

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

**声明：** 路由必须默认保持私信会话隔离，仅在明确配置时才合并会话（渠道优先级 + 身份链接）。

含义：

- 渠道特定的 dmScope 覆盖必须优先于全局默认值。
- identityLinks 应仅在明确链接的组内合并，而不是跨不相关的对等方。

- 绿色：
  - `make routing-precedence`
  - `make routing-identitylinks`
- 红色（预期）：
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
