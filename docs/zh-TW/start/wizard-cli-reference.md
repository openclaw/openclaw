---
summary: >-
  Complete reference for CLI onboarding flow, auth/model setup, outputs, and
  internals
read_when:
  - You need detailed behavior for openclaw onboard
  - You are debugging onboarding results or integrating onboarding clients
title: CLI Onboarding Reference
sidebarTitle: CLI reference
---

# CLI 新手引導參考

本頁為 `openclaw onboard` 的完整參考說明。
簡易指南請參考 [新手引導精靈 (CLI)](/start/wizard)。

## 精靈功能說明

本地模式（預設）會引導您完成：

- 模型與認證設定（OpenAI Code 訂閱 OAuth、Anthropic API 金鑰或設定 token，還有 MiniMax、GLM、Ollama、Moonshot 及 AI Gateway 選項）
- 工作區位置與啟動檔案
- Gateway 設定（埠號、綁定、認證、tailscale）
- 通道與提供者（Telegram、WhatsApp、Discord、Google Chat、Mattermost 插件、Signal）
- 守護程序安裝（LaunchAgent 或 systemd 使用者單元）
- 健康檢查
- 技能設定

遠端模式則是設定此機器連接到其他地方的 gateway。
不會在遠端主機上安裝或修改任何東西。

## 本地流程詳情

