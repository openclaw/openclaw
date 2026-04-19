---
summary: "OpenClaw 如何管理对话会话"
read_when:
  - 你想了解会话路由和隔离
  - 你想为多用户设置配置 DM 范围
title: "会话管理"
---

# 会话管理

OpenClaw 将对话组织为**会话**。每条消息根据其来源（私信、群聊、cron 作业等）被路由到相应的会话。

## 消息如何路由

| 来源      | 行为           |
| --------- | -------------- |
| 私信      | 默认共享会话   |
| 群聊      | 每个群组隔离   |
| 房间/频道 | 每个房间隔离   |
| Cron 作业 | 每次运行新会话 |
| Webhook   | 每个钩子隔离   |

## 私信隔离

默认情况下，所有私信共享一个会话以保持连续性。这对于单用户设置是可以的。

<Warning>
如果多人可以向你的代理发送消息，请启用私信隔离。否则，所有用户将共享相同的对话上下文 —— Alice 的私人消息会对 Bob 可见。
</Warning>

**修复方法：**

```json5
{
  session: {
    dmScope: "per-channel-peer", // 按频道 + 发送者隔离
  },
}
```

其他选项：

- `main`（默认）—— 所有私信共享一个会话。
- `per-peer` —— 按发送者隔离（跨频道）。
- `per-channel-peer` —— 按频道 + 发送者隔离（推荐）。
- `per-account-channel-peer` —— 按账户 + 频道 + 发送者隔离。

<Tip>
如果同一个人从多个频道联系你，使用 `session.identityLinks` 链接他们的身份，以便他们共享一个会话。
</Tip>

使用 `openclaw security audit` 验证你的设置。

## 会话生命周期

会话会被重用，直到它们过期：

- **每日重置**（默认）—— 在网关主机当地时间凌晨 4:00 创建新会话。
- **空闲重置**（可选）—— 一段时间不活动后创建新会话。设置 `session.reset.idleMinutes`。
- **手动重置** —— 在聊天中输入 `/new` 或 `/reset`。`/new <model>` 还可以切换模型。

当同时配置了每日和空闲重置时，以先到期的为准。

## 状态存储位置

所有会话状态都由**网关**拥有。UI 客户端向网关查询会话数据。

- **存储：** `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- **记录：** `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`

## 会话维护

OpenClaw 会随时间自动限制会话存储。默认情况下，它以 `warn` 模式运行（报告将要清理的内容）。将 `session.maintenance.mode` 设置为 `"enforce"` 以自动清理：

```json5
{
  session: {
    maintenance: {
      mode: "enforce",
      pruneAfter: "30d",
      maxEntries: 500,
    },
  },
}
```

使用 `openclaw sessions cleanup --dry-run` 预览。

## 检查会话

- `openclaw status` —— 会话存储路径和最近活动。
- `openclaw sessions --json` —— 所有会话（使用 `--active <minutes>` 过滤）。
- 在聊天中输入 `/status` —— 上下文使用情况、模型和开关。
- `/context list` —— 系统提示中包含的内容。

## 进一步阅读

- [会话修剪](/concepts/session-pruning) —— 修剪工具结果
- [压缩](/concepts/compaction) —— 总结长对话
- [会话工具](/concepts/session-tool) —— 用于跨会话工作的代理工具
- [会话管理深入探讨](/reference/session-management-compaction) —— 存储模式、记录、发送策略、来源元数据和高级配置
- [多代理](/concepts/multi-agent) —— 跨代理的路由和会话隔离
- [后台任务](/automation/tasks) —— 分离工作如何创建带有会话引用的任务记录
- [频道路由](/channels/channel-routing) —— 入站消息如何路由到会话
