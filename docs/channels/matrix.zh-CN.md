---
summary: "Matrix 支持状态、设置和配置示例"
read_when:
  - 在 OpenClaw 中设置 Matrix
  - 配置 Matrix E2EE 和验证
title: "Matrix"
---

# Matrix

Matrix 是 OpenClaw 的一个内置频道插件。
它使用官方的 `matrix-js-sdk`，支持私信、房间、线程、媒体、反应、投票、位置和端到端加密 (E2EE)。

## 内置插件

Matrix 在当前的 OpenClaw 版本中作为内置插件提供，因此正常的打包构建不需要单独安装。

如果您使用的是较旧的构建或不包含 Matrix 的自定义安装，请手动安装：

从 npm 安装：

```bash
openclaw plugins install @openclaw/matrix
```

从本地检出安装：

```bash
openclaw plugins install ./path/to/local/matrix-plugin
```

有关插件行为和安装规则，请参见 [插件](/tools/plugin)。

## 设置

1. 确保 Matrix 插件可用。
   - 当前打包的 OpenClaw 版本已经内置了它。
   - 较旧/自定义安装可以使用上述命令手动添加。
2. 在您的 homeserver 上创建一个 Matrix 账户。
3. 配置 `channels.matrix`，使用以下任一方式：
   - `homeserver` + `accessToken`，或
   - `homeserver` + `userId` + `password`。
4. 重启网关。
5. 与机器人开始私信或邀请它加入房间。
   - 新的 Matrix 邀请只有在 `channels.matrix.autoJoin` 允许时才有效。

交互式设置路径：

```bash
openclaw channels add
openclaw configure --section channels
```

Matrix 向导会询问：

- homeserver URL
- 认证方法：访问令牌或密码
- 用户 ID（仅密码认证）
- 可选的设备名称
- 是否启用 E2EE
- 是否配置房间访问和邀请自动加入

向导的关键行为：

- 如果 Matrix 认证环境变量已经存在且该账户尚未在配置中保存认证信息，向导会提供一个环境快捷方式，将认证信息保存在环境变量中。
- 账户名称会被规范化为账户 ID。例如，`Ops Bot` 变为 `ops-bot`。
- 私信白名单条目直接接受 `@user:server`；显示名称只有在实时目录查找找到一个精确匹配时才有效。
- 房间白名单条目直接接受房间 ID 和别名。优先使用 `!room:server` 或 `#alias:server`；未解析的名称在运行时会被白名单解析忽略。
- 在邀请自动加入白名单模式下，仅使用稳定的邀请目标：`!roomId:server`、`#alias:server` 或 `*`。普通房间名称会被拒绝。
- 要在保存前解析房间名称，请使用 `openclaw channels resolve --channel matrix "Project Room"`。

<Warning>
`channels.matrix.autoJoin` 默认设置为 `off`。

如果您保持其未设置，机器人将不会加入邀请的房间或新的私信式邀请，因此除非您先手动加入，否则它不会出现在新的群组或邀请的私信中。

设置 `autoJoin: "allowlist"` 并结合 `autoJoinAllowlist` 来限制它接受哪些邀请，或者如果您希望它加入每一个邀请，则设置 `autoJoin: "always"`。

在 `allowlist` 模式下，`autoJoinAllowlist` 仅接受 `!roomId:server`、`#alias:server` 或 `*`。
</Warning>

白名单示例：

```json5
{
  channels: {
    matrix: {
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!ops:example.org", "#support:example.org"],
      groups: {
        "!ops:example.org": {
          requireMention: true,
        },
      },
    },
  },
}
```

加入每一个邀请：

```json5
{
  channels: {
    matrix: {
      autoJoin: "always",
    },
  },
}
```

最小令牌式设置：

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_xxx",
      dm: { policy: "pairing" },
    },
  },
}
```

密码式设置（登录后缓存令牌）：

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password: "replace-me", // pragma: allowlist secret
      deviceName: "OpenClaw Gateway",
    },
  },
}
```

Matrix 将缓存的凭据存储在 `~/.openclaw/credentials/matrix/` 中。
默认账户使用 `credentials.json`；命名账户使用 `credentials-<account>.json`。
当那里存在缓存的凭据时，OpenClaw 会将 Matrix 视为已配置，用于设置、诊断和频道状态发现，即使当前认证未直接在配置中设置。

环境变量等效项（当配置键未设置时使用）：

- `MATRIX_HOMESERVER`
- `MATRIX_ACCESS_TOKEN`
- `MATRIX_USER_ID`
- `MATRIX_PASSWORD`
- `MATRIX_DEVICE_ID`
- `MATRIX_DEVICE_NAME`

对于非默认账户，使用账户范围的环境变量：

- `MATRIX_<ACCOUNT_ID>_HOMESERVER`
- `MATRIX_<ACCOUNT_ID>_ACCESS_TOKEN`
- `MATRIX_<ACCOUNT_ID>_USER_ID`
- `MATRIX_<ACCOUNT_ID>_PASSWORD`
- `MATRIX_<ACCOUNT_ID>_DEVICE_ID`
- `MATRIX_<ACCOUNT_ID>_DEVICE_NAME`

账户 `ops` 的示例：

- `MATRIX_OPS_HOMESERVER`
- `MATRIX_OPS_ACCESS_TOKEN`

对于规范化的账户 ID `ops-bot`，使用：

- `MATRIX_OPS_X2D_BOT_HOMESERVER`
- `MATRIX_OPS_X2D_BOT_ACCESS_TOKEN`

Matrix 会转义账户 ID 中的标点符号，以保持范围环境变量无冲突。
例如，`-` 变为 `_X2D_`，因此 `ops-prod` 映射到 `MATRIX_OPS_X2D_PROD_*`。

交互式向导仅在那些认证环境变量已经存在且所选账户尚未在配置中保存 Matrix 认证时才提供环境变量快捷方式。

## 配置示例

