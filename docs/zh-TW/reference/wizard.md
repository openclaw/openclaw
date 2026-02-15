```
---
summary: "CLI 新手導覽精靈的完整參考：每個步驟、旗標和設定欄位"
read_when:
  - 查詢特定的精靈步驟或旗標
  - 使用非互動模式自動執行新手導覽
  - 偵錯精靈行為
title: "新手導覽精靈參考"
sidebarTitle: "精靈參考"
---

# 新手導覽精靈參考

這是 `openclaw onboard` CLI 精靈的完整參考。
如需高階概述，請參閱 [新手導覽精靈](/start/wizard)。

## 流程細節 (local mode)

<Steps>
  <Step title="現有設定偵測">
    - 如果 `~/.openclaw/openclaw.json` 存在，請選擇 **保留 / 修改 / 重設**。
    - 重新執行精靈**不會**清除任何內容，除非您明確選擇 **重設**
      (或傳遞 `--reset`)。
    - 如果設定無效或包含舊版鍵名，精靈將停止並要求您在繼續之前執行 `openclaw doctor`。
    - 重設使用 `trash` (絕不使用 `rm`) 並提供範圍：
      - 僅設定
      - 設定 + 憑證 + 工作階段
      - 完全重設 (同時移除 workspace)
  </Step>
  <Step title="模型/憑證">
    - **Anthropic API key (建議)**：如果存在則使用 `ANTHROPIC_API_KEY`，否則會提示輸入金鑰，然後將其儲存供 daemon 使用。
    - **Anthropic OAuth (Claude Code CLI)**：在 macOS 上，精靈會檢查 Keychain 項目「Claude Code-credentials」(選擇「永遠允許」，這樣 launchd 啟動不會被阻擋)；在 Linux/Windows 上，如果 `~/.claude/.credentials.json` 存在，則會重複使用。
    - **Anthropic token (貼上 setup-token)**：在任何機器上執行 `claude setup-token`，然後貼上 token (您可以為其命名；空白 = 預設)。
    - **OpenAI Code (Codex) 訂閱 (Codex CLI)**：如果 `~/.codex/auth.json` 存在，精靈可以重複使用它。
    - **OpenAI Code (Codex) 訂閱 (OAuth)**：瀏覽器流程；貼上 `code#state`。
      - 當模型未設定或為 `openai/*` 時，將 `agents.defaults.model` 設定為 `openai-codex/gpt-5.2`。
    - **OpenAI API key**：如果存在則使用 `OPENAI_API_KEY`，否則會提示輸入金鑰，然後將其儲存到 `~/.openclaw/.env`，以便 launchd 可以讀取它。
    - **xAI (Grok) API key**：提示輸入 `XAI_API_KEY` 並將 xAI 設定為模型供應商。
    - **OpenCode Zen (多模型代理)**：提示輸入 `OPENCODE_API_KEY` (或 `OPENCODE_ZEN_API_KEY`，可從 https://opencode.ai/auth 取得)。
    - **API key**：為您儲存金鑰。
    - **Vercel AI Gateway (多模型代理)**：提示輸入 `AI_GATEWAY_API_KEY`。
    - 更多細節：[Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**：提示輸入 Account ID、Gateway ID 和 `CLOUDFLARE_AI_GATEWAY_API_KEY`。
    - 更多細節：[Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**：設定自動寫入。
    - 更多細節：[MiniMax](/providers/minimax)
    - **Synthetic (Anthropic 相容)**：提示輸入 `SYNTHETIC_API_KEY`。
    - 更多細節：[Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**：設定自動寫入。
    - **Kimi Coding**：設定自動寫入。
    - 更多細節：[Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **跳過**：尚未設定憑證。
    - 從偵測到的選項中選擇一個預設模型 (或手動輸入供應商/模型)。
    - 精靈會執行模型檢查，如果設定的模型未知或缺少憑證，則會發出警告。
    - OAuth 憑證儲存在 `~/.openclaw/credentials/oauth.json` 中；憑證設定檔儲存在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` 中 (API key + OAuth)。
    - 更多細節：[/concepts/oauth](/concepts/oauth)
    <Note>
    無頭/伺服器提示：在具有瀏覽器的機器上完成 OAuth，然後將
    `~/.openclaw/credentials/oauth.json` (或 `$OPENCLAW_STATE_DIR/credentials/oauth.json`) 複製到
    Gateway 主機。
    </Note>
  </Step>
  <Step title="Workspace">
    - 預設 `~/.openclaw/workspace` (可設定)。
    - 為智慧代理啟動儀式提供所需的 workspace 檔案。
    - 完整的 workspace 配置 + 備份指南：[Agent workspace](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - 連接埠、綁定、憑證模式、Tailscale 暴露。
    - 憑證建議：即使是 local loopback 也保留 **Token**，這樣 local WS 客戶端必須進行憑證。
    - 僅在您完全信任每個 local process 時才禁用憑證。
    - 非 local loopback 綁定仍需要憑證。
  </Step>
  <Step title="頻道">
    - [WhatsApp](/channels/whatsapp)：可選的 QR 登入。
    - [Telegram](/channels/telegram)：bot token。
    - [Discord](/channels/discord)：bot token。
    - [Google Chat](/channels/googlechat)：服務帳戶 JSON + webhook audience。
    - [Mattermost](/channels/mattermost) (外掛程式)：bot token + 基礎 URL。
    - [Signal](/channels/signal)：可選的 `signal-cli` 安裝 + 帳戶設定。
    - [BlueBubbles](/channels/bluebubbles)：**建議用於 iMessage**；伺服器 URL + 密碼 + webhook。
    - [iMessage](/channels/imessage)：舊版 `imsg` CLI 路徑 + DB 存取。
    - 私訊安全性：預設為配對。第一個私訊會傳送一個代碼；透過 `openclaw pairing approve <channel> <code>` 或使用允許列表來批准。
  </Step>
  <Step title="Daemon 安裝">
    - macOS：LaunchAgent
      - 需要已登入的使用者工作階段；對於無頭模式，請使用自訂 LaunchDaemon (未隨附)。
    - Linux (和透過 WSL2 的 Windows)：systemd user unit
      - 精靈會嘗試透過 `loginctl enable-linger <user>` 啟用 lingering，以便 Gateway 在登出後保持運行。
      - 可能會提示輸入 sudo (寫入 `/var/lib/systemd/linger`)；它會先嘗試不使用 sudo。
    - **執行期選擇**：Node (建議；WhatsApp/Telegram 需要)。不**建議**使用 Bun。
  </Step>
  <Step title="健康檢查">
    - 啟動 Gateway (如果需要) 並執行 `openclaw health`。
    - 提示：`openclaw status --deep` 會將 Gateway 健康探測新增到狀態輸出 (需要可連線的 Gateway)。
  </Step>
  <Step title="Skills (建議)">
    - 讀取可用的 Skills 並檢查需求。
    - 讓您選擇一個 node manager：**npm / pnpm** (不建議使用 bun)。
    - 安裝可選的依賴項 (某些在 macOS 上使用 Homebrew)。
  </Step>
  <Step title="完成">
    - 摘要 + 後續步驟，包括用於額外功能的 iOS/Android/macOS 應用程式。
  </Step>
</Steps>

<Note>
如果未偵測到 GUI，精靈會印出 SSH 連接埠轉發 Control UI 的指示，而不是打開瀏覽器。
如果 Control UI 資源遺失，精靈會嘗試建置它們；備用方案是 `pnpm ui:build` (自動安裝 UI 依賴項)。
</Note>

## 非互動模式

使用 `--non-interactive` 自動化或編寫新手導覽指令碼：

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

新增 `--json` 以獲取機器可讀的摘要。

<Note>
`--json` **不**代表非互動模式。對於指令碼，請使用 `--non-interactive` (和 `--workspace`)。
</Note>

<AccordionGroup>
  <Accordion title="Gemini 範例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI 範例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway 範例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway 範例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot 範例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic 範例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen 範例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### 新增智慧代理 (非互動)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway 精靈 RPC

Gateway 透過 RPC 暴露精靈流程 (`wizard.start`、`wizard.next`、`wizard.cancel`、`wizard.status`)。
客戶端 (macOS 應用程式、Control UI) 可以渲染步驟，而無需重新實現新手導覽邏輯。

## Signal 設定 (signal-cli)

精靈可以從 GitHub Releases 安裝 `signal-cli`：

- 下載適當的發布資源。
- 將其儲存在 `~/.openclaw/tools/signal-cli/<version>/` 下。
- 將 `channels.signal.cliPath` 寫入您的設定。

注意事項：

- JVM build 需要 **Java 21**。
- 可用時使用 Native build。
- Windows 使用 WSL2；signal-cli 安裝遵循 WSL 內部的 Linux 流程。

## 精靈寫入的內容

`~/.openclaw/openclaw.json` 中的典型欄位：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (如果選擇 Minimax)
- `gateway.*` (mode, bind, auth, tailscale)
- `channels.telegram.botToken`、`channels.discord.token`、`channels.signal.*`、`channels.imessage.*`
- 頻道允許列表 (Slack/Discord/Matrix/Microsoft Teams)，當您在提示期間選擇加入時 (名稱在可能時解析為 ID)。
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 寫入 `agents.list[]` 和可選的 `bindings`。

WhatsApp 憑證位於 `~/.openclaw/credentials/whatsapp/<accountId>/` 下。
工作階段儲存在 `~/.openclaw/agents/<agentId>/sessions/` 下。

一些頻道作為外掛程式提供。當您在新手導覽期間選擇一個時，精靈
將提示安裝它 (npm 或 local path)，然後才能進行設定。

## 相關文件

- 精靈概述：[新手導覽精靈](/start/wizard)
- macOS 應用程式新手導覽：[新手導覽](/start/onboarding)
- 設定參考：[Gateway 設定](/gateway/configuration)
- 供應商：[WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)、[Google Chat](/channels/googlechat)、[Signal](/channels/signal)、[BlueBubbles](/channels/bluebubbles) (iMessage)、[iMessage](/channels/imessage) (舊版)
- Skills：[Skills](/tools/skills)、[Skills 設定](/tools/skills-config)
```
