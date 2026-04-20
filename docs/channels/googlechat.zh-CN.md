---
summary: "Google Chat 应用支持状态、功能和配置"
read_when:
  - 处理 Google Chat 通道功能
  - 设置 Google Chat 应用
  - 配置 Google Chat webhook
title: "Google Chat"
---

# Google Chat (Chat API)

状态：通过 Google Chat API webhook（仅 HTTP）支持私信 + 空间。

## 快速设置（初学者）

1. 创建 Google Cloud 项目并启用**Google Chat API**。
   - 前往：[Google Chat API 凭证](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - 如果 API 尚未启用，请启用它。
2. 创建**服务账户**：
   - 点击**创建凭证** > **服务账户**。
   - 任意命名（例如 `openclaw-chat`）。
   - 留空权限（点击**继续**）。
   - 留空具有访问权限的主体（点击**完成**）。
3. 创建并下载**JSON 密钥**：
   - 在服务账户列表中，点击你刚创建的账户。
   - 进入**密钥**标签页。
   - 点击**添加密钥** > **创建新密钥**。
   - 选择**JSON**并点击**创建**。
4. 将下载的 JSON 文件存储在网关主机上（例如 `~/.openclaw/googlechat-service-account.json`）。
5. 在 [Google Cloud Console Chat 配置](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) 中创建 Google Chat 应用：
   - 填写**应用信息**：
     - **应用名称**：（例如 `OpenClaw`）
     - **头像 URL**：（例如 `https://openclaw.ai/logo.png`）
     - **描述**：（例如 `个人 AI 助手`）
   - 启用**交互式功能**。
   - 在**功能**下，勾选**加入空间和群组对话**。
   - 在**连接设置**下，选择**HTTP 端点 URL**。
   - 在**触发器**下，选择**对所有触发器使用通用 HTTP 端点 URL**，并将其设置为你的网关的公共 URL 后跟 `/googlechat`。
     - _提示：运行 `openclaw status` 找到网关的公共 URL。_
   - 在**可见性**下，勾选**使此 Chat 应用对 &lt;你的域&gt; 中的特定人员和群组可用**。
   - 在文本框中输入你的电子邮件地址（例如 `user@example.com`）。
   - 点击底部的**保存**。
6. **启用应用状态**：
   - 保存后，**刷新页面**。
   - 查找**应用状态**部分（通常在保存后靠近顶部或底部）。
   - 将状态更改为**已上线 - 对用户可用**。
   - 再次点击**保存**。
7. 使用服务账户路径 + webhook 受众配置 OpenClaw：
   - 环境变量：`GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - 或配置：`channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`。
8. 设置 webhook 受众类型 + 值（与你的 Chat 应用配置匹配）。
9. 启动网关。Google Chat 将向你的 webhook 路径发送 POST 请求。

## 添加到 Google Chat

一旦网关运行且你的电子邮件已添加到可见性列表：

1. 前往 [Google Chat](https://chat.google.com/)。
2. 点击**直接消息**旁边的**+**（加号）图标。
3. 在搜索栏（通常添加人员的地方）中，输入你在 Google Cloud Console 中配置的**应用名称**。
   - **注意**：机器人不会出现在"市场"浏览列表中，因为它是私人应用。你必须按名称搜索它。
4. 从结果中选择你的机器人。
5. 点击**添加**或**聊天**开始 1:1 对话。
6. 发送"Hello"触发助手！

## 公共 URL（仅 Webhook）

Google Chat webhook 需要公共 HTTPS 端点。为安全起见，**仅将 `/googlechat` 路径**暴露到互联网。将 OpenClaw 仪表板和其他敏感端点保持在你的私有网络上。

### 选项 A：Tailscale Funnel（推荐）

使用 Tailscale Serve 用于私有仪表板，Funnel 用于公共 webhook 路径。这将保持 `/` 私有，同时仅暴露 `/googlechat`。

1. **检查网关绑定的地址：**

   ```bash
   ss -tlnp | grep 18789
   ```

   注意 IP 地址（例如 `127.0.0.1`、`0.0.0.0` 或你的 Tailscale IP 如 `100.x.x.x`）。

2. **仅将仪表板暴露到 tailnet（端口 8443）：**

   ```bash
   # 如果绑定到 localhost（127.0.0.1 或 0.0.0.0）：
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # 如果仅绑定到 Tailscale IP（例如 100.106.161.80）：
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **仅将 webhook 路径公开暴露：**

   ```bash
   # 如果绑定到 localhost（127.0.0.1 或 0.0.0.0）：
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # 如果仅绑定到 Tailscale IP（例如 100.106.161.80）：
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **授权节点访问 Funnel：**
   如果提示，请访问输出中显示的授权 URL，以在你的 tailnet 策略中为此节点启用 Funnel。

5. **验证配置：**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

你的公共 webhook URL 将是：
`https://<node-name>.<tailnet>.ts.net/googlechat`

你的私有仪表板保持仅 tailnet 访问：
`https://<node-name>.<tailnet>.ts.net:8443/`

在 Google Chat 应用配置中使用公共 URL（不带 `:8443`）。

> 注意：此配置在重启后仍然有效。以后要移除它，运行 `tailscale funnel reset` 和 `tailscale serve reset`。

### 选项 B：反向代理（Caddy）

如果你使用 Caddy 等反向代理，仅代理特定路径：

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

使用此配置，对 `your-domain.com/` 的任何请求将被忽略或返回 404，而 `your-domain.com/googlechat` 被安全路由到 OpenClaw。

### 选项 C：Cloudflare Tunnel

配置隧道的入口规则以仅路由 webhook 路径：

- **路径**：`/googlechat` -> `http://localhost:18789/googlechat`
- **默认规则**：HTTP 404（未找到）

## 工作原理

1. Google Chat 向网关发送 webhook POST。每个请求都包含 `Authorization: Bearer <token>` 标头。
   - 当标头存在时，OpenClaw 在读取/解析完整的 webhook 正文之前验证承载认证。
   - 支持在正文中携带 `authorizationEventObject.systemIdToken` 的 Google Workspace 附加组件请求，通过更严格的预认证正文预算。
2. OpenClaw 根据配置的 `audienceType` + `audience` 验证令牌：
   - `audienceType: "app-url"` → 受众是你的 HTTPS webhook URL。
   - `audienceType: "project-number"` → 受众是 Cloud 项目编号。
3. 消息按空间路由：
   - 私信使用会话键 `agent:<agentId>:googlechat:direct:<spaceId>`。
   - 空间使用会话键 `agent:<agentId>:googlechat:group:<spaceId>`。
4. 私信默认采用配对模式。未知发送者会收到配对代码；使用以下命令批准：
   - `openclaw pairing approve googlechat <code>`
5. 群组空间默认需要 @提及。如果提及检测需要应用的用户名，请使用 `botUser`。

## 目标

使用这些标识符进行传递和允许列表：

- 私信：`users/<userId>`（推荐）。
- 原始电子邮件 `name@example.com` 是可变的，仅当 `channels.googlechat.dangerouslyAllowNameMatching: true` 时用于直接允许列表匹配。
- 已弃用：`users/<email>` 被视为用户 ID，而不是电子邮件允许列表。
- 空间：`spaces/<spaceId>`。

## 配置要点

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      // 或 serviceAccountRef: { source: "file", provider: "filemain", id: "/channels/googlechat/serviceAccount" }
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // 可选；帮助提及检测
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

注意：

- 服务账户凭证也可以通过 `serviceAccount`（JSON 字符串）内联传递。
- 也支持 `serviceAccountRef`（环境/文件 SecretRef），包括 `channels.googlechat.accounts.<id>.serviceAccountRef` 下的每个账户引用。
- 如果未设置 `webhookPath`，默认 webhook 路径为 `/googlechat`。
- `dangerouslyAllowNameMatching` 重新启用允许列表的可变电子邮件主体匹配（紧急兼容模式）。
- 当 `actions.reactions` 启用时，通过 `reactions` 工具和 `channels action` 可使用反应。
- 消息操作公开 `send` 用于文本和 `upload-file` 用于显式附件发送。`upload-file` 接受 `media` / `filePath` / `path` 以及可选的 `message`、`filename` 和线程目标。
- `typingIndicator` 支持 `none`、`message`（默认）和 `reaction`（反应需要用户 OAuth）。
- 附件通过 Chat API 下载并存储在媒体管道中（大小由 `mediaMaxMb` 限制）。

密钥参考详情：[密钥管理](/gateway/secrets)。

## 故障排除

### 405 Method Not Allowed

如果 Google Cloud Logs Explorer 显示如下错误：

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

这意味着 webhook 处理程序未注册。常见原因：

1. **通道未配置**：配置中缺少 `channels.googlechat` 部分。使用以下命令验证：

   ```bash
   openclaw config get channels.googlechat
   ```

   如果返回"Config path not found"，请添加配置（参见[配置要点](#配置要点)）。

2. **插件未启用**：检查插件状态：

   ```bash
   openclaw plugins list | grep googlechat
   ```

   如果显示"disabled"，请在配置中添加 `plugins.entries.googlechat.enabled: true`。

3. **网关未重启**：添加配置后，重启网关：

   ```bash
   openclaw gateway restart
   ```

验证通道是否运行：

```bash
openclaw channels status
# 应显示：Google Chat default: enabled, configured, ...
```

### 其他问题

- 检查 `openclaw channels status --probe` 了解认证错误或缺少受众配置。
- 如果没有消息到达，确认 Chat 应用的 webhook URL + 事件订阅。
- 如果提及门控阻止回复，将 `botUser` 设置为应用的用户资源名称并验证 `requireMention`。
- 发送测试消息时使用 `openclaw logs --follow` 查看请求是否到达网关。

相关文档：

- [网关配置](/gateway/configuration)
- [安全](/gateway/security)
- [反应](/tools/reactions)

## 相关

- [通道概述](/channels) — 所有支持的通道
- [配对](/channels/pairing) — 私信认证和配对流程
- [群组](/channels/groups) — 群聊行为和提及门控
- [通道路由](/channels/channel-routing) — 消息的会话路由
- [安全](/gateway/security) — 访问模型和强化
