---
summary: "CLI 新手引導精靈的完整參考：每個步驟、旗標與設定欄位"
read_when:
  - 查找特定的精靈步驟或旗標
  - 使用非互動模式自動化入門
  - 除錯精靈行為
title: "入門引導精靈參考"
sidebarTitle: "reference/wizard.md"
---

# 入門引導精靈參考

這是 `openclaw onboard` CLI 精靈的完整參考。
如需高層概覽，請參閱 [入門引導精靈](/start/wizard)。
如需高階總覽，請參閱 [Onboarding Wizard](/start/wizard)。

## 流程細節（本機模式）

<Steps>
  <Step title="Existing config detection">
    - 若 `~/.openclaw/openclaw.json` 存在，請選擇 **保留 / 修改 / 重設**。
    - 重新執行精靈 **不會** 清除任何內容，除非你明確選擇 **重設**
      （或傳入 `--reset`）。
    - 如果設定無效或包含舊版鍵值，精靈會停止並要求你在繼續之前執行 `openclaw doctor`。
    - 重設會使用 `trash`（絕不使用 `rm`），並提供範圍選項：
      - 僅設定
      - 設定 + 憑證 + 工作階段
      - 完整重設（也會移除工作區）  
</Step>
  <Step title="Model/Auth">
    - **Anthropic API 金鑰（建議）**：若存在則使用 `ANTHROPIC_API_KEY`，否則提示輸入金鑰，接著儲存以供 daemon 使用。
    - **Anthropic OAuth（Claude Code CLI）**：在 macOS 上，精靈會檢查 Keychain 項目「Claude Code-credentials」（請選擇「Always Allow」以避免 launchd 啟動時被阻擋）；在 Linux/Windows 上，若存在則重用 `~/.claude/.credentials.json`。
    - **Anthropic token（貼上 setup-token）**：在任何機器上執行 `claude setup-token`，然後貼上 token（可命名；留空 = 預設）。
    - **OpenAI Code（Codex）訂閱（Codex CLI）**：如果存在 `~/.codex/auth.json`，精靈可以重用它。
    - **OpenAI Code（Codex）訂閱（OAuth）**：瀏覽器流程；貼上 `code#state`。
      - Sets `agents.defaults.model` to `openai-codex/gpt-5.2` when model is unset or `openai/*`.
    - **OpenAI API 金鑰**：若存在則使用 `OPENAI_API_KEY`，否則提示輸入金鑰，然後將其儲存至 `~/.openclaw/.env` 以便 launchd 讀取。
    - **xAI (Grok) API key**: prompts for `XAI_API_KEY` and configures xAI as a model provider.
    - **OpenCode Zen（多模型代理）**：提示輸入 `OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`，於 https://opencode.ai/auth 取得）。
    - **API 金鑰**：為你儲存金鑰。
    - **Vercel AI Gateway（多模型代理）**：提示輸入 `AI_GATEWAY_API_KEY`。
    - 更多細節：[Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**：提示輸入 Account ID、Gateway ID 與 `CLOUDFLARE_AI_GATEWAY_API_KEY`。
    - 更多細節：[Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**：設定會自動寫入。
    - More detail: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-compatible)**: prompts for `SYNTHETIC_API_KEY`.
    - More detail: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: config is auto-written.
    - **Kimi Coding**: config is auto-written.
    - More detail: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: no auth configured yet.
    - Pick a default model from detected options (or enter provider/model manually).
    - Wizard runs a model check and warns if the configured model is unknown or missing auth.
    - OAuth credentials live in `~/.openclaw/credentials/oauth.json`; auth profiles live in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（API 金鑰 + OAuth）。
    - 更多說明：[/concepts/oauth](/concepts/oauth)
    
    - 更多細節：[/concepts/oauth](/concepts/oauth)    
<Note>
    無頭／伺服器提示：在有瀏覽器的機器上完成 OAuth，然後將
    `~/.openclaw/credentials/oauth.json`（或 `$OPENCLAW_STATE_DIR/credentials/oauth.json`）複製到
    閘道器主機。
    </Note>
  </Step>
  <Step title="Workspace">
    - Default `~/.openclaw/workspace` (configurable).
    - Seeds the workspace files needed for the agent bootstrap ritual.
    
    - 預設為 `~/.openclaw/workspace`（可設定）。
    - 產生代理程式啟動儀式所需的工作區檔案。
    - 完整工作區配置與備份指南：[代理程式工作區](/concepts/agent-workspace)
    
</Step>
  <Step title="Gateway">
    - Port, bind, auth mode, tailscale exposure.
    - Auth recommendation: keep **Token** even for loopback so local WS clients must authenticate.
    - Disable auth only if you fully trust every local process.
    - Non‑loopback binds still require auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optional QR login.
    - [Telegram](/channels/telegram): bot token.
    - [Discord](/channels/discord): bot token.
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience.
    - [Mattermost](/channels/mattermost) (plugin): bot token + base URL.
    - [Signal](/channels/signal): optional `signal-cli` install + account config.
    - [BlueBubbles](/channels/bluebubbles): **recommended for iMessage**; server URL + password + webhook.
    - [iMessage](/channels/imessage): legacy `imsg` CLI path + DB access.
    - DM security: default is pairing. First DM sends a code; approve via `openclaw pairing approve <channel><code>` 核准或使用允許清單。
  </Step><code>` or use allowlists.
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Requires a logged-in user session; for headless, use a custom LaunchDaemon (not shipped).
    - Linux (and Windows via WSL2): systemd user unit
      - Wizard attempts to enable lingering via `loginctl enable-linger <user>` so the Gateway stays up after logout.
      - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
    - **Runtime selection:** Node (recommended; required for WhatsApp/Telegram). Bun is **not recommended**.
  </Step>
  <Step title="Health check">
    - Starts the Gateway (if needed) and runs `openclaw health`.
    - Tip: `openclaw status --deep` adds gateway health probes to status output (requires a reachable gateway).
  </Step>
  <Step title="Skills (recommended)">
    - Reads the available skills and checks requirements.
    - Lets you choose a node manager: **npm / pnpm** (bun not recommended).
    - Installs optional dependencies (some use Homebrew on macOS).
  </Step>
  <Step title="Finish">
    - Summary + next steps, including iOS/Android/macOS apps for extra features.
  </Step>
</Steps>

<Note>
If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.
If the Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).
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
 Use `--non-interactive` (and `--workspace`) for scripts.
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
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
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
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
Clients (macOS app, Control UI) can render steps without re‑implementing onboarding logic.

## Signal 設定（signal-cli）

精靈可從 GitHub 發行版安裝 `signal-cli`：

- Downloads the appropriate release asset.
- 儲存在 `~/.openclaw/tools/signal-cli/<version>/` 之下。
- 將 `channels.signal.cliPath` 寫入你的設定。

注意事項：

- JVM 版本需要 **Java 21**。
- Native builds are used when available.
- Windows 使用 WSL2；signal-cli 的安裝會在 WSL 內依 Linux 流程進行。

## What the wizard writes

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
Sessions are stored under `~/.openclaw/agents/<agentId>/sessions/`.

Some channels are delivered as plugins. When you pick one during onboarding, the wizard
will prompt to install it (npm or a local path) before it can be configured.

## Related docs

- 精靈概覽：[入門引導精靈](/start/wizard)
- macOS 應用程式入門：[入門](/start/onboarding)
- 設定參考：[Gateway 設定](/gateway/configuration)
- 提供者：[WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)、[Google Chat](/channels/googlechat)、[Signal](/channels/signal)、[BlueBubbles](/channels/bluebubbles)（iMessage）、[iMessage](/channels/imessage)（舊版）
- Skills：[Skills](/tools/skills)、[Skills 設定](/tools/skills-config)
