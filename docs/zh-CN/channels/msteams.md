---
read_when:
  - 开发 Microsoft Teams 渠道功能
summary: Microsoft Teams 机器人支持状态、功能和配置
title: Microsoft Teams
x-i18n:
  generated_at: "2026-02-01T19:26:12Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 3d5641c578086f7569f42276d4ef2462200b9927ca3f505e6ee26806103eaa60
  source_path: channels/msteams.md
  workflow: 14
---

# Microsoft Teams（插件）

> "进入此处者，放弃一切希望。"

更新时间：2026-01-21

状态：支持文本 + 私信附件；频道/群组文件发送需要 `sharePointSiteId` + Graph 权限（参见[在群聊中发送文件](#在群聊中发送文件)）。投票通过 Adaptive Cards 发送。

## 需要插件

Microsoft Teams 作为插件发布，不包含在核心安装中。

**破坏性变更（2026.1.15）：** Microsoft Teams 已从核心中移出。如果你使用它，必须安装插件。

原因说明：保持核心安装更轻量，并让 Microsoft Teams 依赖项可以独立更新。

通过 CLI 安装（npm 注册表）：

```bash
openclaw plugins install @openclaw/msteams
```

本地检出（从 git 仓库运行时）：

```bash
openclaw plugins install ./extensions/msteams
```

如果你在配置/新手引导期间选择了 Teams 并检测到 git 检出，OpenClaw 会自动提供本地安装路径。

详情：[插件](/plugin)

## 快速设置（新手）

1. 安装 Microsoft Teams 插件。
2. 创建一个 **Azure Bot**（App ID + 客户端密钥 + 租户 ID）。
3. 使用这些凭据配置 OpenClaw。
4. 通过公共 URL 或隧道暴露 `/api/messages`（默认端口 3978）。
5. 安装 Teams 应用包并启动 Gateway网关。

最小配置：

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

注意：群聊默认被阻止（`channels.msteams.groupPolicy: "allowlist"`）。要允许群组回复，请设置 `channels.msteams.groupAllowFrom`（或使用 `groupPolicy: "open"` 允许任何成员，提及门控）。

## 目标

- 通过 Teams 私信、群聊或频道与 OpenClaw 对话。
- 保持路由确定性：回复始终发回消息到达的渠道。
- 默认使用安全的渠道行为（除非另行配置，否则需要提及）。

## 配置写入

默认情况下，Microsoft Teams 允许通过 `/config set|unset` 触发的配置更新写入（需要 `commands.config: true`）。

通过以下方式禁用：

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## 访问控制（私信 + 群组）

**私信访问**

- 默认：`channels.msteams.dmPolicy = "pairing"`。未知发送者在批准前会被忽略。
- `channels.msteams.allowFrom` 接受 AAD 对象 ID、UPN 或显示名称。当凭据允许时，向导通过 Microsoft Graph 将名称解析为 ID。

**群组访问**

- 默认：`channels.msteams.groupPolicy = "allowlist"`（被阻止，除非你添加 `groupAllowFrom`）。使用 `channels.defaults.groupPolicy` 可在未设置时覆盖默认值。
- `channels.msteams.groupAllowFrom` 控制哪些发送者可以在群聊/频道中触发（回退到 `channels.msteams.allowFrom`）。
- 设置 `groupPolicy: "open"` 可允许任何成员（默认仍需提及门控）。
- 要**不允许任何频道**，设置 `channels.msteams.groupPolicy: "disabled"`。

示例：

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**团队 + 频道允许列表**

- 通过在 `channels.msteams.teams` 下列出团队和频道来限定群组/频道回复范围。
- 键可以是团队 ID 或名称；频道键可以是会话 ID 或名称。
- 当 `groupPolicy="allowlist"` 且存在团队允许列表时，仅接受列出的团队/频道（提及门控）。
- 配置向导接受 `Team/Channel` 条目并为你存储。
- 启动时，OpenClaw 将团队/频道和用户允许列表名称解析为 ID（当 Graph 权限允许时）并记录映射；未解析的条目保持原样。

示例：

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## 工作原理

1. 安装 Microsoft Teams 插件。
2. 创建一个 **Azure Bot**（App ID + 密钥 + 租户 ID）。
3. 构建一个引用该机器人并包含下方 RSC 权限的 **Teams 应用包**。
4. 将 Teams 应用上传/安装到团队（或私人范围用于私信）。
5. 在 `~/.openclaw/openclaw.json`（或环境变量）中配置 `msteams` 并启动 Gateway网关。
6. Gateway网关默认在 `/api/messages` 上监听 Bot Framework webhook 流量。

## Azure Bot 设置（前提条件）

在配置 OpenClaw 之前，你需要创建一个 Azure Bot 资源。

### 步骤 1：创建 Azure Bot

1. 前往[创建 Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. 填写 **Basics** 标签页：

   | 字段               | 值                                                  |
   | ------------------ | --------------------------------------------------- |
   | **Bot handle**     | 你的机器人名称，例如 `openclaw-msteams`（必须唯一） |
   | **Subscription**   | 选择你的 Azure 订阅                                 |
   | **Resource group** | 新建或使用现有的                                    |
   | **Pricing tier**   | **Free** 用于开发/测试                              |
   | **Type of App**    | **Single Tenant**（推荐 - 见下方说明）              |
   | **Creation type**  | **Create new Microsoft App ID**                     |

> **弃用通知：** 2025-07-31 之后已弃用创建新的多租户机器人。新机器人请使用 **Single Tenant**。

3. 点击 **Review + create** → **Create**（等待约 1-2 分钟）

### 步骤 2：获取凭据

1. 前往你的 Azure Bot 资源 → **Configuration**
2. 复制 **Microsoft App ID** → 这是你的 `appId`
3. 点击 **Manage Password** → 进入应用注册
4. 在 **Certificates & secrets** → **New client secret** → 复制 **Value** → 这是你的 `appPassword`
5. 进入 **Overview** → 复制 **Directory (tenant) ID** → 这是你的 `tenantId`

### 步骤 3：配置消息端点

1. 在 Azure Bot → **Configuration**
2. 将 **Messaging endpoint** 设置为你的 webhook URL：
   - 生产环境：`https://your-domain.com/api/messages`
   - 本地开发：使用隧道（参见下方[本地开发](#本地开发隧道)）

### 步骤 4：启用 Teams 频道

1. 在 Azure Bot → **Channels**
2. 点击 **Microsoft Teams** → Configure → Save
3. 接受服务条款

## 本地开发（隧道）

Teams 无法访问 `localhost`。本地开发请使用隧道：

**方案 A：ngrok**

```bash
ngrok http 3978
# 复制 https URL，例如 https://abc123.ngrok.io
# 将消息端点设置为：https://abc123.ngrok.io/api/messages
```

**方案 B：Tailscale Funnel**

```bash
tailscale funnel 3978
# 使用你的 Tailscale funnel URL 作为消息端点
```

## Teams 开发者门户（替代方案）

除了手动创建清单 ZIP 外，你可以使用 [Teams 开发者门户](https://dev.teams.microsoft.com/apps)：

1. 点击 **+ New app**
2. 填写基本信息（名称、描述、开发者信息）
3. 进入 **App features** → **Bot**
4. 选择 **Enter a bot ID manually** 并粘贴你的 Azure Bot App ID
5. 勾选范围：**Personal**、**Team**、**Group Chat**
6. 点击 **Distribute** → **Download app package**
7. 在 Teams 中：**Apps** → **Manage your apps** → **Upload a custom app** → 选择 ZIP

这通常比手动编辑 JSON 清单更简单。

## 测试机器人

**方案 A：Azure Web Chat（先验证 webhook）**

1. 在 Azure 门户 → 你的 Azure Bot 资源 → **Test in Web Chat**
2. 发送一条消息 - 你应该看到回复
3. 这确认了你的 webhook 端点在 Teams 设置之前可以正常工作

**方案 B：Teams（安装应用后）**

1. 安装 Teams 应用（旁加载或组织目录）
2. 在 Teams 中找到机器人并发送私信
3. 检查 Gateway网关日志中的传入活动

## 设置（最小纯文本）

1. **安装 Microsoft Teams 插件**
   - 从 npm：`openclaw plugins install @openclaw/msteams`
   - 从本地检出：`openclaw plugins install ./extensions/msteams`

2. **机器人注册**
   - 创建 Azure Bot（见上方）并记录：
     - App ID
     - 客户端密钥（App password）
     - 租户 ID（单租户）

3. **Teams 应用清单**
   - 包含一个 `bot` 条目，其中 `botId = <App ID>`。
   - 范围：`personal`、`team`、`groupChat`。
   - `supportsFiles: true`（个人范围文件处理所必需）。
   - 添加 RSC 权限（见下方）。
   - 创建图标：`outline.png`（32x32）和 `color.png`（192x192）。
   - 将三个文件打包在一起：`manifest.json`、`outline.png`、`color.png`。

4. **配置 OpenClaw**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   你也可以使用环境变量替代配置键：
   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **机器人端点**
   - 将 Azure Bot 消息端点设置为：
     - `https://<host>:3978/api/messages`（或你选择的路径/端口）。

6. **运行 Gateway网关**
   - 当插件已安装且 `msteams` 配置存在凭据时，Teams 渠道会自动启动。

## 历史上下文

- `channels.msteams.historyLimit` 控制多少条最近的频道/群组消息被包含在提示中。
- 回退到 `messages.groupChat.historyLimit`。设置 `0` 可禁用（默认 50）。
- 私信历史可通过 `channels.msteams.dmHistoryLimit`（用户回合数）限制。按用户覆盖：`channels.msteams.dms["<user_id>"].historyLimit`。

## 当前 Teams RSC 权限（清单）

以下是我们 Teams 应用清单中**现有的 resourceSpecific 权限**。它们仅在安装了应用的团队/聊天中适用。

**频道（团队范围）：**

- `ChannelMessage.Read.Group`（Application）- 无需 @提及即可接收所有频道消息
- `ChannelMessage.Send.Group`（Application）
- `Member.Read.Group`（Application）
- `Owner.Read.Group`（Application）
- `ChannelSettings.Read.Group`（Application）
- `TeamMember.Read.Group`（Application）
- `TeamSettings.Read.Group`（Application）

**群聊：**

- `ChatMessage.Read.Chat`（Application）- 无需 @提及即可接收所有群聊消息

## 示例 Teams 清单（已脱敏）

包含必需字段的最小有效示例。请替换 ID 和 URL。

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### 清单注意事项（必需字段）

- `bots[].botId` **必须**与 Azure Bot App ID 匹配。
- `webApplicationInfo.id` **必须**与 Azure Bot App ID 匹配。
- `bots[].scopes` 必须包含你计划使用的范围（`personal`、`team`、`groupChat`）。
- `bots[].supportsFiles: true` 是个人范围文件处理所必需的。
- `authorization.permissions.resourceSpecific` 必须包含频道读取/发送权限（如果你需要频道流量）。

### 更新现有应用

要更新已安装的 Teams 应用（例如添加 RSC 权限）：

1. 使用新设置更新 `manifest.json`
2. **递增 `version` 字段**（例如 `1.0.0` → `1.1.0`）
3. **重新打包**清单和图标（`manifest.json`、`outline.png`、`color.png`）
4. 上传新的 zip：
   - **方案 A（Teams 管理中心）：** Teams 管理中心 → Teams apps → Manage apps → 找到你的应用 → Upload new version
   - **方案 B（旁加载）：** 在 Teams 中 → Apps → Manage your apps → Upload a custom app
5. **对于团队频道：** 在每个团队中重新安装应用以使新权限生效
6. **完全退出并重新启动 Teams**（不只是关闭窗口）以清除缓存的应用元数据

## 功能：仅 RSC vs Graph

### 仅使用 **Teams RSC**（已安装应用，无 Graph API 权限）

可用：

- 读取频道消息**文本**内容。
- 发送频道消息**文本**内容。
- 接收**个人（私信）**文件附件。

不可用：

- 频道/群组**图片或文件内容**（负载仅包含 HTML 占位符）。
- 下载存储在 SharePoint/OneDrive 中的附件。
- 读取消息历史（超出实时 webhook 事件范围）。

### 使用 **Teams RSC + Microsoft Graph Application 权限**

新增：

- 下载托管内容（粘贴到消息中的图片）。
- 下载存储在 SharePoint/OneDrive 中的文件附件。
- 通过 Graph 读取频道/聊天消息历史。

### RSC vs Graph API

| 功能           | RSC 权限           | Graph API                   |
| -------------- | ------------------ | --------------------------- |
| **实时消息**   | 是（通过 webhook） | 否（仅轮询）                |
| **历史消息**   | 否                 | 是（可查询历史）            |
| **设置复杂度** | 仅需应用清单       | 需要管理员同意 + token 流程 |
| **离线可用**   | 否（必须运行中）   | 是（可随时查询）            |

**总结：** RSC 用于实时监听；Graph API 用于历史访问。要补上离线期间错过的消息，你需要具有 `ChannelMessage.Read.All` 的 Graph API（需要管理员同意）。

## 启用 Graph 的媒体 + 历史（频道所必需）

如果你需要**频道**中的图片/文件或想获取**消息历史**，必须启用 Microsoft Graph 权限并授予管理员同意。

1. 在 Entra ID（Azure AD）**应用注册**中，添加 Microsoft Graph **Application 权限**：
   - `ChannelMessage.Read.All`（频道附件 + 历史）
   - `Chat.Read.All` 或 `ChatMessage.Read.All`（群聊）
2. 为租户**授予管理员同意**。
3. 递增 Teams 应用**清单版本**，重新上传，并在 **Teams 中重新安装应用**。
4. **完全退出并重新启动 Teams** 以清除缓存的应用元数据。

## 已知限制

### Webhook 超时

Teams 通过 HTTP webhook 投递消息。如果处理时间过长（例如 LLM 响应缓慢），你可能会看到：

- Gateway网关超时
- Teams 重试消息（导致重复）
- 回复丢失

OpenClaw 通过快速返回并主动发送回复来处理此问题，但非常慢的响应仍可能导致问题。

### 格式

Teams markdown 比 Slack 或 Discord 更有限：

- 基本格式有效：**粗体**、_斜体_、`代码`、链接
- 复杂 markdown（表格、嵌套列表）可能无法正确渲染
- 支持 Adaptive Cards 用于投票和任意卡片发送（见下方）

## 配置

关键设置（共享渠道模式请参见 `/gateway/configuration`）：

- `channels.msteams.enabled`：启用/禁用渠道。
- `channels.msteams.appId`、`channels.msteams.appPassword`、`channels.msteams.tenantId`：机器人凭据。
- `channels.msteams.webhook.port`（默认 `3978`）
- `channels.msteams.webhook.path`（默认 `/api/messages`）
- `channels.msteams.dmPolicy`：`pairing | allowlist | open | disabled`（默认：pairing）
- `channels.msteams.allowFrom`：私信允许列表（AAD 对象 ID、UPN 或显示名称）。当 Graph 访问可用时，向导在设置期间将名称解析为 ID。
- `channels.msteams.textChunkLimit`：出站文本分块大小。
- `channels.msteams.chunkMode`：`length`（默认）或 `newline`，在按长度分块之前按空行（段落边界）分割。
- `channels.msteams.mediaAllowHosts`：入站附件主机允许列表（默认为 Microsoft/Teams 域名）。
- `channels.msteams.requireMention`：在频道/群组中需要 @提及（默认 true）。
- `channels.msteams.replyStyle`：`thread | top-level`（参见[回复样式：线程 vs 帖子](#回复样式线程-vs-帖子)）。
- `channels.msteams.teams.<teamId>.replyStyle`：按团队覆盖。
- `channels.msteams.teams.<teamId>.requireMention`：按团队覆盖。
- `channels.msteams.teams.<teamId>.tools`：按团队默认工具策略覆盖（`allow`/`deny`/`alsoAllow`），在频道覆盖缺失时使用。
- `channels.msteams.teams.<teamId>.toolsBySender`：按团队按发送者工具策略覆盖（支持 `"*"` 通配符）。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`：按频道覆盖。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`：按频道覆盖。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`：按频道工具策略覆盖（`allow`/`deny`/`alsoAllow`）。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`：按频道按发送者工具策略覆盖（支持 `"*"` 通配符）。
- `channels.msteams.sharePointSiteId`：用于群聊/频道文件上传的 SharePoint 站点 ID（参见[在群聊中发送文件](#在群聊中发送文件)）。

## 路由与会话

- 会话键遵循标准智能体格式（参见 [/concepts/session](/concepts/session)）：
  - 私信共享主会话（`agent:<agentId>:<mainKey>`）。
  - 频道/群组消息使用会话 ID：
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## 回复样式：线程 vs 帖子

Teams 最近在相同的底层数据模型上引入了两种频道 UI 样式：

| 样式                    | 描述                           | 推荐的 `replyStyle` |
| ----------------------- | ------------------------------ | ------------------- |
| **Posts**（经典）       | 消息显示为卡片，下方有线程回复 | `thread`（默认）    |
| **Threads**（类 Slack） | 消息线性排列，更像 Slack       | `top-level`         |

**问题：** Teams API 不暴露频道使用哪种 UI 样式。如果你使用了错误的 `replyStyle`：

- 在 Threads 样式的频道中使用 `thread` → 回复嵌套显示不自然
- 在 Posts 样式的频道中使用 `top-level` → 回复显示为独立的顶级帖子而非在线程中

**解决方案：** 根据频道的设置方式按频道配置 `replyStyle`：

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## 附件与图片

**当前限制：**

- **私信：** 图片和文件附件通过 Teams bot 文件 API 可用。
- **频道/群组：** 附件存储在 M365 存储（SharePoint/OneDrive）中。Webhook 负载仅包含 HTML 占位符，而非实际文件字节。**需要 Graph API 权限**才能下载频道附件。

没有 Graph 权限时，包含图片的频道消息将仅作为纯文本接收（机器人无法访问图片内容）。默认情况下，OpenClaw 仅从 Microsoft/Teams 主机名下载媒体。通过 `channels.msteams.mediaAllowHosts` 覆盖（使用 `["*"]` 允许任何主机）。

## 在群聊中发送文件

机器人可以使用 FileConsentCard 流程在私信中发送文件（内置）。然而，**在群聊/频道中发送文件**需要额外设置：

| 场景                 | 文件发送方式                            | 所需设置                             |
| -------------------- | --------------------------------------- | ------------------------------------ |
| **私信**             | FileConsentCard → 用户接受 → 机器人上传 | 开箱即用                             |
| **群聊/频道**        | 上传到 SharePoint → 分享链接            | 需要 `sharePointSiteId` + Graph 权限 |
| **图片（任何场景）** | Base64 编码内联                         | 开箱即用                             |

### 为什么群聊需要 SharePoint

机器人没有个人 OneDrive 驱动器（`/me/drive` Graph API 端点对应用程序标识不可用）。要在群聊/频道中发送文件，机器人上传到 **SharePoint 站点**并创建共享链接。

### 设置

1. 在 Entra ID（Azure AD）→ 应用注册中**添加 Graph API 权限**：
   - `Sites.ReadWrite.All`（Application）- 上传文件到 SharePoint
   - `Chat.Read.All`（Application）- 可选，启用按用户共享链接

2. 为租户**授予管理员同意**。

3. **获取你的 SharePoint 站点 ID：**

   ```bash
   # 通过 Graph Explorer 或使用有效 token 的 curl：
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # 示例：对于 "contoso.sharepoint.com/sites/BotFiles" 的站点
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # 响应包含："id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **配置 OpenClaw：**
   ```json5
   {
     channels: {
       msteams: {
         // ... 其他配置 ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### 共享行为

| 权限                                    | 共享行为                                   |
| --------------------------------------- | ------------------------------------------ |
| 仅 `Sites.ReadWrite.All`                | 组织范围共享链接（组织中的任何人都可访问） |
| `Sites.ReadWrite.All` + `Chat.Read.All` | 按用户共享链接（仅聊天成员可访问）         |

按用户共享更安全，因为只有聊天参与者可以访问文件。如果缺少 `Chat.Read.All` 权限，机器人回退到组织范围共享。

### 回退行为

| 场景                                    | 结果                                       |
| --------------------------------------- | ------------------------------------------ |
| 群聊 + 文件 + 已配置 `sharePointSiteId` | 上传到 SharePoint，发送共享链接            |
| 群聊 + 文件 + 未配置 `sharePointSiteId` | 尝试 OneDrive 上传（可能失败），仅发送文本 |
| 个人聊天 + 文件                         | FileConsentCard 流程（无需 SharePoint）    |
| 任何场景 + 图片                         | Base64 编码内联（无需 SharePoint）         |

### 文件存储位置

上传的文件存储在已配置 SharePoint 站点默认文档库中的 `/OpenClawShared/` 文件夹。

## 投票（Adaptive Cards）

OpenClaw 通过 Adaptive Cards 发送 Teams 投票（没有原生 Teams 投票 API）。

- CLI：`openclaw message poll --channel msteams --target conversation:<id> ...`
- 投票由 Gateway网关记录在 `~/.openclaw/msteams-polls.json` 中。
- Gateway网关必须保持在线以记录投票。
- 投票尚不会自动发布结果摘要（如需要请查看存储文件）。

## Adaptive Cards（任意）

使用 `message` 工具或 CLI 向 Teams 用户或会话发送任意 Adaptive Card JSON。

`card` 参数接受 Adaptive Card JSON 对象。提供 `card` 时，消息文本是可选的。

**智能体工具：**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI：**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

卡片 schema 和示例请参见 [Adaptive Cards 文档](https://adaptivecards.io/)。目标格式详情请参见下方[目标格式](#目标格式)。

## 目标格式

Microsoft Teams 目标使用前缀区分用户和会话：

| 目标类型          | 格式                             | 示例                                              |
| ----------------- | -------------------------------- | ------------------------------------------------- |
| 用户（按 ID）     | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`       |
| 用户（按名称）    | `user:<display-name>`            | `user:John Smith`（需要 Graph API）               |
| 群组/频道         | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`          |
| 群组/频道（原始） | `<conversation-id>`              | `19:abc123...@thread.tacv2`（如果包含 `@thread`） |

**CLI 示例：**

```bash
# 按 ID 发送给用户
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# 按显示名称发送给用户（触发 Graph API 查找）
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# 发送到群聊或频道
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# 向会话发送 Adaptive Card
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**智能体工具示例：**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

注意：不带 `user:` 前缀时，名称默认解析为群组/团队。通过显示名称定位人员时请始终使用 `user:`。

## 主动消息

- 主动消息仅在用户**已交互后**才可能，因为我们在那个时候存储会话引用。
- `dmPolicy` 和允许列表门控请参见 `/gateway/configuration`。

## 团队和频道 ID（常见陷阱）

Teams URL 中的 `groupId` 查询参数**不是**用于配置的团队 ID。请从 URL 路径中提取 ID：

**团队 URL：**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    团队 ID（URL 解码此部分）
```

**频道 URL：**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      频道 ID（URL 解码此部分）
```

**用于配置：**

- 团队 ID = `/team/` 后的路径段（URL 解码后，例如 `19:Bk4j...@thread.tacv2`）
- 频道 ID = `/channel/` 后的路径段（URL 解码后）
- **忽略** `groupId` 查询参数

## 私有频道

机器人在私有频道中的支持有限：

| 功能                | 标准频道 | 私有频道         |
| ------------------- | -------- | ---------------- |
| 机器人安装          | 是       | 有限             |
| 实时消息（webhook） | 是       | 可能不可用       |
| RSC 权限            | 是       | 行为可能不同     |
| @提及               | 是       | 如果机器人可访问 |
| Graph API 历史      | 是       | 是（需要权限）   |

**私有频道不可用时的变通方案：**

1. 使用标准频道进行机器人交互
2. 使用私信 - 用户始终可以直接给机器人发消息
3. 使用 Graph API 进行历史访问（需要 `ChannelMessage.Read.All`）

## 故障排除

### 常见问题

- **频道中图片不显示：** Graph 权限或管理员同意缺失。重新安装 Teams 应用并完全退出/重新打开 Teams。
- **频道中没有响应：** 默认需要提及；设置 `channels.msteams.requireMention=false` 或按团队/频道配置。
- **版本不匹配（Teams 仍显示旧清单）：** 移除并重新添加应用，完全退出 Teams 以刷新。
- **Webhook 返回 401 Unauthorized：** 在没有 Azure JWT 的情况下手动测试时这是预期的 - 表示端点可达但认证失败。使用 Azure Web Chat 进行正确测试。

### 清单上传错误

- **"Icon file cannot be empty"：** 清单引用了 0 字节的图标文件。创建有效的 PNG 图标（`outline.png` 32x32，`color.png` 192x192）。
- **"webApplicationInfo.Id already in use"：** 应用仍安装在其他团队/聊天中。先找到并卸载它，或等待 5-10 分钟传播。
- **上传时显示"Something went wrong"：** 改为通过 https://admin.teams.microsoft.com 上传，打开浏览器 DevTools（F12）→ Network 标签页，检查响应体中的实际错误。
- **旁加载失败：** 尝试"Upload an app to your org's app catalog"而非"Upload a custom app" - 这通常可以绕过旁加载限制。

### RSC 权限不生效

1. 验证 `webApplicationInfo.id` 与你的机器人 App ID 完全匹配
2. 重新上传应用并在团队/聊天中重新安装
3. 检查你的组织管理员是否阻止了 RSC 权限
4. 确认你使用了正确的范围：`ChannelMessage.Read.Group` 用于团队，`ChatMessage.Read.Chat` 用于群聊

## 参考

- [创建 Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot 设置指南
- [Teams 开发者门户](https://dev.teams.microsoft.com/apps) - 创建/管理 Teams 应用
- [Teams 应用清单 schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [使用 RSC 接收频道消息](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC 权限参考](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot 文件处理](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4)（频道/群组需要 Graph）
- [主动消息](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
