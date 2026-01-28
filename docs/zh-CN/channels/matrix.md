---
read_when:
  - 开发 Matrix 渠道功能
summary: Matrix 支持状态、功能和配置
title: Matrix
x-i18n:
  generated_at: "2026-02-01T19:22:24Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b276b5263593c766e7be6549abbb27927177e7b51cfd297b4825965372513ee4
  source_path: channels/matrix.md
  workflow: 14
---

# Matrix（插件）

Matrix 是一个开放、去中心化的消息协议。OpenClaw 作为 Matrix **用户**连接到任何主服务器，因此你需要为机器人创建一个 Matrix 账户。登录后，你可以直接私信机器人或邀请它加入房间（Matrix 的"群组"）。Beeper 也是一个可用的客户端选项，但它需要启用端到端加密。

状态：通过插件支持（@vector-im/matrix-bot-sdk）。支持私信、房间、线程、媒体、回应、投票（发送 + poll-start 转为文本）、位置和端到端加密（需要加密支持）。

## 需要插件

Matrix 作为插件发布，不包含在核心安装中。

通过 CLI 安装（npm 注册表）：

```bash
openclaw plugins install @openclaw/matrix
```

本地检出（从 git 仓库运行时）：

```bash
openclaw plugins install ./extensions/matrix
```

如果你在配置/新手引导期间选择了 Matrix 并检测到 git 检出，OpenClaw 会自动提供本地安装路径。

详情：[插件](/plugin)

## 设置

1. 安装 Matrix 插件：
   - 从 npm：`openclaw plugins install @openclaw/matrix`
   - 从本地检出：`openclaw plugins install ./extensions/matrix`
2. 在主服务器上创建 Matrix 账户：
   - 在 [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/) 浏览托管选项
   - 或自行托管。
3. 获取机器人账户的访问 token：
   - 在你的主服务器上使用 Matrix 登录 API 配合 `curl`：

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - 将 `matrix.example.org` 替换为你的主服务器 URL。
   - 或设置 `channels.matrix.userId` + `channels.matrix.password`：OpenClaw 调用相同的登录端点，将访问 token 存储在 `~/.openclaw/credentials/matrix/credentials.json` 中，并在下次启动时重用。

4. 配置凭据：
   - 环境变量：`MATRIX_HOMESERVER`、`MATRIX_ACCESS_TOKEN`（或 `MATRIX_USER_ID` + `MATRIX_PASSWORD`）
   - 或配置：`channels.matrix.*`
   - 如果两者都设置了，配置优先。
   - 使用访问 token 时：用户 ID 通过 `/whoami` 自动获取。
   - 设置时，`channels.matrix.userId` 应为完整的 Matrix ID（例如：`@bot:example.org`）。
5. 重启 Gateway网关（或完成新手引导）。
6. 从任何 Matrix 客户端（Element、Beeper 等；参见 https://matrix.org/ecosystem/clients/）与机器人开始私信或邀请它加入房间。Beeper 需要端到端加密，因此请设置 `channels.matrix.encryption: true` 并验证设备。

最小配置（访问 token，用户 ID 自动获取）：

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

端到端加密配置（启用端到端加密）：

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## 加密（端到端加密）

端到端加密通过 Rust 加密 SDK **支持**。

通过 `channels.matrix.encryption: true` 启用：

- 如果加密模块加载成功，加密房间会自动解密。
- 向加密房间发送时，出站媒体会被加密。
- 首次连接时，OpenClaw 会从你的其他会话请求设备验证。
- 在另一个 Matrix 客户端（Element 等）中验证设备以启用密钥共享。
- 如果加密模块无法加载，端到端加密将被禁用且加密房间无法解密；OpenClaw 会记录警告。
- 如果你看到缺少加密模块的错误（例如 `@matrix-org/matrix-sdk-crypto-nodejs-*`），请允许 `@matrix-org/matrix-sdk-crypto-nodejs` 的构建脚本并运行 `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` 或通过 `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js` 获取二进制文件。

加密状态按账户 + 访问 token 存储在 `~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`（SQLite 数据库）。同步状态存储在同一目录下的 `bot-storage.json` 中。如果访问 token（设备）发生变化，会创建新的存储，机器人必须重新验证才能在加密房间中使用。

**设备验证：**
启用端到端加密后，机器人会在启动时从你的其他会话请求验证。打开 Element（或其他客户端）并批准验证请求以建立信任。验证完成后，机器人可以解密加密房间中的消息。

## 路由模型

- 回复始终发回 Matrix。
- 私信共享智能体的主会话；房间映射到群组会话。

## 访问控制（私信）

