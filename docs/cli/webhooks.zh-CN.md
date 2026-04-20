---
summary: "`openclaw webhooks` 命令行参考（webhook 助手 + Gmail Pub/Sub）"
read_when:
  - 你想将 Gmail Pub/Sub 事件连接到 OpenClaw
  - 你想要 webhook 助手命令
title: "webhooks"
---

# `openclaw webhooks`

Webhook 助手和集成（Gmail Pub/Sub、webhook 助手）。

相关：

- Webhooks：[Webhooks](/automation/cron-jobs#webhooks)
- Gmail Pub/Sub：[Gmail Pub/Sub](/automation/cron-jobs#gmail-pubsub-integration)

## Gmail

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail run
```

### `webhooks gmail setup`

配置 Gmail 监视、Pub/Sub 和 OpenClaw webhook 传递。

必需：

- `--account <email>`

选项：

- `--project <id>`
- `--topic <name>`
- `--subscription <name>`
- `--label <label>`
- `--hook-url <url>`
- `--hook-token <token>`
- `--push-token <token>`
- `--bind <host>`
- `--port <port>`
- `--path <path>`
- `--include-body`
- `--max-bytes <n>`
- `--renew-minutes <n>`
- `--tailscale <funnel|serve|off>`
- `--tailscale-path <path>`
- `--tailscale-target <target>`
- `--push-endpoint <url>`
- `--json`

示例：

```bash
openclaw webhooks gmail setup --account you@example.com
openclaw webhooks gmail setup --account you@example.com --project my-gcp-project --json
openclaw webhooks gmail setup --account you@example.com --hook-url https://gateway.example.com/hooks/gmail
```

### `webhooks gmail run`

运行 `gog watch serve` 加上监视自动续订循环。

选项：

- `--account <email>`
- `--topic <topic>`
- `--subscription <name>`
- `--label <label>`
- `--hook-url <url>`
- `--hook-token <token>`
- `--push-token <token>`
- `--bind <host>`
- `--port <port>`
- `--path <path>`
- `--include-body`
- `--max-bytes <n>`
- `--renew-minutes <n>`
- `--tailscale <funnel|serve|off>`
- `--tailscale-path <path>`
- `--tailscale-target <target>`

示例：

```bash
openclaw webhooks gmail run --account you@example.com
```

有关端到端设置流程和操作细节，请参阅 [Gmail Pub/Sub 文档](/automation/cron-jobs#gmail-pubsub-integration)。