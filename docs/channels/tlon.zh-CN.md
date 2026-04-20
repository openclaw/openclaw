---
summary: "Tlon/Urbit 支持状态、功能和配置"
read_when:
  - 处理 Tlon/Urbit 通道功能
title: "Tlon"
---

# Tlon

Tlon 是基于 Urbit 构建的去中心化 messenger。OpenClaw 连接到您的 Urbit ship 并可以
响应 DM 和群聊消息。默认情况下，群组回复需要 @ 提及，并且可以通过允许列表进一步限制。

状态：捆绑插件。支持 DM、群组提及、线程回复、富文本格式和
图片上传。尚不支持反应和投票。

## 捆绑插件

Tlon 在当前 OpenClaw 版本中作为捆绑插件提供，因此正常的打包构建不需要单独安装。

如果您使用的是旧版本或不包含 Tlon 的自定义安装，请手动安装：

通过 CLI 安装（npm 注册表）：

```bash
openclaw plugins install @openclaw/tlon
```

本地检出（从 git 仓库运行时）：

```bash
openclaw plugins install ./path/to/local/tlon-plugin
```

详情：[插件](/tools/plugin)

## 设置

1. 确保 Tlon 插件可用：
   - 当前打包的 OpenClaw 版本已经捆绑了它
   - 旧版本/自定义安装可以使用上述命令手动添加
2. 收集您的 ship URL 和登录代码
3. 配置 `channels.tlon`
4. 重启网关
5. 向机器人发送 DM 或在群组频道中提及它

最小配置（单个账户）：

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
      ownerShip: "~your-main-ship", // 推荐：您的 ship，始终允许
    },
  },
}
```

## 私有/LAN ships

默认情况下，OpenClaw 阻止私有/内部主机名和 IP 范围以防止 SSRF 攻击。
如果您的 ship 在私有网络上运行（localhost、LAN IP 或内部主机名），
您必须明确选择加入：

```json5
{
  channels: {
    tlon: {
      url: "http://localhost:8080",
      allowPrivateNetwork: true,
    },
  },
}
```

这适用于以下 URL：

- `http://localhost:8080`
- `http://192.168.x.x:8080`
- `http://my-ship.local:8080`

⚠️ 只有在您信任本地网络时才启用此设置。此设置会禁用对您的 ship URL 请求的 SSRF 保护。

## 群组频道

默认启用自动发现。您也可以手动固定频道：

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

禁用自动发现：

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## 访问控制

DM 允许列表（空 = 不允许 DM，使用 `ownerShip` 进行批准流程）：

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

群组授权（默认受限）：

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## 所有者和批准系统

设置所有者 ship 以在未授权用户尝试交互时接收批准请求：

```json5
{
  channels: {
    tlon: {
      ownerShip: "~your-main-ship",
    },
  },
}
```

所有者 ship **在所有地方都自动授权** — DM 邀请会自动接受，
频道消息始终被允许。您不需要将所有者添加到 `dmAllowlist` 或
`defaultAuthorizedShips` 中。

设置后，所有者会收到以下 DM 通知：

- 来自不在允许列表中的 ships 的 DM 请求
- 在未经授权的频道中的提及
- 群组邀请请求

## 自动接受设置

自动接受 DM 邀请（对于 dmAllowlist 中的 ships）：

```json5
{
  channels: {
    tlon: {
      autoAcceptDmInvites: true,
    },
  },
}
```

自动接受群组邀请：

```json5
{
  channels: {
    tlon: {
      autoAcceptGroupInvites: true,
    },
  },
}
```

## 传递目标（CLI/计划任务）

将这些与 `openclaw message send` 或计划任务传递一起使用：

- DM: `~sampel-palnet` 或 `dm/~sampel-palnet`
- 群组: `chat/~host-ship/channel` 或 `group:~host-ship/channel`

## 捆绑技能

Tlon 插件包含一个捆绑技能（[`@tloncorp/tlon-skill`](https://github.com/tloncorp/tlon-skill)）
提供对 Tlon 操作的 CLI 访问：

- **联系人**：获取/更新个人资料，列出联系人
- **频道**：列出，创建，发布消息，获取历史记录
- **群组**：列出，创建，管理成员
- **DM**：发送消息，对消息做出反应
- **反应**：添加/删除对帖子和 DM 的表情反应
- **设置**：通过斜杠命令管理插件权限

该技能在插件安装时自动可用。

## 功能

| 功能      | 状态                          |
| --------- | ----------------------------- |
| 直接消息  | ✅ 支持                       |
| 群组/频道 | ✅ 支持（默认提及门控）       |
| 线程      | ✅ 支持（线程中自动回复）     |
| 富文本    | ✅ Markdown 转换为 Tlon 格式  |
| 图片      | ✅ 上传到 Tlon 存储           |
| 反应      | ✅ 通过 [捆绑技能](#捆绑技能) |
| 投票      | ❌ 尚不支持                   |
| 原生命令  | ✅ 支持（默认仅所有者）       |

## 故障排除

首先运行此阶梯：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
```

常见故障：

- **DM 被忽略**：发送者不在 `dmAllowlist` 中，且未配置 `ownerShip` 用于批准流程
- **群组消息被忽略**：频道未被发现或发送者未获授权
- **连接错误**：检查 ship URL 是否可访问；为本地 ships 启用 `allowPrivateNetwork`
- **认证错误**：验证登录代码是否当前有效（代码会轮换）

## 配置参考

完整配置：[配置](/gateway/configuration)

提供者选项：

- `channels.tlon.enabled`：启用/禁用通道启动
- `channels.tlon.ship`：机器人的 Urbit ship 名称（例如 `~sampel-palnet`）
- `channels.tlon.url`：ship URL（例如 `https://sampel-palnet.tlon.network`）
- `channels.tlon.code`：ship 登录代码
- `channels.tlon.allowPrivateNetwork`：允许 localhost/LAN URL（SSRF 绕过）
- `channels.tlon.ownerShip`：批准系统的所有者 ship（始终授权）
- `channels.tlon.dmAllowlist`：允许 DM 的 ships（空 = 无）
- `channels.tlon.autoAcceptDmInvites`：自动接受来自允许列表 ships 的 DM
- `channels.tlon.autoAcceptGroupInvites`：自动接受所有群组邀请
- `channels.tlon.autoDiscoverChannels`：自动发现群组频道（默认：true）
- `channels.tlon.groupChannels`：手动固定的频道嵌套
- `channels.tlon.defaultAuthorizedShips`：授权所有频道的 ships
- `channels.tlon.authorization.channelRules`：每个频道的认证规则
- `channels.tlon.showModelSignature`：在消息后附加模型名称

## 注意事项

- 群组回复需要提及（例如 `~your-bot-ship`）才能响应
- 线程回复：如果入站消息在线程中，OpenClaw 会在线程中回复
- 富文本：Markdown 格式（粗体、斜体、代码、标题、列表）会转换为 Tlon 的原生格式
- 图片：URL 会上传到 Tlon 存储并作为图片块嵌入

## 相关

- [通道概览](/channels) — 所有支持的通道
- [配对](/channels/pairing) — DM 认证和配对流程
- [群组](/channels/groups) — 群聊行为和提及限制
- [通道路由](/channels/channel-routing) — 消息的会话路由
- [安全性](/gateway/security) — 访问模型和加固
