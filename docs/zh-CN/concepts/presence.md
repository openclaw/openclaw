---
read_when:
  - 调试实例标签页
  - 排查重复或过期的实例行
  - 更改 Gateway 网关 WS 连接或系统事件信标
summary: OpenClaw 在线状态条目如何生成、合并和显示
title: 在线状态
x-i18n:
  generated_at: "2026-02-03T07:46:37Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: c752c76a880878fed673d656db88beb5dbdeefff2491985127ad791521f97d00
  source_path: concepts/presence.md
  workflow: 15
---

# 在线状态

OpenClaw"在线状态"是以下内容的轻量级、尽力而为的视图：

- **Gateway 网关**本身，以及
- **连接到 Gateway 网关的客户端**（mac 应用、WebChat、CLI 等）

在线状态主要用于渲染 macOS 应用的**实例**标签页，并为运维人员提供快速可见性。

## 在线状态字段（显示的内容）

在线状态条目是具有以下字段的结构化对象：

- `instanceId`（可选但强烈推荐）：稳定的客户端身份（通常是 `connect.client.instanceId`）
- `host`：人类友好的主机名
- `ip`：尽力而为的 IP 地址
- `version`：客户端版本字符串
- `deviceFamily` / `modelIdentifier`：硬件提示
- `mode`：`ui`、`webchat`、`cli`、`backend`、`probe`、`test`、`node`，...
- `lastInputSeconds`："自上次用户输入以来的秒数"（如果已知）
- `reason`：`self`、`connect`、`node-connected`、`periodic`，...
- `ts`：最后更新时间戳（自纪元以来的毫秒数）

## 生产者（在线状态来源）

在线状态条目由多个来源生成并**合并**。

### 1）Gateway 网关自身条目

Gateway 网关始终在启动时植入一个"self"条目，这样即使在任何客户端连接之前，UI 也能显示 Gateway 网关主机。

### 2）WebSocket 连接

每个 WS 客户端都以 `connect` 请求开始。在成功握手后，Gateway 网关为该连接更新插入一个在线状态条目。

#### 为什么一次性 CLI 命令不会显示

CLI 经常为短暂的一次性命令进行连接。为避免实例列表被刷屏，`client.mode === "cli"` **不会**被转换为在线状态条目。

### 3）`system-event` 信标

客户端可以通过 `system-event` 方法发送更丰富的周期性信标。mac 应用使用此方法报告主机名、IP 和 `lastInputSeconds`。

### 4）节点连接（role: node）

当节点通过 Gateway 网关 WebSocket 以 `role: node` 连接时，Gateway 网关为该节点更新插入一个在线状态条目（与其他 WS 客户端流程相同）。

## 合并 + 去重规则（为什么 `instanceId` 很重要）

在线状态条目存储在单个内存映射中：

- 条目以**在线状态键**为索引。
- 最佳键是稳定的 `instanceId`（来自 `connect.client.instanceId`），它在重启后仍然有效。
- 键不区分大小写。

如果客户端在没有稳定 `instanceId` 的情况下重新连接，它可能会显示为**重复**行。

## TTL 和有界大小

在线状态是有意设计为短暂的：

- **TTL：** 超过 5 分钟的条目会被修剪
- **最大条目数：** 200（最旧的优先删除）

这使列表保持新鲜并避免无限制的内存增长。

## 远程/隧道注意事项（回环 IP）

当客户端通过 SSH 隧道/本地端口转发连接时，Gateway 网关可能会看到远程地址为 `127.0.0.1`。为避免覆盖客户端报告的有效 IP，回环远程地址会被忽略。

## 消费者

### macOS 实例标签页

macOS 应用渲染 `system-presence` 的输出，并根据最后更新的时间应用一个小的状态指示器（活跃/空闲/过期）。

## 调试技巧

- 要查看原始列表，对 Gateway 网关调用 `system-presence`。
- 如果你看到重复项：
  - 确认客户端在握手中发送稳定的 `client.instanceId`
  - 确认周期性信标使用相同的 `instanceId`
  - 检查连接派生的条目是否缺少 `instanceId`（这种情况下重复是预期的）
