---
summary: "蓝信机器人支持状态、功能和配置"
read_when:
  - 您想连接蓝信智能机器人
  - 您正在配置蓝信渠道
title: 蓝信
---

# 蓝信机器人

蓝信（Lanxin）是为党政军、央国企等大型组织打造的即时通信平台，覆盖8000余家大型组织。OpenClaw 的蓝信插件通过开放平台回调 + 消息 API，实现私聊/群聊收发以及媒体文件发送。

状态：生产就绪，支持机器人私聊和群组。使用回调模式接收消息。

- 私聊和群聊消息接收
- 文本发送
- 图片/文件/视频上传后发送
- 回调解密（`dataEncrypt`）
- 事件 ID 去重（防平台重试导致重复处理）
- DM/群策略（`dmPolicy`/`groupPolicy`）

---

## 需要插件

安装 Lanxin 插件：

```bash
openclaw plugins install @openclaw/lanxin
```

本地 checkout（在 git 仓库内运行）：

```bash
openclaw plugins install ./extensions/lanxin
```

---

## 快速开始

添加蓝信渠道有两种方式：

### 方式一：通过安装向导添加（推荐）

如果您刚安装完 OpenClaw，可以直接运行向导，根据提示添加蓝信：

```bash
openclaw onboard
```

向导会引导您完成：

1. 创建蓝信应用并获取凭证
2. 配置应用凭证
3. 启动网关

或使用以下命令直接添加渠道：

```bash
openclaw channels add
```

选择 **Lanxin** 后，按提示填写：

1. API 基础地址
2. App ID
3. App Secret
4. AES Key（用于解密平台回调）
5. 可选 `defaultEntryId`（主动发送时兜底）

✅ **完成配置后**，您可以使用以下命令检查网关状态：

- `openclaw gateway status` - 查看网关运行状态
- `openclaw logs --follow` - 查看实时日志

### 方式二：通过配置文件添加

编辑 `~/.openclaw/openclaw.json`：

```json5
{
  channels: {
    lanxin: {
      enabled: true,
      name: "企业助手",
      appId: "xxxxxxx-xxxxxxx",
      appSecret: "xxxxxxxxxxxxxxxx",
      aesKey: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      apiBaseUrl: "https://x.e.lanxin.cn/open/apigw/v1/",
      webhookHost: "0.0.0.0",
      webhookPort: 8789,
      webhookPath: "/lanxin/callback",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: [],
      groupAllowFrom: [],
      // 可选：主动消息缺少 entryId 时使用
      defaultEntryId: "alpha-xxxx",
      // 可选：调试日志
      debug: false,
    },
  },
}
```

### 配置项速查表

| 配置项           | 必填 | 默认值                                 | 说明                                        |
| ---------------- | ---- | -------------------------------------- | ------------------------------------------- |
| `enabled`        | 否   | `false`                                | 是否启用蓝信渠道                            |
| `appId`          | 是   | -                                      | 蓝信应用 ID                                 |
| `appSecret`      | 是   | -                                      | 蓝信应用密钥                                |
| `aesKey`         | 是   | -                                      | 回调 `dataEncrypt` 解密密钥                 |
| `apiBaseUrl`     | 否   | `https://x.e.lanxin.cn/open/apigw/v1/` | 蓝信开放平台 API 基础地址                   |
| `webhookHost`    | 否   | `0.0.0.0`                              | 回调监听地址                                |
| `webhookPort`    | 否   | `8789`                                 | 回调监听端口                                |
| `webhookPath`    | 否   | `/lanxin/callback`                     | 回调路径                                    |
| `dmPolicy`       | 否   | `pairing`                              | 私聊策略：`open/pairing/allowlist/disabled` |
| `groupPolicy`    | 否   | `allowlist`（建议）                    | 群策略：`open/allowlist/disabled`           |
| `allowFrom`      | 否   | `[]`                                   | 私聊允许列表                                |
| `groupAllowFrom` | 否   | `[]`                                   | 群允许列表                                  |
| `defaultEntryId` | 否   | -                                      | 主动发送缺少 `entryId` 时兜底               |
| `debug`          | 否   | `false`                                | 是否输出蓝信调试日志                        |

