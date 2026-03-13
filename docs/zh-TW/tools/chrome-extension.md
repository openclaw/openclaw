---
summary: "Chrome extension: let OpenClaw drive your existing Chrome tab"
read_when:
  - You want the agent to drive an existing Chrome tab (toolbar button)
  - You need remote Gateway + local browser automation via Tailscale
  - You want to understand the security implications of browser takeover
title: Chrome Extension
---

# Chrome 擴充功能（瀏覽器中繼）

OpenClaw Chrome 擴充功能讓代理程式能控制你**現有的 Chrome 分頁**（你一般使用的 Chrome 視窗），而非啟動一個由 openclaw 管理的獨立 Chrome 設定檔。

附加/分離是透過**單一 Chrome 工具列按鈕**完成。

## 什麼是它（概念）

有三個部分：

- **瀏覽器控制服務**（Gateway 或節點）：代理程式/工具呼叫的 API（透過 Gateway）
- **本地中繼伺服器**（loopback CDP）：在控制伺服器與擴充功能之間橋接（預設為 `http://127.0.0.1:18792`）
- **Chrome MV3 擴充功能**：使用 `chrome.debugger` 附加到目前分頁，並將 CDP 訊息傳送到中繼伺服器

OpenClaw 接著透過一般的 `browser` 工具介面（選擇正確的設定檔）來控制已附加的分頁。

## 安裝 / 載入（未打包）

1. 將擴充功能安裝到一個穩定的本地路徑：

```bash
openclaw browser extension install
```

2. 列印已安裝擴充功能的目錄路徑：

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- 啟用「開發者模式」
- 「載入未打包的擴充功能」→ 選擇上面列印的目錄

4. 將擴充功能釘選。

## 更新（無需建置步驟）

此擴充功能隨 OpenClaw 發行版（npm 套件）以靜態檔案形式提供。沒有獨立的「建置」步驟。

升級 OpenClaw 後：

- 重新執行 `openclaw browser extension install`，以更新安裝在 OpenClaw 狀態目錄下的檔案。
- Chrome → `chrome://extensions` → 點擊擴充功能上的「重新載入」。

## 使用方式（設定 gateway token 一次）

OpenClaw 內建一個名為 `chrome` 的瀏覽器設定檔，目標是預設埠號上的擴充功能中繼站。

首次連接前，請開啟擴充功能選項並設定：

- `Port`（預設為 `18792`）
- `Gateway token`（必須與 `gateway.auth.token` / `OPENCLAW_GATEWAY_TOKEN` 相符）

使用方式：

- CLI：`openclaw browser --browser-profile chrome tabs`
- Agent 工具：搭配 `profile="chrome"` 使用 `browser`

若想使用不同名稱或不同中繼埠，請建立自訂設定檔：

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

### 自訂 Gateway 埠號

若使用自訂 gateway 埠號，擴充功能中繼埠會自動推算：

**擴充功能中繼埠 = Gateway 埠號 + 3**

範例：如果 `gateway.port: 19001`，則：

- 擴充功能中繼埠：`19004`（閘道器 + 3）

在擴充功能的選項頁面中，設定使用推導出的中繼埠。

## 附加 / 分離（工具列按鈕）

- 開啟你想讓 OpenClaw 控制的分頁。
- 點擊擴充功能圖示。
  - 附加時徽章顯示 `ON`。
- 再次點擊以分離。

## 它控制哪個分頁？

- 它**不會**自動控制「你正在瀏覽的任何分頁」。
- 它只控制**你明確點擊工具列按鈕附加的分頁**。
- 若要切換：開啟其他分頁並在那裡點擊擴充功能圖示。

## 徽章 + 常見錯誤

- `ON`：已附加；OpenClaw 可以控制該分頁。
- `…`：正在連接本地中繼。
- `!`：中繼無法連線/驗證失敗（最常見：中繼伺服器未啟動，或閘道器 token 遺失/錯誤）。

如果你看到 `!`：

