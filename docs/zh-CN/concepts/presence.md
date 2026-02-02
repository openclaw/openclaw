---
read_when:
  - 调试实例选项卡
  - 排查重复或过期的实例行
  - 更改 Gateway网关 WebSocket 连接或系统事件信标
summary: OpenClaw 在线状态条目的生成、合并与显示方式
title: 在线状态
x-i18n:
  generated_at: "2026-02-01T20:23:31Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: c752c76a880878fed673d656db88beb5dbdeefff2491985127ad791521f97d00
  source_path: concepts/presence.md
  workflow: 14
---

# 在线状态

OpenClaw 的"在线状态"是一个轻量级、尽力而为的视图，展示：

- **Gateway网关** 自身，以及
- **连接到 Gateway网关的客户端**（Mac 应用、WebChat、CLI 等）

在线状态主要用于渲染 macOS 应用的**实例**选项卡，并为操作人员提供快速可视化。

## 在线状态字段（显示内容）

在线状态条目是结构化对象，包含以下字段：

- `instanceId`（可选但强烈建议提供）：稳定的客户端标识（通常为 `connect.client.instanceId`）
- `host`：人类可读的主机名
- `ip`：尽力而为的 IP 地址
- `version`：客户端版本字符串
- `deviceFamily` / `modelIdentifier`：硬件提示信息
- `mode`：`ui`、`webchat`、`cli`、`backend`、`probe`、`test`、`node`，...
- `lastInputSeconds`："距上次用户输入的秒数"（如果已知）
- `reason`：`self`、`connect`、`node-connected`、`periodic`，...
- `ts`：最后更新时间戳（自纪元以来的毫秒数）

## 生产者（在线状态的来源）

在线状态条目由多个来源产生并进行**合并**。

### 1）Gateway网关自身条目

Gateway网关在启动时始终会创建一个"self"条目，这样即使在任何客户端连接之前，UI 也能显示 Gateway网关主机。

### 2）WebSocket 连接

每个 WebSocket 客户端都以 `connect` 请求开始。握手成功后，Gateway网关会为该连接更新插入一个在线状态条目。

#### 为什么一次性 CLI 命令不会显示

CLI 通常只为短暂的一次性命令建立连接。为避免实例列表被频繁刷新，`client.mode === "cli"` **不会**被转换为在线状态条目。

### 3）`system-event` 信标

客户端可以通过 `system-event` 方法发送更丰富的周期性信标。Mac 应用使用此机制报告主机名、IP 和 `lastInputSeconds`。

### 4）节点连接（role: node）

当节点通过 Gateway网关 WebSocket 以 `role: node` 连接时，Gateway网关会为该节点更新插入一个在线状态条目（与其他 WebSocket 客户端流程相同）。

## 合并与去重规则（为什么 `instanceId` 很重要）

在线状态条目存储在单个内存映射中：

- 条目以**在线状态键**作为索引。
- 最佳键是稳定的 `instanceId`（来自 `connect.client.instanceId`），可在重启后保持不变。
- 键不区分大小写。

如果客户端在没有稳定 `instanceId` 的情况下重新连接，可能会显示为**重复**行。

## TTL 和大小限制

在线状态是有意设计为临时性的：

- **TTL：**超过 5 分钟的条目将被清除
- **最大条目数：**200（优先丢弃最旧的条目）

这确保列表保持新鲜，避免无限制的内存增长。

## 远程/隧道注意事项（local loopback IP）

当客户端通过 SSH 隧道/本地端口转发连接时，Gateway网关可能会将远程地址识别为 `127.0.0.1`。为避免覆盖客户端报告的有效 IP，local loopback 远程地址会被忽略。

## 消费者

### macOS 实例选项卡

macOS 应用渲染 `system-presence` 的输出，并根据最后更新的时间显示小型状态指示器（活跃/空闲/过期）。

## 调试技巧

- 要查看原始列表，请对 Gateway网关调用 `system-presence`。
- 如果看到重复条目：
  - 确认客户端在握手中发送了稳定的 `client.instanceId`
  - 确认周期性信标使用相同的 `instanceId`
  - 检查连接派生的条目是否缺少 `instanceId`（此时重复是预期行为）
