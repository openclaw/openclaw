# 🦞 OpenClaw — 個人 AI 助手

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.png">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <strong>EXFOLIATE! EXFOLIATE!</strong>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**OpenClaw** 是一個你可以在自己的裝置上運行的 _個人 AI 助手_。
它在你已經使用的頻道（WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、Microsoft Teams、WebChat）以及擴展頻道（如 BlueBubbles、Matrix、Zalo 和 Zalo Personal）上回應你。它可以在 macOS/iOS/Android 上說話與聆聽，並能渲染一個受你控制的即時 Canvas。Gateway 只是控制平面 (control plane) —— 產品核心是 AI 助手。

如果你想要一個感覺像在地執行、快速且永遠在線的個人、單使用者助手，這就是你的選擇。

[網站](https://openclaw.ai) · [文件](https://docs.openclaw.ai) · [願景](VISION.md) · [DeepWiki](https://deepwiki.com/openclaw/openclaw) · [入門指南](https://docs.openclaw.ai/start/getting-started) · [更新](https://docs.openclaw.ai/install/updating) · [展示](https://docs.openclaw.ai/start/showcase) · [常見問題](https://docs.openclaw.ai/start/faq) · [精靈](https://docs.openclaw.ai/start/wizard) · [Nix](https://github.com/openclaw/nix-openclaw) · [Docker](https://docs.openclaw.ai/install/docker) · [Discord](https://discord.gg/clawd)

建議設定：在你的終端機中運行上線精靈 (`openclaw onboard`)。
精靈將引導你逐步設定 Gateway、工作區、頻道與 Skills。CLI 精靈是推薦的路徑，可在 **macOS、Linux 與 Windows (透過 WSL2；強烈建議)** 上運行。
支援 npm、pnpm 或 bun。
新安裝？從這裡開始：[入門指南](https://docs.openclaw.ai/start/getting-started)

## 贊助商

| OpenAI                                                            | Blacksmith                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [![OpenAI](docs/assets/sponsors/openai.svg)](https://openai.com/) | [![Blacksmith](docs/assets/sponsors/blacksmith.svg)](https://blacksmith.sh/) |

**訂閱 (OAuth):**

- **[Anthropic](https://www.anthropic.com/)** (Claude Pro/Max)
- **[OpenAI](https://openai.com/)** (ChatGPT/Codex)

模型建議：雖然支援任何模型，但我強烈建議使用 **Anthropic Pro/Max (100/200) + Opus 4.6**，以獲得更強的長上下文處理能力和更好的 Prompt Injection 抵禦能力。請參閱 [上線引導](https://docs.openclaw.ai/start/onboarding)。

## 模型 (選擇 + 驗證)

- 模型配置 + CLI: [模型](https://docs.openclaw.ai/concepts/models)
- 驗證設定輪換 (OAuth vs API keys) + 備援: [模型容錯移轉](https://docs.openclaw.ai/concepts/model-failover)

## 安裝 (建議)

運行環境：**Node ≥22**。

```bash
npm install -g openclaw@latest
# 或: pnpm add -g openclaw@latest

openclaw onboard --install-daemon
```

精靈會安裝 Gateway 守護程序 (launchd/systemd 使用者服務)，使其保持運行。

## 快速上手 (TL;DR)

運行環境：**Node ≥22**。

完整的初學者指南 (驗證、配對、頻道)：[入門指南](https://docs.openclaw.ai/start/getting-started)

```bash
openclaw onboard --install-daemon

openclaw gateway --port 18789 --verbose

# 發送訊息
openclaw message send --to +1234567890 --message "來自 OpenClaw 的問候"

# 與助手對話 (可選擇回傳至任何已連接頻道：WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage/BlueBubbles/Microsoft Teams/Matrix/Zalo/Zalo Personal/WebChat)
openclaw agent --message "出貨檢查清單" --thinking high
```

正在升級？[更新指南](https://docs.openclaw.ai/install/updating) (並運行 `openclaw doctor`)。

## 開發頻道

- **stable**: 已標記的版本 (`vYYYY.M.D` 或 `vYYYY.M.D-<patch>`)，npm dist-tag 為 `latest`。
- **beta**: 預發佈標記 (`vYYYY.M.D-beta.N`)，npm dist-tag 為 `beta` (可能缺少 macOS 應用程式)。
- **dev**: `main` 分支的最新動態，發佈時 npm dist-tag 為 `dev`。

切換頻道 (git + npm)：`openclaw update --channel stable|beta|dev`。
詳情：[開發頻道](https://docs.openclaw.ai/install/development-channels)。

## 從源碼開發

推薦使用 `pnpm`。Bun 是直接運行 TypeScript 的可選選項。

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw

pnpm install
pnpm ui:build # 首次運行會自動安裝 UI 依賴
pnpm build

pnpm openclaw onboard --install-daemon

# 開發循環 (TS 變更後自動重新載入)
pnpm gateway:watch
```

注意：`pnpm openclaw ...` 直接運行 TypeScript (透過 `tsx`)。`pnpm build` 產生 `dist/`，用於透過 Node 或封裝後的 `openclaw` 二進位檔運行。

## 安全預設 (私訊存取)

OpenClaw 連接到真實的通訊介面。請將傳入的私訊視為 **不可信輸入**。

完整安全指南：[安全性](https://docs.openclaw.ai/gateway/security)

Telegram/WhatsApp/Signal/iMessage/Microsoft Teams/Discord/Google Chat/Slack 的預設行為：

- **私訊配對 (DM pairing)** (`dmPolicy="pairing"`): 未知發送者會收到一個簡短的配對碼，機器人不會處理他們的訊息。
- 批准方式：`openclaw pairing approve <channel> <code>` (隨後發送者將被加入本地白名單)。
- 公開傳入私訊需要明確加入：設定 `dmPolicy="open"` 並在頻道白名單 (`allowFrom`) 中包含 `"*"`。

運行 `openclaw doctor` 來檢查風險或設定錯誤的私訊政策。

## 功能亮點

- **[在地優先的 Gateway]** — 用於會話、頻道、工具與事件的單一控制平面。
- **[多頻道收件匣]** — WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, BlueBubbles (iMessage), iMessage (舊版), Microsoft Teams, Matrix, Zalo, Zalo Personal, WebChat, macOS, iOS/Android。
- **[多 Agent 路由]** — 將傳入的頻道/帳號/對象路由到隔離的 Agent (工作區 + 每個 Agent 專屬會話)。
- **[語音喚醒] + [對話模式]** — 使用 ElevenLabs 在 macOS/iOS/Android 上實現永遠在線的語音。
- **[即時 Canvas]** — 透過 [A2UI] 實現由 Agent 驅動的視覺化工作區。
- **[一等公民工具]** — 瀏覽器控制、Canvas、節點、Cron、會話以及 Discord/Slack 動作。
- **[隨身應用程式]** — macOS 選單列應用程式 + iOS/Android [節點]。
- **[上線引導] + [Skills]** — 由精靈驅動的設定，包含內建/受管/工作區 Skills。

## 核心子系統

- **[Gateway WebSocket 網路]** — 用於客戶端、工具與事件的單一 WS 控制平面。
- **[Tailscale 公開]** — 為 Gateway 控制台 + WS 提供 Serve/Funnel 功能。
- **[瀏覽器控制]** — 具備 CDP 控制的 OpenClaw 代管型 Chrome/Chromium。
- **[Canvas + A2UI]** — Agent 驅動的視覺化工作區。
- **[語音喚醒] + [對話模式]** — 永遠在線的語音與持續對話。
- **[節點 (Nodes)]** — Canvas、相機快照/剪輯、螢幕錄製、`location.get`、通知，以及僅限 macOS 的 `system.run`/`system.notify`。

## 如何運作 (簡述)

```
WhatsApp / Telegram / Slack / Discord / Google Chat / Signal / iMessage / BlueBubbles / Microsoft Teams / Matrix / Zalo / Zalo Personal / WebChat
               │
               ▼
┌───────────────────────────────┐
│            Gateway            │
│          (控制平面)           │
│     ws://127.0.0.1:18789      │
└──────────────┬────────────────┘
               │
               ├─ Pi Agent (RPC)
               ├─ CLI (openclaw …)
               ├─ WebChat UI
               ├─ macOS 應用程式
               └─ iOS / Android 節點
```

## 社群

參閱 [CONTRIBUTING.md](CONTRIBUTING.md) 以了解規範、維護者以及如何提交 PR。
歡迎 AI/vibe 編碼的 PR！🤖

特別感謝 [Mario Zechner](https://mariozechner.at/) 的支持與 [pi-mono](https://github.com/badlogic/pi-mono)。
特別感謝 Adam Doppelt 提供的 lobster.bot。
