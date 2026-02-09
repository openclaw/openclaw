---
summary: "透過 gogcli 將 Gmail Pub/Sub 推送接線至 OpenClaw Webhooks"
read_when:
  - 將 Gmail 收件匣觸發器接線至 OpenClaw
  - 設定用於代理程式喚醒的 Pub/Sub 推送
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

目標：Gmail watch -> Pub/Sub push -> `gog gmail watch serve` -> OpenClaw webhook。

## Prereqs

- 已安裝並登入 `gcloud`（[安裝指南](https://docs.cloud.google.com/sdk/docs/install-sdk)）。
- 已安裝並授權 Gmail 帳戶使用的 `gog`（gogcli）（[gogcli.sh](https://gogcli.sh/)）。
- 已啟用 OpenClaw hooks（請參閱 [Webhooks](/automation/webhook)）。
- `tailscale` 已登入（[tailscale.com](https://tailscale.com/)）。 支援的設定使用 Tailscale Funnel 作為公開的 HTTPS 端點。
  其他通道服務也可行，但屬於 DIY／未支援，且需要手動設定。
  目前我們支援的是 Tailscale。

範例 hook 設定（啟用 Gmail 預設對應）：

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

若要將 Gmail 摘要傳送到聊天介面，請以設定對應覆寫預設，
並設定 `deliver` + 選用的 `channel`/`to`：

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

如果你想要固定的頻道，請設定 `channel` + `to`。 若要固定頻道，請設定 `channel` + `to`。否則 `channel: "last"`
會使用最後一次的傳送路由（回退至 WhatsApp）。

若要在 Gmail 執行時強制使用較便宜的模型，請在對應中設定 `model`
（`provider/model` 或別名）。如果你強制 `agents.defaults.models`，也請在此加入。 如果你強制使用 `agents.defaults.models`，請在那裡包含它。

若要專門為 Gmail hooks 設定預設模型與思考層級，請在設定中加入
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

注意事項：

- 對應表中每個 hook 的 `model`／`thinking` 仍會覆寫這些預設值。
- 回退順序：`hooks.gmail.model` → `agents.defaults.model.fallbacks` → 主要（驗證／速率限制／逾時）。
- 若已設定 `agents.defaults.models`，Gmail 模型必須在允許清單中。
- Gmail hook 的內容預設會以外部內容安全邊界包裹。
  若要停用（有風險），請設定 `hooks.gmail.allowUnsafeExternalContent: true`。

若要進一步自訂 payload 處理，請加入 `hooks.mappings` 或在
`hooks.transformsDir` 下放置 JS/TS 轉換模組（請參閱 [Webhooks](/automation/webhook)）。

## Wizard（建議）

使用 OpenClaw 輔助工具將所有項目接線完成（在 macOS 上透過 brew 安裝相依套件）：

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

預設值：

- 使用 Tailscale Funnel 作為公開推送端點。
- 為 `openclaw webhooks gmail run` 寫入 `hooks.gmail` 設定。
- 啟用 Gmail hook 預設集（`hooks.presets: ["gmail"]`）。

路徑說明：當啟用 `tailscale.mode` 時，OpenClaw 會自動將
`hooks.gmail.serve.path` 設為 `/`，並將公開路徑維持在
`hooks.gmail.tailscale.path`（預設 `/gmail-pubsub`），因為 Tailscale
在代理前會移除設定的路徑前綴。
如果你需要後端接收帶有前綴的路徑，請將
`hooks.gmail.tailscale.target`（或 `--tailscale-target`）設定為完整 URL，例如
`http://127.0.0.1:8788/gmail-pubsub`，並對應 `hooks.gmail.serve.path`。
如果你需要後端接收帶前綴的路徑，請將
`hooks.gmail.tailscale.target`（或 `--tailscale-target`）設定為完整的 URL，例如
`http://127.0.0.1:8788/gmail-pubsub`，並與 `hooks.gmail.serve.path` 相符。

想要自訂端點嗎？ 想要自訂端點？請使用 `--push-endpoint <url>` 或 `--tailscale off`。

平台說明：在 macOS 上，精靈會透過 Homebrew 安裝 `gcloud`、`gogcli` 與 `tailscale`；
在 Linux 上請先手動安裝。

Gateway 自動啟動（建議）：

- 當設定 `hooks.enabled=true` 且 `hooks.gmail.account` 已設定時，Gateway 會在開機時啟動
  `gog gmail watch serve` 並自動續期 watch。
- 設定 `OPENCLAW_SKIP_GMAIL_WATCHER=1` 以選擇退出（若你自行執行守護程式時很有用）。
- 請勿同時執行手動守護程式，否則會遇到
  `listen tcp 127.0.0.1:8788: bind: address already in use`。

手動守護程式（啟動 `gog gmail watch serve` + 自動續期）：

```bash
openclaw webhooks gmail run
```

## 一次性設定

1. 選擇 **擁有 OAuth 用戶端** 的 GCP 專案，該用戶端由 `gog` 使用。

```bash
gcloud auth login
gcloud config set project <project-id>
```

注意：Gmail watch 需要 Pub/Sub 主題位於與 OAuth 用戶端相同的專案中。

2. 啟用 API：

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. 建立主題：

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. 允許 Gmail 推送發佈：

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## 啟動 watch

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

請從輸出中保存 `history_id`（用於除錯）。

## 執行推送處理器

本地範例（共用權杖驗證）：

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

注意事項：

- `--token` 會保護推送端點（`x-gog-token` 或 `?token=`）。
- `--hook-url` 指向 OpenClaw `/hooks/gmail`（已對應；隔離執行 + 將摘要送至主流程）。
- `--include-body` 與 `--max-bytes` 會控制送往 OpenClaw 的本文片段。

建議：`openclaw webhooks gmail run` 會包裝相同流程並自動續期 watch。

## 對外公開處理器（進階，未受支援）

若你需要非 Tailscale 的通道，請手動接線並在推送訂閱中使用公開 URL
（未受支援，無防護機制）：

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

使用產生的 URL 作為推送端點：

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

正式環境：使用穩定的 HTTPS 端點並設定 Pub/Sub OIDC JWT，然後執行：

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## 測試

向受監看的收件匣傳送一封訊息：

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

檢查 watch 狀態與歷史紀錄：

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## 疑難排解

- `Invalid topicName`：專案不相符（主題不在 OAuth 用戶端專案中）。
- `User not authorized`：主題缺少 `roles/pubsub.publisher`。
- 空訊息：Gmail 推送僅提供 `historyId`；請透過 `gog gmail history` 擷取。

## 清理

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
