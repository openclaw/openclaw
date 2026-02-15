---
summary: "Chrome 擴充功能：讓 OpenClaw 控制您現有的 Chrome 分頁"
read_when:
  - 您希望智慧代理控制現有的 Chrome 分頁（透過工具列按鈕）
  - 您需要透過 Tailscale 進行遠端 Gateway + 本地瀏覽器自動化
  - 您想了解瀏覽器接管的安全影響
title: "Chrome 擴充功能"
---

# Chrome 擴充功能 (瀏覽器中繼)

OpenClaw Chrome 擴充功能讓智慧代理能夠控制您**現有的 Chrome 分頁**（您平常使用的 Chrome 視窗），而不是啟動一個由 OpenClaw 獨立管理的 Chrome 設定檔。

透過**單一 Chrome 工具列按鈕**即可進行附加（Attach）或卸載（Detach）。

## 運作概念

包含三個部分：

- **瀏覽器控制服務** (Gateway 或 node)：智慧代理/工具（透過 Gateway）呼叫的 API。
- **本地中繼伺服器** (loopback CDP)：連接控制伺服器與擴充功能之間的橋樑（預設為 `http://127.0.0.1:18792`）。
- **Chrome MV3 擴充功能**：使用 `chrome.debugger` 附加到活動分頁，並將 CDP 訊息傳送到中繼伺服器。

接著 OpenClaw 就會透過正常的 `browser` 工具介面（選擇正確的設定檔）來控制已附加的分頁。

## 安裝 / 載入 (未封裝)

1. 將擴充功能安裝到穩定的本地路徑：

```bash
openclaw browser extension install
```

2. 列印安裝的擴充功能目錄路徑：

```bash
openclaw browser extension path
```

3. 開啟 Chrome → `chrome://extensions`

- 啟用「開發者模式」
- 點擊「載入解壓縮擴充功能」→ 選擇上方列印的目錄

4. 固定（Pin）該擴充功能。

## 更新 (無需建置步驟)

此擴充功能以靜態檔案的形式包含在 OpenClaw 發佈版本 (npm 套件) 中，沒有獨立的「建置」步驟。

升級 OpenClaw 後：

- 重新執行 `openclaw browser extension install` 以重新整理 OpenClaw 狀態目錄下的安裝檔案。
- 開啟 Chrome → `chrome://extensions` → 點擊該擴充功能上的「重新整理」。

## 使用方式 (無需額外設定)

OpenClaw 內建了一個名為 `chrome` 的瀏覽器設定檔，預設指向連接埠上的擴充功能中繼。

使用方式：

- CLI: `openclaw browser --browser-profile chrome tabs`
- 智慧代理工具: `browser` 並設定 `profile="chrome"`

如果您想要不同的名稱或不同的中繼連接埠，請建立您自己的設定檔：

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## 附加 / 卸載 (工具列按鈕)

- 開啟您想要讓 OpenClaw 控制的分頁。
- 點擊擴充功能圖示。
  - 附加後標記會顯示 `ON`。
- 再次點擊即可卸載。

## 它控制哪個分頁？

- 它**不會**自動控制「您正在查看的任何分頁」。
- 它**僅控制您明確點擊工具列按鈕附加**的分頁。
- 若要切換：請開啟另一個分頁並在該處點擊擴充功能圖示。

## 標記與常見錯誤

- `ON`：已附加；OpenClaw 可以控制該分頁。
- `…`：正在連線至本地中繼。
- `!`：無法連線至中繼（最常見的原因：瀏覽器中繼伺服器未在此機器上執行）。

如果您看到 `!`：

- 確保 Gateway 正在本地執行（預設設定），或者如果 Gateway 在其他地方執行，請在此機器上執行一個 node 主機。
- 開啟擴充功能的「選項」頁面；它會顯示中繼是否可存取。

## 遠端 Gateway (使用 node 主機)

### 本地 Gateway (與 Chrome 在同一台機器) — 通常**無需額外步驟**

如果 Gateway 與 Chrome 在同一台機器上執行，它會在 local loopback 啟動瀏覽器控制服務並自動啟動中繼伺服器。擴充功能與本地中繼通訊；CLI/工具呼叫則傳送到 Gateway。

### 遠端 Gateway (Gateway 在其他地方執行) — **執行 node 主機**

如果您的 Gateway 在另一台機器上執行，請在執行 Chrome 的機器上啟動一個 node 主機。
Gateway 會將瀏覽器操作代理到該 node；擴充功能與中繼則保持在瀏覽器所在的本地機器上。

如果連接了多個 node，請使用 `gateway.nodes.browser.node` 固定一個，或設定 `gateway.nodes.browser.mode`。

## 沙箱隔離 (工具容器)

如果您的智慧代理工作階段處於沙箱隔離狀態 (`agents.defaults.sandbox.mode != "off"`)，`browser` 工具可能會受到限制：

- 預設情況下，沙箱化工作階段通常指向**沙箱瀏覽器** (`target="sandbox"`)，而不是您的宿主 Chrome。
- Chrome 擴充功能中繼接管需要控制**宿主**瀏覽器控制伺服器。

選項：

- 最簡單的方法：從**非沙箱化**的工作階段/智慧代理使用擴充功能。
- 或者為沙箱化工作階段允許宿主瀏覽器控制：

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

然後確保工具未被工具策略拒絕，並且（如果需要）在呼叫 `browser` 時設定 `target="host"`。

偵錯：`openclaw sandbox explain`

## 遠端存取建議

- 將 Gateway 和 node 主機保持在同一個 tailnet 中；避免將中繼連接埠暴露給區域網路或公開網路。
- 有意識地進行 node 配對；如果您不想要遠端控制，請停用瀏覽器代理路由 (`gateway.nodes.browser.mode="off"`)。

## 「擴充功能路徑」如何運作

`openclaw browser extension path` 會列印包含擴充功能檔案的**已安裝**磁碟目錄。

CLI 特意**不**列印 `node_modules` 路徑。請務必先執行 `openclaw browser extension install` 將擴充功能複製到 OpenClaw 狀態目錄下的穩定位置。

如果您移動或刪除該安裝目錄，Chrome 會將該擴充功能標記為損壞，直到您從有效路徑重新載入它。

## 安全影響 (必讀)

這項功能強大且具有風險。請將其視為賦予模型「控制您瀏覽器的手」。

- 該擴充功能使用 Chrome 的偵錯 API (`chrome.debugger`)。附加後，模型可以：
  - 在該分頁中點擊/打字/導覽
  - 讀取頁面內容
  - 存取該分頁已登入工作階段可以存取的任何內容
- **這不是隔離的**，不像專用的 OpenClaw 管理設定檔。
  - 如果您附加到日常使用的設定檔/分頁，即表示您授予了對該帳號狀態的存取權限。

建議：

- 針對擴充功能中繼使用，建議使用專用的 Chrome 設定檔（與您的個人瀏覽分開）。
- 將 Gateway 和任何 node 主機保持在僅限 tailnet 存取；依賴 Gateway 認證 + node 配對。
- 避免透過區域網路 (`0.0.0.0`) 暴露中繼連接埠，並避免使用 Funnel (公開)。
- 中繼會封鎖非擴充功能的來源，且 CDP 客戶端需要內部的驗證權杖。

相關內容：

- 瀏覽器工具總覽：[Browser](/tools/browser)
- 安全稽核：[Security](/gateway/security)
- Tailscale 設定：[Tailscale](/gateway/tailscale)