<Steps>
  <Step title="現有設定偵測">
    - 若 `~/.openclaw/openclaw.json` 存在，選擇保留、修改或重置。
    - 重新執行精靈不會清除任何東西，除非您明確選擇重置（或傳入 `--reset`）。
    - CLI `--reset` 預設為 `config+creds+sessions`；使用 `--reset-scope full` 可同時移除工作區。
    - 若設定無效或包含舊版金鑰，精靈會停止並要求您先執行 `openclaw doctor` 再繼續。
    - 重置使用 `trash`，並提供範圍選擇：
      - 僅設定檔
      - 設定檔 + 憑證 + 會話
      - 完全重置（同時移除工作區）
  </Step>
  <Step title="模型與認證">
    - 完整選項矩陣請參考 [認證與模型選項](#auth-and-model-options)。
  </Step>
  <Step title="工作區">
    - 預設 `~/.openclaw/workspace`（可設定）。
    - 會初始化工作區檔案，供首次啟動儀式使用。
    - 工作區結構詳見：[Agent 工作區](/concepts/agent-workspace)。
  </Step>
  <Step title="Gateway">
    - 會提示設定埠號、綁定、認證模式及 tailscale 曝露。
    - 建議：即使是 loopback 也保持 token 認證啟用，讓本地 WS 用戶端必須驗證。
    - token 模式下，互動式新手引導提供：
      - **產生/儲存純文字 token**（預設）
      - **使用 SecretRef**（選擇性）
    - 密碼模式下，互動式新手引導也支援純文字或 SecretRef 儲存。
    - 非互動式 token SecretRef 路徑：`--gateway-token-ref-env <ENV_VAR>`。
      - 需在新手引導執行環境中有非空環境變數。
      - 不可與 `--gateway-token` 同時使用。
    - 僅當您完全信任所有本地程序時，才可停用認證。
    - 非 loopback 綁定仍需認證。
  </Step>
  <Step title="通道">
    - [WhatsApp](/channels/whatsapp)：可選 QR 登入
    - [Telegram](/channels/telegram)：機器人 token
    - [Discord](/channels/discord)：機器人 token
    - [Google Chat](/channels/googlechat)：服務帳號 JSON + webhook 受眾
    - [Mattermost](/channels/mattermost) 插件：機器人 token + 基本 URL
    - [Signal](/channels/signal)：可選 `signal-cli` 安裝 + 帳號設定
    - [BlueBubbles](/channels/bluebubbles)：推薦用於 iMessage；伺服器 URL + 密碼 + webhook
    - [iMessage](/channels/imessage)：舊版 `imsg` CLI 路徑 + 資料庫存取
    - 私訊安全：預設為配對。首次私訊會發送程式碼；可透過 `openclaw pairing approve <channel> <code>` 批准或使用允許清單。
  </Step>
  <Step title="守護程序安裝">
    - macOS：LaunchAgent
      - 需登入使用者會話；無頭環境請使用自訂 LaunchDaemon（未內建）。
    - Linux 與 Windows（WSL2）：systemd 使用者單元
      - 精靈會嘗試 `loginctl enable-linger <user>`，確保 gateway 登出後仍持續運作。
      - 可能會提示 sudo（寫入 `/var/lib/systemd/linger`）；會先嘗試不使用 sudo。
    - 執行環境選擇：Node（推薦；WhatsApp 和 Telegram 必須）。不建議使用 Bun。
  </Step>
  <Step title="健康檢查">
    - 啟動 gateway（如有需要）並執行 `openclaw health`。
    - `openclaw status --deep` 會將 gateway 健康探針加入狀態輸出。
  </Step>
  <Step title="技能">
    - 讀取可用技能並檢查需求。
    - 讓您選擇節點管理器：npm 或 pnpm（不建議 Bun）。
    - 安裝選用依賴（部分在 macOS 使用 Homebrew）。
  </Step>
  <Step title="完成">
    - 摘要與後續步驟，包括 iOS、Android 及 macOS 應用選項。
  </Step>
</Steps>

<Note>
若未偵測到 GUI，精靈會列印 SSH 端口轉發指令以使用 Control UI，並不會自動開啟瀏覽器。
若 Control UI 資源缺失，精靈會嘗試建置；備用方案為 `pnpm ui:build`（自動安裝 UI 依賴）。
</Note>

## 遠端模式詳情

遠端模式設定此機器連接到其他地方的 gateway。

<Info>
遠端模式不會在遠端主機上安裝或修改任何東西。
</Info>

您需要設定：

- 遠端 gateway URL (`ws://...`)
- 若遠端 gateway 需要認證，則提供 token（建議）

<Note>
- 若 gateway 僅限 loopback，請使用 SSH 隧道或 tailnet。
- 發現提示：
  - macOS：Bonjour (`dns-sd`)
  - Linux：Avahi (`avahi-browse`)
</Note>

## 認證與模型選項

<AccordionGroup>
  <Accordion title="Anthropic API 金鑰">
    如果存在 `ANTHROPIC_API_KEY` 則使用，否則提示輸入金鑰，並儲存以供 daemon 使用。
  </Accordion>
  <Accordion title="Anthropic OAuth（Claude Code CLI）">
    - macOS：檢查 Keychain 專案「Claude Code-credentials」
    - Linux 和 Windows：如果存在則重用 `~/.claude/.credentials.json`

在 macOS 上，請選擇「Always Allow」，以免 launchd 啟動時被阻擋。

</Accordion>
  <Accordion title="Anthropic token（setup-token 貼上）">
    在任一機器上執行 `claude setup-token`，然後貼上 token。
    你可以命名；留空則使用預設名稱。
  </Accordion>
  <Accordion title="OpenAI Code 訂閱（Codex CLI 重用）">
    如果存在 `~/.codex/auth.json`，精靈可重用它。
  </Accordion>
  <Accordion title="OpenAI Code 訂閱（OAuth）">
    瀏覽器流程；貼上 `code#state`。

當模型未設定或為 `openai/*` 時，將 `agents.defaults.model` 設為 `openai-codex/gpt-5.4`。

</Accordion>
  <Accordion title="OpenAI API 金鑰">
    如果存在 `OPENAI_API_KEY` 則使用，否則提示輸入金鑰，並將憑證儲存在認證設定檔中。

當模型未設定、為 `openai/*` 或 `openai-codex/*` 時，將 `agents.defaults.model` 設為 `openai/gpt-5.1-codex`。

</Accordion>
  <Accordion title="xAI (Grok) API 金鑰">
    提示輸入 `XAI_API_KEY`，並將 xAI 設定為模型提供者。
  </Accordion>
  <Accordion title="OpenCode">
    提示輸入 `OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`），並讓你選擇 Zen 或 Go 目錄。
    設定網址：[opencode.ai/auth](https://opencode.ai/auth)。
  </Accordion>
  <Accordion title="API 金鑰（通用）">
    幫你儲存金鑰。
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    提示輸入 `AI_GATEWAY_API_KEY`。
    詳細資訊：[Vercel AI Gateway](/providers/vercel-ai-gateway)。
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    提示輸入帳戶 ID、gateway ID 和 `CLOUDFLARE_AI_GATEWAY_API_KEY`。
    詳細資訊：[Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)。
  </Accordion>
  <Accordion title="MiniMax M2.5">
    設定會自動寫入。
    詳細資訊：[MiniMax](/providers/minimax)。
  </Accordion>
  <Accordion title="Synthetic（Anthropic 相容）">
    提示輸入 `SYNTHETIC_API_KEY`。
    詳細資訊：[Synthetic](/providers/synthetic)。
  </Accordion>
  <Accordion title="Ollama（雲端與本地開放模型）">
    提示輸入基底 URL（預設 `http://127.0.0.1:11434`），然後提供雲端 + 本地或僅本地模式選擇。
    會偵測可用模型並建議預設值。
    詳細資訊：[Ollama](/providers/ollama)。
  </Accordion>
  <Accordion title="Moonshot 與 Kimi Coding">
    Moonshot（Kimi K2）與 Kimi Coding 設定會自動寫入。
    詳細資訊：[Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)。
  </Accordion>
  <Accordion title="自訂提供者">
    支援 OpenAI 相容與 Anthropic 相容的端點。

互動式入門支援與其他提供者 API 金鑰流程相同的金鑰儲存選項：- **立即貼上 API 金鑰**（純文字）- **使用秘密參考**（環境變數參考或已設定的提供者參考，含預檢驗證）

非互動式旗標：- `--auth-choice custom-api-key` - `--custom-base-url` - `--custom-model-id` - `--custom-api-key`（可選；若無則回退至 `CUSTOM_API_KEY`）- `--custom-provider-id`（可選）- `--custom-compatibility <openai|anthropic>`（可選；預設 `openai`）

</Accordion>
  <Accordion title="跳過">
    不設定認證。
  </Accordion>
</AccordionGroup>

模型行為：

- 從偵測到的選項中挑選預設模型，或手動輸入提供者與模型。
- 精靈會執行模型檢查，並在設定的模型未知或缺少認證時發出警告。

憑證與設定檔路徑：

- OAuth 憑證：`~/.openclaw/credentials/oauth.json`
- 認證設定檔（API 金鑰 + OAuth）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

憑證儲存模式：

- 預設的上線行為會將 API 金鑰以純文字形式保存在認證設定檔中。
- `--secret-input-mode ref` 啟用參考模式，取代純文字金鑰儲存。
  在互動式上線時，你可以選擇：
  - 環境變數參考（例如 `keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" }`）
  - 已設定的提供者參考（`file` 或 `exec`），使用提供者別名 + ID
- 互動式參考模式會在儲存前執行快速的預檢驗證。
  - 環境變數參考：驗證變數名稱及當前上線環境中非空值。
  - 提供者參考：驗證提供者設定並解析請求的 ID。
  - 若預檢驗證失敗，上線程序會顯示錯誤並允許重試。
- 非互動模式下，`--secret-input-mode ref` 僅支援環境變數。
  - 在上線過程環境中設定提供者環境變數。
  - 內嵌金鑰旗標（例如 `--openai-api-key`）需要該環境變數已設定，否則上線會快速失敗。
  - 對於自訂提供者，非互動 `ref` 模式會將 `models.providers.<id>.apiKey` 儲存為 `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`。
  - 在該自訂提供者情況下，`--custom-api-key` 需要設定 `CUSTOM_API_KEY`，否則上線會快速失敗。
- Gateway 認證憑證在互動式上線支援純文字與 SecretRef 選項：
  - Token 模式：**產生/儲存純文字 token**（預設）或 **使用 SecretRef**。
  - 密碼模式：純文字或 SecretRef。
- 非互動 token SecretRef 路徑：`--gateway-token-ref-env <ENV_VAR>`。
- 既有的純文字設定繼續照常運作。

<Note>
無頭與伺服器提示：請在有瀏覽器的機器上完成 OAuth，然後將
`~/.openclaw/credentials/oauth.json`（或 `$OPENCLAW_STATE_DIR/credentials/oauth.json`）
複製到 gateway 主機。
</Note>

## 輸出與內部結構

`~/.openclaw/openclaw.json` 中的典型欄位：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`（若選擇 Minimax）
- `tools.profile`（本地上線若未設定，預設為 `"coding"`；既有明確值會保留）
- `gateway.*`（模式、綁定、認證、tailscale）
- `session.dmScope`（本地上線若未設定，預設為 `per-channel-peer`；既有明確值會保留）
- `channels.telegram.botToken`、`channels.discord.token`、`channels.signal.*`、`channels.imessage.*`
- 頻道允許清單（Slack、Discord、Matrix、Microsoft Teams），在提示時選擇加入（名稱會盡可能解析為 ID）
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 會寫入 `agents.list[]` 及可選的 `bindings`。

WhatsApp 憑證放在 `~/.openclaw/credentials/whatsapp/<accountId>/`。
會話則儲存在 `~/.openclaw/agents/<agentId>/sessions/`。

<Note>
部分頻道以外掛形式提供。當在上線時選擇，精靈會提示先安裝外掛（npm 或本地路徑），然後才進行頻道設定。
</Note>

Gateway 精靈 RPC：

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

用戶端（macOS 應用程式與控制介面）可以呈現步驟，而無需重新實作上線邏輯。

Signal 設定行為：

- 下載對應的發行資產
- 儲存在 `~/.openclaw/tools/signal-cli/<version>/`
- 在設定中寫入 `channels.signal.cliPath`
- JVM 版本需 Java 21
- 優先使用原生版本
- Windows 使用 WSL2，並在 WSL 內遵循 Linux signal-cli 流程

## 相關文件

- 新手引導中心：[新手引導精靈 (CLI)](/start/wizard)
- 自動化與腳本：[CLI 自動化](/start/wizard-cli-automation)
- 指令參考：[`openclaw onboard`](/cli/onboard)
