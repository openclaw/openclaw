---
summary: "OpenClaw 存在条目如何生成、合并和显示"
read_when:
  - 调试实例选项卡
  - 调查重复或过时的实例行
  - 更改网关 WS 连接或系统事件信标
title: "存在"
---

# 存在

OpenClaw "存在" 是一个轻量级、尽力而为的视图，包含：

- **网关**本身，以及
- **连接到网关的客户端**（mac 应用、WebChat、CLI 等）

存在主要用于渲染 macOS 应用的**实例**选项卡并提供快速的操作员可见性。

## 存在字段（显示的内容）

存在条目是具有以下字段的结构化对象：

- `instanceId`（可选但强烈推荐）：稳定的客户端身份（通常是 `connect.client.instanceId`）
- `host`：人类友好的主机名
- `ip`：尽力而为的 IP 地址
- `version`：客户端版本字符串
- `deviceFamily` / `modelIdentifier`：硬件提示
- `mode`：`ui`、`webchat`、`cli`、`backend`、`probe`、`test`、`node`，...
- `lastInputSeconds`："自上次用户输入以来的秒数"（如果已知）
- `reason`：`self`、`connect`、`node-connected`、`periodic`，...
- `ts`：最后更新时间戳（自纪元以来的毫秒数）

## 生产者（存在的来源）

存在条目由多个源**生成并合并**。

### 1) 网关自条目

网关在启动时总是生成一个"self"条目，因此即使在任何客户端连接之前，UI 也会显示网关主机。

### 2) WebSocket 连接

每个 WS 客户端都以 `connect` 请求开始。在成功握手时，网关为该连接更新存在条目。

#### 为什么一次性 CLI 命令不显示

CLI 通常连接进行简短的一次性命令。为避免垃圾邮件实例列表，`client.mode === "cli"` **不会**转换为存在条目。

### 3) `system-event` 信标

客户端可以通过 `system-event` 方法发送更丰富的定期信标。mac 应用使用此功能报告主机名、IP 和 `lastInputSeconds`。

### 4) 节点连接（role: node）

当节点通过网关 WebSocket 以 `role: node` 连接时，网关为该节点更新存在条目（与其他 WS 客户端相同的流程）。

## 合并 + 去重规则（为什么 `instanceId` 很重要）

存在条目存储在单个内存映射中：

- 条目由**存在键**键控。
- 最好的键是一个稳定的 `instanceId`（来自 `connect.client.instanceId`），它在重启后仍然存在。
- 键不区分大小写。

如果客户端在没有稳定 `instanceId` 的情况下重新连接，它可能会显示为**重复**行。

## TTL 和有界大小

存在故意是短暂的：

- **TTL：** 超过 5 分钟的条目会被修剪
- **最大条目数：** 200（首先丢弃最旧的）

这保持列表新鲜并避免无限的内存增长。

## 远程/隧道警告（环回 IP）

当客户端通过 SSH 隧道 / 本地端口转发连接时，网关可能会将远程地址视为 `127.0.0.1`。为避免覆盖客户端报告的良好 IP，环回远程地址被忽略。

## 消费者

### macOS 实例选项卡

macOS 应用渲染 `system-presence` 的输出，并根据上次更新的年龄应用小的状态指示器（活动/空闲/过时）。

## 调试提示

- 要查看原始列表，请向网关调用 `system-presence`。
- 如果看到重复项：
  - 确认客户端在握手中发送稳定的 `client.instanceId`
  - 确认定期信标使用相同的 `instanceId`
  - 检查连接派生的条目是否缺少 `instanceId`（预期会有重复项）