---
summary: "Gmail Pub/Sub push 透過 gogcli 整合到 OpenClaw webhook"
read_when:
  - 整合 Gmail 收件匣觸發器到 OpenClaw
  - 設定 Pub/Sub push 來喚醒智慧代理
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

目標：Gmail 監看 -> Pub/Sub push -> `gog gmail watch serve` -> OpenClaw webhook。

## 前置條件

- `gcloud` 已安裝並登入 ([安裝指南](https://docs.cloud.google.com/sdk/docs/install-sdk))。
- `gog` (gogcli) 已安裝並針對 Gmail 帳號授權 ([gogcli.sh](https://gogcli.sh/))。
- OpenClaw hooks 已啟用 (請參閱 [Webhooks](/automation/webhook))。
- `tailscale` 已登入 ([tailscale.com](https://tailscale.com/))。支援的設定使用 Tailscale Funnel 作為公開 HTTPS 端點。
  其他通道服務可能也能運作，但屬於自建/不支援且需要手動整合。
  目前，我們支援 Tailscale。

範例 hook 設定 (啟用 Gmail 預設映射)：

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

若要將 Gmail 摘要傳遞至聊天介面，請透過設定 `deliver` + 選用 `channel`/`to` 的映射來覆寫預設：

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
        messageTemplate: "來自 {{messages[0].from}} 的新郵件\n主旨: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

如果您想要固定的頻道，請設定 `channel` + `to`。否則 `channel: "last"`
會使用上次的傳遞路徑 (若失敗則回退到 WhatsApp)。

若要強制 Gmail 執行使用較便宜的模型，請在映射中設定 `model`
(`provider/model` 或別名)。如果您強制執行 `agents.defaults.models`，請將其包含在該處。

若要專門為 Gmail hooks 設定預設模型和思考等級，請在您的設定中新增
`hooks.gmail.model` / `hooks.gmail.thinking`：

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

備註：

- 映射中的每個 hook `model`/`thinking` 仍會覆寫這些預設值。
- 回退順序：`hooks.gmail.model` → `agents.defaults.model.fallbacks` → 主要 (auth/rate-limit/timeouts)。
- 如果設定了 `agents.defaults.models`，Gmail 模型必須在允許清單中。
- 預設情況下，Gmail hook 內容會以外部內容安全邊界包裹。
  若要停用 (危險)，請設定 `hooks.gmail.allowUnsafeExternalContent: true`。

若要進一步自訂酬載處理，請新增 `hooks.mappings` 或在 `hooks.transformsDir` 下新增 JS/TS 轉換模組
(請參閱 [Webhooks](/automation/webhook))。

## 精靈 (建議)

使用 OpenClaw 輔助工具將所有內容整合 (在 macOS 上透過 brew 安裝依賴項目)：

```bash
openclaw webhooks gmail setup \
  --account openclaw @gmail.com
```

預設值：

- 使用 Tailscale Funnel 作為公開 push 端點。
- 為 `openclaw webhooks gmail run` 寫入 `hooks.gmail` 設定。
- 啟用 Gmail hook 預設值 (`hooks.presets: ["gmail"]`)。

路徑備註：當 `tailscale.mode` 啟用時，OpenClaw 會自動將
`hooks.gmail.serve.path` 設定為 `/`，並將公開路徑保持在
`hooks.gmail.tailscale.path` (預設 `/gmail-pubsub`)，因為 Tailscale
在代理之前會剝離設定的路徑前綴。
如果您需要後端接收帶有前綴的路徑，請將
`hooks.gmail.tailscale.target` (或 `--tailscale-target`) 設定為完整的 URL，例如
`http://127.0.0.1:8788/gmail-pubsub` 並匹配 `hooks.gmail.serve.path`。

想要自訂端點？請使用 `--push-endpoint <url>` 或 `--tailscale off`。

平台備註：在 macOS 上，精靈會透過 Homebrew 安裝 `gcloud`、`gogcli` 和 `tailscale`；
在 Linux 上，請先手動安裝它們。

Gateway 自動啟動 (建議)：

- 當 `hooks.enabled=true` 且 `hooks.gmail.account` 設定時，Gateway 會在開機時啟動
  `gog gmail watch serve` 並自動續訂監看。
- 設定 `OPENCLAW_SKIP_GMAIL_WATCHER=1` 可選擇退出 (如果您自行執行守護程式會很有用)。
- 不要同時執行手動守護程式，否則會遇到
  `listen tcp 127.0.0.1:8788: bind: address already in use`。

手動守護程式 (啟動 `gog gmail watch serve` + 自動續訂)：

```bash
openclaw webhooks gmail run
```

## 一次性設定

1. 選取 `gog` 使用的 **OAuth 客戶端所屬的** GCP 專案。

```bash
gcloud auth login
gcloud config set project <project-id>
```

備註：Gmail 監看要求 Pub/Sub topic 位於與 OAuth 客戶端相同的專案中。

2. 啟用 API：

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. 建立一個 topic：

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. 允許 Gmail push 發佈：

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push @system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## 啟動監看

```bash
gog gmail watch start \
  --account openclaw @gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

儲存輸出中的 `history_id` (用於疑難排解)。

## 執行 push 處理程式

本地範例 (共享 token 驗證)：

```bash
gog gmail watch serve \
  --account openclaw @gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token OPENCLAW_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

備註：

- `--token` 保護 push 端點 (`x-gog-token` 或 `?token=`)。
- `--hook-url` 指向 OpenClaw `/hooks/gmail` (已映射；獨立執行 + 摘要至主程式)。
- `--include-body` 和 `--max-bytes` 控制傳送到 OpenClaw 的內文片段。

建議：`openclaw webhooks gmail run` 包裝了相同的流程並自動續訂監看。

## 暴露處理程式 (進階，不支援)

如果您需要非 Tailscale 的通道，請手動整合並在 push
訂閱中使用公開 URL (不支援，無防護措施)：

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

使用生成的 URL 作為 push 端點：

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

正式環境：使用穩定的 HTTPS 端點並設定 Pub/Sub OIDC JWT，然後執行：

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc @...>
```

## 測試

向受監看的收件匣傳送訊息：

```bash
gog gmail send \
  --account openclaw @gmail.com \
  --to openclaw @gmail.com \
  --subject "watch test" \
  --body "ping"
```

檢查監看狀態和歷史記錄：

```bash
gog gmail watch status --account openclaw @gmail.com
gog gmail history --account openclaw @gmail.com --since <historyId>
```

## 疑難排解

- `Invalid topicName`：專案不匹配 (topic 不在 OAuth 客戶端專案中)。
- `User not authorized`：topic 缺少 `roles/pubsub.publisher`。
- 空訊息：Gmail push 只提供 `historyId`；透過 `gog gmail history` 擷取。

## 清理

```bash
gog gmail watch stop --account openclaw @gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
