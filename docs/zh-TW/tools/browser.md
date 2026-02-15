---
summary: "整合式瀏覽器控制服務 + 動作指令"
read_when:
  - 新增代理控制的瀏覽器自動化功能時
  - 偵錯 OpenClaw 為何干擾您的 Chrome 時
  - 在 macOS 應用程式中實作瀏覽器設定 + 生命週期時
title: "瀏覽器 (由 OpenClaw 管理)"
---

# 瀏覽器 (由 OpenClaw 管理)

OpenClaw 可以執行一個由智慧代理控制的**專用 Chrome/Brave/Edge/Chromium 設定檔**。
它與您的個人瀏覽器隔離，並透過 Gateway 內部一個小型的本機控制服務 (僅限 loopback) 進行管理。

新手視角：

- 將其視為一個**獨立的、僅供智慧代理使用的瀏覽器**。
- `openclaw` 設定檔**不會**動到您的個人瀏覽器設定檔。
- 智慧代理可以在安全的環境中**開啟分頁、閱讀頁面、點擊並輸入**。
- 預設的 `chrome` 設定檔透過擴充功能中繼使用**系統預設的 Chromium 瀏覽器**；切換到 `openclaw` 以使用獨立管理的瀏覽器。

## 您將獲得的功能

- 一個名為 **openclaw** 的獨立瀏覽器設定檔 (預設為橘色強調色)。
- 確定性分頁控制 (列出/開啟/聚焦/關閉)。
- 智慧代理動作 (點擊/輸入/拖曳/選取)、快照、螢幕截圖、PDF 檔案。
- 選用的多重設定檔支援 (`openclaw`、`work`、`remote` 等)。

此瀏覽器**不是**您日常使用的瀏覽器。它是用於智慧代理自動化和驗證的安全、隔離的介面。

## 快速開始

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

如果您遇到「瀏覽器已停用」訊息，請在設定中啟用它 (詳見下方)，然後重新啟動 Gateway。

## 設定檔：`openclaw` 與 `chrome`

- `openclaw`：受管理的、隔離的瀏覽器 (無需擴充功能)。
- `chrome`：擴充功能中繼到您的**系統瀏覽器** (需要 OpenClaw 擴充功能附加到分頁)。

如果您想預設使用受管理模式，請設定 `browser.defaultProfile: "openclaw"`。

## 設定

瀏覽器設定位於 `~/.openclaw/openclaw.json`。

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
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

- 瀏覽器控制服務繫結到 loopback，使用的連接埠是從 `gateway.port` 衍生而來 (預設：`18791`，即 gateway + 2)。中繼使用下一個連接埠 (`18792`)。
- 如果您覆寫 Gateway 連接埠 (`gateway.port` 或 `OPENCLAW_GATEWAY_PORT`)，衍生的瀏覽器連接埠將會偏移以保持在同一個「系列」中。
- 如果未設定，`cdpUrl` 預設為中繼連接埠。
- `remoteCdpTimeoutMs` 適用於遠端 (非 loopback) CDP 可達性檢查。
- `remoteCdpHandshakeTimeoutMs` 適用於遠端 CDP WebSocket 可達性檢查。
- `attachOnly: true` 表示「絕不啟動本機瀏覽器；僅在它已經運行時才附加。」
- `color` + 每個設定檔的 `color` 會為瀏覽器 UI 著色，以便您查看哪個設定檔處於啟用狀態。
- 預設設定檔是 `chrome` (擴充功能中繼)。對於受管理的瀏覽器，請使用 `defaultProfile: "openclaw"`。
- 自動偵測順序：如果基於 Chromium，則為系統預設瀏覽器；否則為 Chrome → Brave → Edge → Chromium → Chrome Canary。
- 本機 `openclaw` 設定檔會自動分配 `cdpPort`/`cdpUrl` — 僅針對遠端 CDP 設定這些值。

## 使用 Brave (或其他基於 Chromium 的瀏覽器)

如果您的**系統預設**瀏覽器是基於 Chromium 的 (Chrome/Brave/Edge 等)，OpenClaw 會自動使用它。設定 `browser.executablePath` 以覆寫自動偵測：

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

## 本機與遠端控制

