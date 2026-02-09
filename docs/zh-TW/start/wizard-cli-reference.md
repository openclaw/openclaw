---
summary: "CLI 入門引導流程、驗證／模型設定、輸出與內部機制的完整參考"
read_when:
  - 你需要 openclaw 入門引導的詳細行為
  - 你正在除錯入門引導結果或整合入門引導用戶端
title: "CLI 入門引導參考"
sidebarTitle: "CLI 參考"
---

# CLI 入門引導參考

This page is the full reference for `openclaw onboard`.
42. 簡短指南請見 [Onboarding Wizard (CLI)](/start/wizard)。

## What the wizard does

本機模式（預設）會引導你完成：

- 模型與身分驗證設定（OpenAI Code 訂閱 OAuth、Anthropic API 金鑰或 setup token，另含 MiniMax、GLM、Moonshot 與 AI Gateway 選項）
- 工作區位置與啟動用檔案
- Gateway 設定（連接埠、繫結、驗證、 tailscale）
- 頻道與提供者（Telegram、WhatsApp、Discord、Google Chat、Mattermost 外掛、Signal）
- 常駐程式安裝（LaunchAgent 或 systemd 使用者單位）
- 健康檢查
- Skills 設定

遠端模式會設定此機器以連線到其他位置的 Gateway。
它不會在遠端主機上安裝或修改任何內容。
It does not install or modify anything on the remote host.

## Local flow details

<Steps>
  <Step title="Existing config detection">
    - If `~/.openclaw/openclaw.json` exists, choose Keep, Modify, or Reset.
    47. - 重新執行精靈不會清除任何內容，除非你明確選擇重設（或傳入 `--reset`）。
    - If config is invalid or contains legacy keys, the wizard stops and asks you to run `openclaw doctor` before continuing.
    - Reset uses `trash` and offers scopes:
      - Config only
      - Config + credentials + sessions
      - Full reset (also removes workspace)  