---

## 第一步：创建蓝信应用

### 1. 打开蓝信开放平台

访问蓝信后台（地址根据您的企业部署环境而定），使用蓝信账号登录。

### 2. 创建应用

1. 进入 **应用中心** 点击 **应用管理**
2. 点击 **新建应用**
3. 填写应用名称和描述等信息
4. 选择应用图标

### 3. 获取应用凭证

在应用详情页面点击 **前往开发者中心**，复制以下信息：

- **App ID**（应用标识）
- **App Secret**（应用密钥）
- **AES Key**（加密密钥，用于解密回调消息）

❗ **重要**：请妥善保管 App Secret 和 AES Key，不要分享给他人或提交到公开仓库。

### 4. 启用机器人能力

1. 在应用的 **自建应用开发** 页面，点击 **智能机器人** 能力
2. 开启机器人服务，配置机器人名称和头像

### 5. 配置应用回调权限

在应用的 **回调事件** 页面，为应用开通以下权限：

- 应用机器人私聊消息回复（发送回复用户消息）
- 应用机器人群消息回复（发送回复群消息）
- 用户信息读取权限（可选，用于获取发送者名称）

### 6. 配置事件订阅（回调地址）

⚠️ **重要提醒**：在配置回调地址前，请确保：

1. 已完成 OpenClaw 渠道配置（运行 `openclaw channels add`）
2. 网关处于启动状态（可通过 `openclaw gateway status` 检查）
3. 回调地址可公网访问

在应用的 **回调事件** 页面：

1. 填写回调地址：`https://<你的域名>/lanxin/callback`
2. 订阅所需事件（如私聊消息、群聊消息等）
3. 保存配置

平台会以 `POST` 调用你的地址，URL 可能携带查询参数：

```text
https://<你的域名>/lanxin/callback?timestamp=...&nonce=...&signature=...
```

### 7. 发布应用

1. 在 **应用发布** 页面发布
2. 提交审核并等待管理员审批

---

## 第二步：配置 OpenClaw

### 通过向导配置（推荐）

运行以下命令，根据提示输入凭证信息：

```bash
openclaw channels add
```

选择 **Lanxin**，然后依次输入：

1. API 基础地址
2. App ID
3. App Secret
4. AES Key（用于解密回调消息）
5. 可选：默认 Entry ID（用于主动发送消息）

### 通过配置文件配置

编辑 `~/.openclaw/openclaw.json`：

```json5
{
  channels: {
    lanxin: {
      enabled: true,
      name: "企业助手",
      appId: "xxxxxxx-xxxxxxx",
      appSecret: "xxxxxxxxxxxxxxxx",
      aesKey: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      apiBaseUrl: "https://x.e.lanxin.cn/open/apigw/v1/",
      webhookHost: "0.0.0.0",
      webhookPort: 8789,
      webhookPath: "/lanxin/callback",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: [],
      groupAllowFrom: [],
      // 可选：主动消息缺少 entryId 时使用
      defaultEntryId: "alpha-xxxx",
      // 可选：调试日志
      debug: false,
    },
  },
}
```

### 通过环境变量配置

