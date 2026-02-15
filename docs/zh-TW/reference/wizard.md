---
summary: "CLI 入門精靈完整參考：包含所有步驟、旗標與設定欄位"
read_when:
  - 查找特定精靈步驟或旗標時
  - 使用非互動模式自動化執行入門流程時
  - 偵錯精靈行為時
title: "入門精靈參考"
sidebarTitle: "精靈參考"
---

# 入門精靈參考

這是 `openclaw onboard` CLI 精靈的完整參考資料。
如需高階概覽，請參閱 [入門精靈](/start/wizard)。

## 流程詳情 (本地模式)

<Steps>
  <Step title="現有設定偵測">
    - 若 `~/.openclaw/openclaw.json` 存在，請選擇 **保留 / 修改 / 重設**。
    - 重新執行精靈**不會**清除任何內容，除非您明確選擇**重設**（或傳遞 `--reset`）。
    - 若設定無效或包含舊版鍵值，精靈會停止並要求您在繼續前執行 `openclaw doctor`。
    - 重設會使用 `trash` (絕非 `rm`) 並提供以下範圍：
      - 僅設定
      - 設定 + 憑證 + 工作階段
      - 完整重設 (同時移除工作區)
  </Step>
  <Step title="模型/身分驗證">
    - **Anthropic API 金鑰 (建議使用)**：若存在則使用 `ANTHROPIC_API_KEY`，或提示輸入金鑰，隨後將其儲存供守護行程使用。
    - **Anthropic OAuth (Claude Code CLI)**：在 macOS 上，精靈會檢查鑰匙圈項目「Claude Code-credentials」（請選擇「永遠允許」，以免 launchd 啟動時被阻擋）；在 Linux/Windows 上，若存在則會重複使用 `~/.claude/.credentials.json`。
    - **Anthropic 權杖 (貼上 setup-token)**：在任何機器上執行 `claude setup-token`，然後貼上權杖（您可以為其命名；留白則為預設值）。
    - **OpenAI Code (Codex) 訂閱 (Codex CLI)**：若 `~/.codex/auth.json` 存在，精靈可以重複使用它。
    - **OpenAI Code (Codex) 訂閱 (OAuth)**：瀏覽器流程；貼上 `code#state`。
      - 當模型未設定或為 `openai/*` 時，將 `agents.defaults.model` 設定為 `openai-codex/gpt-5.2`。
    - **OpenAI API 金鑰**：若存在則使用 `OPENAI_API_KEY`，或提示輸入金鑰，隨後將其儲存至 `~/.openclaw/.env` 以便 launchd 讀取。
    - **xAI (Grok) API 金鑰**：提示輸入 `XAI_API_KEY` 並將 xAI 設定為模型供應商。
    - **OpenCode Zen (多模型代理)**：提示輸入 `OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`，可於 https://opencode.ai/auth 取得）。
    - **API 金鑰**：為您儲存金鑰。
    - **Vercel AI Gateway (多模型代理)**：提示輸入 `AI_GATEWAY_API_KEY`。
    - 更多詳情：[Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**：提示輸入帳戶 ID、Gateway ID 以及 `CLOUDFLARE_AI_GATEWAY_API_KEY`。
    - 更多詳情：[Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**：設定將自動寫入。
    - 更多詳情：[MiniMax](/providers/minimax)
    - **Synthetic (相容 Anthropic)**：提示輸入 `SYNTHETIC_API_KEY`。
    - 更多詳情：[Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**：設定將自動寫入。
    - **Kimi Coding**：設定將自動寫入。
    - 更多詳情：[Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **跳過**：尚未設定身分驗證。
    - 從偵測到的選項中挑選預設模型（或手動輸入供應商/模型）。
    - 精靈會執行模型檢查，若設定的模型不明或缺少身分驗證則會發出警告。
    - OAuth 憑證儲存在 `~/.openclaw/credentials/oauth.json`；身分驗證設定檔則在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (API 金鑰 + OAuth)。
    - 更多詳情：[/concepts/oauth](/concepts/oauth)
    <Note>
    無頭模式/伺服器提示：在有瀏覽器的機器上完成 OAuth，然後將 `~/.openclaw/credentials/oauth.json` (或 `$OPENCLAW_STATE_DIR/credentials/oauth.json`) 複製到 Gateway 主機。
    </Note>
  </Step>
  <Step title="工作區">
    - 預設為 `~/.openclaw/workspace` (可自訂)。
    - 置入 Agent 引導儀式所需的種子檔案。
    - 完整工作區配置與備份指南：[Agent 工作區](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - 連接埠、繫結、驗證模式、Tailscale 暴露。
    - 驗證建議：即使是回環 (loopback) 也請保留 **Token**，以便本地 WS 用戶端必須通過驗證。
    - 僅在您完全信任每個本地程序時才停用驗證。
    - 非回環繫結仍需要驗證。
  </Step>
  <Step title="通道">
    - [WhatsApp](/channels/whatsapp)：選用的 QR Code 登入。
    - [Telegram](/channels/telegram)：機器人權杖。
    - [Discord](/channels/discord)：機器人權杖。
    - [Google Chat](/channels/googlechat)：服務帳戶 JSON + Webhook 受眾。
    - [Mattermost](/channels/mattermost) (外掛程式)：機器人權杖 + 基本網址。
    - [Signal](/channels/signal)：選用的 `signal-cli` 安裝 + 帳戶設定。
    - [BlueBubbles](/channels/bluebubbles)：**iMessage 建議使用**；伺服器網址 + 密碼 + Webhook。
    - [iMessage](/channels/imessage)：舊版 `imsg` CLI 路徑 + 資料庫存取。
    - 私訊安全性：預設為配對。第一則私訊會傳送驗證碼；請透過 `openclaw pairing approve <channel> <code>` 核准或使用白名單。
  </Step>
  <Step title="守護行程安裝">
    - macOS: LaunchAgent
      - 需要已登入的使用者工作階段；若為無頭模式，請使用自訂 LaunchDaemon (未隨附)。
    - Linux (以及透過 WSL2 的 Windows): systemd 使用者單元
      - 精靈會嘗試透過 `loginctl enable-linger <user>` 開啟停留 (lingering)，使 Gateway 在登出後保持開啟。
      - 可能會提示輸入 sudo (寫入 `/var/lib/systemd/linger`)；精靈會先嘗試不使用 sudo。
    - **執行環境選擇：** Node (建議使用；WhatsApp/Telegram 必要)。**不建議**使用 Bun。
  </Step>
  <Step title="健康檢查">
    - 啟動 Gateway (如有需要) 並執行 `openclaw health`。
    - 提示：`openclaw status --deep` 會在狀態輸出中加入 Gateway 健康探測 (需要可連線的 Gateway)。
  </Step>
  <Step title="Skills (建議使用)">
    - 讀取可用的 Skills 並檢查需求。
    - 讓您選擇 Node 管理器：**npm / pnpm** (不建議使用 Bun)。
    - 安裝選用依賴項 (在 macOS 上部分會使用 Homebrew)。
  </Step>
  <Step title="完成">
    - 摘要與後續步驟，包含適用於額外功能的 iOS/Android/macOS 應用程式。
  </Step>
</Steps>

<Note>
若偵測不到 GUI，精靈會印出 Control UI 的 SSH 連接埠轉發指令，而非直接開啟瀏覽器。
若缺少 Control UI 資產，精靈會嘗試建置它們；備援方案為 `pnpm ui:build` (會自動安裝 UI 依賴項)。
</Note>

## 非互動模式

使用 `--non-interactive` 來自動化或指令碼化入門流程：

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

加入 `--json` 以取得機器可讀的摘要。

<Note>
`--json` **不代表**非互動模式。指令碼請使用 `--non-interactive` (以及 `--workspace`)。
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

### 新增 Agent (非互動)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway 精靈 RPC

Gateway 透過 RPC 暴露精靈流程 (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`)。
用戶端 (macOS 應用程式、Control UI) 無需重新實作入門邏輯即可呈現步驟。

## Signal 設定 (signal-cli)

精靈可以從 GitHub 發行版本安裝 `signal-cli`：

- 下載合適的發行資產。
- 將其儲存在 `~/.openclaw/tools/signal-cli/<version>/`。
- 將 `channels.signal.cliPath` 寫入您的設定。

注意事項：

- JVM 建置版本需要 **Java 21**。
- 若有原生建置版本則優先使用。
- Windows 使用 WSL2；Signal-cli 安裝程序會遵循 WSL 內的 Linux 流程。

## 精靈寫入的內容

`~/.openclaw/openclaw.json` 中的典型欄位：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (若選擇 Minimax)
- `gateway.*` (模式、繫結、驗證、Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- 當您在提示中選擇加入時的通道白名單 (Slack/Discord/Matrix/Microsoft Teams) (盡可能將名稱解析為 ID)。
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 會寫入 `agents.list[]` 以及選用的 `bindings`。

WhatsApp 憑證位於 `~/.openclaw/credentials/whatsapp/<accountId>/`。
工作階段儲存在 `~/.openclaw/agents/<agentId>/sessions/`。

部分通道以外掛程式形式提供。若您在入門流程中選擇了其中一個，精靈會在設定前提示您進行安裝 (使用 npm 或本地路徑)。

## 相關文件

- 精靈概覽：[入門精靈](/start/wizard)
- macOS 應用程式入門：[入門](/start/onboarding)
- 設定參考：[Gateway 設定](/gateway/configuration)
- 供應商：[WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (舊版)
- Skills：[Skills](/tools/skills), [Skills 設定](/tools/skills-config)
