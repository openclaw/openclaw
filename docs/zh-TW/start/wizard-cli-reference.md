---
summary: "CLI新手導覽流程、憑證/模型設定、輸出及內部結構的完整參考"
read_when:
  - 您需要 `openclaw onboard` 的詳細行為說明時
  - 您正在偵錯新手導覽結果或整合新手導覽用戶端時
title: "CLI 新手導覽參考"
sidebarTitle: "CLI 參考"
---

# CLI 新手導覽參考

此頁面是 `openclaw onboard` 的完整參考。
如需簡短指南，請參閱 [新手導覽精靈 (CLI)](/start/wizard)。

## 精靈的功能

本機模式（預設）會引導您完成：

- 模型和憑證設定（OpenAI Code 訂閱 OAuth、Anthropic API 金鑰或設定權杖，以及 MiniMax、GLM、Moonshot 和 AI Gateway 選項）
- 工作區位置和引導檔案
- Gateway 設定（連接埠、綁定、憑證、tailscale）
- 頻道和供應商（Telegram、WhatsApp、Discord、Google Chat、Mattermost 外掛程式、Signal）
- 常駐程式安裝 (LaunchAgent 或 systemd 使用者單元)
- 健康檢查
- Skills 設定

遠端模式會將此機器設定為連線到其他地方的 Gateway。
它不會在遠端主機上安裝或修改任何內容。

## 本機流程細節