```bash
export LANXIN_APP_ID="xxxxxxx-xxxxxxx"
export LANXIN_APP_SECRET="xxxxxxxxxxxxxxxx"
export LANXIN_AES_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

---

## 第三步：启动并测试

### 1. 启动网关

```bash
openclaw gateway run
```

建议同时查看日志：

```bash
openclaw logs --follow
```

### 2. 发送测试消息

在蓝信中找到您创建的机器人，发送一条消息。

### 3. 配对授权

默认情况下（`dmPolicy: "pairing"`），机器人会回复一个 **配对码**。您需要批准此代码：

```bash
openclaw pairing approve lanxin <配对码>
```

批准后即可正常对话。

### 4. 验证清单

- ✅ 蓝信私聊机器人发送文本，确认 OpenClaw 回复
- ✅ 蓝信发送图片，确认机器人能处理媒体消息
- ✅ 蓝信群聊中发送消息，确认策略生效（允许或被拦截）

✅ **完成配置后**，您可以使用以下命令管理网关：

- `openclaw gateway status` - 查看网关运行状态
- `openclaw gateway restart` - 重启网关以应用新配置
- `openclaw logs --follow` - 实时查看日志输出

---

## 回调与重试机制

蓝信事件回调在超时或失败时会重试，典型间隔：

- 首次失败后约 5 分钟
- 再失败后约 1 小时
- 再失败后约 6 小时

平台要求应用回调尽量在 3 秒内返回结果。

### OpenClaw 的处理方式

Lanxin 插件会：

1. 尽快返回 `200`（避免平台判定失败）
2. 基于 `events[].id` 做持久化去重
3. 仅对“首次出现”的事件进入业务处理

这可以避免平台重试导致重复回复。

---

## 回调负载格式（简述）

回调请求体（解密前）：

```json
{
  "dataEncrypt": "XXXXXXXX"
}
```

解密后重点字段（示意）：

```json
{
  "events": [
    {
      "id": "event-id",
      "type": "bot_person_message",
      "data": {
        "entryId": "alpha-xxx",
        "msgId": "msg-xxx",
        "msgType": "text",
        "msgData": { "text": { "content": "hello" } }
      }
    }
  ]
}
```

---

## 消息目标格式

蓝信发送支持以下 `target` 格式：

- 私聊标准：`user:<userId>:<entryId>`
- 私聊简写：`<userId>:<entryId>`
- 群聊：`group:<groupId>:<entryId>`

说明：

- `entryId` 是发送消息的关键参数
- 若主动发送时缺少 `entryId`，可用 `channels.lanxin.defaultEntryId` 兜底

---

## 媒体处理

### 发送媒体

发送媒体时插件流程：

1. 读取 `mediaUrl`（本地路径或远程 URL）
2. 上传至 `medias/create` 获取 `mediaId`
3. 调用发送接口，携带 `mediaType/mediaIds`

当前兼容策略：媒体发送走 `msgType=text`，并在 `msgData.text` 中带 `mediaType/mediaIds`（与常见蓝信 Python 客户端行为一致）。

### 接收媒体

接收包含 `mediaIds` 的回调时插件会：

1. 调 `medias/{mediaId}/fetch` 下载文件
2. 保存到入站媒体路径
3. 注入 `MediaPath/MediaPaths` 到上下文
4. 给 agent 增加结构化附件提示（类型、数量、contentType）

---

## 访问控制

### 私聊访问

- **默认**：`dmPolicy: "pairing"`，陌生用户会收到配对码
- **批准配对**：

```bash
openclaw pairing list lanxin      # 查看待审批列表
openclaw pairing approve lanxin <CODE>  # 批准
```

- **白名单模式**：通过 `channels.lanxin.allowFrom` 配置允许的用户 ID

### 群组访问

**群组策略**（`channels.lanxin.groupPolicy`）：

- `"open"` = 允许所有群组
- `"allowlist"` = 仅允许 `groupAllowFrom` 中的群组（推荐）
- `"disabled"` = 禁用群组消息

---

## 策略配置

### DM 策略（`dmPolicy`）

| 值            | 行为                                               |
| ------------- | -------------------------------------------------- |
| `"pairing"`   | **默认**。未知用户收到配对码，管理员批准后才能对话 |
| `"allowlist"` | 仅 `allowFrom` 列表中的用户可对话，其他静默忽略    |
| `"open"`      | 允许所有人对话（需在 allowFrom 中加 `"*"`）        |
| `"disabled"`  | 完全禁止私聊                                       |

### 群策略（`groupPolicy`）

| 值            | 行为                                   |
| ------------- | -------------------------------------- |
| `"open"`      | 允许所有群组                           |
| `"allowlist"` | 仅 `groupAllowFrom` 列表中的群组可触发 |
| `"disabled"`  | 禁用群组消息                           |

建议生产环境使用：

- `dmPolicy: "pairing"`
- `groupPolicy: "allowlist"`

### 群组配置示例

#### 仅允许特定群组

```json5
{
  channels: {
    lanxin: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["group-id-1", "group-id-2"],
    },
  },
}
```

---

## 常用命令

| 命令      | 说明           |
| --------- | -------------- |
| `/status` | 查看机器人状态 |
| `/reset`  | 重置对话会话   |
| `/model`  | 查看/切换模型  |

## 网关管理命令

| 命令                       | 说明              |
| -------------------------- | ----------------- |
| `openclaw gateway status`  | 查看网关运行状态  |
| `openclaw gateway install` | 安装/启动网关服务 |
| `openclaw gateway stop`    | 停止网关服务      |
| `openclaw gateway restart` | 重启网关服务      |
| `openclaw logs --follow`   | 实时查看日志输出  |

---

## 调试与日志

启用调试日志（任选其一）：

- 环境变量：`OPENCLAW_LANXIN_DEBUG=1`
- 配置项：`channels.lanxin.debug=true`

常见关键日志：

- `upload media start/success`
- `HTTP POST start/response/parsed body`
- `webhook decrypted events`
- `skip duplicated event`

### 日志排错对照

| 日志关键词                      | 含义               | 建议检查                                               |
| ------------------------------- | ------------------ | ------------------------------------------------------ |
| `HTTP POST ... status: 401/403` | 鉴权失败           | `appId/appSecret`、token 是否过期                      |
| `errCode != 0`                  | 平台业务错误       | 查看 `errMsg` 与请求字段（尤其 `entryId`）             |
| `Invalid Lanxin target`         | 发送目标格式不正确 | 使用 `user:<userId>:<entryId>` 或 `<userId>:<entryId>` |
| `Missing dataEncrypt`           | 回调体不符合预期   | 平台回调地址/请求体格式                                |
| `failed downloading media`      | 入站媒体下载失败   | `mediaId` 是否有效、token 权限                         |
| `skip duplicated event`         | 命中去重           | 属于正常现象（平台重试回调）                           |

---

## 故障排除

### 回调 404 / 平台验证失败

1. 检查 `webhookPath` 与平台配置是否一致
2. 检查反向代理是否改写了路径
3. 检查回调地址是否为可公网访问 HTTPS
4. 检查网关是否正在运行：`openclaw gateway status`
5. 查看实时日志：`openclaw logs --follow`

### 机器人收不到消息

1. 检查应用是否已发布并审批通过
2. 检查事件订阅/回调配置是否正确
3. 检查应用权限是否完整
4. 检查网关是否正在运行
5. 查看日志是否有回调请求到达

### 收到消息但不回复

1. 检查 `dmPolicy/groupPolicy` 是否拦截
2. 检查 `allowFrom/groupAllowFrom` 是否包含发送者
3. 是否命中了去重（日志中 `skip duplicated event`）
4. 查看日志是否有解析失败或发送异常

### 媒体上传成功但消息没显示

请开启 debug（`channels.lanxin.debug=true`），重点检查：

1. 上传返回的 `mediaId` 是否有效
2. `bot/messages/create` 返回的 `errCode/errMsg`
3. `target` 是否包含有效 `entryId`

### Invalid Lanxin target

支持的 target 格式：

- `user:<userId>:<entryId>`（私聊标准格式）
- `<userId>:<entryId>`（私聊简写格式）
- `group:<groupId>:<entryId>`（群聊格式）

如果是主动发送且拿不到 `entryId`，请配置 `defaultEntryId`。

### App Secret 泄露怎么办

1. 在蓝信开放平台重置 App Secret
2. 更新配置文件中的 App Secret
3. 重启网关：`openclaw gateway restart`

---

## 安全建议

- 不要将真实 `appSecret/aesKey` 写入公开仓库
- 建议在生产使用 secret 管理方案
- 建议仅对白名单用户/群开放触发

---

## 版本与兼容说明

- 当前媒体发送采用蓝信常见兼容路径：`msgType=text` + `msgData.text.mediaType/mediaIds`。
- 回调路径匹配按 `pathname` 处理，支持带查询参数（如 `timestamp/nonce/signature`）。
- 若蓝信租户 API 域名不同，请显式设置 `apiBaseUrl`。

---

## 相关文档

- [渠道总览](/channels)
- [分组消息策略](/channels/groups)
- [网关配置](/gateway/configuration)
