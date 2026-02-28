---
read_when:
  - 开发 Google Chat 渠道功能时
summary: Google Chat 应用支持状态、功能和配置
title: Google Chat
x-i18n:
  generated_at: "2026-02-03T07:43:39Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 3b2bb116cdd12614c3d5afddd0879e9deb05c3606e3a2385cbc07f23552b357e
  source_path: channels/googlechat.md
  workflow: 15
---

# Google Chat（Chat API）

状态：已支持通过 Google Chat API webhooks（仅 HTTP）使用私信和空间。

## 快速设置（新手）

1. 创建一个 Google Cloud 项目并启用 **Google Chat API**。
   - 前往：[Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - 如果 API 尚未启用，请启用它。
2. 创建一个**服务账号**：
   - 点击 **Create Credentials** > **Service Account**。
   - 随意命名（例如 `openclaw-chat`）。
   - 权限留空（点击 **Continue**）。
   - 有访问权限的主账号留空（点击 **Done**）。
3. 创建并下载 **JSON 密钥**：
   - 在服务账号列表中，点击刚刚创建的账号。
   - 前往 **Keys** 标签页。
   - 点击 **Add Key** > **Create new key**。
   - 选择 **JSON** 并点击 **Create**。
4. 将下载的 JSON 文件存储在 Gateway 网关主机上（例如 `~/.openclaw/googlechat-service-account.json`）。
5. 在 [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) 中创建一个 Google Chat 应用：
   - 填写 **Application info**：
     - **App name**：（例如 `OpenClaw`）
     - **Avatar URL**：（例如 `https://openclaw.ai/logo.png`）
     - **Description**：（例如 `Personal AI Assistant`）
   - 启用 **Interactive features**。
   - 在 **Functionality** 下，勾选 **Join spaces and group conversations**。
   - 在 **Connection settings** 下，选择 **HTTP endpoint URL**。
   - 在 **Triggers** 下，选择 **Use a common HTTP endpoint URL for all triggers** 并将其设置为你的 Gateway 网关公网 URL 后加 `/googlechat`。
     - _提示：运行 `openclaw status` 查看你的 Gateway 网关公网 URL。_
   - 在 **Visibility** 下，勾选 **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**。
   - 在文本框中输入你的邮箱地址（例如 `user@example.com`）。
   - 点击底部的 **Save**。
6. **启用应用状态**：
   - 保存后，**刷新页面**。
   - 找到 **App status** 部分（通常在保存后位于顶部或底部附近）。
   - 将状态更改为 **Live - available to users**。
   - 再次点击 **Save**。
7. 使用服务账号路径和 webhook audience 配置 OpenClaw：
   - 环境变量：`GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - 或配置：`channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`。
8. 设置 webhook audience 类型和值（与你的 Chat 应用配置匹配）。
9. 启动 Gateway 网关。Google Chat 将向你的 webhook 路径发送 POST 请求。

## 添加到 Google Chat

Gateway 网关运行后，且你的邮箱已添加到可见性列表中：

1. 前往 [Google Chat](https://chat.google.com/)。
2. 点击 **Direct Messages** 旁边的 **+**（加号）图标。
3. 在搜索栏（通常用于添加联系人的位置）中，输入你在 Google Cloud Console 中配置的 **App name**。
   - **注意**：该机器人*不会*出现在"Marketplace"浏览列表中，因为它是私有应用。你必须按名称搜索。
4. 从结果中选择你的机器人。
5. 点击 **Add** 或 **Chat** 开始一对一对话。
6. 发送"Hello"来触发助手！

## 公网 URL（仅 Webhook）

Google Chat webhooks 需要一个公网 HTTPS 端点。为了安全起见，**只将 `/googlechat` 路径暴露到互联网**。将 OpenClaw 仪表板和其他敏感端点保留在你的私有网络上。

### 方案 A：Tailscale Funnel（推荐）

使用 Tailscale Serve 提供私有仪表板，使用 Funnel 提供公网 webhook 路径。这样可以保持 `/` 私有，同时只暴露 `/googlechat`。

1. **检查你的 Gateway 网关绑定的地址：**

   ```bash
   ss -tlnp | grep 18789
   ```

   记下 IP 地址（例如 `127.0.0.1`、`0.0.0.0` 或你的 Tailscale IP 如 `100.x.x.x`）。

2. **仅将仪表板暴露给 tailnet（端口 8443）：**

   ```bash
   # 如果绑定到 localhost（127.0.0.1 或 0.0.0.0）：
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # 如果仅绑定到 Tailscale IP（例如 100.106.161.80）：
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **仅公开暴露 webhook 路径：**

   ```bash
   # 如果绑定到 localhost（127.0.0.1 或 0.0.0.0）：
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # 如果仅绑定到 Tailscale IP（例如 100.106.161.80）：
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **授权节点访问 Funnel：**
   如果出现提示，请访问输出中显示的授权 URL，以在你的 tailnet 策略中为此节点启用 Funnel。

5. **验证配置：**
   ```bash
   tailscale serve status
   tailscale funnel status
   ```

你的公网 webhook URL 将是：
`https://<node-name>.<tailnet>.ts.net/googlechat`

你的私有仪表板仅限 tailnet 访问：
`https://<node-name>.<tailnet>.ts.net:8443/`

在 Google Chat 应用配置中使用公网 URL（不带 `:8443`）。

> 注意：此配置在重启后会保留。如需稍后移除，请运行 `tailscale funnel reset` 和 `tailscale serve reset`。

### 方案 B：反向代理（Caddy）

如果你使用像 Caddy 这样的反向代理，只代理特定路径：

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

使用此配置，任何发往 `your-domain.com/` 的请求将被忽略或返回 404，而 `your-domain.com/googlechat` 会安全地路由到 OpenClaw。

### 方案 C：Cloudflare Tunnel

配置你的隧道入口规则，只路由 webhook 路径：

- **路径**：`/googlechat` -> `http://localhost:18789/googlechat`
- **默认规则**：HTTP 404（未找到）

## 工作原理

1. Google Chat 向 Gateway 网关发送 webhook POST 请求。每个请求都包含一个 `Authorization: Bearer <token>` 头。
2. OpenClaw 根据配置的 `audienceType` + `audience` 验证令牌：
   - `audienceType: "app-url"` → audience 是你的 HTTPS webhook URL。
   - `audienceType: "project-number"` → audience 是 Cloud 项目编号。
3. 消息按空间路由：
   - 私信使用会话键 `agent:<agentId>:googlechat:dm:<spaceId>`。
   - 空间使用会话键 `agent:<agentId>:googlechat:group:<spaceId>`。
4. 私信访问默认为配对模式。未知发送者会收到配对码；使用以下命令批准：
   - `openclaw pairing approve googlechat <code>`
5. 群组空间默认需要 @提及。如果提及检测需要应用的用户名，请使用 `botUser`。

## 目标标识符

使用这些标识符进行消息投递和允许列表：

- 私信：`users/<userId>` 或 `users/<email>`（接受邮箱地址）。
- 空间：`spaces/<spaceId>`。

## 配置要点

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // 可选；帮助提及检测
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
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

注意事项：

- 服务账号凭证也可以通过 `serviceAccount`（JSON 字符串）内联传递。
- 如果未设置 `webhookPath`，默认 webhook 路径为 `/googlechat`。
- 当 `actions.reactions` 启用时，可通过 `reactions` 工具和 `channels action` 使用表情回应。
- `typingIndicator` 支持 `none`、`message`（默认）和 `reaction`（reaction 需要用户 OAuth）。
- 附件通过 Chat API 下载并存储在媒体管道中（大小受 `mediaMaxMb` 限制）。

## 故障排除

### 405 Method Not Allowed

如果 Google Cloud Logs Explorer 显示如下错误：

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

这意味着 webhook 处理程序未注册。常见原因：

1. **渠道未配置**：配置中缺少 `channels.googlechat` 部分。使用以下命令验证：

   ```bash
   openclaw config get channels.googlechat
   ```

   如果返回"Config path not found"，请添加配置（参见[配置要点](#配置要点)）。

2. **插件未启用**：检查插件状态：

   ```bash
   openclaw plugins list | grep googlechat
   ```

   如果显示"disabled"，请在配置中添加 `plugins.entries.googlechat.enabled: true`。

3. **Gateway 网关未重启**：添加配置后，重启 Gateway 网关：
   ```bash
   openclaw gateway restart
   ```

验证渠道是否正在运行：

```bash
openclaw channels status
# 应显示：Google Chat default: enabled, configured, ...
```

### 其他问题

- 检查 `openclaw channels status --probe` 以查看认证错误或缺少 audience 配置。
- 如果没有收到消息，请确认 Chat 应用的 webhook URL 和事件订阅。
- 如果提及门控阻止了回复，请将 `botUser` 设置为应用的用户资源名称并验证 `requireMention`。
- 在发送测试消息时使用 `openclaw logs --follow` 查看请求是否到达 Gateway 网关。

相关文档：

- [Gateway 网关配置](/gateway/configuration)
- [安全](/gateway/security)
- [表情回应](/tools/reactions)
