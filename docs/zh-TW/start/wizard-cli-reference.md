---
summary: "CLI 新手導覽流程、憑證/模型設定、輸出及內部運作的完整參考指南"
read_when:
  - 您需要 openclaw onboard 的詳細行為資訊
  - 您正在偵錯新手導覽結果或整合新手導覽用戶端
title: "CLI 新手導覽參考指南"
sidebarTitle: "CLI 參考指南"
---

# CLI 新手導覽參考指南

本頁面是 `openclaw onboard` 的完整參考指南。
簡短指南請參閱 [新手導覽精靈 (CLI)](/start/wizard)。

## 精靈的功能

本機模式（預設）將引導您完成：

- 模型與憑證設定（OpenAI Code 訂閱 OAuth、Anthropic API 金鑰或設定權杖，以及 MiniMax、GLM、Moonshot 和 AI Gateway 選項）
- 工作區位置和引導 (bootstrap) 檔案
- Gateway 設定（連接埠、繫結、憑證、Tailscale）
- 頻道與供應商（Telegram、WhatsApp、Discord、Google Chat、Mattermost 外掛、Signal）
- 背景程式 (Daemon) 安裝 (LaunchAgent 或 systemd 使用者單元)
- 健康檢查
- Skills 設定

遠端模式會將此機器設定為連線到其他地方的 Gateway。
它不會在遠端主機上安裝或修改任何內容。

## 本機流程細節