这是一个实用的基线配置，启用了私信配对、房间白名单和 E2EE：

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_xxx",
      encryption: true,

      dm: {
        policy: "pairing",
        sessionScope: "per-room",
        threadReplies: "off",
      },

      groupPolicy: "allowlist",
      groupAllowFrom: ["@admin:example.org"],
      groups: {
        "!roomid:example.org": {
          requireMention: true,
        },
      },

      autoJoin: "allowlist",
      autoJoinAllowlist: ["!roomid:example.org"],
      threadReplies: "inbound",
      replyToMode: "off",
      streaming: "partial",
    },
  },
}
```

`autoJoin` 适用于所有 Matrix 邀请，包括私信式邀请。OpenClaw 无法在邀请时可靠地将邀请的房间分类为私信或群组，因此所有邀请都首先通过 `autoJoin`。`dm.policy` 在机器人加入并将房间分类为私信后应用。

## 流式预览

Matrix 回复流式传输是可选的。

当您希望 OpenClaw 发送单个实时预览回复，在模型生成文本时在适当位置编辑该预览，然后在回复完成时将其定稿时，将 `channels.matrix.streaming` 设置为 `"partial"`：

```json5
{
  channels: {
    matrix: {
      streaming: "partial",
    },
  },
}
```

- `streaming: "off"` 是默认值。OpenClaw 等待最终回复并一次性发送。
- `streaming: "partial"` 使用正常的 Matrix 文本消息为当前助手块创建一个可编辑的预览消息。这保留了 Matrix 的传统预览优先通知行为，因此库存客户端可能会在第一个流式预览文本而不是完成的块上发出通知。
- `streaming: "quiet"` 为当前助手块创建一个可编辑的安静预览通知。仅当您还为定稿的预览编辑配置了接收者推送规则时才使用此选项。
- `blockStreaming: true` 启用单独的 Matrix 进度消息。启用预览流式传输后，Matrix 会为当前块保留实时草稿，并将已完成的块保留为单独的消息。
- 当预览流式传输开启且 `blockStreaming` 关闭时，Matrix 会在适当位置编辑实时草稿，并在块或回合完成时最终确定同一事件。
- 如果预览不再适合一个 Matrix 事件，OpenClaw 会停止预览流式传输并回退到正常的最终传递。
- 媒体回复仍正常发送附件。如果过时的预览不能再安全地重用，OpenClaw 会在发送最终媒体回复前将其删除。
- 预览编辑需要额外的 Matrix API 调用。如果您希望最保守的速率限制行为，请保持流式传输关闭。

`blockStreaming` 本身不会启用草稿预览。
使用 `streaming: "partial"` 或 `streaming: "quiet"` 进行预览编辑；然后仅当您还希望已完成的助手块作为单独的进度消息保持可见时，才添加 `blockStreaming: true`。

如果您需要没有自定义推送规则的库存 Matrix 通知，请使用 `streaming: "partial"` 获得预览优先行为，或保持 `streaming` 关闭以获得仅最终传递。使用 `streaming: "off"`：

- `blockStreaming: true` 将每个完成的块作为正常的通知 Matrix 消息发送。
- `blockStreaming: false` 仅将最终完成的回复作为正常的通知 Matrix 消息发送。

### 用于安静定稿预览的自托管推送规则

如果您运行自己的 Matrix 基础设施，并且希望安静预览仅在块或最终回复完成时通知，请设置 `streaming: "quiet"` 并为定稿的预览编辑添加每个用户的推送规则。

这通常是接收者用户设置，而不是 homeserver 全局配置更改：

开始前的快速映射：

- 接收者用户 = 应该收到通知的人
- 机器人用户 = 发送回复的 OpenClaw Matrix 账户
- 对以下 API 调用使用接收者用户的访问令牌
- 将推送规则中的 `sender` 与机器人用户的完整 MXID 匹配

1. 配置 OpenClaw 使用安静预览：

```json5
{
  channels: {
    matrix: {
      streaming: "quiet",
    },
  },
}
```

2. 确保接收者账户已经接收正常的 Matrix 推送通知。安静预览规则仅在该用户已经有工作的推送器/设备时才有效。

3. 获取接收者用户的访问令牌。
   - 使用接收用户的令牌，而不是机器人的令牌。
   - 重用现有的客户端会话令牌通常最容易。
   - 如果您需要生成新令牌，可以通过标准 Matrix 客户端-服务器 API 登录：

```bash
curl -sS -X POST \
  "https://matrix.example.org/_matrix/client/v3/login" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "m.login.password",
    "identifier": {
      "type": "m.id.user",
      "user": "@alice:example.org"
    },
    "password": "REDACTED"
  }'
```

4. 验证接收者账户已经有推送器：

```bash
curl -sS \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  "https://matrix.example.org/_matrix/client/v3/pushers"
```

如果这返回没有活动的推送器/设备，请先修复正常的 Matrix 通知，然后再添加下面的 OpenClaw 规则。

OpenClaw 用以下标记标记定稿的纯文本预览编辑：

```json
{
  "com.openclaw.finalized_preview": true
}
```

5. 为每个应该接收这些通知的接收者账户创建一个覆盖推送规则：

```bash
curl -sS -X PUT \
  "https://matrix.example.org/_matrix/client/v3/pushrules/global/override/openclaw-finalized-preview-botname" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "conditions": [
      { "kind": "event_match", "key": "type", "pattern": "m.room.message" },
      {
        "kind": "event_property_is",
        "key": "content.m\\.relates_to.rel_type",
        "value": "m.replace"
      },
      {
        "kind": "event_property_is",
        "key": "content.com\\.openclaw\\.finalized_preview",
        "value": true
      },
      { "kind": "event_match", "key": "sender", "pattern": "@bot:example.org" }
    ],
    "actions": [
      "notify",
      { "set_tweak": "sound", "value": "default" },
      { "set_tweak": "highlight", "value": false }
    ]
  }'