<Steps>
  <Step title="現有設定偵測">
    - 如果 `~/.openclaw/openclaw.json` 存在，請選擇保留、修改或重設。
    - 重新執行精靈不會清除任何內容，除非您明確選擇重設（或傳遞 `--reset`）。
    - 如果設定無效或包含舊版鍵名，精靈會停止並要求您在繼續之前執行 `openclaw doctor`。
    - 重設使用 `trash` 並提供範圍：
      - 僅限設定
      - 設定 + 憑證 + 工作階段
      - 完全重設（也會移除工作區）
  </Step>
  <Step title="模型和憑證">
    - 完整的選項矩陣在 [憑證和模型選項](#auth-and-model-options) 中。
  </Step>
  <Step title="工作區">
    - 預設 `~/.openclaw/workspace`（可設定）。
    - 植入首次執行引導儀式所需的工作區檔案。
    - 工作區佈局：[智慧代理工作區](/concepts/agent-workspace)。
  </Step>
  <Step title="Gateway">
    - 提示連接埠、綁定、憑證模式和 tailscale 暴露。
    - 建議：即使對於 local loopback 也保持權杖憑證啟用，以便本機 WS 用戶端必須進行驗證。
    - 僅在您完全信任每個本機程式時才停用憑證。
    - 非 local loopback 綁定仍需要憑證。
  </Step>
  <Step title="頻道">
    - [WhatsApp](/channels/whatsapp)：可選的 QR 登入
    - [Telegram](/channels/telegram)：bot token
    - [Discord](/channels/discord)：bot token
    - [Google Chat](/channels/googlechat)：服務帳號 JSON + webhook 觀眾
    - [Mattermost](/channels/mattermost) plugin：bot token + 基礎 URL
    - [Signal](/channels/signal)：可選的 `signal-cli` 安裝 + 帳號設定
    - [BlueBubbles](/channels/bluebubbles)：建議用於 iMessage；伺服器 URL + 密碼 + webhook
    - [iMessage](/channels/imessage)：舊版 `imsg` CLI 路徑 + 資料庫存取
    - 私訊安全性：預設為配對。第一個私訊會傳送一個代碼；透過
      `openclaw pairing approve <channel> <code>` 批准或使用允許清單。
  </Step>
  <Step title="常駐程式安裝">
    - macOS：LaunchAgent
      - 需要已登入的使用者工作階段；對於無頭模式，請使用自訂 LaunchDaemon（未隨附）。
    - 透過 WSL2 的 Linux 和 Windows：systemd 使用者單元
      - 精靈會嘗試 `loginctl enable-linger <user>`，以便 Gateway 在登出後保持運作。
      - 可能會提示輸入 sudo（寫入 `/var/lib/systemd/linger`）；它會先嘗試不使用 sudo。
    - 執行時選擇：Node（推薦；WhatsApp 和 Telegram 需要）。不推薦使用 Bun。
  </Step>
  <Step title="健康檢查">
    - 啟動 Gateway（如果需要）並執行 `openclaw health`。
    - `openclaw status --deep` 會將 Gateway 健康探測新增到狀態輸出。
  </Step>
  <Step title="Skills">
    - 讀取可用的 Skills 並檢查要求。
    - 讓您選擇節點管理器：npm 或 pnpm（不推薦使用 bun）。
    - 安裝可選依賴項（某些在 macOS 上使用 Homebrew）。
  </Step>
  <Step title="完成">
    - 摘要和後續步驟，包括 iOS、Android 和 macOS 應用程式選項。
  </Step>
</Steps>

<Note>
如果未偵測到圖形使用者介面，精靈會列印 Control UI 的 SSH 連接埠轉發說明，而不是開啟瀏覽器。
如果 Control UI 資源遺失，精靈會嘗試建置它們；備用方案是 `pnpm ui:build`（自動安裝 UI 依賴項）。
</Note>

## 遠端模式細節

遠端模式會將此機器設定為連線到其他地方的 Gateway。

<Info>
遠端模式不會在遠端主機上安裝或修改任何內容。
</Info>

您設定的內容：

- 遠端 Gateway URL (`ws://...`)
- 如果需要遠端 Gateway 憑證（推薦），則為權杖

<Note>
- 如果 Gateway 僅限於 local loopback，請使用 SSH 通道或 tailnet。
- 裝置探索提示：
  - macOS：Bonjour (`dns-sd`)
  - Linux：Avahi (`avahi-browse`)
</Note>

## 憑證和模型選項

<AccordionGroup>
  <Accordion title="Anthropic API 金鑰（推薦）">
    如果存在 `ANTHROPIC_API_KEY`，則使用它；否則提示輸入金鑰，然後將其儲存以供常駐程式使用。
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS：檢查 Keychain 項目 "Claude Code-credentials"
    - Linux 和 Windows：如果存在 `~/.claude/.credentials.json`，則重複使用它

    在 macOS 上，選擇「永遠允許」，這樣 launchd 啟動就不會被阻擋。

  </Accordion>
  <Accordion title="Anthropic 權杖（貼上 setup-token）">
    在任何機器上執行 `claude setup-token`，然後貼上權杖。
    您可以為其命名；留空則使用預設值。
  </Accordion>
  <Accordion title="OpenAI Code 訂閱（Codex CLI 重複使用）">
    如果 `~/.codex/auth.json` 存在，精靈可以重複使用它。
  </Accordion>
  <Accordion title="OpenAI Code 訂閱（OAuth）">
    瀏覽器流程；貼上 `code#state`。

    當模型未設定或為 `openai/*` 時，將 `agents.defaults.model` 設定為 `openai-codex/gpt-5.3-codex`。

  </Accordion>
  <Accordion title="OpenAI API 金鑰">
    如果存在 `OPENAI_API_KEY`，則使用它；否則提示輸入金鑰，然後將其儲存到
    `~/.openclaw/.env`，以便 launchd 可以讀取它。

    當模型未設定、`openai/*` 或 `openai-codex/*` 時，將 `agents.defaults.model` 設定為 `openai/gpt-5.1-codex`。

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
    了解詳情：[Vercel AI Gateway](/providers/vercel-ai-gateway)。
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    提示輸入帳號 ID、Gateway ID 和 `CLOUDFLARE_AI_GATEWAY_API_KEY`。
    了解詳情：[Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)。
  </Accordion>
  <Accordion title="MiniMax M2.1">
    設定會自動寫入。
    了解詳情：[MiniMax](/providers/minimax)。
  </Accordion>
  <Accordion title="Synthetic（與 Anthropic 相容）">
    提示輸入 `SYNTHETIC_API_KEY`。
    了解詳情：[Synthetic](/providers/synthetic)。
  </Accordion>
  <Accordion title="Moonshot 和 Kimi Coding">
    Moonshot (Kimi K2) 和 Kimi Coding 設定會自動寫入。
    了解詳情：[Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)。
  </Accordion>
  <Accordion title="自訂供應商">
    適用於與 OpenAI 相容和與 Anthropic 相容的端點。

    非互動式旗標：
    - `--auth-choice custom-api-key`
    - `--custom-base-url`
    - `--custom-model-id`
    - `--custom-api-key`（可選；如果未提供，則使用 `CUSTOM_API_KEY`）
    - `--custom-provider-id`（可選）
    - `--custom-compatibility <openai|anthropic>`（可選；預設 `openai`）

  </Accordion>
  <Accordion title="跳過">
    保持憑證未設定。
  </Accordion>
</AccordionGroup>

模型行為：

- 從偵測到的選項中選擇預設模型，或手動輸入供應商和模型。
- 精靈會執行模型檢查，如果設定的模型未知或缺少憑證，則會發出警告。

憑證和設定檔路徑：

- OAuth 憑證：`~/.openclaw/credentials/oauth.json`
- 憑證設定檔（API 金鑰 + OAuth）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
無頭模式和伺服器提示：在有瀏覽器的機器上完成 OAuth，然後將
`~/.openclaw/credentials/oauth.json`（或 `$OPENCLAW_STATE_DIR/credentials/oauth.json`）
複製到 Gateway 主機。
</Note>

## 輸出和內部結構

`~/.openclaw/openclaw.json` 中的典型欄位：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (if Minimax chosen)
- `gateway.*` (mode, bind, auth, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- 當您在提示期間選擇加入時的頻道允許清單（Slack、Discord、Matrix、Microsoft Teams）（名稱在可能的情況下會解析為 ID）
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 會寫入 `agents.list[]` 和可選的 `bindings`。

WhatsApp 憑證位於 `~/.openclaw/credentials/whatsapp/<accountId>/` 下。
工作階段儲存在 `~/.openclaw/agents/<agentId>/sessions/` 下。

<Note>
某些頻道以外掛程式的形式交付。在新手導覽期間選擇時，精靈會在頻道設定之前提示安裝外掛程式（npm 或本機路徑）。
</Note>

Gateway 精靈 RPC：

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

用戶端（macOS 應用程式和 Control UI）可以呈現步驟，而無需重新實作新手導覽邏輯。

Signal 設定行為：

- 下載適當的發行資產
- 將其儲存在 `~/.openclaw/tools/signal-cli/<version>/` 下
- 在設定中寫入 `channels.signal.cliPath`
- JVM 建置需要 Java 21
- 在可用時使用原生建置
- Windows 使用 WSL2 並遵循 WSL 內部的 Linux signal-cli 流程

## 相關檔案

- 新手導覽中心：[新手導覽精靈 (CLI)](/start/wizard)
- 自動化和指令碼：[CLI 自動化](/start/wizard-cli-automation)
- 指令參考：[`openclaw onboard`](/cli/onboard)
