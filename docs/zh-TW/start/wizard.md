---
summary: "CLI 新手導覽精靈：Gateway、工作區、頻道與 Skills 的引導式設定"
read_when:
  - 執行或設定新手導覽精靈
  - 設定新機器
title: "新手導覽精靈 (CLI)"
sidebarTitle: "新手導覽：CLI"
---

# 新手導覽精靈 (CLI)

新手導覽精靈是在 macOS、Linux 或 Windows（透過 WSL2；強烈建議）上設定 OpenClaw 的**推薦**方式。
它能透過引導流程一次設定好本地 Gateway 或遠端 Gateway 連線，以及頻道、Skills 和工作區預設值。

```bash
openclaw onboard
```

<Info>
最快開始第一次對話的方式：開啟控制介面（不需要設定頻道）。執行
`openclaw dashboard` 並在瀏覽器中對話。文件：[Dashboard](/web/dashboard)。
</Info>

稍後重新設定：

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` 並不代表非互動模式。若要用於腳本，請使用 `--non-interactive`。
</Note>

<Tip>
建議：設定 Brave Search API 金鑰，讓智慧代理可以使用 `web_search`
（`web_fetch` 不需要金鑰即可運作）。最簡單的路徑：執行 `openclaw configure --section web`
，這會儲存 `tools.web.search.apiKey`。文件：[Web 工具](/tools/web)。
</Tip>

## 快速開始 vs 進階

精靈會從 **快速開始 (QuickStart)**（預設值）對比 **進階 (Advanced)**（完整控制）開始。

<Tabs>
  <Tab title="快速開始 (預設值)">
    - 本地 Gateway (local loopback)
    - 工作區預設值（或現有工作區）
    - Gateway 埠號 **18789**
    - Gateway 驗證方式 **Token**（自動產生，即使在 local loopback 也是如此）
    - Tailscale 暴露 **關閉**
    - Telegram + WhatsApp 私訊預設為 **白名單 (allowlist)**（系統會提示您輸入電話號碼）
  </Tab>
  <Tab title="進階 (完整控制)">
    - 顯示每個步驟（模式、工作區、Gateway、頻道、守護行程 (daemon)、Skills）。
  </Tab>
</Tabs>

## 精靈設定的內容

**本地模式 (預設)** 會帶領您完成以下步驟：

1. **模型/驗證** — Anthropic API 金鑰（推薦）、OpenAI 或自定義供應商
   （相容 OpenAI、相容 Anthropic 或未知自動偵測）。選擇預設模型。
2. **工作區** — 智慧代理檔案的存放位置（預設為 `~/.openclaw/workspace`）。產生引導程式 (bootstrap) 檔案。
3. **Gateway** — 埠號、綁定地址、驗證模式、Tailscale 暴露。
4. **頻道** — WhatsApp、Telegram、Discord、Google Chat、Mattermost、Signal、BlueBubbles 或 iMessage。
5. **守護行程 (Daemon)** — 安裝 LaunchAgent (macOS) 或 systemd 使用者單元 (Linux/WSL2)。
6. **健康檢查** — 啟動 Gateway 並確認其正在執行。
7. **Skills** — 安裝推薦的 Skills 和選用的相依項目。

<Note>
重新執行精靈**不會**清除任何內容，除非您明確選擇 **Reset**（或傳遞 `--reset`）。
如果設定無效或包含舊版鍵名，精靈會要求您先執行 `openclaw doctor`。
</Note>

**遠端模式** 僅設定本地用戶端以連線至其他地方的 Gateway。
它**不會**在遠端主機上安裝或變更任何內容。

## 新增另一個智慧代理

使用 `openclaw agents add <name>` 建立一個獨立的智慧代理，擁有自己的工作區、
工作階段和驗證設定檔。在不帶 `--workspace` 的情況下執行會啟動精靈。

它設定的內容：

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

備註：

- 預設工作區路徑為 `~/.openclaw/workspace-<agentId>`。
- 新增 `bindings` 來路由傳入訊息（精靈可以完成此操作）。
- 非互動模式標記：`--model`、`--agent-dir`、`--bind`、`--non-interactive`。

## 完整參考指南

關於詳細的逐步拆解、非互動式腳本編寫、Signal 設定、
RPC API 以及精靈寫入的完整設定欄位列表，請參閱
[精靈參考指南](/reference/wizard)。

## 相關文件

- CLI 指令參考：[`openclaw onboard`](/cli/onboard)
- 新手導覽概覽：[新手導覽概覽](/start/onboarding-overview)
- macOS 應用程式新手導覽：[新手導覽](/start/onboarding)
- 智慧代理首度執行儀式：[智慧代理引導程式](/start/bootstrapping)