```

在运行命令前替换这些值：

- `https://matrix.example.org`：您的 homeserver 基础 URL
- `$USER_ACCESS_TOKEN`：接收用户的访问令牌
- `openclaw-finalized-preview-botname`：对该接收用户唯一的此机器人规则 ID
- `@bot:example.org`：您的 OpenClaw Matrix 机器人 MXID，不是接收用户的 MXID

多机器人设置的重要事项：

- 推送规则按 `ruleId` 键控。对同一个规则 ID 重新运行 `PUT` 会更新该规则。
- 如果一个接收用户应该为多个 OpenClaw Matrix 机器人账户通知，请为每个机器人创建一个规则，每个发送者匹配都有唯一的规则 ID。
- 一个简单的模式是 `openclaw-finalized-preview-<botname>`，例如 `openclaw-finalized-preview-ops` 或 `openclaw-finalized-preview-support`。

规则根据事件发送者进行评估：

- 使用接收用户的令牌进行认证
- 将 `sender` 与 OpenClaw 机器人 MXID 匹配

6. 验证规则存在：

```bash
curl -sS \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  "https://matrix.example.org/_matrix/client/v3/pushrules/global/override/openclaw-finalized-preview-botname"
```

7. 测试流式回复。在安静模式下，房间应该显示一个安静的草稿预览，当块或回合完成时，最终的原地编辑应该通知一次。

如果您以后需要删除规则，请使用接收用户的令牌删除同一个规则 ID：

```bash
curl -sS -X DELETE \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  "https://matrix.example.org/_matrix/client/v3/pushrules/global/override/openclaw-finalized-preview-botname"
```

注意：

- 使用接收用户的访问令牌而不是机器人的令牌创建规则。
- 新的用户定义 `override` 规则会插入到默认抑制规则之前，因此不需要额外的排序参数。
- 这仅影响 OpenClaw 可以安全地原地定稿的纯文本预览编辑。媒体回退和过时预览回退仍使用正常的 Matrix 传递。
- 如果 `GET /_matrix/client/v3/pushers` 显示没有推送器，则用户尚未为此账户/设备启用工作的 Matrix 推送传递。

#### Synapse

对于 Synapse，上面的设置通常本身就足够：

- 不需要对 `homeserver.yaml` 进行特殊更改即可完成 OpenClaw 预览通知。
- 如果您的 Synapse 部署已经发送正常的 Matrix 推送通知，上述用户令牌 + `pushrules` 调用是主要设置步骤。
- 如果您在反向代理或工作器后面运行 Synapse，请确保 `/_matrix/client/.../pushrules/` 正确到达 Synapse。
- 如果您运行 Synapse 工作器，请确保推送器健康。推送传递由主进程或 `synapse.app.pusher` / 配置的推送器工作器处理。

#### Tuwunel

对于 Tuwunel，使用上面显示的相同设置流程和推送规则 API 调用：

- 不需要 Tuwunel 特定的配置来处理定稿的预览标记本身。
- 如果该用户的正常 Matrix 通知已经工作，上述用户令牌 + `pushrules` 调用是主要设置步骤。
- 如果通知在用户在另一台设备上活跃时似乎消失，请检查是否启用了 `suppress_push_when_active`。Tuwunel 在 2025 年 9 月 12 日的 Tuwunel 1.4.2 中添加了此选项，它可以在一台设备活跃时有意抑制对其他设备的推送。

## 机器人到机器人房间

默认情况下，来自其他配置的 OpenClaw Matrix 账户的 Matrix 消息会被忽略。

当您有意希望代理间 Matrix 流量时，使用 `allowBots`：

```json5
{
  channels: {
    matrix: {
      allowBots: "mentions", // true | "mentions"
      groups: {
        "!roomid:example.org": {
          requireMention: true,
        },
      },
    },
  },
}
```

- `allowBots: true` 接受来自允许的房间和私信中其他配置的 Matrix 机器人账户的消息。
- `allowBots: "mentions"` 仅当这些消息在房间中明显提及此机器人时才接受。私信仍然被允许。
- `groups.<room>.allowBots` 覆盖一个房间的账户级设置。
- OpenClaw 仍然忽略来自同一 Matrix 用户 ID 的消息，以避免自回复循环。
- Matrix 在这里不公开原生机器人标志；OpenClaw 将“机器人撰写”视为“由此 OpenClaw 网关上的另一个配置的 Matrix 账户发送”。

在共享房间中启用机器人到机器人流量时，请使用严格的房间白名单和提及要求。

## 加密和验证

在加密 (E2EE) 房间中，出站图像事件使用 `thumbnail_file`，因此图像预览与完整附件一起加密。未加密的房间仍然使用纯 `thumbnail_url`。不需要配置 — 插件会自动检测 E2EE 状态。

启用加密：

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_xxx",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

检查验证状态：

```bash
openclaw matrix verify status
```

详细状态（完整诊断）：

```bash
openclaw matrix verify status --verbose
```

在机器可读输出中包含存储的恢复密钥：

```bash
openclaw matrix verify status --include-recovery-key --json
```

引导交叉签名和验证状态：

```bash
openclaw matrix verify bootstrap
```

详细引导诊断：

```bash
openclaw matrix verify bootstrap --verbose
```

在引导前强制重置交叉签名身份：

```bash
openclaw matrix verify bootstrap --force-reset-cross-signing
```

使用恢复密钥验证此设备：

```bash
openclaw matrix verify device "<your-recovery-key>"
```

详细设备验证详情：

```bash
openclaw matrix verify device "<your-recovery-key>" --verbose
```

检查房间密钥备份健康状态：

```bash
openclaw matrix verify backup status
```

详细备份健康诊断：

```bash
openclaw matrix verify backup status --verbose
```

从服务器备份恢复房间密钥：

```bash
openclaw matrix verify backup restore
```

详细恢复诊断：

```bash
openclaw matrix verify backup restore --verbose
```