- 默认：`channels.matrix.dm.policy = "pairing"`。未知发送者会收到配对码。
- 通过以下方式批准：
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- 公开私信：`channels.matrix.dm.policy="open"` 加上 `channels.matrix.dm.allowFrom=["*"]`。
- `channels.matrix.dm.allowFrom` 接受用户 ID 或显示名称。向导在目录搜索可用时会将显示名称解析为用户 ID。

## 房间（群组）

- 默认：`channels.matrix.groupPolicy = "allowlist"`（提及门控）。使用 `channels.defaults.groupPolicy` 可在未设置时覆盖默认值。
- 使用 `channels.matrix.groups` 允许列表中的房间（房间 ID、别名或名称）：

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` 启用该房间的自动回复。
- `groups."*"` 可以设置跨房间的提及门控默认值。
- `groupAllowFrom` 限制哪些发送者可以在房间中触发机器人（可选）。
- 按房间的 `users` 允许列表可以进一步限制特定房间内的发送者。
- 配置向导会提示输入房间允许列表（房间 ID、别名或名称）并在可能时解析名称。
- 启动时，OpenClaw 将允许列表中的房间/用户名称解析为 ID 并记录映射；未解析的条目保持原样。
- 邀请默认自动加入；通过 `channels.matrix.autoJoin` 和 `channels.matrix.autoJoinAllowlist` 控制。
- 要**不允许任何房间**，设置 `channels.matrix.groupPolicy: "disabled"`（或保持空的允许列表）。
- 旧版键：`channels.matrix.rooms`（与 `groups` 结构相同）。

## 线程

- 支持回复线程。
- `channels.matrix.threadReplies` 控制回复是否保持在线程中：
  - `off`、`inbound`（默认）、`always`
- `channels.matrix.replyToMode` 控制不在线程中回复时的 reply-to 元数据：
  - `off`（默认）、`first`、`all`

## 功能

| 功能       | 状态                                                       |
| ---------- | ---------------------------------------------------------- |
| 私信       | ✅ 支持                                                    |
| 房间       | ✅ 支持                                                    |
| 线程       | ✅ 支持                                                    |
| 媒体       | ✅ 支持                                                    |
| 端到端加密 | ✅ 支持（需要加密模块）                                    |
| 回应       | ✅ 支持（通过工具发送/读取）                               |
| 投票       | ✅ 支持发送；入站 poll start 转换为文本（响应/结束被忽略） |
| 位置       | ✅ 支持（geo URI；忽略海拔）                               |
| 原生命令   | ✅ 支持                                                    |

## 配置参考（Matrix）

完整配置：[配置](/gateway/configuration)

提供商选项：

- `channels.matrix.enabled`：启用/禁用渠道启动。
- `channels.matrix.homeserver`：主服务器 URL。
- `channels.matrix.userId`：Matrix 用户 ID（使用访问 token 时可选）。
- `channels.matrix.accessToken`：访问 token。
- `channels.matrix.password`：登录密码（token 会被存储）。
- `channels.matrix.deviceName`：设备显示名称。
- `channels.matrix.encryption`：启用端到端加密（默认：false）。
- `channels.matrix.initialSyncLimit`：初始同步限制。
- `channels.matrix.threadReplies`：`off | inbound | always`（默认：inbound）。
- `channels.matrix.textChunkLimit`：出站文本分块大小（字符）。
- `channels.matrix.chunkMode`：`length`（默认）或 `newline`，在按长度分块之前按空行（段落边界）分割。
- `channels.matrix.dm.policy`：`pairing | allowlist | open | disabled`（默认：pairing）。
- `channels.matrix.dm.allowFrom`：私信允许列表（用户 ID 或显示名称）。`open` 需要 `"*"`。向导在可能时将名称解析为 ID。
- `channels.matrix.groupPolicy`：`allowlist | open | disabled`（默认：allowlist）。
- `channels.matrix.groupAllowFrom`：群组消息的允许发送者列表。
- `channels.matrix.allowlistOnly`：强制对私信 + 房间执行允许列表规则。
- `channels.matrix.groups`：群组允许列表 + 按房间设置映射。
- `channels.matrix.rooms`：旧版群组允许列表/配置。
- `channels.matrix.replyToMode`：线程/标签的 reply-to 模式。
- `channels.matrix.mediaMaxMb`：入站/出站媒体上限（MB）。
- `channels.matrix.autoJoin`：邀请处理（`always | allowlist | off`，默认：always）。
- `channels.matrix.autoJoinAllowlist`：自动加入的允许房间 ID/别名。
- `channels.matrix.actions`：按操作的工具门控（reactions/messages/pins/memberInfo/channelInfo）。
