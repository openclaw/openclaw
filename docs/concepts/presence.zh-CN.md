---
summary: "OpenClaw 状态条目如何生成、合并和显示"
read_when:
  - 调试实例选项卡
  - 调查重复或过时的实例行
  - 更改网关 WS 连接或系统事件信标
title: "状态"
---

# 状态

OpenClaw "状态"是一个轻量级、尽力而为的视图，包含：

- **网关**本身，以及
- **连接到网关的客户端**（mac 应用、WebChat、CLI 等）

状态主要用于渲染 macOS 应用的**实例**选项卡，并提供快速的操作员可见性。

## 状态字段（显示内容）

状态条目是结构化对象，包含如下字段：

- `instanceId`（可选但强烈推荐）：稳定的客户端标识（通常是 `connect.client.instanceId`）
- `host`：人性化的主机名
- `ip`：尽力而为的 IP 地址
- `version`：客户端版本字符串
- `deviceFamily` / `modelIdentifier`：硬件提示
- `mode`：`ui`、`webchat`、`cli`、`backend`、`probe`、`test`、`node` 等
- `lastInputSeconds`："自上次用户输入以来的秒数"（如果已知）
- `reason`：`self`、`connect`、`node-connected`、`periodic` 等
- `ts`：最后更新时间戳（自纪元以来的毫秒）

## 生产者（状态来源）

状态条目由多个源**生成**并**合并**。

### 1) 网关自条目

网关在启动时总是生成一个"自"条目，因此即使在任何客户端连接之前，UI 也会显示网关主机。

### 2) WebSocket 连接

每个 WS 客户端都以 `connect` 请求开始。在成功握手时，网关为该连接更新或插入一个状态条目。

#### 为什么一次性 CLI 命令不显示

CLI 通常为简短的一次性命令连接。为避免向实例列表发送垃圾信息，`client.mode === "cli"` **不会**被转换为状态条目。

### 3) `system-event` 信标

客户端可以通过 `system-event` 方法发送更丰富的周期性信标。mac 应用使用此功能报告主机名、IP 和 `lastInputSeconds`。

### 4) 节点连接（role: node）

当节点通过网关 WebSocket 以 `role: node` 连接时，网关为该节点更新或插入一个状态条目（与其他 WS 客户端相同的流程）。

## 合并 + 去重规则（为什么 `instanceId` 很重要）

状态条目存储在单个内存映射中：

- 条目按键为**状态键**。
- 最佳键是在重启后仍然存在的稳定 `instanceId`（来自 `connect.client.instanceId`）。
- 键不区分大小写。

如果客户端在没有稳定 `instanceId` 的情况下重新连接，它可能会显示为**重复**行。

## TTL 和有界大小

状态是故意短暂的：

- **TTL：**超过 5 分钟的条目会被修剪
- **最大条目数：**200（最早的先丢弃）

这保持列表新鲜并避免无界内存增长。

## 远程/隧道注意事项（环回 IP）

当客户端通过 SSH 隧道/本地端口转发连接时，网关可能会将远程地址视为 `127.0.0.1`。为避免覆盖良好的客户端报告 IP，环回远程地址被忽略。

## 消费者

### macOS 实例选项卡

macOS 应用渲染 `system-presence` 的输出，并根据上次更新的年龄应用小状态指示器（活动/空闲/过时）。

## 调试提示

- 要查看原始列表，请针对网关调用 `system-presence`。
- 如果您看到重复项：
  - 确认客户端在握手中发送稳定的 `client.instanceId`
  - 确认周期性信标使用相同的 `instanceId`
  - 检查连接派生的条目是否缺少 `instanceId`（预期会有重复项）