删除当前服务器备份并创建新的备份基线。如果无法干净地加载存储的备份密钥，此重置还可以重新创建秘密存储，以便将来的冷启动可以加载新的备份密钥：

```bash
openclaw matrix verify backup reset --yes
```

所有 `verify` 命令默认都是简洁的（包括安静的内部 SDK 日志记录），并且仅在使用 `--verbose` 时显示详细诊断。
脚本编写时使用 `--json` 获取完整的机器可读输出。

在多账户设置中，Matrix CLI 命令使用隐式 Matrix 默认账户，除非您传递 `--account <id>`。
如果您配置了多个命名账户，请先设置 `channels.matrix.defaultAccount`，否则那些隐式 CLI 操作将停止并要求您明确选择一个账户。
当您希望验证或设备操作明确针对命名账户时，使用 `--account`：

```bash
openclaw matrix verify status --account assistant
openclaw matrix verify backup restore --account assistant
openclaw matrix devices list --account assistant
```

当加密对于命名账户被禁用或不可用时，Matrix 警告和验证错误会指向该账户的配置键，例如 `channels.matrix.accounts.assistant.encryption`。

### “已验证”的含义

OpenClaw 仅当此 Matrix 设备被您自己的交叉签名身份验证时才将其视为已验证。
实际上，`openclaw matrix verify status --verbose` 公开三个信任信号：

- `本地信任`：此设备仅被当前客户端信任
- `交叉签名已验证`：SDK 通过交叉签名报告设备已验证
- `由所有者签名`：设备由您自己的自签名密钥签名

只有当存在交叉签名验证或所有者签名时，`由所有者验证` 才变为 `是`。
仅本地信任不足以让 OpenClaw 将设备视为完全已验证。

### 引导的作用

`openclaw matrix verify bootstrap` 是加密 Matrix 账户的修复和设置命令。
它按顺序执行以下所有操作：

- 引导秘密存储，尽可能重用现有的恢复密钥
- 引导交叉签名并上传缺少的公共交叉签名密钥
- 尝试标记并交叉签名当前设备
- 如果不存在，则创建新的服务器端房间密钥备份

如果 homeserver 需要交互式认证来上传交叉签名密钥，OpenClaw 首先尝试无认证上传，然后使用 `m.login.dummy`，然后在配置了 `channels.matrix.password` 时使用 `m.login.password`。

仅当您有意希望丢弃当前交叉签名身份并创建新身份时，才使用 `--force-reset-cross-signing`。

如果您有意希望丢弃当前房间密钥备份并为未来消息开始新的备份基线，请使用 `openclaw matrix verify backup reset --yes`。
只有当您接受不可恢复的旧加密历史将保持不可用，并且如果当前备份秘密无法安全加载，OpenClaw 可能会重新创建秘密存储时，才执行此操作。

### 新的备份基线

如果您希望保持未来的加密消息正常工作并接受丢失不可恢复的旧历史，请按顺序运行这些命令：

```bash
openclaw matrix verify backup reset --yes
openclaw matrix verify backup status --verbose
openclaw matrix verify status
```

当您希望明确针对命名 Matrix 账户时，在每个命令中添加 `--account <id>`。

### 启动行为

当 `encryption: true` 时，Matrix 默认将 `startupVerification` 设置为 `"if-unverified"`。
启动时，如果此设备仍未验证，Matrix 将在另一个 Matrix 客户端中请求自我验证，
在一个请求已经挂起时跳过重复请求，并在重启后应用本地冷却时间再重试。
默认情况下，失败的请求尝试比重试成功的请求创建更快。
设置 `startupVerification: "off"` 以禁用自动启动请求，或者如果您想要更短或更长的重试窗口，调整 `startupVerificationCooldownHours`。

启动还会自动执行保守的加密引导过程。
该过程首先尝试重用当前的秘密存储和交叉签名身份，并避免重置交叉签名，除非您运行显式的引导修复流程。

如果启动仍然发现损坏的引导状态，即使未配置 `channels.matrix.password`，OpenClaw 也可以尝试受保护的修复路径。
如果 homeserver 需要基于密码的 UIA 进行该修复，OpenClaw 会记录警告并保持启动非致命，而不是中止机器人。
如果当前设备已经由所有者签名，OpenClaw 会保留该身份，而不是自动重置它。

有关完整的升级流程、限制、恢复命令和常见迁移消息，请参见 [Matrix 迁移](/install/migrating-matrix)。

### 验证通知

Matrix 将验证生命周期通知作为 `m.notice` 消息直接发布到严格的私信验证房间中。
这包括：

- 验证请求通知
- 验证就绪通知（带有明确的“通过表情符号验证”指南）
- 验证开始和完成通知
- SAS 详情（表情符号和小数）（如果可用）

来自另一个 Matrix 客户端的传入验证请求由 OpenClaw 跟踪并自动接受。
对于自我验证流程，当表情符号验证可用时，OpenClaw 还会自动启动 SAS 流程并确认其自己的一方。
对于来自另一个 Matrix 用户/设备的验证请求，OpenClaw 自动接受请求，然后等待 SAS 流程正常进行。
您仍然需要在 Matrix 客户端中比较表情符号或小数 SAS 并确认“它们匹配”以完成验证。

OpenClaw 不会盲目自动接受自我发起的重复流程。当自我验证请求已经挂起时，启动会跳过创建新请求。

验证协议/系统通知不会转发到代理聊天管道，因此它们不会产生 `NO_REPLY`。

### 设备卫生

旧的 OpenClaw 管理的 Matrix 设备可能会在账户上累积，使加密房间信任更难推理。
列出它们：

```bash
openclaw matrix devices list
```

移除过时的 OpenClaw 管理的设备：

```bash
openclaw matrix devices prune-stale
```

### 加密存储

Matrix E2EE 在 Node 中使用官方的 `matrix-js-sdk` Rust 加密路径，使用 `fake-indexeddb` 作为 IndexedDB 垫片。加密状态持久化到快照文件 (`crypto-idb-snapshot.json`) 并在启动时恢复。快照文件是敏感的运行时状态，以限制性文件权限存储。

