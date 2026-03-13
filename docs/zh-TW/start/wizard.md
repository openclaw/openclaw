---
summary: >-
  CLI onboarding wizard: guided setup for gateway, workspace, channels, and
  skills
read_when:
  - Running or configuring the onboarding wizard
  - Setting up a new machine
title: Onboarding Wizard (CLI)
sidebarTitle: "Onboarding: CLI"
---

# 新手引導精靈（CLI）

新手引導精靈是設定 OpenClaw 在 macOS、Linux 或 Windows（透過 WSL2；強烈推薦）上的**建議**方式。
它會在一個引導流程中設定本地 Gateway 或遠端 Gateway 連線，以及頻道、技能和工作區預設值。

```bash
openclaw onboard
```

<Info>
最快速的首次聊天：開啟控制介面（不需設定頻道）。執行
`openclaw dashboard` 並在瀏覽器中聊天。文件：[Dashboard](/web/dashboard)。
</Info>

之後要重新設定：

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` 不代表非互動模式。腳本請使用 `--non-interactive`。
</Note>

<Tip>
新手引導精靈包含一個網路搜尋步驟，您可以選擇提供者（Perplexity、Brave、Gemini、Grok 或 Kimi）並貼上 API 金鑰，讓代理能使用 `web_search`。您也可以稍後用
`openclaw configure --section web` 來設定。文件：[Web tools](/tools/web)。
</Tip>

## 快速開始 vs 進階設定

精靈會從 **快速開始**（預設）與 **進階設定**（完全控制）開始。

<Tabs>
  <Tab title="快速開始（預設）">
    - 本地 gateway（迴圈回路）
    - 工作區預設（或現有工作區）
    - Gateway 連接埠 **18789**
    - Gateway 認證 **Token**（自動產生，即使是迴圈回路）
    - 新本地設定的工具政策預設：`tools.profile: "coding"`（保留現有明確設定的設定檔）
    - DM 隔離預設：本地新手引導在未設定時寫入 `session.dmScope: "per-channel-peer"`。詳情：[CLI Onboarding Reference](/start/wizard-cli-reference#outputs-and-internals)
    - Tailscale 曝露 **關閉**
    - Telegram + WhatsApp 私訊預設為 **允許清單**（系統會提示您輸入電話號碼）
  </Tab>
  <Tab title="進階設定（完全控制）">
    - 顯示每個步驟（模式、工作區、gateway、頻道、守護程序、技能）。
  </Tab>
</Tabs>

## 精靈會設定什麼

**本地模式（預設）** 會引導您完成以下步驟：

1. **模型/認證** — 選擇任何支援的提供者/認證流程（API 金鑰、OAuth 或設定token），包含自訂提供者
   （OpenAI 相容、Anthropic 相容或未知自動偵測）。選擇預設模型。
   安全提醒：如果此代理會執行工具或處理 webhook/hook 內容，請優先使用最新一代最強模型並保持工具政策嚴格。較弱/舊版模型較容易被注入提示。
   非互動執行時，`--secret-input-mode ref` 會在認證設定檔中以環境變數參考取代明文 API 金鑰。
   非互動 `ref` 模式下，必須設定提供者環境變數；若未設定，帶入內嵌金鑰參數會快速失敗。
   互動執行時，選擇秘密參考模式可指向環境變數或已設定的提供者參考 (`file` 或 `exec`)，並在儲存前快速驗證。
2. **工作區** — 代理檔案位置（預設 `~/.openclaw/workspace`）。會初始化啟動檔案。
3. **Gateway** — 連接埠、綁定地址、認證模式、Tailscale 曝露。
   互動 token 模式下，選擇預設明文 token 儲存或改用 SecretRef。
   非互動 token SecretRef 路徑：`--gateway-token-ref-env <ENV_VAR>`。
4. **頻道** — WhatsApp、Telegram、Discord、Google Chat、Mattermost、Signal、BlueBubbles 或 iMessage。
5. **守護程序** — 安裝 LaunchAgent（macOS）或 systemd 使用者單元（Linux/WSL2）。
   若 token 認證需要 token 且 `gateway.auth.token` 由 SecretRef 管理，守護程序安裝會驗證但不會將解析後的 token 寫入監督服務環境元資料。
   若 token 認證需要 token 且設定的 token SecretRef 未解析，守護程序安裝會被阻擋並提供可行指引。
   若同時設定了 `gateway.auth.token` 和 `gateway.auth.password`，且 `gateway.auth.mode` 未設定，守護程序安裝會被阻擋，直到明確設定模式。
6. **健康檢查** — 啟動 Gateway 並確認其運作中。
7. **技能** — 安裝推薦技能及選用相依套件。

<Note>
重新執行精靈**不會**清除任何東西，除非您明確選擇 **重置**（或帶入 `--reset`）。
CLI `--reset` 預設包含設定、憑證和會話；使用 `--reset-scope full` 可包含工作區。
若設定無效或含有舊版金鑰，精靈會要求您先執行 `openclaw doctor`。
</Note>

**遠端模式** 僅設定本地用戶端以連接其他地方的 Gateway。
它**不會**在遠端主機上安裝或更改任何東西。

## 新增另一個代理程式

使用 `openclaw agents add <name>` 來建立一個擁有自己工作區、
工作階段和認證設定檔的獨立代理程式。
若未使用 `--workspace` 執行，則會啟動設定精靈。

設定內容：

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

注意事項：

- 預設工作區遵循 `~/.openclaw/workspace-<agentId>`。
- 新增 `bindings` 以路由入站訊息（設定精靈可完成此步驟）。
- 非互動式旗標：`--model`、`--agent-dir`、`--bind`、`--non-interactive`。

## 完整參考

欲取得詳細的逐步說明與設定輸出，請參閱
[CLI 新手引導參考](/start/wizard-cli-reference)。
非互動式範例請見 [CLI 自動化](/start/wizard-cli-automation)。
更深入的技術參考，包括 RPC 細節，請參閱
[設定精靈參考](/reference/wizard)。

## 相關文件

- CLI 指令參考：[`openclaw onboard`](/cli/onboard)
- 新手引導總覽：[新手引導總覽](/start/onboarding-overview)
- macOS 應用程式新手引導：[新手引導](/start/onboarding)
- 代理程式首次啟動流程：[代理程式啟動](/start/bootstrapping)
