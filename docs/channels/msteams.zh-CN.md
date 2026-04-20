---
summary: "Microsoft Teams 机器人支持状态、功能和配置"
read_when:
  - 处理 Microsoft Teams 频道功能
title: "Microsoft Teams"
---

# Microsoft Teams

> "进入这里的人，放弃所有希望。"

更新时间：2026-03-25

状态：支持文本 + 私信附件；频道/群组文件发送需要 `sharePointSiteId` + Graph 权限（见 [在群组聊天中发送文件](#在群组聊天中发送文件)）。投票通过自适应卡片发送。消息操作公开显式的 `upload-file` 用于文件优先发送。

## 捆绑插件

Microsoft Teams 在当前的 OpenClaw 版本中作为捆绑插件提供，因此在正常的打包构建中不需要单独安装。

如果您使用的是较旧的构建或不包含捆绑 Teams 的自定义安装，请手动安装：

```bash
openclaw plugins install @openclaw/msteams
```

本地检出（从 git 仓库运行时）：

```bash
openclaw plugins install ./path/to/local/msteams-plugin
```

详细信息：[插件](/tools/plugin)

## 快速设置（初学者）

1. 确保 Microsoft Teams 插件可用。
   - 当前打包的 OpenClaw 版本已经内置了它。
   - 较旧/自定义安装可以使用上述命令手动添加。
2. 创建一个**Azure Bot**（应用 ID + 客户端密钥 + 租户 ID）。
3. 使用这些凭据配置 OpenClaw。
4. 通过公共 URL 或隧道公开 `/api/messages`（默认端口 3978）。
5. 安装 Teams 应用包并启动网关。

最小配置（客户端密钥）：

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

对于生产部署，考虑使用 [联合身份验证](#联合身份验证证书--托管标识)（证书或托管标识）而不是客户端密钥。

注意：默认情况下，群组聊天被阻止（`channels.msteams.groupPolicy: "allowlist"`）。要允许群组回复，请设置 `channels.msteams.groupAllowFrom`（或使用 `groupPolicy: "open"` 允许任何成员，提及门控）。

## 目标

- 通过 Teams 私信、群组聊天或频道与 OpenClaw 交谈。
- 保持路由确定性：回复始终返回到它们到达的频道。
- 默认安全频道行为（除非另有配置，否则需要提及）。

## 配置写入

默认情况下，Microsoft Teams 允许写入由 `/config set|unset` 触发的配置更新（需要 `commands.config: true`）。

禁用：

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## 访问控制（私信 + 群组）

**私信访问**

- 默认：`channels.msteams.dmPolicy = "pairing"`。未知发送者在批准前被忽略。
- `channels.msteams.allowFrom` 应使用稳定的 AAD 对象 ID。
- UPN/显示名称是可变的；默认情况下禁用直接匹配，仅在 `channels.msteams.dangerouslyAllowNameMatching: true` 时启用。
- 向导可以在凭据允许时通过 Microsoft Graph 将名称解析为 ID。

**群组访问**

- 默认：`channels.msteams.groupPolicy = "allowlist"`（除非添加 `groupAllowFrom`，否则被阻止）。使用 `channels.defaults.groupPolicy` 在未设置时覆盖默认值。
- `channels.msteams.groupAllowFrom` 控制哪些发送者可以在群组聊天/频道中触发（回退到 `channels.msteams.allowFrom`）。
- 设置 `groupPolicy: "open"` 以允许任何成员（默认仍需提及）。
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

**Teams + 频道白名单**

- 通过在 `channels.msteams.teams` 下列出团队和频道来限制群组/频道回复范围。
- 键应使用稳定的团队 ID 和频道对话 ID。
- 当 `groupPolicy="allowlist"` 且存在团队白名单时，只接受列出的团队/频道（提及门控）。
- 配置向导接受 `Team/Channel` 条目并为您存储它们。
- 启动时，OpenClaw 将团队/频道和用户白名单名称解析为 ID（当 Graph 权限允许时）
  并记录映射；未解析的团队/频道名称保持原样输入，但默认情况下被忽略用于路由，除非启用了 `channels.msteams.dangerouslyAllowNameMatching: true`。

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

1. 确保 Microsoft Teams 插件可用。
   - 当前打包的 OpenClaw 版本已经内置了它。
   - 较旧/自定义安装可以使用上述命令手动添加。
2. 创建一个**Azure Bot**（应用 ID + 密钥 + 租户 ID）。
3. 构建一个**Teams 应用包**，引用机器人并包含以下 RSC 权限。
4. 将 Teams 应用上传/安装到团队（或私信的个人范围）。
5. 在 `~/.openclaw/openclaw.json`（或环境变量）中配置 `msteams` 并启动网关。
6. 网关默认在 `/api/messages` 上监听 Bot Framework webhook 流量。

## Azure Bot 设置（先决条件）

在配置 OpenClaw 之前，您需要创建一个 Azure Bot 资源。

### 步骤 1：创建 Azure Bot

1. 前往 [创建 Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. 填写**基本信息**选项卡：

   | 字段              | 值                                                    |
   | ------------------ | -------------------------------------------------------- |
   | **Bot handle**     | 您的机器人名称，例如 `openclaw-msteams`（必须唯一） |
   | **Subscription**   | 选择您的 Azure 订阅                           |
   | **Resource group** | 创建新的或使用现有                               |
   | **Pricing tier**   | **免费**用于开发/测试                                 |
   | **Type of App**    | **单租户**（推荐 - 见下面的注释）         |
   | **Creation type**  | **创建新的 Microsoft App ID**                          |

> **弃用通知：** 2025-07-31 后，新的多租户机器人创建已被弃用。为新机器人使用**单租户**。

3. 点击 **Review + create** → **Create**（等待约 1-2 分钟）

### 步骤 2：获取凭据

1. 前往您的 Azure Bot 资源 → **Configuration**
2. 复制 **Microsoft App ID** → 这是您的 `appId`
3. 点击 **Manage Password** → 前往 App Registration
4. 在 **Certificates & secrets** → **New client secret** → 复制 **Value** → 这是您的 `appPassword`
5. 前往 **Overview** → 复制 **Directory (tenant) ID** → 这是您的 `tenantId`

### 步骤 3：配置消息传递端点

1. 在 Azure Bot → **Configuration**
2. 将 **Messaging endpoint** 设置为您的 webhook URL：
   - 生产：`https://your-domain.com/api/messages`
   - 本地开发：使用隧道（见下面的 [本地开发](#本地开发隧道)）

### 步骤 4：启用 Teams 频道

1. 在 Azure Bot → **Channels**
2. 点击 **Microsoft Teams** → Configure → Save
3. 接受服务条款

## 联合身份验证（证书 + 托管标识）

> 2026.3.24 添加

对于生产部署，OpenClaw 支持**联合身份验证**作为比客户端密钥更安全的替代方案。有两种方法可用：

### 选项 A：基于证书的身份验证

使用注册到您的 Entra ID 应用注册的 PEM 证书。

**设置：**

1. 生成或获取证书（带私钥的 PEM 格式）。
2. 在 Entra ID → App Registration → **Certificates & secrets** → **Certificates** → 上传公钥证书。

**配置：**

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      tenantId: "<TENANT_ID>",
      authType: "federated",
      certificatePath: "/path/to/cert.pem",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

**环境变量：**

- `MSTEAMS_AUTH_TYPE=federated`
- `MSTEAMS_CERTIFICATE_PATH=/path/to/cert.pem`

### 选项 B：Azure 托管标识

使用 Azure 托管标识进行无密码身份验证。这对于在 Azure 基础设施（AKS、App Service、Azure VM）上的部署非常理想，其中托管标识可用。

**工作原理：**

1. 机器人 pod/VM 具有托管标识（系统分配或用户分配）。
2. **联合标识凭据**将托管标识链接到 Entra ID 应用注册。
3. 在运行时，OpenClaw 使用 `@azure/identity` 从 Azure IMDS 端点（`169.254.169.254`）获取令牌。
4. 令牌传递给 Teams SDK 用于机器人身份验证。

**先决条件：**

- 启用了托管标识的 Azure 基础设施（AKS 工作负载标识、App Service、VM）
- 在 Entra ID 应用注册上创建的联合标识凭据
- 从 pod/VM 到 IMDS（`169.254.169.254:80`）的网络访问

**配置（系统分配的托管标识）：**

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      tenantId: "<TENANT_ID>",
      authType: "federated",
      useManagedIdentity: true,
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

**配置（用户分配的托管标识）：**

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      tenantId: "<TENANT_ID>",
      authType: "federated",
      useManagedIdentity: true,
      managedIdentityClientId: "<MI_CLIENT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

**环境变量：**

- `MSTEAMS_AUTH_TYPE=federated`
- `MSTEAMS_USE_MANAGED_IDENTITY=true`
- `MSTEAMS_MANAGED_IDENTITY_CLIENT_ID=<client-id>`（仅用于用户分配）

### AKS 工作负载标识设置

对于使用工作负载标识的 AKS 部署：

1. **在您的 AKS 集群上启用工作负载标识**。
2. **在 Entra ID 应用注册上创建联合标识凭据**：

   ```bash
   az ad app federated-credential create --id <APP_OBJECT_ID> --parameters '{
     "name": "my-bot-workload-identity",
     "issuer": "<AKS_OIDC_ISSUER_URL>",
     "subject": "system:serviceaccount:<NAMESPACE>:<SERVICE_ACCOUNT>",
     "audiences": ["api://AzureADTokenExchange"]
   }'
   ```

3. **用应用客户端 ID 注释 Kubernetes 服务账户**：

   ```yaml
   apiVersion: v1
   kind: ServiceAccount
   metadata:
     name: my-bot-sa
     annotations:
       azure.workload.identity/client-id: "<APP_CLIENT_ID>"
   ```

4. **为工作负载标识注入标记 pod**：

   ```yaml
   metadata:
     labels:
       azure.workload.identity/use: "true"
   ```

5. **确保对 IMDS 的网络访问**（`169.254.169.254`）— 如果使用 NetworkPolicy，添加允许流量到 `169.254.169.254/32` 端口 80 的出口规则。

### 身份验证类型比较

| 方法               | 配置                                         | 优点                               | 缺点                                  |
| -------------------- | ---------------------------------------------- | ---------------------------------- | ------------------------------------- |
| **客户端密钥**    | `appPassword`                                  | 设置简单                       | 需要密钥轮换，安全性较低 |
| **证书**      | `authType: "federated"` + `certificatePath`    | 网络上无共享密钥      | 证书管理开销       |
| **托管标识** | `authType: "federated"` + `useManagedIdentity` | 无密码，无需管理密钥 | 需要 Azure 基础设施         |

**默认行为：** 当未设置 `authType` 时，OpenClaw 默认使用客户端密钥身份验证。现有配置无需更改即可继续工作。

## 本地开发（隧道）

Teams 无法访问 `localhost`。使用隧道进行本地开发：

**选项 A：ngrok**

```bash
ngrok http 3978
# 复制 https URL，例如 https://abc123.ngrok.io
# 设置消息传递端点为：https://abc123.ngrok.io/api/messages
```

**选项 B：Tailscale Funnel**

```bash
tailscale funnel 3978
# 使用您的 Tailscale funnel URL 作为消息传递端点
```

## Teams 开发者门户（替代方案）

您可以使用 [Teams 开发者门户](https://dev.teams.microsoft.com/apps) 而不是手动创建清单 ZIP：

1. 点击 **+ New app**
2. 填写基本信息（名称、描述、开发者信息）
3. 前往 **App features** → **Bot**
4. 选择 **Enter a bot ID manually** 并粘贴您的 Azure Bot App ID
5. 检查范围：**Personal**、**Team**、**Group Chat**
6. 点击 **Distribute** → **Download app package**
7. 在 Teams 中：**Apps** → **Manage your apps** → **Upload a custom app** → 选择 ZIP

这通常比手动编辑 JSON 清单更容易。

## 测试机器人

**选项 A：Azure Web Chat（先验证 webhook）**

1. 在 Azure 门户 → 您的 Azure Bot 资源 → **Test in Web Chat**
2. 发送消息 - 您应该看到响应
3. 这在 Teams 设置之前确认您的 webhook 端点工作正常

**选项 B：Teams（应用安装后）**

1. 安装 Teams 应用（侧载或组织目录）
2. 在 Teams 中找到机器人并发送私信
3. 检查网关日志中的传入活动

## 设置（最小文本-only）

1. **确保 Microsoft Teams 插件可用**
   - 当前打包的 OpenClaw 版本已经内置了它。
   - 较旧/自定义安装可以手动添加：
     - 从 npm：`openclaw plugins install @openclaw/msteams`
     - 从本地检出：`openclaw plugins install ./path/to/local/msteams-plugin`

2. **机器人注册**
   - 创建 Azure Bot（见上文）并记录：
     - App ID
     - 客户端密钥（App password）
     - 租户 ID（单租户）

3. **Teams 应用清单**
   - 包含一个 `bot` 条目，其中 `botId = <App ID>`。
   - 范围：`personal`、`team`、`groupChat`。
   - `supportsFiles: true`（个人范围文件处理所需）。
   - 添加 RSC 权限（如下）。
   - 创建图标：`outline.png`（32x32）和 `color.png`（192x192）。
   - 将所有三个文件一起压缩：`manifest.json`、`outline.png`、`color.png`。

4. **配置 OpenClaw**

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

   您也可以使用环境变量代替配置键：
   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`
   - `MSTEAMS_AUTH_TYPE`（可选：`"secret"` 或 `"federated"`）
   - `MSTEAMS_CERTIFICATE_PATH`（联合 + 证书）
   - `MSTEAMS_CERTIFICATE_THUMBPRINT`（可选，认证不需要）
   - `MSTEAMS_USE_MANAGED_IDENTITY`（联合 + 托管标识）
   - `MSTEAMS_MANAGED_IDENTITY_CLIENT_ID`（仅用户分配的 MI）

5. **机器人端点**
   - 将 Azure Bot 消息传递端点设置为：
     - `https://<host>:3978/api/messages`（或您选择的路径/端口）。

6. **运行网关**
   - 当捆绑或手动安装的插件可用且 `msteams` 配置存在且包含凭据时，Teams 频道会自动启动。

## 成员信息操作

OpenClaw 为 Microsoft Teams 公开了一个基于 Graph 的 `member-info` 操作，因此代理和自动化可以直接从 Microsoft Graph 解析频道成员详细信息（显示名称、电子邮件、角色）。

要求：

- `Member.Read.Group` RSC 权限（已在推荐清单中）
- 对于跨团队查找：`User.Read.All` Graph 应用程序权限，需要管理员同意

该操作由 `channels.msteams.actions.memberInfo` 控制（默认：当 Graph 凭据可用时启用）。

## 历史上下文

- `channels.msteams.historyLimit` 控制包装到提示中的最近频道/群组消息数量。
- 回退到 `messages.groupChat.historyLimit`。设置 `0` 以禁用（默认 50）。
- 获取的线程历史记录按发送者白名单（`allowFrom` / `groupAllowFrom`）过滤，因此线程上下文种子仅包含来自允许发送者的消息。
- 引用的附件上下文（从 Teams 回复 HTML 派生的 `ReplyTo*`）当前按接收时传递。
- 换句话说，白名单控制谁可以触发代理；今天只有特定的补充上下文路径被过滤。
- 私信历史可以用 `channels.msteams.dmHistoryLimit`（用户回合）限制。每用户覆盖：`channels.msteams.dms["<user_id>"].historyLimit`。

## 当前 Teams RSC 权限（清单）

这些是我们的 Teams 应用清单中的**现有资源特定权限**。它们仅在安装应用的团队/聊天中应用。

**对于频道（团队范围）：**

- `ChannelMessage.Read.Group`（应用程序）- 接收所有频道消息，无需 @ 提及
- `ChannelMessage.Send.Group`（应用程序）
- `Member.Read.Group`（应用程序）
- `Owner.Read.Group`（应用程序）
- `ChannelSettings.Read.Group`（应用程序）
- `TeamMember.Read.Group`（应用程序）
- `TeamSettings.Read.Group`（应用程序）

**对于群组聊天：**

- `ChatMessage.Read.Chat`（应用程序）- 接收所有群组聊天消息，无需 @ 提及

## 示例 Teams 清单（已编辑）

具有必填字段的最小有效示例。替换 ID 和 URL。

```json5
{
  $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  manifestVersion: "1.23",
  version: "1.0.0",
  id: "00000000-0000-0000-0000-000000000000",
  name: { short: "OpenClaw" },
  developer: {
    name: "Your Org",
    websiteUrl: "https://example.com",
    privacyUrl: "https://example.com/privacy",
    termsOfUseUrl: "https://example.com/terms",
  },
  description: { short: "OpenClaw in Teams", full: "OpenClaw in Teams" },
  icons: { outline: "outline.png", color: "color.png" },
  accentColor: "#5B6DEF",
  bots: [
    {
      botId: "11111111-1111-1111-1111-111111111111",
      scopes: ["personal", "team", "groupChat"],
      isNotificationOnly: false,
      supportsCalling: false,
      supportsVideo: false,
      supportsFiles: true,
    },
  ],
  webApplicationInfo: {
    id: "11111111-1111-1111-1111-111111111111",
  },
  authorization: {
    permissions: {
      resourceSpecific: [
        { name: "ChannelMessage.Read.Group", type: "Application" },
        { name: "ChannelMessage.Send.Group", type: "Application" },
        { name: "Member.Read.Group", type: "Application" },
        { name: "Owner.Read.Group", type: "Application" },
        { name: "ChannelSettings.Read.Group", type: "Application" },
        { name: "TeamMember.Read.Group", type: "Application" },
        { name: "TeamSettings.Read.Group", type: "Application" },
        { name: "ChatMessage.Read.Chat", type: "Application" },
      ],
    },
  },
}
```

### 清单注意事项（必填字段）

- `bots[].botId` **必须**匹配 Azure Bot App ID。
- `webApplicationInfo.id` **必须**匹配 Azure Bot App ID。
- `bots[].scopes` 必须包含您计划使用的表面（`personal`、`team`、`groupChat`）。
- `bots[].supportsFiles: true` 是个人范围文件处理所必需的。
- `authorization.permissions.resourceSpecific` 必须包含频道读/发权限，如果您想要频道流量。

### 更新现有应用

要更新已安装的 Teams 应用（例如，添加 RSC 权限）：

1. 使用新设置更新您的 `manifest.json`
2. **增加 `version` 字段**（例如，`1.0.0` → `1.1.0`）
3. **重新压缩**清单和图标（`manifest.json`、`outline.png`、`color.png`）
4. 上传新的 zip：
   - **选项 A（Teams 管理中心）：** Teams 管理中心 → Teams 应用 → 管理应用 → 找到您的应用 → 上传新版本
   - **选项 B（侧载）：** 在 Teams 中 → Apps → Manage your apps → Upload a custom app
5. **对于团队频道：** 在每个团队中重新安装应用，以使新权限生效
6. **完全退出并重新启动 Teams**（不仅仅是关闭窗口）以清除缓存的应用元数据

## 功能：仅 RSC 与 Graph

### 仅使用 **Teams RSC**（应用已安装，无 Graph API 权限）

工作：

- 读取频道消息**文本**内容。
- 发送频道消息**文本**内容。
- 接收**个人（私信）**文件附件。

不工作：

- 频道/群组**图像或文件内容**（负载仅包含 HTML 存根）。
- 下载存储在 SharePoint/OneDrive 中的附件。
- 读取消息历史（超出实时 webhook 事件）。

### 使用 **Teams RSC + Microsoft Graph 应用程序权限**

添加：

- 下载托管内容（粘贴到消息中的图像）。
- 下载存储在 SharePoint/OneDrive 中的文件附件。
- 通过 Graph 读取频道/聊天消息历史。

### RSC 与 Graph API

| 功能              | RSC 权限      | Graph API                           |
| ----------------------- | -------------------- | ----------------------------------- |
| **实时消息**  | 是（通过 webhook）    | 否（仅轮询）                   |
| **历史消息** | 否                   | 是（可以查询历史）             |
| **设置复杂性**    | 仅应用清单    | 需要管理员同意 + 令牌流 |
| **离线工作**       | 否（必须运行） | 是（随时查询）                 |

**底线：** RSC 用于实时监听；Graph API 用于历史访问。要在离线时赶上错过的消息，您需要带有 `ChannelMessage.Read.All` 的 Graph API（需要管理员同意）。

## 启用 Graph 的媒体 + 历史（频道所需）

如果您需要**频道**中的图像/文件或想要获取**消息历史**，必须启用 Microsoft Graph 权限并授予管理员同意。

1. 在 Entra ID（Azure AD）**应用注册**中，添加 Microsoft Graph **应用程序权限**：
   - `ChannelMessage.Read.All`（频道附件 + 历史）
   - `Chat.Read.All` 或 `ChatMessage.Read.All`（群组聊天）
2. **为租户授予管理员同意**。
3. 增加 Teams 应用**清单版本**，重新上传，并**在 Teams 中重新安装应用**。
4. **完全退出并重新启动 Teams** 以清除缓存的应用元数据。

**用户提及的额外权限：** 对于对话中的用户，用户 @ 提及开箱即用。但是，如果您想动态搜索和提及**不在当前对话中的用户**，添加 `User.Read.All`（应用程序）权限并授予管理员同意。

## 已知限制

### Webhook 超时

Teams 通过 HTTP webhook 传递消息。如果处理时间过长（例如，LLM 响应缓慢），您可能会看到：

- 网关超时
- Teams 重试消息（导致重复）
- 丢失的回复

OpenClaw 通过快速返回并主动发送回复来处理此问题，但非常缓慢的响应仍可能导致问题。

### 格式

Teams markdown 比 Slack 或 Discord 更有限：

- 基本格式有效：**粗体**、_斜体_、`代码`、链接
- 复杂 markdown（表格、嵌套列表）可能无法正确渲染
- 支持自适应卡片用于投票和任意卡片发送（见下文）

## 配置

关键设置（有关共享频道模式，请参阅 `/gateway/configuration`）：

- `channels.msteams.enabled`：启用/禁用频道。
- `channels.msteams.appId`、`channels.msteams.appPassword`、`channels.msteams.tenantId`：机器人凭据。
- `channels.msteams.webhook.port`（默认 `3978`）
- `channels.msteams.webhook.path`（默认 `/api/messages`）
- `channels.msteams.dmPolicy`：`pairing | allowlist | open | disabled`（默认：pairing）
- `channels.msteams.allowFrom`：私信白名单（推荐使用 AAD 对象 ID）。向导在 Graph 访问可用时在设置期间将名称解析为 ID。
- `channels.msteams.dangerouslyAllowNameMatching`：打破玻璃的切换，重新启用可变 UPN/显示名称匹配和直接团队/频道名称路由。
- `channels.msteams.textChunkLimit`：出站文本块大小。
- `channels.msteams.chunkMode`：`length`（默认）或 `newline` 在长度分块前在空行（段落边界）处分割。
- `channels.msteams.mediaAllowHosts`：入站附件主机的白名单（默认为 Microsoft/Teams 域）。
- `channels.msteams.mediaAuthAllowHosts`：在媒体重试时附加 Authorization 标头的白名单（默认为 Graph + Bot Framework 主机）。
- `channels.msteams.requireMention`：在频道/群组中需要 @ 提及（默认 true）。
- `channels.msteams.replyStyle`：`thread | top-level`（见 [回复样式](#回复样式-线程-vs-帖子)）。
- `channels.msteams.teams.<teamId>.replyStyle`：每团队覆盖。
- `channels.msteams.teams.<teamId>.requireMention`：每团队覆盖。
- `channels.msteams.teams.<teamId>.tools`：当频道覆盖缺失时使用的默认每团队工具策略覆盖（`allow`/`deny`/`alsoAllow`）。
- `channels.msteams.teams.<teamId>.toolsBySender`：默认每团队每发送者工具策略覆盖（支持 `"*"` 通配符）。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`：每频道覆盖。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`：每频道覆盖。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`：每频道工具策略覆盖（`allow`/`deny`/`alsoAllow`）。
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`：每频道每发送者工具策略覆盖（支持 `"*"` 通配符）。
- `toolsBySender` 键应使用显式前缀：
  `id:`、`e164:`、`username:`、`name:`（遗留未前缀键仍仅映射到 `id:`）。
- `channels.msteams.actions.memberInfo`：启用或禁用基于 Graph 的成员信息操作（默认：当 Graph 凭据可用时启用）。
- `channels.msteams.authType`：身份验证类型 — `"secret"`（默认）或 `"federated"`。
- `channels.msteams.certificatePath`：PEM 证书文件路径（联合 + 证书身份验证）。
- `channels.msteams.certificateThumbprint`：证书指纹（可选，认证不需要）。
- `channels.msteams.useManagedIdentity`：启用托管身份认证（联合模式）。
- `channels.msteams.managedIdentityClientId`：用户分配的托管身份的客户端 ID。
- `channels.msteams.sharePointSiteId`：群组聊天/频道中文件上传的 SharePoint 站点 ID（见 [在群组聊天中发送文件](#在群组聊天中发送文件)）。

## 路由和会话

- 会话键遵循标准代理格式（见 [/concepts/session](/concepts/session)）：
  - 私信共享主会话（`agent:<agentId>:<mainKey>`）。
  - 频道/群组消息使用对话 ID：
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## 回复样式：线程 vs 帖子

Teams 最近在相同的底层数据模型上引入了两种频道 UI 样式：

| 样式                    | 描述                                               | 推荐的 `replyStyle` |
| ------------------------ | --------------------------------------------------------- | ------------------------ |
| **帖子**（经典）      | 消息显示为卡片，下面有线程回复 | `thread`（默认）       |
| **线程**（Slack 式） | 消息线性流动，更像 Slack                   | `top-level`              |

**问题：** Teams API 不公开频道使用哪种 UI 样式。如果您使用错误的 `replyStyle`：

- `thread` 在 Threads 样式频道中 → 回复显示嵌套尴尬
- `top-level` 在 Posts 样式频道中 → 回复显示为单独的顶级帖子而不是在线程中

**解决方案：** 根据频道的设置方式按频道配置 `replyStyle`：

```json5
{
  channels: {
    msteams: {
      replyStyle: "thread",
      teams: {
        "19:abc...@thread.tacv2": {
          channels: {
            "19:xyz...@thread.tacv2": {
              replyStyle: "top-level",
            },
          },
        },
      },
    },
  },
}
```

## 附件和图像

**当前限制：**

- **私信：** 图像和文件附件通过 Teams 机器人文件 API 工作。
- **频道/群组：** 附件存储在 M365 存储（SharePoint/OneDrive）中。Webhook 负载仅包含 HTML 存根，而不是实际文件字节。**需要 Graph API 权限**来下载频道附件。
- 对于显式文件优先发送，使用 `action=upload-file` 与 `media` / `filePath` / `path`；可选的 `message` 成为随附的文本/评论，`filename` 覆盖上传的名称。

没有 Graph 权限，带有图像的频道消息将作为纯文本接收（图像内容对机器人不可访问）。
默认情况下，OpenClaw 仅从 Microsoft/Teams 主机名下载媒体。使用 `channels.msteams.mediaAllowHosts` 覆盖（使用 `["*"]` 允许任何主机）。
仅对 `channels.msteams.mediaAuthAllowHosts` 中的主机附加 Authorization 标头（默认为 Graph + Bot Framework 主机）。保持此列表严格（避免多租户后缀）。

## 在群组聊天中发送文件

机器人可以使用 FileConsentCard 流程在私信中发送文件（内置）。然而，**在群组聊天/频道中发送文件**需要额外设置：

| 上下文                  | 文件发送方式                           | 需要的设置                                    |
| ------------------------ | -------------------------------------------- | ----------------------------------------------- |
| **私信**                  | FileConsentCard → 用户接受 → 机器人上传 | 开箱即用                            |
| **群组聊天/频道** | 上传到 SharePoint → 共享链接            | 需要 `sharePointSiteId` + Graph 权限 |
| **图像（任何上下文）** | Base64 编码内联                        | 开箱即用                            |

### 为什么群组聊天需要 SharePoint

机器人没有个人 OneDrive 驱动器（`/me/drive` Graph API 端点对应用程序标识不起作用）。要在群组聊天/频道中发送文件，机器人上传到**SharePoint 站点**并创建共享链接。

### 设置

1. **在 Entra ID（Azure AD）→ App Registration 中添加 Graph API 权限**：
   - `Sites.ReadWrite.All`（应用程序）- 上传文件到 SharePoint
   - `Chat.Read.All`（应用程序）- 可选，启用每用户共享链接

2. **为租户授予管理员同意**。

3. **获取您的 SharePoint 站点 ID**：

   ```bash
   # 通过 Graph Explorer 或带有有效令牌的 curl：
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # 示例：对于 "contoso.sharepoint.com/sites/BotFiles" 站点
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # 响应包含："id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **配置 OpenClaw**：

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

| 权限                              | 共享行为                                          |
| --------------------------------------- | --------------------------------------------------------- |
| 仅 `Sites.ReadWrite.All`              | 组织范围共享链接（组织中的任何人都可以访问） |
| `Sites.ReadWrite.All` + `Chat.Read.All` | 每用户共享链接（只有聊天成员可以访问）      |

每用户共享更安全，因为只有聊天参与者可以访问文件。如果缺少 `Chat.Read.All` 权限，机器人会回退到组织范围共享。

### 回退行为

| 场景                                          | 结果                                             |
| ------------------------------------------------- | -------------------------------------------------- |
| 群组聊天 + 文件 + 配置了 `sharePointSiteId` | 上传到 SharePoint，发送共享链接            |
| 群组聊天 + 文件 + 无 `sharePointSiteId`         | 尝试 OneDrive 上传（可能失败），仅发送文本 |
| 个人聊天 + 文件                              | FileConsentCard 流程（无需 SharePoint）    |
| 任何上下文 + 图像                               | Base64 编码内联（无需 SharePoint）   |

### 文件存储位置

上传的文件存储在配置的 SharePoint 站点默认文档库的 `/OpenClawShared/` 文件夹中。

## 投票（自适应卡片）

OpenClaw 将 Teams 投票作为自适应卡片发送（没有原生 Teams 投票 API）。

- CLI：`openclaw message poll --channel msteams --target conversation:<id> ...`
- 投票由网关记录在 `~/.openclaw/msteams-polls.json` 中。
- 网关必须保持在线以记录投票。
- 投票尚未自动发布结果摘要（如有需要，请检查存储文件）。

## 自适应卡片（任意）

使用 `message` 工具或 CLI 向 Teams 用户或对话发送任何自适应卡片 JSON。

`card` 参数接受自适应卡片 JSON 对象。提供 `card` 时，消息文本是可选的。

**代理工具：**

```json5
{
  action: "send",
  channel: "msteams",
  target: "user:<id>",
  card: {
    type: "AdaptiveCard",
    version: "1.5",
    body: [{ type: "TextBlock", text: "Hello!" }],
  },
}
```

**CLI：**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

有关卡片架构和示例，请参阅 [自适应卡片文档](https://adaptivecards.io/)。有关目标格式详细信息，请参阅下面的 [目标格式](#目标格式)。

## 目标格式

MSTeams 目标使用前缀来区分用户和对话：

| 目标类型         | 格式                           | 示例                                             |
| ------------------- | -------------------------------- | --------------------------------------------------- |
| 用户（按 ID）        | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`         |
| 用户（按名称）      | `user:<display-name>`            | `user:John Smith`（需要 Graph API）              |
| 群组/频道       | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`            |
| 群组/频道（原始） | `<conversation-id>`              | `19:abc123...@thread.tacv2`（如果包含 `@thread`） |

**CLI 示例：**

```bash
# 按 ID 发送给用户
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# 按显示名称发送给用户（触发 Graph API 查找）
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# 发送到群组聊天或频道
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# 向对话发送自适应卡片
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**代理工具示例：**

```json5
{
  action: "send",
  channel: "msteams",
  target: "user:John Smith",
  message: "Hello!",
}
```

```json5
{
  action: "send",
  channel: "msteams",
  target: "conversation:19:abc...@thread.tacv2",
  card: {
    type: "AdaptiveCard",
    version: "1.5",
    body: [{ type: "TextBlock", text: "Hello" }],
  },
}
```

注意：没有 `user:` 前缀，名称默认为群组/团队解析。当按显示名称定位人员时，始终使用 `user:`。

## 主动消息

- 主动消息仅在**用户互动后**才可能，因为我们在那时存储对话引用。
- 有关 `dmPolicy` 和白名单门控，请参阅 `/gateway/configuration`。

## 团队和频道 ID（常见陷阱）

Teams URL 中的 `groupId` 查询参数**不是**用于配置的团队 ID。而是从 URL 路径中提取 ID：

**团队 URL：**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    团队 ID（URL 解码此）
```

**频道 URL：**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      频道 ID（URL 解码此）
```

**对于配置：**

- 团队 ID = `/team/` 后的路径段（URL 解码，例如 `19:Bk4j...@thread.tacv2`）
- 频道 ID = `/channel/` 后的路径段（URL 解码）
- **忽略** `groupId` 查询参数

## 私有频道

机器人在私有频道中支持有限：

| 功能                      | 标准频道 | 私有频道       |
| ---------------------------- | ----------------- | ---------------------- |
| 机器人安装             | 是               | 有限                |
| 实时消息（webhook） | 是               | 可能不工作           |
| RSC 权限              | 是               | 可能行为不同 |
| @ 提及                    | 是               | 如果机器人可访问   |
| Graph API 历史            | 是               | 是（带权限） |

**如果私有频道不工作的解决方法：**

1. 使用标准频道进行机器人交互
2. 使用私信 - 用户始终可以直接向机器人发送消息
3. 使用 Graph API 进行历史访问（需要 `ChannelMessage.Read.All`）

## 故障排除

### 常见问题

- **频道中图像不显示：** 缺少 Graph 权限或管理员同意。重新安装 Teams 应用并完全退出/重新打开 Teams。
- **频道中无响应：** 默认需要提及；设置 `channels.msteams.requireMention=false` 或按团队/频道配置。
- **版本不匹配（Teams 仍显示旧清单）：** 删除 + 重新添加应用并完全退出 Teams 以刷新。
- **从 webhook 收到 401 Unauthorized：** 手动测试时没有 Azure JWT 是预期的 - 表示端点可达但认证失败。使用 Azure Web Chat 正确测试。

### 清单上传错误

- **"Icon file cannot be empty"：** 清单引用的图标文件为 0 字节。创建有效的 PNG 图标（`outline.png` 为 32x32，`color.png` 为 192x192）。
- **"webApplicationInfo.Id already in use"：** 应用仍安装在另一个团队/聊天中。先找到并卸载它，或等待 5-10 分钟传播。
- **上传时"Something went wrong"：** 改为通过 [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) 上传，打开浏览器开发工具（F12）→ 网络选项卡，并检查响应体中的实际错误。
- **侧载失败：** 尝试"Upload an app to your org's app catalog"而不是"Upload a custom app" - 这通常绕过侧载限制。

### RSC 权限不工作

1. 验证 `webApplicationInfo.id` 与您的机器人的 App ID 完全匹配
2. 重新上传应用并在团队/聊天中重新安装
3. 检查您的组织管理员是否阻止了 RSC 权限
4. 确认您使用了正确的范围：团队使用 `ChannelMessage.Read.Group`，群组聊天使用 `ChatMessage.Read.Chat`

## 参考

- [创建 Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Azure Bot 设置指南
- [Teams 开发者门户](https://dev.teams.microsoft.com/apps) - 创建/管理 Teams 应用
- [Teams 应用清单架构](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [使用 RSC 接收频道消息](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC 权限参考](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams 机器人文件处理](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4)（频道/群组需要 Graph）
- [主动消息](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)

## 相关

- [频道概述](/channels) — 所有支持的频道
- [配对](/channels/pairing) — 私信认证和配对流程
- [群组](/channels/groups) — 群组聊天行为和提及门控
- [频道路由](/channels/channel-routing) — 消息的会话路由
- [安全](/gateway/security) — 访问模型和强化