加密的运行时状态位于每个账户、每个用户令牌哈希根目录下的
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/`。
该目录包含同步存储 (`bot-storage.json`)、加密存储 (`crypto/`)、
恢复密钥文件 (`recovery-key.json`)、IndexedDB 快照 (`crypto-idb-snapshot.json`)、
线程绑定 (`thread-bindings.json`) 和启动验证状态 (`startup-verification.json`)。
当令牌更改但账户身份保持相同时，OpenClaw 会为此账户/homeserver/用户元组重用最佳现有根，以便先前的同步状态、加密状态、线程绑定和启动验证状态保持可见。

## 个人资料管理

使用以下命令更新所选账户的 Matrix 自我个人资料：

```bash
openclaw matrix profile set --name "OpenClaw Assistant"
openclaw matrix profile set --avatar-url https://cdn.example.org/avatar.png
```

当您希望明确针对命名 Matrix 账户时，添加 `--account <id>`。

Matrix 直接接受 `mxc://` 头像 URL。当您传递 `http://` 或 `https://` 头像 URL 时，OpenClaw 会首先将其上传到 Matrix，然后将解析的 `mxc://` URL 存储回 `channels.matrix.avatarUrl`（或所选账户覆盖）。

## 线程

Matrix 支持用于自动回复和消息工具发送的原生 Matrix 线程。

- `dm.sessionScope: "per-user"`（默认）保持 Matrix 私信路由以发送者为范围，因此当多个私信房间解析到同一个对等方时，可以共享一个会话。
- `dm.sessionScope: "per-room"` 将每个 Matrix 私信房间隔离到其自己的会话密钥中，同时仍然使用正常的私信认证和白名单检查。
- 显式 Matrix 对话绑定仍然优先于 `dm.sessionScope`，因此绑定的房间和线程保持其选择的目标会话。
- `threadReplies: "off"` 保持回复在顶层，并将入站线程消息保持在父会话上。
- `threadReplies: "inbound"` 仅当入站消息已经在该线程中时才在线程内回复。
- `threadReplies: "always"` 将房间回复保持在以触发消息为根的线程中，并通过第一个触发消息的匹配线程范围会话路由该对话。
- `dm.threadReplies` 仅为私信覆盖顶级设置。例如，您可以保持房间线程隔离，同时保持私信扁平。
- 入站线程消息包含线程根消息作为额外的代理上下文。
- 消息工具发送在目标是同一个房间或同一个私信用户目标时，会自动继承当前 Matrix 线程，除非提供了显式的 `threadId`。
- 同会话私信用户目标重用仅在当前会话元数据证明同一 Matrix 账户上的同一私信对等方时才会启动；否则 OpenClaw 会回退到正常的用户范围路由。
- 当 OpenClaw 看到 Matrix 私信房间与同一共享 Matrix 私信会话上的另一个私信房间冲突时，当启用线程绑定和 `dm.sessionScope` 提示时，它会在该房间中发布一次性 `m.notice` 并带有 `/focus` 逃生舱口。
- Matrix 支持运行时线程绑定。`/focus`、`/unfocus`、`/agents`、`/session idle`、`/session max-age` 和线程绑定的 `/acp spawn` 在 Matrix 房间和私信中工作。
- 顶级 Matrix 房间/私信 `/focus` 当 `threadBindings.spawnSubagentSessions=true` 时会创建新的 Matrix 线程并将其绑定到目标会话。
- 在现有 Matrix 线程内运行 `/focus` 或 `/acp spawn --thread here` 会绑定该当前线程。

## ACP 对话绑定

Matrix 房间、私信和现有的 Matrix 线程可以转变为持久的 ACP 工作区，而无需更改聊天表面。

快速操作员流程：

- 在您想继续使用的 Matrix 私信、房间或现有线程内运行 `/acp spawn codex --bind here`。
- 在顶级 Matrix 私信或房间中，当前的私信/房间保持为聊天表面，未来的消息路由到生成的 ACP 会话。
- 在现有 Matrix 线程内，`--bind here` 就地绑定该当前线程。
- `/new` 和 `/reset` 就地重置同一个绑定的 ACP 会话。
- `/acp close` 关闭 ACP 会话并移除绑定。

注意：

- `--bind here` 不会创建子 Matrix 线程。
- `threadBindings.spawnAcpSessions` 仅对于 `/acp spawn --thread auto|here` 是必需的，其中 OpenClaw 需要创建或绑定子 Matrix 线程。

### 线程绑定配置

Matrix 从 `session.threadBindings` 继承全局默认值，还支持每频道覆盖：

- `threadBindings.enabled`
- `threadBindings.idleHours`
- `threadBindings.maxAgeHours`
- `threadBindings.spawnSubagentSessions`
- `threadBindings.spawnAcpSessions`

Matrix 线程绑定的生成标志是可选的：

- 设置 `threadBindings.spawnSubagentSessions: true` 以允许顶级 `/focus` 创建和绑定新的 Matrix 线程。
- 设置 `threadBindings.spawnAcpSessions: true` 以允许 `/acp spawn --thread auto|here` 将 ACP 会话绑定到 Matrix 线程。

## 反应

Matrix 支持出站反应操作、入站反应通知和入站确认反应。

- 出站反应工具由 `channels["matrix"].actions.reactions` 控制。
- `react` 向特定 Matrix 事件添加反应。
- `reactions` 列出特定 Matrix 事件的当前反应摘要。
- `emoji=""` 移除机器人账户在该事件上的自己的反应。
- `remove: true` 仅从机器人账户中移除指定的表情符号反应。

确认反应使用标准的 OpenClaw 解析顺序：

- `channels["matrix"].accounts.<accountId>.ackReaction`
- `channels["matrix"].ackReaction`
- `messages.ackReaction`
- 代理身份表情符号回退

确认反应范围按此顺序解析：