- **本機控制 (預設)：** Gateway 啟動 loopback 控制服務，並可以啟動本機瀏覽器。
- **遠端控制 (節點主機)：** 在擁有瀏覽器的機器上執行節點主機；Gateway 會將瀏覽器動作代理到它。
- **遠端 CDP：** 設定 `browser.profiles.<name>.cdpUrl` (或 `browser.cdpUrl`) 以附加到遠端基於 Chromium 的瀏覽器。在此情況下，OpenClaw 將不會啟動本機瀏覽器。

遠端 CDP URL 可以包含身份驗證：

- 查詢權杖 (例如 `https://provider.example?token=<token>`)
- HTTP 基本身份驗證 (例如 `https://user:pass @provider.example`)

OpenClaw 在呼叫 `/json/*` 端點和連線到 CDP WebSocket 時會保留身份驗證。建議使用環境變數或密鑰管理工具來儲存權杖，而不是將它們提交到設定檔中。

## 節點瀏覽器代理 (零設定預設)

如果您在擁有瀏覽器的機器上執行**節點主機**，OpenClaw 可以自動將瀏覽器工具呼叫路由到該節點，而無需任何額外的瀏覽器設定。這是遠端 gateways 的預設路徑。

注意事項：

- 節點主機透過**代理指令**公開其本機瀏覽器控制伺服器。
- 設定檔來自節點自己的 `browser.profiles` 設定 (與本機相同)。
- 如果您不想要它，請停用：
  - 在節點上：`nodeHost.browserProxy.enabled=false`
  - 在 gateway 上：`gateway.nodes.browser.mode="off"`

## Browserless (託管的遠端 CDP)

