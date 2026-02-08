---
summary: "CLI 入門引導精靈的完整參考：每個步驟、旗標與設定欄位"
read_when:
  - 查找特定的精靈步驟或旗標
  - 使用非互動模式自動化入門
  - 偵錯精靈行為
title: "入門引導精靈參考"
sidebarTitle: "精靈參考"
x-i18n:
  source_path: reference/wizard.md
  source_hash: 05fac3786016d906
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:36Z
---

# 入門引導精靈參考

這是 `openclaw onboard` CLI 精靈的完整參考。
如需高層概覽，請參閱 [入門引導精靈](/start/wizard)。

## 流程細節（本機模式）

<Steps>
  <Step title="既有設定偵測">
    - 若存在 `~/.openclaw/openclaw.json`，可選擇 **保留 / 修改 / 重設**。
    - 重新執行精靈**不會**清除任何內容，除非你明確選擇 **重設**
      （或傳入 `--reset`）。
    - 若設定無效或包含舊版金鑰，精靈會停止並要求
      你先執行 `openclaw doctor` 再繼續。
    - 重設會使用 `trash`（絕不使用 `rm`），並提供範圍：
      - 僅設定
      - 設定 + 憑證 + 工作階段
      - 完整重設（同時移除工作區）
  </Step>
  <Step title="模型／身分驗證">
    - **Anthropic API 金鑰（建議）**：若存在則使用 `ANTHROPIC_API_KEY`，否則提示輸入金鑰，並儲存供 daemon 使用。
    - **Anthropic OAuth（Claude Code CLI）**：在 macOS 上，精靈會檢查鑰匙圈項目「Claude Code-credentials」（請選擇「永遠允許」，避免 launchd 啟動時被阻擋）；在 Linux／Windows 上，若存在則重用 `~/.claude/.credentials.json`。
    - **Anthropic 權杖（貼上 setup-token）**：在任何機器上執行 `claude setup-token`，再貼上權杖（可命名；留白 = 預設）。
    - **OpenAI Code（Codex）訂閱（Codex CLI）**：若存在 `~/.codex/auth.json`，精靈可重用。
    - **OpenAI Code（Codex）訂閱（OAuth）**：瀏覽器流程；貼上 `code#state`。
      - 當模型未設定或為 `openai/*` 時，將 `agents.defaults.model` 設為 `openai-codex/gpt-5.2`。
    - **OpenAI API 金鑰**：若存在則使用 `OPENAI_API_KEY`，否則提示輸入金鑰，並儲存至 `~/.openclaw/.env` 以供 launchd 讀取。
    - **xAI（Grok）API 金鑰**：提示輸入 `XAI_API_KEY`，並將 xAI 設定為模型提供者。
    - **OpenCode Zen（多模型代理）**：提示輸入 `OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`，於 https://opencode.ai/auth 取得）。
    - **API 金鑰**：為你儲存金鑰。
    - **Vercel AI Gateway（多模型代理）**：提示輸入 `AI_GATEWAY_API_KEY`。
    - 更多說明：[Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**：提示輸入 Account ID、Gateway ID，以及 `CLOUDFLARE_AI_GATEWAY_API_KEY`。
    - 更多說明：[Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**：設定會自動寫入。
    - 更多說明：[MiniMax](/providers/minimax)
    - **Synthetic（相容 Anthropic）**：提示輸入 `SYNTHETIC_API_KEY`。
    - 更多說明：[Synthetic](/providers/synthetic)
    - **Moonshot（Kimi K2）**：設定會自動寫入。
    - **Kimi Coding**：設定會自動寫入。
    - 更多說明：[Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)
    - **略過**：暫不設定任何身分驗證。
    - 從偵測到的選項中選擇預設模型（或手動輸入 提供者／模型）。
    - 精靈會執行模型檢查，若設定的模型未知或缺少身分驗證則提出警告。
    - OAuth 憑證位於 `~/.openclaw/credentials/oauth.json`；身分驗證設定檔位於 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（API 金鑰 + OAuth）。
    - 更多說明：[/concepts/oauth](/concepts/oauth)
    <Note>
    無頭／伺服器提示：在有瀏覽器的機器上完成 OAuth，然後將
    `~/.openclaw/credentials/oauth.json`（或 `$OPENCLAW_STATE_DIR/credentials/oauth.json`）複製到
    閘道器主機。
    </Note>
  </Step>
  <Step title="工作區">
    - 預設為 `~/.openclaw/workspace`（可設定）。
    - 產生代理程式啟動儀式所需的工作區檔案。
    - 完整工作區配置與備份指南：[代理程式工作區](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - 連接埠、繫結、驗證模式、 Tailscale 暴露。
    - 驗證建議：即使是 loopback 也保留 **Token**，讓本機 WS 用戶端必須驗證。
    - 僅在你完全信任所有本機程序時才停用驗證。
    - 非 loopback 的繫結仍需要驗證。
  </Step>
  <Step title="頻道">
    - [WhatsApp](/channels/whatsapp)：選用的 QR 登入。
    - [Telegram](/channels/telegram)：機器人權杖。
    - [Discord](/channels/discord)：機器人權杖。
    - [Google Chat](/channels/googlechat)：服務帳戶 JSON + webhook audience。
    - [Mattermost](/channels/mattermost)（外掛）：機器人權杖 + base URL。
    - [Signal](/channels/signal)：選用的 `signal-cli` 安裝 + 帳戶設定。
    - [BlueBubbles](/channels/bluebubbles)：**建議用於 iMessage**；伺服器 URL + 密碼 + webhook。
    - [iMessage](/channels/imessage)：舊版 `imsg` CLI 路徑 + DB 存取。
    - 私訊安全性：預設為配對。首次私訊會傳送代碼；透過 `openclaw pairing approve <channel> <code>` 核准或使用允許清單。
  </Step>
  <Step title="Daemon 安裝">
    - macOS：LaunchAgent
      - 需要已登入的使用者工作階段；無頭環境請使用自訂 LaunchDaemon（未隨附）。
    - Linux（以及透過 WSL2 的 Windows）：systemd 使用者單元
      - 精靈會嘗試透過 `loginctl enable-linger <user>` 啟用 lingering，讓 Gateway 在登出後仍保持運作。
      - 可能會要求 sudo（寫入 `/var/lib/systemd/linger`）；會先嘗試不使用 sudo。
    - **執行階段選擇：** Node（建議；WhatsApp／Telegram 必要）。不建議使用 Bun。
  </Step>
  <Step title="健康檢查">
    - 啟動 Gateway（如有需要）並執行 `openclaw health`。
    - 提示：`openclaw status --deep` 會將 Gateway 健康探測加入狀態輸出（需要可連線的 Gateway）。
  </Step>
  <Step title="Skills（建議）">
    - 讀取可用的 Skills 並檢查需求。
    - 讓你選擇 Node 管理器：**npm / pnpm**（不建議 bun）。
    - 安裝選用相依套件（部分在 macOS 上使用 Homebrew）。
  </Step>
  <Step title="完成">
    - 摘要與後續步驟，包含 iOS／Android／macOS 應用程式以取得額外功能。
  </Step>
</Steps>

<Note>
若未偵測到 GUI，精靈會列印 Control UI 的 SSH 連接埠轉送指示，而非開啟瀏覽器。
若缺少 Control UI 資產，精靈會嘗試建置；後備方案為 `pnpm ui:build`（自動安裝 UI 相依套件）。
</Note>

## 非互動模式

使用 `--non-interactive` 來自動化或以指令碼進行入門：

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
`--json` **不**代表非互動模式。請在指令碼中使用 `--non-interactive`（以及 `--workspace`）。
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

### 新增代理程式（非互動）

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway 精靈 RPC

Gateway 透過 RPC 提供精靈流程（`wizard.start`、`wizard.next`、`wizard.cancel`、`wizard.status`）。
用戶端（macOS 應用程式、Control UI）可在不重新實作入門邏輯的情況下呈現步驟。

## Signal 設定（signal-cli）

精靈可從 GitHub 發行版安裝 `signal-cli`：

- 下載對應的發行資產。
- 儲存在 `~/.openclaw/tools/signal-cli/<version>/` 之下。
- 將 `channels.signal.cliPath` 寫入你的設定。

注意事項：

- JVM 版本需要 **Java 21**。
- 有可用時會使用原生版本。
- Windows 使用 WSL2；signal-cli 的安裝會在 WSL 內依 Linux 流程進行。

## 精靈寫入的內容

`~/.openclaw/openclaw.json` 中的常見欄位：

- `agents.defaults.workspace`
- `agents.defaults.model`／`models.providers`（若選擇 Minimax）
- `gateway.*`（模式、繫結、驗證、 Tailscale）
- `channels.telegram.botToken`、`channels.discord.token`、`channels.signal.*`、`channels.imessage.*`
- 在提示中選擇加入時，頻道允許清單（Slack／Discord／Matrix／Microsoft Teams）（名稱在可能時會解析為 ID）。
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 會寫入 `agents.list[]` 與選用的 `bindings`。

WhatsApp 憑證位於 `~/.openclaw/credentials/whatsapp/<accountId>/`。
工作階段儲存在 `~/.openclaw/agents/<agentId>/sessions/`。

部分頻道以外掛形式提供。當你在入門過程中選擇其中一個時，精靈
會在可設定之前提示你安裝它（npm 或本機路徑）。

## 相關文件

- 精靈概覽：[入門引導精靈](/start/wizard)
- macOS 應用程式入門：[入門](/start/onboarding)
- 設定參考：[Gateway 設定](/gateway/configuration)
- 提供者：[WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)、[Google Chat](/channels/googlechat)、[Signal](/channels/signal)、[BlueBubbles](/channels/bluebubbles)（iMessage）、[iMessage](/channels/imessage)（舊版）
- Skills：[Skills](/tools/skills)、[Skills 設定](/tools/skills-config)