- 確認閘道器在本機執行（預設設定），或如果閘道器在其他地方，請在此機器上執行 node host。
- 開啟擴充功能選項頁面；它會驗證中繼可達性與閘道器 token 驗證。

## 遠端閘道器（使用 node host）

### 本地閘道器（與 Chrome 同機）— 通常**不需額外步驟**

如果閘道器與 Chrome 在同一台機器上，會在 loopback 啟動瀏覽器控制服務並自動啟動中繼伺服器。擴充功能與本地中繼通訊；CLI/工具呼叫則連到閘道器。

### 遠端閘道器（閘道器在其他地方）— **執行 node host**

如果您的 Gateway 執行在另一台機器上，請在執行 Chrome 的機器上啟動一個 node host。
Gateway 將代理瀏覽器操作到該 node；擴充功能 + 中繼保持在瀏覽器機器本地。

如果連接了多個 node，請使用 `gateway.nodes.browser.node` 鎖定其中一個，或設定 `gateway.nodes.browser.mode`。

## 沙箱環境（工具容器）

如果您的代理會話是沙箱環境 (`agents.defaults.sandbox.mode != "off"`)，則 `browser` 工具可能會受到限制：

- 預設情況下，沙箱會話通常會針對 **沙箱瀏覽器** (`target="sandbox"`)，而非您的主機 Chrome。
- Chrome 擴充功能中繼接管需要控制 **主機** 瀏覽器控制伺服器。

選項：

- 最簡單：從 **非沙箱** 會話/代理使用擴充功能。
- 或允許沙箱會話控制主機瀏覽器：

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

接著確保工具未被工具政策拒絕，並且（如有需要）使用 `target="host"` 呼叫 `browser`。

除錯：`openclaw sandbox explain`

## 遠端存取技巧

- 保持 Gateway 和 node host 在同一 tailnet；避免將中繼端口暴露給 LAN 或公共網路。
- 有意識地配對 node；如果不想要遠端控制，請停用瀏覽器代理路由 (`gateway.nodes.browser.mode="off"`)。
- 除非有真正跨命名空間需求，否則將中繼保持在 loopback。對於 WSL2 或類似的分割主機設定，將 `browser.relayBindHost` 設為明確的綁定地址，例如 `0.0.0.0`，然後透過 Gateway 認證、node 配對和私有網路限制存取。

## “擴充功能路徑” 的運作方式

`openclaw browser extension path` 會列印包含擴充功能檔案的 **已安裝** 磁碟目錄。

CLI 故意不列印 `node_modules` 路徑。請務必先執行 `openclaw browser extension install`，將擴充功能複製到您 OpenClaw 狀態目錄下的穩定位置。

如果你移動或刪除該安裝目錄，Chrome 會將擴充功能標記為損壞，直到你從有效路徑重新載入它。

## 安全性影響（請閱讀）

這功能強大且風險高。請將它視為給模型「操作你瀏覽器的權限」。

- 擴充功能使用 Chrome 的除錯器 API (`chrome.debugger`)。連接後，模型可以：
  - 在該分頁點擊/輸入/導航
  - 讀取頁面內容
  - 存取該分頁登入的任何會話可存取的資料
- **這並非隔離環境**，不像專用的 openclaw 管理的瀏覽器設定檔。
  - 如果你連接到日常使用的設定檔/分頁，就等於授權該帳號狀態的存取權。

建議：

- 優先使用專用的 Chrome 設定檔（與個人瀏覽分開）來使用擴充功能中繼。
- 保持 Gateway 和任何節點主機僅限 tailnet；依賴 Gateway 認證 + 節點配對。
- 避免在區域網路公開中繼埠口 (`0.0.0.0`)，並避免使用 Funnel（公開）。
- 中繼會阻擋非擴充功能來源，且 `/cdp` 和 `/extension` 都需要 gateway-token 認證。

相關資源：

- 瀏覽器工具概覽：[Browser](/tools/browser)
- 安全性審核：[Security](/gateway/security)
- Tailscale 設定：[Tailscale](/gateway/tailscale)
