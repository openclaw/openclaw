---
read_when:
  - 将 Gmail 收件箱触发器接入 OpenClaw
  - 为智能体唤醒设置 Pub/Sub 推送
summary: 通过 gogcli 将 Gmail Pub/Sub 推送接入 OpenClaw webhooks
title: Gmail PubSub
x-i18n:
  generated_at: "2026-02-03T07:43:25Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: dfb92133b69177e4e984b7d072f5dc28aa53a9e0cf984a018145ed811aa96195
  source_path: automation/gmail-pubsub.md
  workflow: 15
---

# Gmail Pub/Sub -> OpenClaw

目标：Gmail watch -> Pub/Sub 推送 -> `gog gmail watch serve` -> OpenClaw webhook。

## 前置条件

- 已安装并登录 `gcloud`（[安装指南](https://docs.cloud.google.com/sdk/docs/install-sdk)）。
- 已安装 `gog` (gogcli) 并为 Gmail 账户授权（[gogcli.sh](https://gogcli.sh/)）。
- 已启用 OpenClaw hooks（参见 [Webhooks](/automation/webhook)）。
- 已登录 `tailscale`（[tailscale.com](https://tailscale.com/)）。支持的设置使用 Tailscale Funnel 作为公共 HTTPS 端点。
  其他隧道服务也可以使用，但需要自行配置/不受支持，需要手动接入。
  目前，我们支持的是 Tailscale。

示例 hook 配置（启用 Gmail 预设映射）：

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
  },
}
```

要将 Gmail 摘要投递到聊天界面，请用设置了 `deliver` 以及可选的 `channel`/`to` 的映射覆盖预设：

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

如果你想使用固定渠道，请设置 `channel` + `to`。否则 `channel: "last"` 会使用上次的投递路由（默认回退到 WhatsApp）。

要为 Gmail 运行强制使用更便宜的模型，请在映射中设置 `model`（`provider/model` 或别名）。如果你强制启用了 `agents.defaults.models`，请将其包含在内。

要专门为 Gmail hooks 设置默认模型和思考级别，请在配置中添加 `hooks.gmail.model` / `hooks.gmail.thinking`：

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

注意事项：

- 映射中的每个 hook 的 `model`/`thinking` 仍会覆盖这些默认值。
- 回退顺序：`hooks.gmail.model` → `agents.defaults.model.fallbacks` → 主模型（认证/速率限制/超时）。
- 如果设置了 `agents.defaults.models`，Gmail 模型必须在允许列表中。
- Gmail hook 内容默认使用外部内容安全边界包装。
  要禁用（危险），请设置 `hooks.gmail.allowUnsafeExternalContent: true`。

要进一步自定义负载处理，请添加 `hooks.mappings` 或在 `hooks.transformsDir` 下添加 JS/TS 转换模块（参见 [Webhooks](/automation/webhook)）。

## 向导（推荐）

使用 OpenClaw 助手将所有内容接入在一起（在 macOS 上通过 brew 安装依赖）：

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

默认设置：

- 使用 Tailscale Funnel 作为公共推送端点。
- 为 `openclaw webhooks gmail run` 写入 `hooks.gmail` 配置。
- 启用 Gmail hook 预设（`hooks.presets: ["gmail"]`）。

路径说明：当启用 `tailscale.mode` 时，OpenClaw 会自动将 `hooks.gmail.serve.path` 设置为 `/`，并将公共路径保持在 `hooks.gmail.tailscale.path`（默认 `/gmail-pubsub`），因为 Tailscale 在代理之前会剥离设置的路径前缀。
如果你需要后端接收带前缀的路径，请将 `hooks.gmail.tailscale.target`（或 `--tailscale-target`）设置为完整 URL，如 `http://127.0.0.1:8788/gmail-pubsub`，并匹配 `hooks.gmail.serve.path`。

想要自定义端点？使用 `--push-endpoint <url>` 或 `--tailscale off`。

平台说明：在 macOS 上，向导通过 Homebrew 安装 `gcloud`、`gogcli` 和 `tailscale`；在 Linux 上请先手动安装它们。

Gateway 网关自动启动（推荐）：

- 当 `hooks.enabled=true` 且设置了 `hooks.gmail.account` 时，Gateway 网关会在启动时运行 `gog gmail watch serve` 并自动续期 watch。
- 设置 `OPENCLAW_SKIP_GMAIL_WATCHER=1` 可退出（如果你自己运行守护进程则很有用）。
- 不要同时运行手动守护进程，否则会遇到 `listen tcp 127.0.0.1:8788: bind: address already in use`。

手动守护进程（启动 `gog gmail watch serve` + 自动续期）：

```bash
openclaw webhooks gmail run
```

## 一次性设置

1. 选择**拥有 `gog` 使用的 OAuth 客户端**的 GCP 项目。

```bash
gcloud auth login
gcloud config set project <project-id>
```

注意：Gmail watch 要求 Pub/Sub 主题与 OAuth 客户端位于同一项目中。

2. 启用 API：

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. 创建主题：

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. 允许 Gmail push 发布：

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## 启动 watch

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

保存输出中的 `history_id`（用于调试）。

## 运行推送处理程序

本地示例（共享 token 认证）：

```bash
gog gmail watch serve \
  --account openclaw@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token OPENCLAW_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

注意事项：

- `--token` 保护推送端点（`x-gog-token` 或 `?token=`）。
- `--hook-url` 指向 OpenClaw `/hooks/gmail`（已映射；隔离运行 + 摘要发送到主线程）。
- `--include-body` 和 `--max-bytes` 控制发送到 OpenClaw 的正文片段。

推荐：`openclaw webhooks gmail run` 封装了相同的流程并自动续期 watch。

## 暴露处理程序（高级，不受支持）

如果你需要非 Tailscale 隧道，请手动接入并在推送订阅中使用公共 URL（不受支持，无保护措施）：

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

使用生成的 URL 作为推送端点：

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

生产环境：使用稳定的 HTTPS 端点并配置 Pub/Sub OIDC JWT，然后运行：

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## 测试

向被监视的收件箱发送一条消息：

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

检查 watch 状态和历史记录：

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## 故障排除

- `Invalid topicName`：项目不匹配（主题不在 OAuth 客户端项目中）。
- `User not authorized`：主题缺少 `roles/pubsub.publisher`。
- 空消息：Gmail push 仅提供 `historyId`；通过 `gog gmail history` 获取。

## 清理

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
