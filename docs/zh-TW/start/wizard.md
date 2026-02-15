---
summary: "CLI 新手導覽精靈：Gateway、工作空間、頻道和 Skills 的引導式設定"
read_when:
  - 執行或設定新手導覽精靈時
  - 設定新機器時
title: "新手導覽精靈 (CLI)"
sidebarTitle: "新手導覽：CLI"
---

# 新手導覽精靈 (CLI)

新手導覽精靈是**建議**在 macOS、Linux 或 Windows（透過 WSL2；強烈建議）上設定 OpenClaw 的方式。它會在一個引導式流程中設定本機 Gateway 或遠端 Gateway 連線，以及頻道、Skills 和工作空間預設值。

```bash
openclaw onboard
```

<Info>
最快的初次聊天：開啟控制介面（無需設定頻道）。執行 `openclaw dashboard` 並在瀏覽器中聊天。文件：[儀表板](/web/dashboard)。
</Info>

若要稍後重新設定：

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` 不表示非互動模式。對於腳本，請使用 `--non-interactive`。
</Note>

<Tip>
建議：設定 Brave Search API 金鑰，以便智慧代理可以使用 `web_search`（`web_fetch` 無需金鑰即可運作）。最簡單的路徑：`openclaw configure --section web`，這會儲存 `tools.web.search.apiKey`。文件：[網頁工具](/tools/web)。
</Tip>

## 快速開始 vs 進階

精靈會以**快速開始**（預設值）或**進階**（完全控制）模式啟動。

<Tabs>
  <Tab title="快速開始 (預設值)">
    - 本機 Gateway (local loopback)
    - 工作空間預設值（或現有工作空間）
    - Gateway 連接埠 **18789**
    - Gateway 驗證 **Token**（自動產生，即使在 local loopback 上也一樣）
    - Tailscale 暴露 **關閉**
    - Telegram + WhatsApp 私訊預設為**允許清單**（系統會提示您輸入電話號碼）
  </Tab>
  <Tab title="進階 (完全控制)">
    - 顯示每個步驟（模式、工作空間、Gateway、頻道、守護程式、Skills）。
  </Tab>
</Tabs>

## 精靈設定了什麼

**本機模式（預設）**會引導您完成這些步驟：

1.  **模型/驗證** — Anthropic API 金鑰（建議）、OpenAI 或自訂供應商（與 OpenAI 相容、與 Anthropic 相容或未知自動偵測）。選擇預設模型。
2.  **工作空間** — 智慧代理檔案的位置（預設 `~/.openclaw/workspace`）。播種啟動檔案。
3.  **Gateway** — 連接埠、綁定位址、驗證模式、Tailscale 暴露。
4.  **頻道** — WhatsApp、Telegram、Discord、Google Chat、Mattermost、Signal、BlueBubbles 或 iMessage。
5.  **守護程式** — 安裝 LaunchAgent (macOS) 或 systemd 使用者單元 (Linux/WSL2)。
6.  **健康檢查** — 啟動 Gateway 並驗證其是否正在執行。
7.  **Skills** — 安裝建議的 Skills 和可選的依賴項。

<Note>
重新執行精靈**不會**清除任何內容，除非您明確選擇**重設**（或傳遞 `--reset`）。如果設定無效或包含舊版鍵名，精靈會要求您先執行 `openclaw doctor`。
</Note>

**遠端模式**只會設定本機用戶端連線到其他地方的 Gateway。它**不會**在遠端主機上安裝或更改任何內容。

## 新增另一個智慧代理

使用 `openclaw agents add <name>` 建立一個單獨的智慧代理，擁有自己的工作空間、工作階段和驗證設定檔。在沒有 `--workspace` 的情況下執行會啟動精靈。

它設定了什麼：

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

注意事項：

- 預設工作空間遵循 `~/.openclaw/workspace-<agentId>`。
- 新增 `bindings` 以路由傳入訊息（精靈可以執行此操作）。
- 非互動式旗標：`--model`、`--agent-dir`、`--bind`、`--non-interactive`。

## 完整參考

有關詳細的步驟分解、非互動式腳本、Signal 設定、RPC API 以及精靈寫入的所有設定欄位清單，請參閱[精靈參考](/reference/wizard)。

## 相關文件

- CLI 指令參考：[`openclaw onboard`](/cli/onboard)
- 新手導覽概觀：[新手導覽概觀](/start/onboarding-overview)
- macOS 應用程式新手導覽：[新手導覽](/start/onboarding)
- 智慧代理首次執行儀式：[智慧代理啟動](/start/bootstrapping)
