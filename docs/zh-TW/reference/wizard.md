---
summary: >-
  Full reference for the CLI onboarding wizard: every step, flag, and config
  field
read_when:
  - Looking up a specific wizard step or flag
  - Automating onboarding with non-interactive mode
  - Debugging wizard behavior
title: Onboarding Wizard Reference
sidebarTitle: Wizard Reference
---

# 新手導引精靈參考

這是 `openclaw onboard` CLI 精靈的完整參考。
如需高階概覽，請參考 [新手導引精靈](/start/wizard)。

## 流程細節（本地模式）

<Steps>
  <Step title="現有設定偵測">
    - 如果 `~/.openclaw/openclaw.json` 存在，選擇 **保留 / 修改 / 重設**。
    - 重新執行精靈不會清除任何東西，除非你明確選擇 **重設**
      （或傳入 `--reset`）。
    - CLI `--reset` 預設為 `config+creds+sessions`；使用 `--reset-scope full`
      也會移除工作區。
    - 如果設定無效或包含舊版鍵，精靈會停止並要求你先執行 `openclaw doctor` 再繼續。
    - 重設使用 `trash`（絕不使用 `rm`），並提供範圍選擇：
      - 僅設定檔
      - 設定檔 + 憑證 + 會話
      - 完全重設（也移除工作區）
  </Step>
  <Step title="模型/認證">
    - **Anthropic API 金鑰**：若存在則使用 `ANTHROPIC_API_KEY`，否則提示輸入金鑰，並儲存供 daemon 使用。
    - **Anthropic OAuth (Claude Code CLI)**：macOS 上精靈會檢查 Keychain 專案 "Claude Code-credentials"（選擇「永遠允許」以避免 launchd 啟動時被阻擋）；Linux/Windows 則重用存在的 `~/.claude/.credentials.json`。
    - **Anthropic token（貼上 setup-token）**：在任意機器執行 `claude setup-token`，然後貼上 token（可命名；空白為預設）。
    - **OpenAI Code (Codex) 訂閱 (Codex CLI)**：若 `~/.codex/auth.json` 存在，精靈可重用。
    - **OpenAI Code (Codex) 訂閱 (OAuth)**：瀏覽器流程；貼上 `code#state`。
      - 當模型未設定或為 `openai/*` 時，設定 `agents.defaults.model` 為 `openai-codex/gpt-5.2`。
    - **OpenAI API 金鑰**：若存在則使用 `OPENAI_API_KEY`，否則提示輸入金鑰，並儲存於認證設定檔。
    - **xAI (Grok) API 金鑰**：提示輸入 `XAI_API_KEY`，並設定 xAI 為模型提供者。
    - **OpenCode**：提示輸入 `OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`，可於 https://opencode.ai/auth 取得），並讓你選擇 Zen 或 Go 目錄。
    - **Ollama**：提示輸入 Ollama 基本 URL，提供 **雲端 + 本地** 或 **本地** 模式，偵測可用模型，並在需要時自動拉取選定的本地模型。
    - 更多細節：[Ollama](/providers/ollama)
    - **API 金鑰**：為你儲存金鑰。
    - **Vercel AI Gateway（多模型代理）**：提示輸入 `AI_GATEWAY_API_KEY`。
    - 更多細節：[Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**：提示輸入帳戶 ID、Gateway ID 及 `CLOUDFLARE_AI_GATEWAY_API_KEY`。
    - 更多細節：[Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.5**：設定自動寫入。
    - 更多細節：[MiniMax](/providers/minimax)
    - **Synthetic (Anthropic 相容)**：提示輸入 `SYNTHETIC_API_KEY`。
    - 更多細節：[Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**：設定自動寫入。
    - **Kimi Coding**：設定自動寫入。
    - 更多細節：[Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **跳過**：尚未設定認證。
    - 從偵測到的選項中選擇預設模型（或手動輸入提供者/模型）。為了最佳品質及降低提示注入風險，請選擇你提供者堆疊中最強大且最新一代的模型。
    - 精靈會執行模型檢查，若設定模型未知或缺少認證會發出警告。
    - API 金鑰儲存模式預設為純文字認證設定檔值。使用 `--secret-input-mode ref` 可改為儲存環境變數參考（例如 `keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" }`）。
    - OAuth 憑證存放於 `~/.openclaw/credentials/oauth.json`；認證設定檔存放 API 金鑰 + OAuth 於 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`。
    - 更多細節：[/concepts/oauth](/concepts/oauth)
    <Note>
    無頭/伺服器提示：在有瀏覽器的機器完成 OAuth，然後複製
    `~/.openclaw/credentials/oauth.json`（或 `$OPENCLAW_STATE_DIR/credentials/oauth.json`）到
    gateway 主機。
    </Note>
  </Step>
  <Step title="工作區">
    - 預設 `~/.openclaw/workspace`（可設定）。
    - 種下代理啟動儀式所需的工作區檔案。
    - 完整工作區佈局 + 備份指南：[代理工作區](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - 埠號、綁定、認證模式、tailscale 曝露。
    - 認證建議：即使是迴圈回路也保留 **Token**，讓本地 WS 用戶端必須認證。
    - 在 token 模式下，互動式新手導引提供：
      - **產生/儲存純文字 token**（預設）
      - **使用 SecretRef**（選擇性）
      - 快速啟動會重用現有 `gateway.auth.token` SecretRef，跨 `env`、`file` 和 `exec` 提供者用於新手導引探測/儀表板啟動。
      - 若該 SecretRef 已設定但無法解析，新手導引會提前失敗並提供明確修正訊息，而非靜默降級執行時認證。
    - 在密碼模式下，互動式新手導引也支援純文字或 SecretRef 儲存。
    - 非互動式 token SecretRef 路徑：`--gateway-token-ref-env <ENV_VAR>`。
      - 需要在新手導引過程環境中有非空的環境變數。
      - 不可與 `--gateway-token` 同時使用。
    - 僅當你完全信任所有本地程序時才禁用認證。
    - 非迴圈回路綁定仍需認證。
  </Step>
  <Step title="頻道">
    - [WhatsApp](/channels/whatsapp)：可選 QR 登入。
    - [Telegram](/channels/telegram)：機器人 token。
    - [Discord](/channels/discord)：機器人 token。
    - [Google Chat](/channels/googlechat)：服務帳戶 JSON + webhook 受眾。
    - [Mattermost](/channels/mattermost)（外掛）：機器人 token + 基本 URL。
    - [Signal](/channels/signal)：可選 `signal-cli` 安裝 + 帳戶設定。
    - [BlueBubbles](/channels/bluebubbles)：**推薦用於 iMessage**；伺服器 URL + 密碼 + webhook。
    - [iMessage](/channels/imessage)：舊版 `imsg` CLI 路徑 + 資料庫存取。
    - 私訊安全：預設為配對。首次私訊會發送程式碼；透過 `openclaw pairing approve <channel> <code>` 批准或使用允許清單。
  </Step>
  <Step title="網路搜尋">
    - 選擇提供者：Perplexity、Brave、Gemini、Grok 或 Kimi（或跳過）。
    - 貼上你的 API 金鑰（快速啟動會自動偵測環境變數或現有設定中的金鑰）。
    - 使用 `--skip-search` 跳過。
    - 之後可設定：`openclaw configure --section web`。
  </Step>
  <Step title="Daemon 安裝">
    - macOS：LaunchAgent
      - 需要已登入的使用者會話；無頭環境請使用自訂 LaunchDaemon（未內建）。
    - Linux（及 Windows 透過 WSL2）：systemd 使用者單元
      - 精靈嘗試透過 `loginctl enable-linger <user>` 啟用 lingering，讓 Gateway 登出後仍持續運作。
      - 可能會提示 sudo（寫入 `/var/lib/systemd/linger`）；會先嘗試不使用 sudo。
    - **執行時選擇：** Node（推薦；WhatsApp/Telegram 必須）。Bun **不推薦**。
    - 若 token 認證需要 token 且 `gateway.auth.token` 由 SecretRef 管理，daemon 安裝會驗證但不會將解析後的純文字 token 寫入監督服務環境元資料。
    - 若 token 認證需要 token 且設定的 token SecretRef 無法解析，daemon 安裝會阻擋並提供可行指導。
    - 若同時設定 `gateway.auth.token` 和 `gateway.auth.password`，且 `gateway.auth.mode` 未設定，daemon 安裝會阻擋直到明確設定模式。
  </Step>
  <Step title="健康檢查">
    - 啟動 Gateway（如有需要）並執行 `openclaw health`。
    - 提示：`openclaw status --deep` 可將 gateway 健康探測加入狀態輸出（需可連線 gateway）。
  </Step>
  <Step title="技能（推薦）">
    - 讀取可用技能並檢查需求。
    - 讓你選擇節點管理器：**npm / pnpm**（不推薦 bun）。
    - 安裝選用依賴（部分在 macOS 使用 Homebrew）。
  </Step>
  <Step title="完成">
    - 摘要 + 下一步，包括 iOS/Android/macOS 應用程式以獲得額外功能。
  </Step>
</Steps>

<Note>
若未偵測到 GUI，精靈會列印 SSH 端口轉發指令以使用控制介面，而非開啟瀏覽器。
若控制介面資源缺失，精靈會嘗試建置；備援為 `pnpm ui:build`（自動安裝 UI 依賴）。
</Note>

## 非互動模式

使用 `--non-interactive` 來自動化或腳本化新手導引：

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

加入 `--json` 以取得機器可讀摘要。

非互動模式下的 Gateway token SecretRef：

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice skip \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN
```

`--gateway-token` 與 `--gateway-token-ref-env` 互斥。

<Note>
`--json` 不代表非互動模式。腳本請使用 `--non-interactive`（及 `--workspace`）。
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
  <Accordion title="OpenCode 範例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
    換成 `--auth-choice opencode-go --opencode-go-api-key "$OPENCODE_API_KEY"` 以使用 Go 目錄。
  </Accordion>
  <Accordion title="Ollama 範例">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ollama \
      --custom-model-id "qwen3.5:27b" \
      --accept-risk \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
    加上 `--custom-base-url "http://ollama-host:11434"` 以指定遠端 Ollama 實例。
  </Accordion>
</AccordionGroup>

### 新增代理（非互動）

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
用戶端（macOS 應用程式、控制介面）可以呈現步驟，而無需重新實作 onboarding 邏輯。

## Signal 設定（signal-cli）

精靈可以從 GitHub 釋出版本安裝 `signal-cli`：

- 下載適合的釋出資產。
- 儲存在 `~/.openclaw/tools/signal-cli/<version>/` 底下。
- 將 `channels.signal.cliPath` 寫入你的設定檔。

注意事項：

- JVM 版本需要 **Java 21**。
- 有原生版本時會優先使用。
- Windows 使用 WSL2；signal-cli 安裝流程會在 WSL 的 Linux 環境中執行。

## 精靈會寫入的內容

`~/.openclaw/openclaw.json` 中常見欄位：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`（若選擇 Minimax）
- `tools.profile`（本地 onboarding 若未設定，預設為 `"coding"`；已有明確值則保留）
- `gateway.*`（模式、綁定、認證、tailscale）
- `session.dmScope`（行為細節：[CLI Onboarding 參考](/start/wizard-cli-reference#outputs-and-internals)）
- `channels.telegram.botToken`、`channels.discord.token`、`channels.signal.*`、`channels.imessage.*`
- 頻道允許清單（Slack/Discord/Matrix/Microsoft Teams），當你在提示中選擇加入時（名稱會盡可能解析成 ID）。
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 會寫入 `agents.list[]` 及可選的 `bindings`。

WhatsApp 認證資料會放在 `~/.openclaw/credentials/whatsapp/<accountId>/`。
會話資料儲存在 `~/.openclaw/agents/<agentId>/sessions/`。

部分頻道以外掛形式提供。當你在 onboarding 選擇其中一個時，精靈會提示先安裝該外掛（npm 或本地路徑），才能進行設定。

## 相關文件

- 精靈總覽：[入門精靈](/start/wizard)
- macOS 應用程式入門：[入門指南](/start/onboarding)
- 設定參考：[Gateway 設定](/gateway/configuration)
- 服務提供者：[WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)、[Google Chat](/channels/googlechat)、[Signal](/channels/signal)、[BlueBubbles](/channels/bluebubbles)（iMessage）、[iMessage](/channels/imessage)（舊版）
- 技能：[技能](/tools/skills)、[技能設定](/tools/skills-config)