</Step>
  <Step title="Model and auth">
    - 完整選項矩陣請見 [驗證與模型選項](#auth-and-model-options)。
  </Step>
  <Step title="Workspace">
    50. - 預設為 `~/.openclaw/workspace`（可設定）。
    - Seeds workspace files needed for first-run bootstrap ritual.
    - 工作區配置：[Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Prompts for port, bind, auth mode, and tailscale exposure.
    - Recommended: keep token auth enabled even for loopback so local WS clients must authenticate.
    - Disable auth only if you fully trust every local process.
    - Non-loopback binds still require auth.
  </Step>
  <Step title="Channels">
    
    - [WhatsApp](/channels/whatsapp)：選用的 QR 登入
    - [Telegram](/channels/telegram)：機器人權杖
    - [Discord](/channels/discord)：機器人權杖
    - [Google Chat](/channels/googlechat)：服務帳戶 JSON + webhook 受眾
    - [Mattermost](/channels/mattermost) 外掛：機器人權杖 + 基底 URL
    - [Signal](/channels/signal)：選用的 `signal-cli` 安裝 + 帳戶設定
    - [BlueBubbles](/channels/bluebubbles)：建議用於 iMessage；伺服器 URL + 密碼 + webhook
    - [iMessage](/channels/imessage)：舊版 `imsg` CLI 路徑 + DB 存取
    - 私訊安全性：預設為配對。第一則私訊會傳送代碼；透過
      `openclaw pairing approve  First DM sends a code; approve via
      `openclaw pairing approve <channel><code>` 核准，或使用允許清單。
  </Step><code>` or use allowlists.
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Requires logged-in user session; for headless, use a custom LaunchDaemon (not shipped).
    - Linux and Windows via WSL2: systemd user unit
      - Wizard attempts `loginctl enable-linger <user>` so gateway stays up after logout.
      - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
    - 執行環境選擇：Node（建議；WhatsApp 與 Telegram 需要）。 Bun is not recommended.
  </Step>
  <Step title="Health check">
    - Starts gateway (if needed) and runs `openclaw health`.
    - `openclaw status --deep` adds gateway health probes to status output.
  </Step>
  <Step title="Skills">
    - 讀取可用的技能並檢查需求。
    - Lets you choose node manager: npm or pnpm (bun not recommended).
    - Installs optional dependencies (some use Homebrew on macOS).
  </Step>
  <Step title="Finish">
    - Summary and next steps, including iOS, Android, and macOS app options.
  </Step>
</Steps>

<Note>
If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.
If Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).
</Note>

## 遠端模式細節

遠端模式會設定此機器以連線到其他位置的 Gateway。

<Info>
遠端模式不會在遠端主機上安裝或修改任何內容。
</Info>

你需要設定：

- 遠端 Gateway URL（`ws://...`）
- 若遠端 Gateway 需要驗證，則設定權杖（建議）

<Note>

- 若 Gateway 僅限 loopback，請使用 SSH 通道或 tailnet。
- 裝置探索提示：
  - macOS：Bonjour（`dns-sd`）
  - Linux：Avahi（`avahi-browse`）

- 探索提示：
  - macOS：Bonjour（`dns-sd`）
  - Linux：Avahi（`avahi-browse`）
</Note>

## Auth and model options

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    若存在 `ANTHROPIC_API_KEY` 則使用，否則提示輸入金鑰，並儲存供常駐程式使用。
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS：檢查鑰匙圈項目「Claude Code-credentials」
    - Linux 與 Windows：若存在則重用 `~/.claude/.credentials.json`

    ```
    在 macOS 上，請選擇「Always Allow」，以避免 launchd 啟動被阻擋。
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Run `claude setup-token` on any machine, then paste the token.
    You can name it; blank uses default.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    若存在 `~/.codex/auth.json`，精靈可重用它。
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    瀏覽器流程；貼上 `code#state`。

    ```
    當模型未設定或為 `openai/*` 時，會將 `agents.defaults.model` 設為 `openai-codex/gpt-5.3-codex`。
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    若存在 `OPENAI_API_KEY` 則使用，否則提示輸入金鑰，並將其儲存至
    `~/.openclaw/.env` 以供 launchd 讀取。

    ```
    當模型未設定、為 `openai/*`，或為 `openai-codex/*` 時，會將 `agents.defaults.model` 設為 `openai/gpt-5.1-codex`。
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    提示輸入 `XAI_API_KEY`，並將 xAI 設定為模型提供者。
  </Accordion>
  <Accordion title="OpenCode Zen">
    Prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`).
    
    提示輸入 `OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`）。
    設定 URL：[opencode.ai/auth](https://opencode.ai/auth)。
  
  </Accordion>
  <Accordion title="API key (generic)">
    為你儲存金鑰。
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    提示輸入 `AI_GATEWAY_API_KEY`。
    
    提示輸入 `AI_GATEWAY_API_KEY`。
    更多說明：[Vercel AI Gateway](/providers/vercel-ai-gateway)。
  
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    提示輸入帳戶 ID、Gateway ID，以及 `CLOUDFLARE_AI_GATEWAY_API_KEY`。
    More detail: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Config is auto-written.
    More detail: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Prompts for `SYNTHETIC_API_KEY`.
    More detail: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    
    Moonshot（Kimi K2）與 Kimi Coding 的設定會自動寫入。
    更多說明：[Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)。
  
    More detail: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
    Leaves auth unconfigured.
  </Accordion>
</AccordionGroup>

模型行為：

- Pick default model from detected options, or enter provider and model manually.
- Wizard runs a model check and warns if the configured model is unknown or missing auth.

憑證與設定檔路徑：

- OAuth 憑證：`~/.openclaw/credentials/oauth.json`
- 驗證設定檔（API 金鑰 + OAuth）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
無頭與伺服器提示：在有瀏覽器的機器上完成 OAuth，然後將
`~/.openclaw/credentials/oauth.json`（或 `$OPENCLAW_STATE_DIR/credentials/oauth.json`）
複製到 Gateway 主機。
</Note>

## Outputs and internals

`~/.openclaw/openclaw.json` 中的常見欄位：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`（若選擇 Minimax）
- `gateway.*`（模式、繫結、驗證、 tailscale）
- `channels.telegram.botToken`、`channels.discord.token`、`channels.signal.*`、`channels.imessage.*`
- 在提示時選擇加入的頻道允許清單（Slack、Discord、Matrix、Microsoft Teams）（名稱會在可能時解析為 ID）
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

<Note>
部分頻道以外掛形式提供。 在入門設定期間選取時，精靈會在頻道設定前提示安裝外掛（npm 或本機路徑）。
</Note>

Gateway 精靈 RPC：

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

用戶端（macOS 應用程式與 Control UI）可在不重新實作入門引導邏輯的情況下呈現步驟。

Signal 設定行為：

- Downloads the appropriate release asset
- 儲存至 `~/.openclaw/tools/signal-cli/<version>/`
- 在設定中寫入 `channels.signal.cliPath`
- JVM 版本需要 Java 21
- Native builds are used when available
- Windows 透過 WSL2，並在 WSL 內依循 Linux 的 signal-cli 流程

## Related docs

- 入門引導樞紐：[入門引導精靈（CLI）](/start/wizard)
- 自動化與腳本：[CLI 自動化](/start/wizard-cli-automation)
- 指令參考：[`openclaw onboard`](/cli/onboard)
