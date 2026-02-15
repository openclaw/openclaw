---
summary: "整合的瀏覽器控制服務 + 操作指令"
read_when:
  - 新增智慧代理控制的瀏覽器自動化
  - 偵錯為什麼 openclaw 干擾了您原本的 Chrome
  - 在 macOS 應用程式中實作瀏覽器設定與生命週期
title: "瀏覽器 (OpenClaw 管理)"
---

<!-- markdownlint-disable MD024 MD051 -->

# 瀏覽器 (openclaw 管理)

OpenClaw 可以執行一個由智慧代理控制的**專用 Chrome/Brave/Edge/Chromium 設定檔**。
它與您的個人瀏覽器隔離，並透過 Gateway 內部的小型本地控制服務進行管理（僅限 local loopback）。

初學者視角：

- 把它想像成一個**獨立、智慧代理專用的瀏覽器**。
- `openclaw` 設定檔**不會**碰到您的個人瀏覽器設定檔。
- 智慧代理可以在安全的環境中**開啟分頁、讀取頁面、點擊和輸入**。
- 預設的 `chrome` 設定檔會透過擴充功能轉接器使用**系統預設的 Chromium 瀏覽器**；若要使用隔離的受管理瀏覽器，請切換至 `openclaw`。

## 您將獲得

- 一個名為 **openclaw** 的獨立瀏覽器設定檔（預設為橘色強調色）。
- 確定的分頁控制（列表/開啟/聚焦/關閉）。
- 智慧代理操作（點擊/輸入/拖曳/選取）、快照、螢幕截圖、PDF。
- 選用多重設定檔支援（`openclaw`、`work`、`remote` 等）。

此瀏覽器**不是**您的日常使用工具。它是為智慧代理自動化與驗證提供的安全、隔離介面。

## 快速開始

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

如果您看到「Browser disabled」，請在設定中啟用它（見下文）並重新啟動 Gateway。

## 設定檔：`openclaw` vs `chrome`

- `openclaw`：受管理的隔離瀏覽器（不需擴充功能）。
- `chrome`：連至您**系統瀏覽器**的擴充功能轉接器（需要將 OpenClaw 擴充功能掛載至分頁）。

如果您希望預設使用受管理模式，請設定 `browser.defaultProfile: "openclaw"`。

## 設定

瀏覽器設定儲存在 `~/.openclaw/openclaw.json`。

```json5
{
  browser: {
    enabled: true, // 預設：true
    // cdpUrl: "http://127.0.0.1:18792", // 舊版單一設定檔覆蓋
    remoteCdpTimeoutMs: 1500, // 遠端 CDP HTTP 逾時 (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // 遠端 CDP WebSocket 交握逾時 (ms)
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

注意事項：

- 瀏覽器控制服務綁定到由 `gateway.port` 衍生出的 local loopback 連接埠（預設：`18791`，即 gateway + 2）。轉接器使用下一個連接埠（`18792`）。
- 如果您覆蓋了 Gateway 連接埠（`gateway.port` 或 `OPENCLAW_GATEWAY_PORT`），衍生的瀏覽器連接埠也會隨之調整以保持在同一個「系列」。
- 未設定時，`cdpUrl` 預設為轉接器連接埠。
- `remoteCdpTimeoutMs` 用於遠端（非 local loopback）CDP 可達性檢查。
- `remoteCdpHandshakeTimeoutMs` 用於遠端 CDP WebSocket 交握可達性檢查。
- `attachOnly: true` 表示「絕不啟動本地瀏覽器；僅在瀏覽器已執行時進行掛載」。
- `color` + 個別設定檔的 `color` 會為瀏覽器 UI 著色，以便您辨識目前使用的是哪個設定檔。
- 預設設定檔為 `chrome`（擴充功能轉接器）。若要使用受管理的瀏覽器，請使用 `defaultProfile: "openclaw"`。
- 自動偵測順序：若是基於 Chromium 則為系統預設瀏覽器；否則依序為 Chrome → Brave → Edge → Chromium → Chrome Canary。
- 本地 `openclaw` 設定檔會自動分配 `cdpPort`/`cdpUrl` —— 只有在使用遠端 CDP 時才需手動設定。

## 使用 Brave (或其他基於 Chromium 的瀏覽器)

如果您的**系統預設**瀏覽器是基於 Chromium（Chrome/Brave/Edge 等），OpenClaw 會自動使用它。設定 `browser.executablePath` 可覆蓋自動偵測：

CLI 範例：

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## 本地與遠端控制

- **本地控制（預設）：** Gateway 啟動 local loopback 控制服務並可開啟本地瀏覽器。
- **遠端控制（node 節點）：** 在擁有瀏覽器的機器上執行 node 節點；Gateway 會將瀏覽器操作代理至該節點。
- **遠端 CDP：** 設定 `browser.profiles.<name>.cdpUrl`（或 `browser.cdpUrl`）以掛載至遠端的 Chromium 瀏覽器。在這種情況下，OpenClaw 不會啟動本地瀏覽器。

遠端 CDP URL 可以包含憑證：

- 查詢權杖 (例如 `https://provider.example?token=<token>`)
- HTTP 基本驗證 (例如 `https://user:pass @provider.example`)