- `channels["matrix"].accounts.<accountId>.ackReactionScope`
- `channels["matrix"].ackReactionScope`
- `messages.ackReactionScope`

反应通知模式按此顺序解析：

- `channels["matrix"].accounts.<accountId>.reactionNotifications`
- `channels["matrix"].reactionNotifications`
- 默认值：`own`

行为：

- `reactionNotifications: "own"` 当 `m.reaction` 事件针对机器人撰写的 Matrix 消息时转发它们。
- `reactionNotifications: "off"` 禁用反应系统事件。
- 反应删除不会合成为系统事件，因为 Matrix 将它们显示为删除，而不是独立的 `m.reaction` 删除。

## 历史上下文

- `channels.matrix.historyLimit` 控制当 Matrix 房间消息触发代理时，作为 `InboundHistory` 包含的最近房间消息数量。回退到 `messages.groupChat.historyLimit`；如果两者都未设置，有效默认值为 `0`。设置 `0` 以禁用。
- Matrix 房间历史仅限于房间。私信继续使用正常的会话历史。
- Matrix 房间历史仅为待处理：OpenClaw 缓冲尚未触发回复的房间消息，然后在提及或其他触发器到达时快照该窗口。
- 当前触发消息不包含在 `InboundHistory` 中；它保持在该回合的主要入站正文中。
- 同一 Matrix 事件的重试重用原始历史快照，而不是向前漂移到更新的房间消息。

## 上下文可见性

Matrix 支持用于补充房间上下文的共享 `contextVisibility` 控制，例如获取的回复文本、线程根和待处理历史。

- `contextVisibility: "all"` 是默认值。补充上下文保持原样接收。
- `contextVisibility: "allowlist"` 将补充上下文过滤到活动房间/用户白名单检查允许的发送者。
- `contextVisibility: "allowlist_quote"` 行为类似于 `allowlist`，但仍然保留一个显式引用的回复。

此设置影响补充上下文可见性，而不是入站消息本身是否可以触发回复。
触发授权仍然来自 `groupPolicy`、`groups`、`groupAllowFrom` 和私信策略设置。

## 私信和房间策略

```json5
{
  channels: {
    matrix: {
      dm: {
        policy: "allowlist",
        allowFrom: ["@admin:example.org"],
        threadReplies: "off",
      },
      groupPolicy: "allowlist",
      groupAllowFrom: ["@admin:example.org"],
      groups: {
        "!roomid:example.org": {
          requireMention: true,
        },
      },
    },
  },
}
```

有关提及门控和白名单行为，请参见 [群组](/channels/groups)。

Matrix 私信的配对示例：

```bash
openclaw pairing list matrix
openclaw pairing approve matrix <CODE>
```

如果未经批准的 Matrix 用户在批准前继续向您发送消息，OpenClaw 会重用相同的待处理配对代码，并可能在短暂冷却后再次发送提醒回复，而不是生成新代码。

有关共享私信配对流程和存储布局，请参见 [配对](/channels/pairing)。

## 直接房间修复

如果直接消息状态不同步，OpenClaw 可能会最终得到指向旧的单独房间而不是活动私信的过时 `m.direct` 映射。使用以下命令检查对等方的当前映射：

```bash
openclaw matrix direct inspect --user-id @alice:example.org
```

使用以下命令修复：

```bash
openclaw matrix direct repair --user-id @alice:example.org
```

修复流程：

- 首选已经在 `m.direct` 中映射的严格 1:1 私信
- 回退到与该用户的任何当前加入的严格 1:1 私信
- 如果不存在健康的私信，则创建新的直接房间并重写 `m.direct`

修复流程不会自动删除旧房间。它只会选择健康的私信并更新映射，以便新的 Matrix 发送、验证通知和其他直接消息流程再次指向正确的房间。

## 执行批准

Matrix 可以作为 Matrix 账户的原生批准客户端。原生
私信/频道路由旋钮仍然位于执行批准配置下：

- `channels.matrix.execApprovals.enabled`
- `channels.matrix.execApprovals.approvers`（可选；回退到 `channels.matrix.dm.allowFrom`）
- `channels.matrix.execApprovals.target`（`dm` | `channel` | `both`，默认：`dm`）
- `channels.matrix.execApprovals.agentFilter`
- `channels.matrix.execApprovals.sessionFilter`

批准者必须是 Matrix 用户 ID，例如 `@owner:example.org`。当 `enabled` 未设置或为 `"auto"` 且至少一个批准者可以解析时，Matrix 会自动启用原生批准。执行批准首先使用 `execApprovals.approvers`，并可以回退到 `channels.matrix.dm.allowFrom`。插件批准通过 `channels.matrix.dm.allowFrom` 授权。设置 `enabled: false` 以明确禁用 Matrix 作为原生批准客户端。否则，批准请求会回退到其他配置的批准路由或批准回退策略。

Matrix 原生路由支持两种批准类型：

- `channels.matrix.execApprovals.*` 控制 Matrix 批准提示的原生私信/频道扇出模式。
- 执行批准使用来自 `execApprovals.approvers` 或 `channels.matrix.dm.allowFrom` 的执行批准者集。
- 插件批准使用来自 `channels.matrix.dm.allowFrom` 的 Matrix 私信白名单。
- Matrix 反应快捷方式和消息更新适用于执行和插件批准。

传递规则：

- `target: "dm"` 向批准者私信发送批准提示
- `target: "channel"` 将提示发送回原始 Matrix 房间或私信
- `target: "both"` 发送到批准者私信和原始 Matrix 房间或私信

Matrix 批准提示在主要批准消息上添加反应快捷方式：

- `✅` = 允许一次
- `❌` = 拒绝
- `♾️` = 当该决定被有效执行策略允许时始终允许

批准者可以对该消息做出反应，或使用回退斜杠命令：`/approve <id> allow-once`、`/approve <id> allow-always` 或 `/approve <id> deny`。

