---
summary: "透過 gogcli 將 Gmail Pub/Sub 推送介接至 OpenClaw webhook"
read_when:
  - 將 Gmail 收件匣觸發器介接至 OpenClaw
  - 為代理人喚醒設定 Pub/Sub 推送
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

目標：Gmail 監看 (watch) -> Pub/Sub 推送 -> `gog gmail watch serve` -> OpenClaw webhook。

## 前置作業

- 已安裝並登入 `gcloud` ([安裝指南](https://docs.cloud.google.com/sdk/docs/install-sdk))。
- 已安裝 `gog` (gogcli) 並取得 Gmail 帳戶授權 ([gogcli.sh](https://gogcli.sh/))。
- 已啟用 OpenClaw hook (請參閱 [Webhooks](/automation/webhook))。
- 已登入 `tailscale` ([tailscale.com](https://tailscale.com/))。支援的設定使用 Tailscale Funnel 作為公用 HTTPS 端點。
  雖然其他通道服務也可能運作，但屬於自行處理且不支援，並需要手動介接。
  目前我們僅支援 Tailscale。

Hook 設定範例（啟用 Gmail 預設集映射）：

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

若要將 Gmail 摘要遞送至對話介面，請使用設定 `deliver` + 選填的 `channel`/`to` 的映射來覆寫預設集：

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
        messageTemplate: "來自 {{messages[0].from}} 的新郵件\n主旨：{{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

如果您想要固定通道，請設定 `channel` + `to`。否則 `channel: "last"` 會使用最後一次的遞送路徑（回退至 WhatsApp）。

若要強制 Gmail 執行時使用較便宜的模型，請在映射中設定 `model`（`供應商/模型` 或別名）。如果您強制執行 `agents.defaults.models`，請將其包含在內。

若要專門為 Gmail hook 設定預設模型和思考層級，請在您的設定中加入 `hooks.gmail.model` / `hooks.gmail.thinking`：

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

- 映射中個別 hook 的 `model`/`thinking` 仍會覆寫這些預設值。
- 回退順序：`hooks.gmail.model` → `agents.defaults.model.fallbacks` → 主要模型（驗證/費率限制/逾時）。
- 如果已設定 `agents.defaults.models`，則 Gmail 模型必須在白名單內。
- 預設情況下，Gmail hook 內容會被外部內容安全邊界包覆。
  若要停用（危險），請設定 `hooks.gmail.allowUnsafeExternalContent: true`。

若要進一步自訂內容處理，請在 `hooks.transformsDir` 下新增 `hooks.mappings` 或 JS/TS 轉換模組（請參閱 [Webhooks](/automation/webhook)）。

## 精靈（推薦）

使用 OpenClaw 協助程式將一切介接起來（在 macOS 上透過 brew 安裝依賴項目）：

```bash
openclaw webhooks gmail setup \
  --account openclaw @gmail.com
```

預設值：

- 使用 Tailscale Funnel 作為公用推送端點。
- 為 `openclaw webhooks gmail run` 寫入 `hooks.gmail` 設定。
- 啟用 Gmail hook 預設集 (`hooks.presets: ["gmail"]`)。

路徑說明：啟用 `tailscale.mode` 時，OpenClaw 會自動將 `hooks.gmail.serve.path` 設定為 `/`，並將公用路徑保留在 `hooks.gmail.tailscale.path`（預設為 `/gmail-pubsub`），因為 Tailscale 在代理之前會移除設定的路徑前置詞。
如果您需要後端接收帶有前置詞的路徑，請將 `hooks.gmail.tailscale.target`（或 `--tailscale-target`）設定為完整 URL，例如 `http://127.0.0.1:8788/gmail-pubsub` 並匹配 `hooks.gmail.serve.path`。

想要自訂端點？請使用 `--push-endpoint <url>` 或 `--tailscale off`。

平台說明：在 macOS 上，精靈會透過 Homebrew 安裝 `gcloud`、`gogcli` 和 `tailscale`；在 Linux 上請先手動安裝。

Gateway 自動啟動（推薦）：

- 當 `hooks.enabled=true` 且設定了 `hooks.gmail.account` 時，Gateway 會在開機時啟動 `gog gmail watch serve` 並自動續期監看。
- 設定 `OPENCLAW_SKIP_GMAIL_WATCHER=1` 以選擇退出（如果您自行執行背景程式則很有用）。
- 請勿同時執行手動背景程式，否則會遇到 `listen tcp 127.0.0.1:8788: bind: address already in use`。

手動背景程式（啟動 `gog gmail watch serve` + 自動續期）：

```bash
openclaw webhooks gmail run
```

## 一次性設定

1. 選擇**擁有 `gog` 所使用之 OAuth 用戶端**的 GCP 專案。

```bash
gcloud auth login
gcloud config set project <project-id>
```

備註：Gmail 監看要求 Pub/Sub 主題必須與 OAuth 用戶端位於同一個專案中。

2. 啟用 API：

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. 建立主題：

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. 允許 Gmail 推送發布訊息：

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push @system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## 開始監看

```bash
gog gmail watch start \
  --account openclaw @gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

儲存輸出中的 `history_id`（用於偵錯）。

## 執行推送處理器

本地範例（共用權杖驗證）：

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

- `--token` 保護推送端點 (`x-gog-token` 或 `?token=`)。
- `--hook-url` 指向 OpenClaw `/hooks/gmail`（已映射；獨立執行並彙整摘要至主程序）。
- `--include-body` 與 `--max-bytes` 控制發送至 OpenClaw 的內文摘要。

推薦方式：`openclaw webhooks gmail run` 封裝了相同的流程並會自動續期監看。

## 公開處理器（進階，不支援）

如果您需要非 Tailscale 的通道，請手動介接並在推送訂閱中使用公用 URL（不支援，無防護機制）：

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

使用產生的 URL 作為推送端點：

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

正式環境：請使用穩定的 HTTPS 端點並設定 Pub/Sub OIDC JWT，然後執行：

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc @...>
```

## 測試

向受監看的收件匣發送訊息：

```bash
gog gmail send \
  --account openclaw @gmail.com \
  --to openclaw @gmail.com \
  --subject "watch test" \
  --body "ping"
```

檢查監看狀態與歷程記錄：

```bash
gog gmail watch status --account openclaw @gmail.com
gog gmail history --account openclaw @gmail.com --since <historyId>
```

## 疑難排解

- `Invalid topicName`：專案不匹配（主題不在 OAuth 用戶端專案中）。
- `User not authorized`：主題缺少 `roles/pubsub.publisher` 權限。
- 訊息為空：Gmail 推送僅提供 `historyId`；請透過 `gog gmail history` 擷取。

## 清理

```bash
gog gmail watch stop --account openclaw @gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
