---
summary: "通过原生 zca-js（QR 登录）的 Zalo 个人账户支持、功能和配置"
read_when:
  - 为 OpenClaw 设置 Zalo Personal
  - 调试 Zalo Personal 登录或消息流程
title: "Zalo Personal"
---

# Zalo Personal（非官方）

状态：实验性。此集成通过 OpenClaw 内部的原生 `zca-js` 自动化**个人 Zalo 账户**。

> **警告：** 这是一个非官方集成，可能导致账户暂停/封禁。风险自负。

## 捆绑插件

Zalo Personal 在当前的 OpenClaw 版本中作为捆绑插件提供，因此正常的打包构建不需要单独安装。

如果您使用的是较旧的构建或排除了 Zalo Personal 的自定义安装，请手动安装：

- 通过 CLI 安装：`openclaw plugins install @openclaw/zalouser`
- 或从源代码检出：`openclaw plugins install ./path/to/local/zalouser-plugin`
- 详情：[插件](/tools/plugin)

不需要外部 `zca`/`openzca` CLI 二进制文件。

## 快速设置（初学者）

1. 确保 Zalo Personal 插件可用。
   - 当前打包的 OpenClaw 版本已经捆绑了它。
   - 较旧/自定义安装可以使用上面的命令手动添加它。
2. 登录（QR，在网关机器上）：
   - `openclaw channels login --channel zalouser`
   - 使用 Zalo 移动应用扫描 QR 码。
3. 启用频道：

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. 重启网关（或完成设置）。
5. DM 访问默认为配对；首次联系时批准配对码。

## 是什么

- 通过 `zca-js` 完全在进程内运行。
- 使用原生事件监听器接收入站消息。
- 通过 JS API 直接发送回复（文本/媒体/链接）。
- 专为 Zalo Bot API 不可用的“个人账户”用例设计。

## 命名

频道 ID 为 `zalouser`，以明确这是自动化**个人 Zalo 用户账户**（非官方）。我们保留 `zalo` 用于潜在的未来官方 Zalo API 集成。

## 查找 ID（目录）

使用目录 CLI 发现对等方/群组及其 ID：

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## 限制

- 出站文本被分块为约 2000 个字符（Zalo 客户端限制）。
- 默认情况下流式传输被阻止。

## 访问控制（DM）

`channels.zalouser.dmPolicy` 支持：`pairing | allowlist | open | disabled`（默认：`pairing`）。

`channels.zalouser.allowFrom` 接受用户 ID 或名称。在设置期间，名称通过插件的进程内联系人查找解析为 ID。

通过以下方式批准：

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## 群组访问（可选）

- 默认：`channels.zalouser.groupPolicy = "open"`（允许群组）。使用 `channels.defaults.groupPolicy` 在未设置时覆盖默认值。
- 使用以下方式限制为允许列表：
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups`（键应为稳定的群组 ID；启动时可能会将名称解析为 ID）
  - `channels.zalouser.groupAllowFrom`（控制允许群组中哪些发送者可以触发机器人）
- 阻止所有群组：`channels.zalouser.groupPolicy = "disabled"`。
- 配置向导可以提示群组允许列表。
- 启动时，OpenClaw 将允许列表中的群组/用户名解析为 ID 并记录映射。
- 群组允许列表匹配默认仅基于 ID。除非启用 `channels.zalouser.dangerouslyAllowNameMatching: true`，否则未解析的名称在认证时被忽略。
- `channels.zalouser.dangerouslyAllowNameMatching: true` 是一种紧急兼容性模式，重新启用可变的群组名称匹配。
- 如果未设置 `groupAllowFrom`，运行时会回退到 `allowFrom` 进行群组发送者检查。
- 发送者检查适用于正常群组消息和控制命令（例如 `/new`、`/reset`）。

示例：

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["1471383327500481391"],
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

### 群组提及门控

- `channels.zalouser.groups.<group>.requireMention` 控制群组回复是否需要提及。
- 解析顺序：精确群组 ID/名称 -> 规范化群组 slug -> `*` -> 默认（`true`）。
- 这适用于允许列群组和开放群组模式。
- 引用机器人消息算作群组激活的隐式提及。
- 授权的控制命令（例如 `/new`）可以绕过提及门控。
- 当群组消息因需要提及而被跳过时，OpenClaw 将其存储为待处理的群组历史记录，并在下一条处理的群组消息中包含它。
- 群组历史限制默认为 `messages.groupChat.historyLimit`（回退 `50`）。您可以使用 `channels.zalouser.historyLimit` 按账户覆盖。

示例：

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "*": { allow: true, requireMention: true },
        "Work Chat": { allow: true, requireMention: false },
      },
    },
  },
}
```

## 多账户

账户映射到 OpenClaw 状态中的 `zalouser` 配置文件。示例：

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## 打字、反应和传递确认

- OpenClaw 在分发回复之前发送打字事件（尽最大努力）。
- 消息反应操作 `react` 支持 `zalouser` 频道操作。
  - 使用 `remove: true` 从消息中删除特定的反应表情。
  - 反应语义：[反应](/tools/reactions)
- 对于包含事件元数据的入站消息，OpenClaw 发送已传递 + 已读确认（尽最大努力）。

## 故障排除

**登录不持久：**

- `openclaw channels status --probe`
- 重新登录：`openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`

**允许列表/群组名称未解析：**

- 在 `allowFrom`/`groupAllowFrom`/`groups` 中使用数字 ID，或使用确切的朋友/群组名称。

**从旧的基于 CLI 的设置升级：**

- 删除任何旧的外部 `zca` 进程假设。
- 该频道现在完全在 OpenClaw 中运行，无需外部 CLI 二进制文件。

## 相关

- [频道概述](/channels) — 所有支持的频道
- [配对](/channels/pairing) — DM 认证和配对流程
- [群组](/channels/groups) — 群聊行为和提及门控
- [频道路由](/channels/channel-routing) — 消息的会话路由
- [安全](/gateway/security) — 访问模型和强化