<Steps>
  <Step title="偵測現有設定">
    - 如果 `~/.openclaw/openclaw.json` 已存在，請選擇保留 (Keep)、修改 (Modify) 或重設 (Reset)。
    - 重新執行精靈不會刪除任何內容，除非您明確選擇重設（或傳遞 `--reset` 參數）。
    - 如果設定無效或包含舊版鍵名，精靈會停止並要求您在繼續之前執行 `openclaw doctor`。
    - 重設會使用 `trash` 並提供以下範圍：
      - 僅設定
      - 設定 + 憑證 + 工作階段
      - 完整重設（同時移除工作區）
  </Step>
  <Step title="模型與憑證">
    - 完整選項矩陣請參閱 [憑證與模型選項](#auth-and-model-options)。
  </Step>
  <Step title="工作區">
    - 預設為 `~/.openclaw/workspace`（可自訂）。
    - 植入初次執行引導程序所需的工作區檔案。
    - 工作區配置：[智慧代理工作區](/concepts/agent-workspace)。
  </Step>
  <Step title="Gateway">
    - 提示輸入連接埠、繫結、憑證模式和 Tailscale 暴露設定。
    - 建議：即使是 local loopback 也保持權杖憑證啟用，以便本機 WS 用戶端必須進行驗證。
    - 只有在您完全信任每個本機處理程序時才停用憑證驗證。
    - 非 loopback 繫結仍需要憑證驗證。
  </Step>
  <Step title="頻道">
    - [WhatsApp](/channels/whatsapp)：可選 QR 碼登入
    - [Telegram](/channels/telegram)：機器人權杖 (bot token)
    - [Discord](/channels/discord)：機器人權杖 (bot token)
    - [Google Chat](/channels/googlechat)：服務帳戶 JSON + webhook 對象 (audience)
    - [Mattermost](/channels/mattermost) 外掛：機器人權杖 + 基礎 URL
    - [Signal](/channels/signal)：可選 `signal-cli` 安裝 + 帳戶設定
    - [BlueBubbles](/channels/bluebubbles)：建議用於 iMessage；伺服器 URL + 密碼 + webhook
    - [iMessage](/channels/imessage)：舊版 `imsg` CLI 路徑 + 資料庫存取
    - 私訊安全性：預設為配對模式。第一則私訊會傳送驗證碼；透過 `openclaw pairing approve <channel> <code>` 進行核准，或使用白名單。
  </Step>
  <Step title="背景程式安裝">
    - macOS：LaunchAgent
      - 需要已登入的使用者工作階段；若為 headless 環境，請使用自訂 LaunchDaemon（未隨附）。
    - Linux 和經由 WSL2 的 Windows：systemd 使用者單元
      - 精靈會嘗試執行 `loginctl enable-linger <user>`，使 Gateway 在登出後仍保持運作。
      - 可能會提示輸入 sudo（寫入 `/var/lib/systemd/linger`）；精靈會先嘗試不使用 sudo。
    - 執行環境選擇：Node（建議；WhatsApp 和 Telegram 為必要）。不建議使用 Bun。
  </Step>
  <Step title="健康檢查">
    - 啟動 Gateway（如果需要）並執行 `openclaw health`。
    - `openclaw status --deep` 會在狀態輸出中加入 Gateway 健康探測。
  </Step>
  <Step title="Skills">
    - 讀取可用的 Skills 並檢查其需求。
    - 讓您選擇套件管理員：npm 或 pnpm（不建議使用 Bun）。
    - 安裝選用的相依項目（在 macOS 上部分會使用 Homebrew）。
  </Step>
  <Step title="完成">
    - 總結與後續步驟，包含 iOS、Android 和 macOS 應用程式選項。
  </Step>
</Steps>

<Note>
如果未偵測到圖形介面 (GUI)，精靈會列印 Control UI 的 SSH 連接埠轉發指令，而不是開啟瀏覽器。
如果缺少 Control UI 靜態資產，精靈會嘗試建置它們；後備方案為 `pnpm ui:build`（自動安裝 UI 相依項目）。
</Note>

## 遠端模式細節

遠端模式會將此機器設定為連線到其他地方的 Gateway。

<Info>
遠端模式不會在遠端主機上安裝或修改任何內容。
</Info>

您設定的內容：

- 遠端 Gateway URL (`ws://...`)
- 如果遠端 Gateway 需要憑證，則提供權杖（建議）

<Note>
- 如果 Gateway 僅限 loopback，請使用 SSH 通道或 tailnet。
- 裝置探索提示：
  - macOS：Bonjour (`dns-sd`)
  - Linux：Avahi (`avahi-browse`)
</Note>

## 憑證與模型選項

<AccordionGroup>
  <Accordion title="Anthropic API 金鑰（建議）">
    如果存在 `ANTHROPIC_API_KEY` 則直接使用，否則提示輸入金鑰，並將其儲存供背景程式使用。
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS：檢查鑰匙圈 (Keychain) 項目 "Claude Code-credentials"
    - Linux 和 Windows：如果存在則重複使用 `~/.claude/.credentials.json`

    在 macOS 上，請選擇「永遠允許」，以免 launchd 啟動時被阻擋。

  </Accordion>
  <Accordion title="Anthropic 權杖 (貼上 setup-token)">
    在任何機器上執行 `claude setup-token`，然後貼上該權杖。
    您可以為其命名；留空則使用預設值。
  </Accordion>
  <Accordion title="OpenAI Code 訂閱 (重複使用 Codex CLI)">
    如果存在 `~/.codex/auth.json`，精靈可以重複使用它。
  </Accordion>
  <Accordion title="OpenAI Code 訂閱 (OAuth)">
    瀏覽器流程；貼上 `code#state`。

    當模型未設定或為 `openai/*` 時，將 `agents.defaults.model` 設定為 `openai-codex/gpt-5.3-codex`。

  </Accordion>
  <Accordion title="OpenAI API 金鑰">
    如果存在 `OPENAI_API_KEY` 則直接使用，否則提示輸入金鑰，並將其儲存至 `~/.openclaw/.env` 以便 launchd 讀取。

    當模型未設定、為 `openai/*` 或 `openai-codex/*` 時，將 `agents.defaults.model` 設定為 `openai/gpt-5.1-codex`。

  </Accordion>
  <Accordion title="xAI (Grok) API 金鑰">
    提示輸入 `XAI_API_KEY` 並將 xAI 設定為模型供應商。
  </Accordion>
  <Accordion title="OpenCode Zen">
    提示輸入 `OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`）。
    設定 URL：[opencode.ai/auth](https://opencode.ai/auth)。
  </Accordion>
  <Accordion title="API 金鑰（通用）">
    為您儲存金鑰。
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    提示輸入 `AI_GATEWAY_API_KEY`。
    更多詳情：[Vercel AI Gateway](/providers/vercel-ai-gateway)。
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    提示輸入帳戶 ID、Gateway ID 和 `CLOUDFLARE_AI_GATEWAY_API_KEY`。
    更多詳情：[Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)。
  </Accordion>
  <Accordion title="MiniMax M2.1">
    自動寫入設定。
    更多詳情：[MiniMax](/providers/minimax)。
  </Accordion>
  <Accordion title="Synthetic (Anthropic 相容)">
    提示輸入 `SYNTHETIC_API_KEY`。
    更多詳情：[Synthetic](/providers/synthetic)。
  </Accordion>
  <Accordion title="Moonshot 和 Kimi Coding">
    自動寫入 Moonshot (Kimi K2) 和 Kimi Coding 設定。
    更多詳情：[Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)。
  </Accordion>
  <Accordion title="自訂供應商">
    適用於 OpenAI 相容和 Anthropic 相容的端點。

    非互動式旗標：
    - `--auth-choice custom-api-key`
    - `--custom-base-url`
    - `--custom-model-id`
    - `--custom-api-key`（選用；後備至 `CUSTOM_API_KEY`）
    - `--custom-provider-id`（選用）
    - `--custom-compatibility <openai|anthropic>`（選用；預設為 `openai`）

  </Accordion>
  <Accordion title="跳過">
    不進行憑證設定。
  </Accordion>
</AccordionGroup>

模型行為：

- 從偵測到的選項中挑選預設模型，或手動輸入供應商與模型。
- 精靈會執行模型檢查，如果設定的模型未知或缺少憑證，則會發出警告。

憑證與設定檔路徑：

- OAuth 憑證：`~/.openclaw/credentials/oauth.json`
- 憑證設定檔 (API 金鑰 + OAuth)：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Headless 與伺服器提示：在有瀏覽器的機器上完成 OAuth，然後將 `~/.openclaw/credentials/oauth.json`（或 `$OPENCLAW_STATE_DIR/credentials/oauth.json`）複製到 Gateway 主機。
</Note>

## 輸出與內部運作

`~/.openclaw/openclaw.json` 中的典型欄位：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`（如果選擇 Minimax）
- `gateway.*`（模式、繫結、憑證、Tailscale）
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- 在提示期間選擇加入時的頻道白名單 (Slack, Discord, Matrix, Microsoft Teams)（名稱會盡可能解析為 ID）
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 會寫入 `agents.list[]` 和選用的 `bindings`。

WhatsApp 憑證儲存在 `~/.openclaw/credentials/whatsapp/<accountId>/`。
工作階段儲存在 `~/.openclaw/agents/<agentId>/sessions/`。

<Note>
某些頻道是以外掛形式提供的。在新手導覽期間選取時，精靈會在設定頻道之前提示安裝外掛（npm 或本機路徑）。
</Note>

Gateway 精靈 RPC：

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

用戶端（macOS 應用程式與 Control UI）可以渲染步驟，而無需重新實作新手導覽邏輯。

Signal 設定行為：

- 下載適當的發行版本資產
- 儲存在 `~/.openclaw/tools/signal-cli/<version>/`
- 在設定中寫入 `channels.signal.cliPath`
- JVM 建置需要 Java 21
- 在可用時使用原生 (Native) 建置
- Windows 使用 WSL2 並遵循 WSL 內的 Linux signal-cli 流程

## 相關文件

- 新手導覽中心：[新手導覽精靈 (CLI)](/start/wizard)
- 自動化與指令碼：[CLI 自動化](/start/wizard-cli-automation)
- 指令參考：[`openclaw onboard`](/cli/onboard)