只有已解析的批准者可以批准或拒绝。对于执行批准，频道传递包含命令文本，因此仅在受信任的房间中启用 `channel` 或 `both`。

每账户覆盖：

- `channels.matrix.accounts.<account>.execApprovals`

相关文档：[执行批准](/tools/exec-approvals)

## 多账户

```json5
{
  channels: {
    matrix: {
      enabled: true,
      defaultAccount: "assistant",
      dm: { policy: "pairing" },
      accounts: {
        assistant: {
          homeserver: "https://matrix.example.org",
          accessToken: "syt_assistant_xxx",
          encryption: true,
        },
        alerts: {
          homeserver: "https://matrix.example.org",
          accessToken: "syt_alerts_xxx",
          dm: {
            policy: "allowlist",
            allowFrom: ["@ops:example.org"],
            threadReplies: "off",
          },
        },
      },
    },
  },
}
```

顶级 `channels.matrix` 值作为命名账户的默认值，除非账户覆盖它们。
您可以使用 `groups.<room>.account` 将继承的房间条目范围限定为一个 Matrix 账户。
没有 `account` 的条目仍然在所有 Matrix 账户之间共享，带有 `account: "default"` 的条目在默认账户直接配置在顶级 `channels.matrix.*` 上时仍然有效。
部分共享的认证默认值不会单独创建隐式默认账户。OpenClaw 仅当该默认值具有新的认证（`homeserver` 加 `accessToken`，或 `homeserver` 加 `userId` 和 `password`）时才会合成顶级 `default` 账户；命名账户在缓存的凭据稍后满足认证时，仍然可以从 `homeserver` 加 `userId` 保持可发现。
如果 Matrix 已经有恰好一个命名账户，或者 `defaultAccount` 指向现有的命名账户键，则单账户到多账户的修复/设置升级会保留该账户，而不是创建新的 `accounts.default` 条目。只有 Matrix 认证/引导键会移动到该升级的账户中；共享的传递策略键保持在顶级。
当您希望 OpenClaw 优先使用一个命名 Matrix 账户进行隐式路由、探测和 CLI 操作时，设置 `defaultAccount`。
如果配置了多个 Matrix 账户且一个账户 ID 为 `default`，即使未设置 `defaultAccount`，OpenClaw 也会隐式使用该账户。
如果您配置了多个命名账户，请设置 `defaultAccount` 或为依赖隐式账户选择的 CLI 命令传递 `--account <id>`。
当您希望为一个命令覆盖该隐式选择时，将 `--account <id>` 传递给 `openclaw matrix verify ...` 和 `openclaw matrix devices ...`。