[Browserless](https://browserless.io) 是一個託管的 Chromium 服務，透過 HTTPS 公開 CDP 端點。您可以將 OpenClaw 瀏覽器設定檔指向 Browserless 區域端點並使用您的 API 密鑰進行身份驗證。

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

- 將 `<BROWSERLESS_API_KEY>` 替換為您真實的 Browserless 權杖。
- 選擇與您的 Browserless 帳戶相符的區域端點 (請參閱他們的說明文件)。

## 安全性

核心概念：

- 瀏覽器控制僅限 loopback；存取透過 Gateway 的身份驗證或節點配對進行。
- 如果啟用瀏覽器控制且未設定身份驗證，OpenClaw 會在啟動時自動生成 `gateway.auth.token` 並將其儲存到設定中。
- 將 Gateway 和任何節點主機保持在私人網路 (Tailscale) 上；避免公開暴露。
- 將遠端 CDP URL/權杖視為機密；建議使用環境變數或密鑰管理工具。

遠端 CDP 提示：

- 盡可能優先使用 HTTPS 端點和短期權杖。
- 避免直接在設定檔中嵌入長期權杖。

## 設定檔 (多瀏覽器)

OpenClaw 支援多個命名設定檔 (路由設定)。設定檔可以是：

- **openclaw-managed**：一個專用的基於 Chromium 的瀏覽器實例，擁有自己的使用者資料目錄 + CDP 連接埠
- **remote**：一個明確的 CDP URL (在其他地方運行的基於 Chromium 的瀏覽器)
- **extension relay**：透過本機中繼 + Chrome 擴充功能，存取您現有的 Chrome 分頁

預設值：

- 如果 `openclaw` 設定檔遺失，將會自動建立。
- `chrome` 設定檔是為 Chrome 擴充功能中繼內建的 (預設指向 `http://127.0.0.1:18792`)。
- 本機 CDP 連接埠預設從 **18800–18899** 分配。
- 刪除設定檔會將其本機資料目錄移至垃圾桶。

所有控制端點都接受 `?profile=<name>`；CLI 使用 `--browser-profile`。

## Chrome 擴充功能中繼 (使用您現有的 Chrome)

OpenClaw 也可以透過本機 CDP 中繼 + Chrome 擴充功能來驅動**您現有的 Chrome 分頁** (無需單獨的「openclaw」Chrome 實例)。

完整指南：[Chrome 擴充功能](/tools/chrome-extension)

流程：

- Gateway 在本機 (同一台機器) 運行，或節點主機在瀏覽器機器上運行。
- 本機**中繼伺服器**在 loopback `cdpUrl` (預設：`http://127.0.0.1:18792`) 監聽。
- 您點擊分頁上的 **OpenClaw 瀏覽器中繼**擴充功能圖示以附加 (它不會自動附加)。
- 智慧代理透過正常的 `browser` 工具控制該分頁，方法是選取正確的設定檔。

如果 Gateway 在其他地方運行，請在瀏覽器機器上運行節點主機，以便 Gateway 可以代理瀏覽器動作。

### 沙箱隔離的工作階段

如果智慧代理工作階段是沙箱隔離的，`browser` 工具可能預設為 `target="sandbox"` (沙箱瀏覽器)。
Chrome 擴充功能中繼接管需要主機瀏覽器控制，因此請執行以下其中一項：

- 以非沙箱模式執行工作階段，或
- 設定 `agents.defaults.sandbox.browser.allowHostControl: true` 並在呼叫工具時使用 `target="host"`。

### 設定

1. 載入擴充功能 (開發/未打包)：

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → 啟用「開發人員模式」
- 「載入未打包的擴充功能」→ 選取由 `openclaw browser extension path` 列印出的目錄
- 固定擴充功能，然後在您要控制的分頁上點擊它 (徽章顯示 `ON`)。

2. 使用方法：

- CLI：`openclaw browser --browser-profile chrome tabs`
- 智慧代理工具：`browser` 與 `profile="chrome"`

選用：如果您想要不同的名稱或中繼連接埠，請建立您自己的設定檔：

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

注意事項：

- 此模式依賴 Playwright-on-CDP 進行大多數操作 (螢幕截圖/快照/動作)。
- 再次點擊擴充功能圖示即可分離。

## 隔離保證

- **專用使用者資料目錄**：絕不觸及您的個人瀏覽器設定檔。
- **專用連接埠**：避免 `9222` 以防止與開發工作流程衝突。
- **確定性分頁控制**：透過 `targetId` 而非「最後一個分頁」來指定分頁。

## 瀏覽器選擇

在本機啟動時，OpenClaw 會選擇第一個可用的瀏覽器：

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

您可以使用 `browser.executablePath` 覆寫。

平台：

- macOS：檢查 `/Applications` 和 `~/Applications`。
- Linux：尋找 `google-chrome`、`brave`、`microsoft-edge`、`chromium` 等。
- Windows：檢查常見安裝位置。

## 控制 API (選用)

僅適用於本機整合，Gateway 公開了一個小型的 loopback HTTP API：

- 狀態/啟動/停止：`GET /`、`POST /start`、`POST /stop`
- 分頁：`GET /tabs`、`POST /tabs/open`、`POST /tabs/focus`、`DELETE /tabs/:targetId`
- 快照/螢幕截圖：`GET /snapshot`、`POST /screenshot`
- 動作：`POST /navigate`、`POST /act`
- 掛鉤：`POST /hooks/file-chooser`、`POST /hooks/dialog`
- 下載：`POST /download`、`POST /wait/download`
- 偵錯：`GET /console`、`POST /pdf`
- 偵錯：`GET /errors`、`GET /requests`、`POST /trace/start`、`POST /trace/stop`、`POST /highlight`
- 網路：`POST /response/body`
- 狀態：`GET /cookies`、`POST /cookies/set`、`POST /cookies/clear`
- 狀態：`GET /storage/:kind`、`POST /storage/:kind/set`、`POST /storage/:kind/clear`
- 設定：`POST /set/offline`、`POST /set/headers`、`POST /set/credentials`、`POST /set/geolocation`、`POST /set/media`、`POST /set/timezone`、`POST /set/locale`、`POST /set/device`

所有端點都接受 `?profile=<name>`。

如果設定了 gateway 身份驗證，瀏覽器 HTTP 路由也需要身份驗證：

- `Authorization: Bearer <gateway token>`
- `x-openclaw-password: <gateway password>` 或使用該密碼的 HTTP 基本身份驗證

### Playwright 要求

某些功能 (導航/執行/AI 快照/角色快照、元素螢幕截圖、PDF) 需要 Playwright。如果未安裝 Playwright，這些端點將返回明確的 501 錯誤。對於由 openclaw 管理的 Chrome，ARIA 快照和基本螢幕截圖仍然有效。對於 Chrome 擴充功能中繼驅動程式，ARIA 快照和螢幕截圖需要 Playwright。

如果您看到 `Playwright is not available in this gateway build`，請安裝完整的 Playwright 套件 (而非 `playwright-core`) 並重新啟動 gateway，或者重新安裝支援瀏覽器的 OpenClaw。

#### Docker Playwright 安裝

如果您的 Gateway 在 Docker 中運行，請避免使用 `npx playwright` (npm 覆寫衝突)。請改用隨附的 CLI：

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

要持久化瀏覽器下載，請設定 `PLAYWRIGHT_BROWSERS_PATH` (例如，`/home/node/.cache/ms-playwright`)，並確保 `/home/node` 透過 `OPENCLAW_HOME_VOLUME` 或綁定掛載進行持久化。請參閱 [Docker](/install/docker)。

## 運作方式 (內部)

高階流程：

- 一個小型的**控制伺服器**接受 HTTP 請求。
- 它透過 **CDP** 連接到基於 Chromium 的瀏覽器 (Chrome/Brave/Edge/Chromium)。
- 對於進階動作 (點擊/輸入/快照/PDF)，它在 CDP 之上使用 **Playwright**。
- 當缺少 Playwright 時，僅提供非 Playwright 的操作。

這種設計使智慧代理保持在穩定、確定性的介面，同時讓您可以交換本機/遠端瀏覽器和設定檔。

## CLI 快速參考

所有指令都接受 `--browser-profile <name>` 以指定特定設定檔。所有指令也接受 `--json` 以用於機器可讀的輸出 (穩定的資料酬載)。

基本功能：

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

檢查：

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

動作：

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

- `upload` 和 `dialog` 是**預備**呼叫；在觸發選擇器/對話框的點擊/按壓之前執行它們。
- 下載和追蹤輸出路徑受限於 OpenClaw 臨時根目錄：
  - 追蹤：`/tmp/openclaw` (備用：`${os.tmpdir()}/openclaw`)
  - 下載：`/tmp/openclaw/downloads` (備用：`${os.tmpdir()}/openclaw/downloads`)
- `upload` 也可以透過 `--input-ref` 或 `--element` 直接設定檔案輸入。
- `snapshot`：
  - `--format ai` (安裝 Playwright 時的預設值)：返回帶有數字參照 (refs) 的 AI 快照 (`aria-ref="<n>"`)。
  - `--format aria`：返回無障礙樹 (無參照；僅供檢查)。
  - `--efficient` (或 `--mode efficient`)：緊湊角色快照預設 (互動式 + 緊湊 + 深度 + 較低的 maxChars)。
  - 設定預設 (僅限工具/CLI)：設定 `browser.snapshotDefaults.mode: "efficient"` 以在呼叫者未傳遞模式時使用高效快照 (請參閱 [Gateway 設定](/gateway/configuration#browser-openclaw-managed-browser))。
  - 角色快照選項 (`--interactive`、`--compact`、`--depth`、`--selector`) 會強制執行帶有 `ref=e12` 等參照的角色式快照。
  - `--frame "<iframe selector>"` 將角色快照範圍限定到 iframe (與 `e12` 等角色參照配對)。
  - `--interactive` 輸出一個扁平、易於選擇的互動元素列表 (最適合驅動動作)。
  - `--labels` 增加一個僅限視口的螢幕截圖，並疊加參照標籤 (列印 `MEDIA:<path>`)。
- `click`/`type` 等需要來自 `snapshot` 的 `ref` (數字 `12` 或角色參照 `e12`)。動作故意不支援 CSS 選取器。

## 快照和參照

OpenClaw 支援兩種「快照」樣式：

- **AI 快照 (數字參照)**：`openclaw browser snapshot` (預設；`--format ai`)
  - 輸出：包含數字參照的文字快照。
  - 動作：`openclaw browser click 12`、`openclaw browser type 23 "hello"`。
  - 在內部，參照透過 Playwright 的 `aria-ref` 解析。

- **角色快照 (如 `e12` 的角色參照)**：`openclaw browser snapshot --interactive` (或 `--compact`、`--depth`、`--selector`、`--frame`)
  - 輸出：帶有 `[ref=e12]` (以及選用 `[nth=1]`) 的角色式列表/樹。
  - 動作：`openclaw browser click e12`、`openclaw browser highlight e12`。
  - 在內部，參照透過 `getByRole(...)` 解析 (加上 `nth()` 用於重複項目)。
  - 新增 `--labels` 以包含帶有疊加 `e12` 標籤的視口螢幕截圖。

參照行為：

- 參照在**導航之間不穩定**；如果出現問題，請重新執行 `snapshot` 並使用新的參照。
- 如果角色快照是使用 `--frame` 拍攝的，則角色參照將限定於該 iframe，直到下一個角色快照。

## 等待強化功能

您不只可以等待時間/文字：

- 等待 URL (Playwright 支援 glob 模式)：
  - `openclaw browser wait --url "**/dash"`
- 等待載入狀態：
  - `openclaw browser wait --load networkidle`
- 等待 JS 判斷式：
  - `openclaw browser wait --fn "window.ready===true"`
- 等待選擇器變得可見：
  - `openclaw browser wait "#main"`

這些可以組合使用：

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## 偵錯工作流程

當動作失敗時 (例如「不可見」、「嚴格模式違規」、「被遮蓋」)：

1. `openclaw browser snapshot --interactive`
2. 使用 `click <ref>` / `type <ref>` (在互動模式下優先使用角色參照)
3. 如果仍然失敗：`openclaw browser highlight <ref>` 以查看 Playwright 正在定位什麼
4. 如果頁面行為異常：
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. 進行深度偵錯：記錄追蹤：
   - `openclaw browser trace start`
   - 重現問題
   - `openclaw browser trace stop` (列印 `TRACE:<path>`)

## JSON 輸出

`--json` 用於腳本和結構化工具。

範例：

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON 中的角色快照包含 `refs` 以及一個小的 `stats` 區塊 (lines/chars/refs/interactive)，以便工具可以判斷資料酬載的大小和密度。

## 狀態和環境設定鈕

這些對於「讓網站像 X 一樣運作」的工作流程很有用：

- Cookies：`cookies`、`cookies set`、`cookies clear`
- 儲存：`storage local|session get|set|clear`
- 離線：`set offline on|off`
- 標頭：`set headers --json '{"X-Debug":"1"}'` (或 `--clear`)
- HTTP 基本身份驗證：`set credentials user pass` (或 `--clear`)
- 地理位置：`set geo <lat> <lon> --origin "https://example.com"` (或 `--clear`)
- 媒體：`set media dark|light|no-preference|none`
- 時區 / 語言環境：`set timezone ...`、`set locale ...`
- 裝置 / 視口：
  - `set device "iPhone 14"` (Playwright 裝置預設值)
  - `set viewport 1280 720`

## 安全與隱私

- openclaw 瀏覽器設定檔可能包含已登入的工作階段；請將其視為敏感資訊。
- `browser act kind=evaluate` / `openclaw browser evaluate` 和 `wait --fn` 在頁面上下文中執行任意 JavaScript。提示注入可能會引導此操作。如果您不需要它，請使用 `browser.evaluateEnabled=false` 停用它。
- 有關登入和反機器人注意事項 (X/Twitter 等)，請參閱 [瀏覽器登入 + X/Twitter 發文](/tools/browser-login)。
- 保持 Gateway/節點主機私有 (loopback 或僅限 tailnet)。
- 遠端 CDP 端點功能強大；請進行通道並保護它們。

## 疑難排解

有關 Linux 特有問題 (尤其是 snap Chromium)，請參閱
[瀏覽器疑難排解](/tools/browser-linux-troubleshooting)。

## 智慧代理工具 + 控制方式

智慧代理有一個用於瀏覽器自動化的**工具**：

- `browser` — 狀態/啟動/停止/分頁/開啟/聚焦/關閉/快照/螢幕截圖/導航/執行

其對應關係：

- `browser snapshot` 返回一個穩定的 UI 樹 (AI 或 ARIA)。
- `browser act` 使用快照 `ref` ID 來點擊/輸入/拖曳/選取。
- `browser screenshot` 捕捉像素 (完整頁面或元素)。
- `browser` 接受：
  - `profile` 以選擇命名的瀏覽器設定檔 (openclaw、chrome 或 remote CDP)。
  - `target` (`sandbox` | `host` | `node`) 以選擇瀏覽器所在的位置。
  - 在沙箱隔離的工作階段中，`target: "host"` 需要 `agents.defaults.sandbox.browser.allowHostControl=true`。
  - 如果省略 `target`：沙箱隔離的工作階段預設為 `sandbox`，非沙箱隔離的工作階段預設為 `host`。
  - 如果連接了支援瀏覽器的節點，工具可能會自動路由到它，除非您固定 `target="host"` 或 `target="node"`。

這使智慧代理保持確定性，並避免脆弱的選取器。