OpenClaw 在呼叫 `/json/*` 端點及連線至 CDP WebSocket 時會保留憑證。建議使用環境變數或秘密管理工具儲存權杖，而非直接寫入設定檔。

## Node 瀏覽器代理（免設定預設值）

如果您在擁有瀏覽器的機器上執行 **node 節點**，OpenClaw 可以自動將瀏覽器工具呼叫路由至該節點，不需額外的瀏覽器設定。這是遠端 Gateway 的預設路徑。

注意事項：

- Node 節點透過 **proxy 指令** 公開其本地瀏覽器控制伺服器。
- 設定檔來自節點本身的 `browser.profiles` 設定（與本地相同）。
- 若不需要可停用：
  - 在節點上：`nodeHost.browserProxy.enabled=false`
  - 在 Gateway 上：`gateway.nodes.browser.mode="off"`

## Browserless (代管遠端 CDP)

[Browserless](https://browserless.io) 是一個透過 HTTPS 提供 CDP 端點的代管 Chromium 服務。您可以將 OpenClaw 瀏覽器設定檔指向 Browserless 區域端點，並使用您的 API 金鑰進行驗證。

範例：

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

注意事項：

- 將 `<BROWSERLESS_API_KEY>` 替換為您實際的 Browserless 權杖。
- 選擇與您的 Browserless 帳戶相符的區域端點（請參閱其文件）。

## 安全性

核心概念：

- 瀏覽器控制僅限 local loopback；存取流程經過 Gateway 的驗證或節點配對。
- 如果啟動了瀏覽器控制且未設定驗證，OpenClaw 會在啟動時自動產生 `gateway.auth.token` 並將其保存至設定中。
- 請將 Gateway 和任何 node 節點保留在私有網路中（Tailscale）；避免公開暴露於網際網路。
- 將遠端 CDP URL/權杖視為秘密；優先使用環境變數或秘密管理工具。

遠端 CDP 秘訣：

- 盡可能優先使用 HTTPS 端點和短期權杖。
- 避免將長期權杖直接嵌入設定檔中。

## 設定檔 (多瀏覽器)

OpenClaw 支援多個命名的設定檔（路由設定）。設定檔可以是：

- **openclaw-managed**：具有獨立使用者資料目錄 + CDP 連接埠的專用 Chromium 瀏覽器執行個體。
- **remote**：明確的 CDP URL（在其他地方執行的 Chromium 瀏覽器）。
- **extension relay**：透過本地轉接器 + Chrome 擴充功能，使用您現有的 Chrome 分頁。

預設值：

- 若遺漏 `openclaw` 設定檔，系統會自動建立。
- `chrome` 設定檔內建用於 Chrome 擴充功能轉接器（預設指向 `http://127.0.0.1:18792`）。
- 本地 CDP 連接埠預設從 **18800–18899** 開始分配。
- 刪除設定檔會將其本地資料目錄移至垃圾桶。

所有控制端點均接受 `?profile=<name>`；CLI 則使用 `--browser-profile`。

## Chrome 擴充功能轉接器 (使用您現有的 Chrome)

OpenClaw 也可以透過本地 CDP 轉接器 + Chrome 擴充功能來操作**您現有的 Chrome 分頁**（不需獨立的 "openclaw" Chrome 執行個體）。

完整指南：[Chrome 擴充功能](/tools/chrome-extension)

流程：

- Gateway 在本地執行（同一台機器）或在瀏覽器機器上執行 node 節點。
- 本地**轉接伺服器**監聽 local loopback `cdpUrl`（預設：`http://127.0.0.1:18792`）。
- 您在分頁上點擊 **OpenClaw Browser Relay** 擴充功能圖示以進行掛載（它不會自動掛載）。
- 智慧代理透過選取正確的設定檔，經由一般的 `browser` 工具控制該分頁。

如果 Gateway 在其他地方執行，請在瀏覽器機器上執行 node 節點，以便 Gateway 代理瀏覽器操作。

### 沙箱隔離工作階段

如果智慧代理工作階段已沙箱隔離，`browser` 工具預設可能會將 `target` 設為 `"sandbox"`（沙箱瀏覽器）。
接管 Chrome 擴充功能轉接器需要主機瀏覽器控制權，因此請：

- 執行未沙箱隔離的工作階段，或
- 設定 `agents.defaults.sandbox.browser.allowHostControl: true` 並在呼叫工具時使用 `target="host"`。

### 設定

1. 載入擴充功能（開發/未封裝）：

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → 啟用「開發者模式」
- 「載入解壓縮」 → 選擇由 `openclaw browser extension path` 印出的目錄
- 釘選擴充功能，然後在您要控制的分頁上點擊它（圖示會顯示 `ON`）。

2. 使用它：

- CLI：`openclaw browser --browser-profile chrome tabs`
- 智慧代理工具：使用 `profile="chrome"` 的 `browser` 工具

選用：如果您想要不同的名稱或轉接連接埠，請建立您自己的設定檔：

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

注意事項：

- 此模式的大多數操作（截圖/快照/動作）依賴於 Playwright-on-CDP。
- 再次點擊擴充功能圖示即可解除掛載。

## 隔離保證

- **專用使用者資料目錄**：絕不觸碰您的個人瀏覽器設定檔。
- **專用連接埠**：避開 `9222` 以防止與開發工作流衝突。
- **確定的分頁控制**：透過 `targetId` 指定分頁，而非「最後一個分頁」。

## 瀏覽器選取

本地啟動時，OpenClaw 會挑選第一個可用的：

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

您可以使用 `browser.executablePath` 進行覆蓋。

平台：

- macOS：檢查 `/Applications` 和 `~/Applications`。
- Linux：尋找 `google-chrome`、`brave`、`microsoft-edge`、`chromium` 等。
- Windows：檢查常用的安裝位置。

## 控制 API (選用)

僅限本地整合，Gateway 提供了一個小型的 local loopback HTTP API：

- 狀態/啟動/停止：`GET /`, `POST /start`, `POST /stop`
- 分頁：`GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- 快照/螢幕截圖：`GET /snapshot`, `POST /screenshot`
- 操作：`POST /navigate`, `POST /act`
- 掛鉤 (Hooks)：`POST /hooks/file-chooser`, `POST /hooks/dialog`
- 下載：`POST /download`, `POST /wait/download`
- 偵錯：`GET /console`, `POST /pdf`
- 偵錯：`GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- 網路：`POST /response/body`
- 狀態：`GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- 狀態：`GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- 設定：`POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

所有端點均接受 `?profile=<name>`。

如果設定了 Gateway 驗證，瀏覽器 HTTP 路由也需要驗證：

- `Authorization: Bearer <gateway token>`
- `x-openclaw-password: <gateway password>` 或使用該密碼的 HTTP 基本驗證

### Playwright 需求

部分功能 (導覽/操作/AI 快照/角色快照, 元素截圖, PDF) 需要 Playwright。如果未安裝 Playwright，這些端點會傳回明確的 501 錯誤。對於 openclaw 管理的 Chrome，ARIA 快照和基本截圖仍可運作。對於 Chrome 擴充功能轉接器驅動程式，ARIA 快照和截圖則需要 Playwright。

如果您看到 `Playwright is not available in this gateway build`，請安裝完整 Playwright 套件（不是 `playwright-core`）並重新啟動 Gateway，或重新安裝具備瀏覽器支援的 OpenClaw。

#### Docker Playwright 安裝

如果您的 Gateway 在 Docker 中執行，請避免使用 `npx playwright`（npm 覆蓋衝突）。請改用隨附的 CLI：

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

若要保存瀏覽器下載內容，請設定 `PLAYWRIGHT_BROWSERS_PATH`（例如 `/home/node/.cache/ms-playwright`），並確保 `/home/node` 透過 `OPENCLAW_HOME_VOLUME` 或綁定掛載 (bind mount) 持久化。請參閱 [Docker](/install/docker)。

## 運作原理 (內部)

高階流程：

- 一個小型的**控制伺服器**接收 HTTP 請求。
- 它透過 **CDP** 連接至基於 Chromium 的瀏覽器 (Chrome/Brave/Edge/Chromium)。
- 針對進階操作 (點擊/輸入/快照/PDF)，它在 CDP 之上使用 **Playwright**。
- 缺少 Playwright 時，僅可使用非 Playwright 的操作。

此設計讓智慧代理保持穩定、確定的介面，同時讓您能更換本地/遠端瀏覽器和設定檔。

## CLI 快速參考

所有指令皆接受 `--browser-profile <name>` 以指定設定檔。
所有指令皆支援 `--json` 以獲得機器可讀的輸出（穩定的酬載）。

基礎：

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

觀察：

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

操作：

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 report.pdf`
- `openclaw browser waitfordownload report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

狀態：

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

注意事項：

- `upload` 和 `dialog` 是**預備 (arming)** 呼叫；請在觸發選擇器/對話框的點擊/按鍵操作之前執行它們。
- 下載和追蹤 (trace) 的輸出路徑受限於 OpenClaw 暫存根目錄：
  - 追蹤：`/tmp/openclaw` (備用：`${os.tmpdir()}/openclaw`)
  - 下載：`/tmp/openclaw/downloads` (備用：`${os.tmpdir()}/openclaw/downloads`)
- `upload` 也可以透過 `--input-ref` 或 `--element` 直接設定檔案輸入。
- `snapshot`：
  - `--format ai` (安裝 Playwright 時的預設值)：傳回包含數字引用的 AI 快照 (`aria-ref="<n>"` )。
  - `--format aria`：傳回無障礙樹 (accessibility tree)（無引用；僅供檢視）。
  - `--efficient` (或 `--mode efficient`)：精簡角色快照預設設定 (互動 + 精簡 + 深度 + 較低的 maxChars)。
  - 設定預設值 (僅限工具/CLI)：設定 `browser.snapshotDefaults.mode: "efficient"` 以在呼叫者未傳遞模式時使用高效快照 (請參閱 [Gateway 設定](/gateway/configuration#browser-openclaw-managed-browser))。
  - 角色快照選項 (`--interactive`, `--compact`, `--depth`, `--selector`) 會強制執行基於角色的快照，引用格式如 `ref=e12`。
  - `--frame "<iframe selector>"` 將角色快照範圍限定在 iframe 內 (搭配角色引用如 `e12`)。
  - `--interactive` 輸出扁平、易於選取的互動元素列表 (最適合驅動操作)。
  - `--labels` 會加入僅限視埠的螢幕截圖，並帶有疊加的引用標籤 (印出 `MEDIA:<path>`)。
- `click`/`type` 等需要來自 `snapshot` 的 `ref`（數字 `12` 或角色引用 `e12`）。操作中刻意不支援 CSS 選擇器。

## 快照與引用 (refs)

OpenClaw 支援兩種「快照」風格：

- **AI 快照（數字引用）**：`openclaw browser snapshot`（預設；`--format ai`）
  - 輸出：包含數字引用的文字快照。
  - 操作：`openclaw browser click 12`、`openclaw browser type 23 "hello"`。
  - 內部透過 Playwright 的 `aria-ref` 解析引用。

- **角色快照（角色引用，如 `e12`）**：`openclaw browser snapshot --interactive`（或 `--compact`、`--depth`、`--selector`、`--frame`）
  - 輸出：帶有 `[ref=e12]`（以及選用的 `[nth=1]`）的基於角色的列表/樹狀結構。
  - 操作：`openclaw browser click e12`、`openclaw browser highlight e12`。
  - 內部透過 `getByRole(...)` 解析引用（重複時搭配 `nth()`）。
  - 加入 `--labels` 可包含帶有疊加 `e12` 標籤的視埠螢幕截圖。

引用行為：

- 引用在導覽過程中**不保證穩定**；如果失敗，請重新執行 `snapshot` 並使用新的引用。
- 如果角色快照是使用 `--frame` 拍攝的，則在下一次角色快照之前，角色引用範圍將限定在該 iframe 內。

## 等待強化功能

您可以等待的不只是時間或文字：

- 等待 URL（支援 Playwright 支援的 glob）：
  - `openclaw browser wait --url "**/dash"`
- 等待載入狀態：
  - `openclaw browser wait --load networkidle`
- 等待一個 JS 述句 (predicate)：
  - `openclaw browser wait --fn "window.ready===true"`
- 等待選擇器變為可見：
  - `openclaw browser wait "#main"`

這些可以組合使用：

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## 偵錯工作流

當操作失敗時（例如「不可見」、「違反嚴格模式」、「被遮蔽」）：

1. `openclaw browser snapshot --interactive`
2. 使用 `click <ref>` / `type <ref>` (互動模式下優先使用角色引用)
3. 如果仍然失敗：使用 `openclaw browser highlight <ref>` 查看 Playwright 的目標對象
4. 如果頁面表現異常：
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. 進行深度偵錯：記錄追蹤 (trace)：
   - `openclaw browser trace start`
   - 重現問題
   - `openclaw browser trace stop` (印出 `TRACE:<path>`)

## JSON 輸出

`--json` 用於指令碼編寫和結構化工具。

範例：

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON 格式的角色快照包含 `refs` 以及一個小型的 `stats` 區塊（行數/字元數/引用數/互動元素），讓工具可以判斷酬載的大小與密度。

## 狀態與環境控制

這些對於「讓網站表現得像 X」的工作流非常有用：

- Cookies：`cookies`, `cookies set`, `cookies clear`
- 儲存：`storage local|session get|set|clear`
- 離線：`set offline on|off`
- 標頭 (Headers)：`set headers --json '{"X-Debug":"1"}'` (或 `--clear`)
- HTTP 基本驗證：`set credentials user pass` (或 `--clear`)
- 地理位置：`set geo <lat> <lon> --origin "https://example.com"` (或 `--clear`)
- 媒體：`set media dark|light|no-preference|none`
- 時區 / 語系：`set timezone ...`, `set locale ...`
- 裝置 / 視埠：
  - `set device "iPhone 14"` (Playwright 裝置預設值)
  - `set viewport 1280 720`

## 安全與隱私

- openclaw 瀏覽器設定檔可能包含已登入的工作階段；請將其視為敏感資訊。
- `browser act kind=evaluate` / `openclaw browser evaluate` 和 `wait --fn` 會在頁面上下文中執行任意 JavaScript。提示詞注入 (Prompt injection) 可能會引導此行為。如果不需要，請使用 `browser.evaluateEnabled=false` 停用。
- 關於登入和防機器人注意事項 (X/Twitter 等)，請參閱 [瀏覽器登入 + X/Twitter 發文](/tools/browser-login)。
- 請保持 Gateway/node 節點私有 (僅限 loopback 或僅限 tailnet)。
- 遠端 CDP 端點功能強大；請使用通道並妥善保護。

## 疑難排解

關於 Linux 專屬問題 (特別是 snap Chromium)，請參閱 [瀏覽器疑難排解](/tools/browser-linux-troubleshooting)。

## 智慧代理工具 + 控制運作方式

智慧代理擁有**一個工具**用於瀏覽器自動化：

- `browser` — 狀態/啟動/停止/分頁/開啟/聚焦/關閉/快照/螢幕截圖/導覽/操作

對應方式：

- `browser snapshot` 傳回穩定的 UI 樹 (AI 或 ARIA)。
- `browser act` 使用快照中的 `ref` ID 進行點擊/輸入/拖曳/選取。
- `browser screenshot` 擷取像素 (全頁或元素)。
- `browser` 接受：
  - `profile`：選擇命名的瀏覽器設定檔 (openclaw、chrome 或遠端 CDP)。
  - `target` (`sandbox` | `host` | `node`)：選擇瀏覽器所在位置。
  - 在沙箱隔離的工作階段中，`target: "host"` 需要設定 `agents.defaults.sandbox.browser.allowHostControl=true`。
  - 如果省略 `target`：沙箱隔離工作階段預設為 `sandbox`，非沙箱工作階段預設為 `host`。
  - 如果連線了具備瀏覽器能力的節點，工具可能會自動路由至該節點，除非您固定使用 `target="host"` 或 `target="node"`。

這讓智慧代理保持確定性並避免脆弱的選擇器。