有关共享多账户模式，请参见 [配置参考](/gateway/configuration-reference#multi-account-all-channels)。

## 私有/LAN homeservers

默认情况下，OpenClaw 会阻止私有/内部 Matrix homeserver 以进行 SSRF 保护，除非您
明确按账户选择加入。

如果您的 homeserver 运行在 localhost、LAN/Tailscale IP 或内部主机名上，请为该 Matrix 账户启用 `network.dangerouslyAllowPrivateNetwork`：

```json5
{
  channels: {
    matrix: {
      homeserver: "http://matrix-synapse:8008",
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
      accessToken: "syt_internal_xxx",
    },
  },
}
```

CLI 设置示例：

```bash
openclaw matrix account add \
  --account ops \
  --homeserver http://matrix-synapse:8008 \
  --allow-private-network \
  --access-token syt_ops_xxx
```

此选择加入仅允许受信任的私有/内部目标。公共明文 homeserver（例如
`http://matrix.example.org:8008`）仍然被阻止。尽可能使用 `https://`。

## 代理 Matrix 流量

如果您的 Matrix 部署需要显式的出站 HTTP(S) 代理，请设置 `channels.matrix.proxy`：

```json5
{
  channels: {
    matrix: {
      homeserver: "https://matrix.example.org",
      accessToken: "syt_bot_xxx",
      proxy: "http://127.0.0.1:7890",
    },
  },
}
```

命名账户可以使用 `channels.matrix.accounts.<id>.proxy` 覆盖顶级默认值。
OpenClaw 对运行时 Matrix 流量和账户状态探测使用相同的代理设置。

## 目标解析

Matrix 在 OpenClaw 要求您提供房间或用户目标的任何地方接受这些目标形式：

- 用户：`@user:server`、`user:@user:server` 或 `matrix:user:@user:server`
- 房间：`!room:server`、`room:!room:server` 或 `matrix:room:!room:server`
- 别名：`#alias:server`、`channel:#alias:server` 或 `matrix:channel:#alias:server`

实时目录查找使用登录的 Matrix 账户：

- 用户查找查询该 homeserver 上的 Matrix 用户目录。
- 房间查找直接接受明确的房间 ID 和别名，然后回退到搜索该账户的已加入房间名称。
- 已加入房间名称查找是尽力而为的。如果房间名称无法解析为 ID 或别名，它会被运行时白名单解析忽略。

## 配置参考

- `enabled`：启用或禁用频道。
- `name`：账户的可选标签。
- `defaultAccount`：配置多个 Matrix 账户时的首选账户 ID。
- `homeserver`：homeserver URL，例如 `https://matrix.example.org`。
- `network.dangerouslyAllowPrivateNetwork`：允许此 Matrix 账户连接到私有/内部 homeserver。当 homeserver 解析为 `localhost`、LAN/Tailscale IP 或内部主机（如 `matrix-synapse`）时启用此选项。
- `proxy`：Matrix 流量的可选 HTTP(S) 代理 URL。命名账户可以使用自己的 `proxy` 覆盖顶级默认值。
- `userId`：完整的 Matrix 用户 ID，例如 `@bot:example.org`。
- `accessToken`：基于令牌的认证的访问令牌。`channels.matrix.accessToken` 和 `channels.matrix.accounts.<id>.accessToken` 支持明文值和 SecretRef 值，跨环境/文件/执行提供者。参见 [密钥管理](/gateway/secrets)。
- `password`：基于密码的登录的密码。支持明文值和 SecretRef 值。
- `deviceId`：明确的 Matrix 设备 ID。
- `deviceName`：密码登录的设备显示名称。
- `avatarUrl`：存储的自我头像 URL，用于个人资料同步和 `profile set` 更新。
- `initialSyncLimit`：启动同步期间获取的最大事件数。
- `encryption`：启用 E2EE。
- `allowlistOnly`：当 `true` 时，将 `open` 房间策略升级为 `allowlist`，并强制所有活动的私信策略（除了 `disabled`）（包括 `pairing` 和 `open`）变为 `allowlist`。不影响 `disabled` 策略。
- `allowBots`：允许来自其他配置的 OpenClaw Matrix 账户的消息（`true` 或 `"mentions"`）。
- `groupPolicy`：`open`、`allowlist` 或 `disabled`。
- `contextVisibility`：补充房间上下文可见性模式（`all`、`allowlist`、`allowlist_quote`）。
- `groupAllowFrom`：房间流量的用户 ID 白名单。条目应该是完整的 Matrix 用户 ID；未解析的名称在运行时会被忽略。
- `historyLimit`：作为群组历史上下文包含的最大房间消息数。回退到 `messages.groupChat.historyLimit`；如果两者都未设置，有效默认值为 `0`。设置 `0` 以禁用。
- `replyToMode`：`off`、`first`、`all` 或 `batched`。
- `markdown`：出站 Matrix 文本的可选 Markdown 渲染配置。
- `streaming`：`off`（默认）、`"partial"`、`"quiet"`、`true` 或 `false`。`"partial"` 和 `true` 启用带有正常 Matrix 文本消息的预览优先草稿更新。`"quiet"` 为自托管推送规则设置使用非通知预览通知。`false` 等效于 `"off"`。
- `blockStreaming`：`true` 在草稿预览流式传输活动时为完成的助手块启用单独的进度消息。
- `threadReplies`：`off`、`inbound` 或 `always`。
- `threadBindings`：线程绑定会话路由和生命周期的每频道覆盖。
- `startupVerification`：启动时的自动自我验证请求模式（`if-unverified`、`off`）。
- `startupVerificationCooldownHours`：自动启动验证请求重试前的冷却时间。
- `textChunkLimit`：出站消息块大小（以字符为单位）（当 `chunkMode` 为 `length` 时适用）。
- `chunkMode`：`length` 按字符数分割消息；`newline` 按行边界分割。
- `responsePrefix`：为此频道的所有出站回复前置的可选字符串。
- `ackReaction`：此频道/账户的可选确认反应覆盖。
- `ackReactionScope`：可选的确认反应范围覆盖（`group-mentions`、`group-all`、`direct`、`all`、`none`、`off`）。
- `reactionNotifications`：入站反应通知模式（`own`、`off`）。
- `mediaMaxMb`：出站发送和入站媒体处理的媒体大小上限（以 MB 为单位）。
- `autoJoin`：邀请自动加入策略（`always`、`allowlist`、`off`）。默认值：`off`。适用于所有 Matrix 邀请，包括私信式邀请。
- `autoJoinAllowlist`：当 `autoJoin` 为 `allowlist` 时允许的房间/别名。别名条目在邀请处理期间解析为房间 ID；OpenClaw 不信任邀请房间声明的别名状态。
- `dm`：私信策略块（`enabled`、`policy`、`allowFrom`、`sessionScope`、`threadReplies`）。
- `dm.policy`：控制 OpenClaw 加入房间并将其分类为私信后的私信访问。它不会改变邀请是否被自动加入。
- `dm.allowFrom`：条目应该是完整的 Matrix 用户 ID，除非您已经通过实时目录查找解析了它们。
- `dm.sessionScope`：`per-user`（默认）或 `per-room`。当您希望每个 Matrix 私信房间即使对等方相同也保持单独的上下文时，使用 `per-room`。
- `dm.threadReplies`：仅私信的线程策略覆盖（`off`、`inbound`、`always`）。它覆盖顶级 `threadReplies` 设置，用于私信中的回复放置和会话隔离。
- `execApprovals`：Matrix 原生执行批准传递（`enabled`、`approvers`、`target`、`agentFilter`、`sessionFilter`）。
- `execApprovals.approvers`：允许批准执行请求的 Matrix 用户 ID。当 `dm.allowFrom` 已经识别批准者时是可选的。
- `execApprovals.target`：`dm | channel | both`（默认：`dm`）。
- `accounts`：命名的每账户覆盖。顶级 `channels.matrix` 值作为这些条目的默认值。
- `groups`：每房间策略映射。优先使用房间 ID 或别名；未解析的房间名称在运行时会被忽略。会话/群组身份在解析后使用稳定的房间 ID。
- `groups.<room>.account`：在多账户设置中，将一个继承的房间条目限制为特定的 Matrix 账户。
- `groups.<room>.allowBots`：配置的机器人发送者的房间级覆盖（`true` 或 `"mentions"`）。
- `groups.<room>.users`：每房间发送者白名单。
- `groups.<room>.tools`：每房间工具允许/拒绝覆盖。
- `groups.<room>.autoReply`：房间级提及门控覆盖。`true` 禁用该房间的提及要求；`false` 强制重新启用它们。
- `groups.<room>.skills`：可选的房间级技能过滤器。
- `groups.<room>.systemPrompt`：可选的房间级系统提示片段。
- `rooms`：`groups` 的旧别名。
- `actions`：每操作工具门控（`messages`、`reactions`、`pins`、`profile`、`memberInfo`、`channelInfo`、`verification`）。

## 相关

- [频道概述](/channels) — 所有支持的频道
- [配对](/channels/pairing) — 私信认证和配对流程
- [群组](/channels/groups) — 群组聊天行为和提及门控
- [频道路由](/channels/channel-routing) — 消息的会话路由
- [安全](/gateway/security) — 访问模型和强化
