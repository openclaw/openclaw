---
summary: Gmail Pub/Sub push wired into OpenClaw webhooks via gogcli
read_when:
  - Wiring Gmail inbox triggers to OpenClaw
  - Setting up Pub/Sub push for agent wake
title: Gmail PubSub
---

# Gmail Pub/Sub -> OpenClaw

目標：Gmail 監控 -> Pub/Sub 推送 -> `gog gmail watch serve` -> OpenClaw webhook。

## Prereqs

- `gcloud` 已安裝並登入 ([安裝指南](https://docs.cloud.google.com/sdk/docs/install-sdk))。
- `gog` (gogcli) 已安裝並授權用於 Gmail 帳戶 ([gogcli.sh](https://gogcli.sh/))。
- OpenClaw 鉤子已啟用 (請參見 [Webhooks](/automation/webhook))。
- `tailscale` 已登入 ([tailscale.com](https://tailscale.com/))。支援的設置使用 Tailscale Funnel 作為公共 HTTPS 端點。
  其他隧道服務可以運作，但屬於 DIY/不支援，並需要手動連接。
  目前，我們支援 Tailscale。

範例掛鉤設定（啟用 Gmail 預設映射）：

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

要將 Gmail 摘要傳送到聊天介面，請使用一個映射來覆蓋預設設定，該映射設置 `deliver` + 可選的 `channel`/`to`:

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

如果您想要固定的頻道，請設定 `channel` + `to`。否則 `channel: "last"` 將使用最後的傳遞路徑（回退到 WhatsApp）。

要強制使用較便宜的 Gmail 模型，請在映射中設置 `model` (`provider/model` 或別名)。如果您強制執行 `agents.defaults.models`，請將其包含在那裡。

要為 Gmail hooks 設定預設模型和思考層級，請在您的設定中添加 `hooks.gmail.model` / `hooks.gmail.thinking`：

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

Notes:

- 每個 hook `model`/`thinking` 在映射中仍然會覆蓋這些預設值。
- 回退順序：`hooks.gmail.model` → `agents.defaults.model.fallbacks` → 主要 (auth/rate-limit/timeouts)。
- 如果 `agents.defaults.models` 被設定，Gmail 模型必須在允許清單中。
- Gmail hook 內容預設被包裹在外部內容安全邊界內。
  若要禁用（危險），請設定 `hooks.gmail.allowUnsafeExternalContent: true`。

要進一步自訂有效載荷處理，請在 `~/.openclaw/hooks/transforms` 下添加 `hooks.mappings` 或一個 JS/TS 轉換模組（請參見 [Webhooks](/automation/webhook)）。

## Wizard (推薦)

使用 OpenClaw 幫助工具將所有內容連接起來（透過 brew 在 macOS 上安裝依賴項）：

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

Defaults:

- 使用 Tailscale Funnel 作為公共推送端點。
- 為 `openclaw webhooks gmail run` 寫入 `hooks.gmail` 設定。
- 啟用 Gmail 鉤子預設 (`hooks.presets: ["gmail"]`)。

路徑說明：當 `tailscale.mode` 被啟用時，OpenClaw 會自動將 `hooks.gmail.serve.path` 設定為 `/`，並保持公開路徑為 `hooks.gmail.tailscale.path`（預設為 `/gmail-pubsub`），因為 Tailscale 在代理之前會去除設定的路徑前綴。如果您需要後端接收帶前綴的路徑，請將 `hooks.gmail.tailscale.target`（或 `--tailscale-target`）設置為完整的 URL，例如 `http://127.0.0.1:8788/gmail-pubsub`，並匹配 `hooks.gmail.serve.path`。

想要自訂端點嗎？使用 `--push-endpoint <url>` 或 `--tailscale off`。

平台說明：在 macOS 上，精靈透過 Homebrew 安裝 `gcloud`、`gogcli` 和 `tailscale`；在 Linux 上，請先手動安裝它們。

Gateway 自動啟動（建議）：

- 當 `hooks.enabled=true` 和 `hooks.gmail.account` 被設定時，Gateway 會在啟動時開始 `gog gmail watch serve` 並自動更新監控。
- 設定 `OPENCLAW_SKIP_GMAIL_WATCHER=1` 以選擇退出（如果你自己執行守護進程，這會很有用）。
- 不要同時執行手動守護進程，否則你會遇到 `listen tcp 127.0.0.1:8788: bind: address already in use`。

手動守護進程（啟動 `gog gmail watch serve` + 自動續期）：

```bash
openclaw webhooks gmail run
```

## 一次性設置

1. 選擇擁有 `gog` 所使用的 OAuth 用戶端的 GCP 專案。

```bash
gcloud auth login
gcloud config set project <project-id>
```

注意：Gmail 監控需要 Pub/Sub 主題與 OAuth 用戶端位於同一專案中。

2. 啟用 API:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. 創建主題：

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. 允許 Gmail 推送發佈：

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## 開始監控

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

保存 `history_id` 以便於輸出（用於除錯）。

## 執行推送處理程序

[[BLOCK_N]] Local example (shared token auth): [[BLOCK_N]]

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

Notes:

- `--token` 保護推送端點 (`x-gog-token` 或 `?token=`)。
- `--hook-url` 指向 OpenClaw `/hooks/gmail`（已映射；隔離執行 + 摘要到主程式）。
- `--include-body` 和 `--max-bytes` 控制發送到 OpenClaw 的主體片段。

建議：`openclaw webhooks gmail run` 包裝了相同的流程並自動續訂手錶。

## Expose the handler (advanced, unsupported)

如果您需要一個非 Tailscale 隧道，請手動設置並在推送訂閱中使用公共 URL（不受支援，沒有保護措施）：

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

使用生成的 URL 作為推送端點：

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

Production: 使用穩定的 HTTPS 端點並設定 Pub/Sub OIDC JWT，然後執行：

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Test

發送訊息到監控的收件箱：

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

檢查手錶狀態和歷史：

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## 故障排除

- `Invalid topicName`: 專案不匹配（主題不在 OAuth 用戶端專案中）。
- `User not authorized`: 主題上缺少 `roles/pubsub.publisher`。
- 空訊息：Gmail 推送僅提供 `historyId`；請透過 `gog gmail history` 進行擷取。

## Cleanup

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
