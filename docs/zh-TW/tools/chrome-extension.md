---
summary: "Chrome 擴充功能：讓 OpenClaw 控制您現有的 Chrome 分頁"
read_when:
  - 您希望智慧代理控制現有的 Chrome 分頁（工具列按鈕）
  - 您需要透過 Tailscale 進行遠端 Gateway + 本機瀏覽器自動化
  - 您想了解瀏覽器接管的資安風險
title: "Chrome 擴充功能"
---

# Chrome 擴充功能 (瀏覽器中繼)

OpenClaw Chrome 擴充功能讓智慧代理控制您**現有的 Chrome 分頁**（您的正常 Chrome 視窗），而不是啟動一個單獨由 openclaw 管理的 Chrome 個人資料。

連結/分離透過**單一 Chrome 工具列按鈕**完成。

## 這是什麼（概念）

這包含三個部分：

- **瀏覽器控制服務** (Gateway 或節點)：智慧代理/工具呼叫的 API（透過 Gateway）
- **本機中繼伺服器** (loopback CDP)：連接控制伺服器和擴充功能 (`http://127.0.0.1:18792` 預設)
- **Chrome MV3 擴充功能**：使用 `chrome.debugger` 附加到活動分頁，並將 CDP 訊息傳輸到中繼。

然後，OpenClaw 透過正常的 `browser` 工具介面（選擇正確的個人資料）控制附加的分頁。

## 安裝/載入（解壓縮）

1. 將擴充功能安裝到穩定的本機路徑：

```bash
openclaw browser extension install
```

2. 列印已安裝的擴充功能目錄路徑：

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- 啟用「開發人員模式」
- 「載入未封裝項目」→ 選擇上面列印的目錄

4. 將擴充功能釘選。

## 更新（無建置步驟）

此擴充功能作為靜態檔案隨 OpenClaw 版本 (npm 套件) 一起提供。沒有單獨的「建置」步驟。

升級 OpenClaw 後：

- 重新執行 `openclaw browser extension install` 以重新整理 OpenClaw 狀態目錄下已安裝的檔案。
- Chrome → `chrome://extensions` → 在擴充功能上按一下「重新載入」。

## 使用（無需額外設定）

OpenClaw 隨附一個名為 `chrome` 的內建瀏覽器個人資料，該個人資料指向預設連接埠上的擴充功能中繼。

使用方式：

- CLI: `openclaw browser --browser-profile chrome tabs`
- 智慧代理工具: `browser` 與 `profile="chrome"`

如果您想要不同的名稱或不同的中繼連接埠，請建立自己的個人資料：

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## 連結/分離（工具列按鈕）

- 開啟您希望 OpenClaw 控制的分頁。
- 按一下擴充功能圖示。
  - 連結時，徽章顯示 `ON`。
- 再次按一下以分離。

## 它控制哪個分頁？

- 它**不會**自動控制「您正在查看的任何分頁」。
- 它**僅控制您透過按一下工具列按鈕明確連結的分頁**。
- 若要切換：開啟另一個分頁，然後按一下該處的擴充功能圖示。

## 徽章 + 常見錯誤

- `ON`：已連結；OpenClaw 可以控制該分頁。
- `…`：正在連線到本機中繼。
- `!`：中繼無法到達（最常見：瀏覽器中繼伺服器未在此機器上執行）。

如果您看到 `!`：

- 確保 Gateway 在本機執行（預設設定），如果 Gateway 在其他地方執行，則在此機器上執行節點主機。
- 開啟擴充功能「選項」頁面；它會顯示中繼是否可到達。

## 遠端 Gateway（使用節點主機）

### 本機 Gateway（與 Chrome 在同一機器上）— 通常**無需額外步驟**

如果 Gateway 與 Chrome 在同一機器上執行，它會在 loopback 上啟動瀏覽器控制服務，
並自動啟動中繼伺服器。擴充功能與本機中繼通訊；CLI/工具呼叫會傳送到 Gateway。

### 遠端 Gateway（Gateway 在其他地方執行）— **執行節點主機**

如果您的 Gateway 在另一台機器上執行，請在執行 Chrome 的機器上啟動節點主機。
Gateway 會將瀏覽器動作代理到該節點；擴充功能 + 中繼會保留在瀏覽器機器本機。

如果連接了多個節點，請使用 `gateway.nodes.browser.node` 釘選一個，或設定 `gateway.nodes.browser.mode`。

## 沙箱隔離（工具容器）

如果您的智慧代理工作階段是沙箱隔離 (`agents.defaults.sandbox.mode != "off"`)，則 `browser` 工具可能會受到限制：

- 預設情況下，沙箱隔離工作階段通常針對**沙箱瀏覽器** (`target="sandbox"`)，而不是您的主機 Chrome。
- Chrome 擴充功能中繼接管需要控制**主機**瀏覽器控制伺服器。

選項：

- 最簡單：從**非沙箱隔離**的工作階段/智慧代理使用擴充功能。
- 或允許沙箱隔離工作階段的主機瀏覽器控制：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

然後確保工具未被工具策略拒絕，並且（如果需要）使用 `target="host"` 呼叫 `browser`。

偵錯: `openclaw sandbox explain`

## 遠端存取技巧

- 將 Gateway 和節點主機保持在相同的 tailnet 上；避免將中繼連接埠暴露給 LAN 或公共網際網路。
- 有意地配對節點；如果您不希望遠端控制，請停用瀏覽器代理路由 (`gateway.nodes.browser.mode="off"`)。

## 「擴充功能路徑」的運作方式

`openclaw browser extension path` 列印包含擴充功能檔案的**已安裝**磁碟目錄。

CLI 故意**不**列印 `node_modules` 路徑。請務必先執行 `openclaw browser extension install`，將擴充功能複製到 OpenClaw 狀態目錄下一個穩定的位置。

如果您移動或刪除該安裝目錄，Chrome 會將擴充功能標記為損壞，直到您從有效路徑重新載入它。

## 資安風險（請閱讀此部分）

這功能強大且具有風險。請將其視為允許模型「控制您的瀏覽器」。

- 此擴充功能使用 Chrome 的偵錯工具 API (`chrome.debugger`)。連結時，模型可以：
  - 在該分頁中點擊/輸入/導航
  - 讀取頁面內容
  - 存取該分頁已登入工作階段可以存取的任何內容
- 這**並非隔離**，不像專用的 openclaw 管理個人資料。
  - 如果您連結到您的日常使用個人資料/分頁，您將授予對該帳戶狀態的存取權。

建議：

- 建議為擴充功能中繼使用專用的 Chrome 個人資料（與您的個人瀏覽分開）。
- 讓 Gateway 和任何節點主機僅限於 tailnet；依賴 Gateway 驗證 + 節點配對。
- 避免透過 LAN (`0.0.0.0`) 暴露中繼連接埠，並避免使用 Funnel (公共)。
- 中繼會阻擋非擴充功能來源，並要求 CDP 用戶端提供內部驗證權杖。

相關連結：

- 瀏覽器工具總覽: [Browser](/tools/browser)
- 資安稽核: [Security](/gateway/security)
- Tailscale 設定: [Tailscale](/gateway/tailscale)
