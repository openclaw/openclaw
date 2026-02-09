---
summary: "Chrome 擴充功能：讓 OpenClaw 操控你現有的 Chrome 分頁"
read_when:
  - 你希望代理程式操控現有的 Chrome 分頁（工具列按鈕）
  - 你需要遠端 Gateway + 透過 Tailscale 的本地瀏覽器自動化
  - 你想了解瀏覽器接管的安全性影響
title: "Chrome 擴充功能"
---

# Chrome 擴充功能（瀏覽器中繼）

OpenClaw Chrome 擴充功能可讓代理程式控制你 **現有的 Chrome 分頁**（你平常使用的 Chrome 視窗），而不是啟動一個由 openclaw 管理的獨立 Chrome 設定檔。

連接／中斷只需要 **一個 Chrome 工具列按鈕**。

## 這是什麼（概念）

共有三個部分：

- **瀏覽器控制服務**（Gateway 或節點）：代理程式／工具呼叫的 API（透過 Gateway）
- **本地中繼伺服器**（loopback CDP）：在控制伺服器與擴充功能之間建立橋接（預設為 `http://127.0.0.1:18792`）
- **Chrome MV3 擴充功能**：使用 `chrome.debugger` 附加到作用中的分頁，並將 CDP 訊息傳送到中繼

OpenClaw then controls the attached tab through the normal `browser` tool surface (selecting the right profile).

## 安裝／載入（未封裝）

1. 將擴充功能安裝到穩定的本地路徑：

```bash
openclaw browser extension install
```

2. Print the installed extension directory path:

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- 啟用「Developer mode」
- 「Load unpacked」→ 選取上一步輸出的目錄

4. Pin the extension.

## 更新（無需建置步驟）

20. 擴充功能隨 OpenClaw 發佈（npm 套件）以靜態檔案形式提供。 There is no separate “build” step.

升級 OpenClaw 之後：

- 重新執行 `openclaw browser extension install`，以重新整理 OpenClaw 狀態目錄下已安裝的檔案。
- Chrome → `chrome://extensions` → 點擊擴充功能的「Reload」。

## 使用方式（無需額外設定）

OpenClaw ships with a built-in browser profile named `chrome` that targets the extension relay on the default port.

使用方式：

- CLI：`openclaw browser --browser-profile chrome tabs`
- 代理程式工具：`browser` 搭配 `profile="chrome"`

如果你想要不同的名稱或不同的中繼連接埠，請建立自己的設定檔：

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## 連接／中斷（工具列按鈕）

- 開啟你希望由 OpenClaw 控制的分頁。
- Click the extension icon.
  - 附加時，徽章會顯示 `ON`。
- Click again to detach.

## 它會控制哪個分頁？

- 它 **不會** 自動控制「你目前正在看的分頁」。
- 它只會控制 **你明確點擊工具列按鈕所附加的分頁**。
- To switch: open the other tab and click the extension icon there.

## Badge + common errors

- `ON`：已附加；OpenClaw 可以操控該分頁。
- `…`：正在連線到本地中繼。
- `!`: relay not reachable (most common: browser relay server isn’t running on this machine).

如果你看到 `!`：

- 確認 Gateway 正在本機執行（預設設定），或若 Gateway 在其他地方執行，請在此機器上啟動節點主機。
- Open the extension Options page; it shows whether the relay is reachable.

## 遠端 Gateway（使用節點主機）

### 本地 Gateway（與 Chrome 在同一台機器）— 通常 **不需要額外步驟**

如果 Gateway 與 Chrome 在同一台機器上執行，它會在 loopback 上啟動瀏覽器控制服務，並自動啟動中繼伺服器。擴充功能會與本地中繼通訊；CLI／工具呼叫則會送往 Gateway。 21. 擴充功能與本地轉送（relay）通訊；CLI／工具呼叫則送往 Gateway。

### 遠端 Gateway（Gateway 在其他地方執行）— **執行節點主機**

如果你的 Gateway 在另一台機器上執行，請在執行 Chrome 的機器上啟動節點主機。
Gateway 會將瀏覽器操作代理到該節點；擴充功能與中繼仍留在瀏覽器所在的機器上。
22. Gateway 會將瀏覽器動作代理到該節點；擴充功能與轉送保持在瀏覽器所在的本機。

如果連接了多個節點，請使用 `gateway.nodes.browser.node` 將其中一個固定，或設定 `gateway.nodes.browser.mode`。

## 沙箱隔離（工具容器）

如果你的代理程式工作階段是沙箱隔離的（`agents.defaults.sandbox.mode != "off"`），`browser` 工具可能會受到限制：

- 預設情況下，沙箱隔離的工作階段通常會指向 **沙箱瀏覽器**（`target="sandbox"`），而不是你的主機 Chrome。
- Chrome 擴充功能中繼接管需要控制 **主機** 的瀏覽器控制伺服器。

選項：

- 15. 遠端存取建議
- 或允許沙箱隔離工作階段進行主機瀏覽器控制：

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

接著確保工具未被工具政策拒絕，並且（如有需要）以 `target="host"` 呼叫 `browser`。

除錯：`openclaw sandbox explain`

## 24. 遠端存取提示

- 將 Gateway 與節點主機保持在同一個 tailnet；避免將中繼連接埠暴露到 LAN 或公開網際網路。
- 有意識地配對節點；如果你不希望遠端控制，請停用瀏覽器代理路由（`gateway.nodes.browser.mode="off"`）。

## 「擴充功能路徑」的運作方式

`openclaw browser extension path` 會輸出包含擴充功能檔案的 **已安裝** 磁碟目錄。

The CLI intentionally does **not** print a `node_modules` path. Always run `openclaw browser extension install` first to copy the extension to a stable location under your OpenClaw state directory.

如果你移動或刪除此安裝目錄，Chrome 會將該擴充功能標記為損壞，直到你從有效路徑重新載入為止。

## 安全性影響（請閱讀）

25. 這很強大，也很有風險。 Treat it like giving the model “hands on your browser”.

- 擴充功能使用 Chrome 的 debugger API（`chrome.debugger`）。附加後，模型可以： When attached, the model can:
  - click/type/navigate in that tab
  - read page content
  - access whatever the tab’s logged-in session can access
- **This is not isolated** like the dedicated openclaw-managed profile.
  - If you attach to your daily-driver profile/tab, you’re granting access to that account state.

建議事項：

- 26. 建議為擴充功能轉送用途使用專用的 Chrome 設定檔（與你的個人瀏覽分開）。
- Keep the Gateway and any node hosts tailnet-only; rely on Gateway auth + node pairing.
- 避免透過 LAN 暴露中繼連接埠（`0.0.0.0`），並避免使用 Funnel（公開）。
- The relay blocks non-extension origins and requires an internal auth token for CDP clients.

Related:

- 瀏覽器工具概覽：[Browser](/tools/browser)
- 安全性稽核：[Security](/gateway/security)
- Tailscale 設定：[Tailscale](/gateway/tailscale)
