---
summary: Integrated browser control service + action commands
read_when:
  - Adding agent-controlled browser automation
  - Debugging why openclaw is interfering with your own Chrome
  - Implementing browser settings + lifecycle in the macOS app
title: Browser (OpenClaw-managed)
---

# 瀏覽器（openclaw 管理）

OpenClaw 可以執行一個由代理控制的 **專用 Chrome/Brave/Edge/Chromium 瀏覽器設定檔**。  
它與你的個人瀏覽器隔離，並透過 Gateway 內部的一個小型本地控制服務（僅限迴圈介面）來管理。

初學者視角：

- 把它想成一個 **獨立、僅供代理使用的瀏覽器**。
- `openclaw` 設定檔 **不會** 影響你的個人瀏覽器設定檔。
- 代理可以在安全環境中 **開啟分頁、讀取頁面、點擊和輸入**。
- 預設的 `chrome` 設定檔透過擴充功能中繼使用 **系統預設的 Chromium 瀏覽器**；切換到 `openclaw` 可使用隔離管理的瀏覽器。

## 你會得到什麼

- 一個名為 **openclaw** 的獨立瀏覽器設定檔（預設為橘色強調色）。
- 確定性的分頁控制（列出/開啟/聚焦/關閉）。
- 代理操作（點擊/輸入/拖曳/選取）、快照、螢幕截圖、PDF。
- 可選的多設定檔支援 (`openclaw`、`work`、`remote` 等)。

此瀏覽器 **不是** 你的日常使用瀏覽器。它是一個安全、隔離的代理自動化與驗證環境。

## 快速開始

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

如果出現「瀏覽器已停用」訊息，請在設定中啟用（見下方說明）並重新啟動 Gateway。

## 設定檔：`openclaw` vs `chrome`

- `openclaw`：受管理、隔離的瀏覽器（不需擴充功能）。
- `chrome`：透過擴充功能中繼連接你的 **系統瀏覽器**（需在分頁中附加 OpenClaw 擴充功能）。

如果你想預設使用管理模式，請設定 `browser.defaultProfile: "openclaw"`。

## 設定

瀏覽器設定位於 `~/.openclaw/openclaw.json`。

```json5
{
  browser: {
    enabled: true, // default: true
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: true, // default trusted-network mode
      // allowPrivateNetwork: true, // legacy alias
      // hostnameAllowlist: ["*.example.com", "example.com"],
      // allowedHostnames: ["localhost"],
    },
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

- 瀏覽器控制服務會綁定到 loopback，使用從 `gateway.port` 推導出的埠號（預設為 `18791`，即 gateway + 2）。中繼服務使用下一個埠號 (`18792`)。
- 如果你覆寫了 Gateway 埠號（`gateway.port` 或 `OPENCLAW_GATEWAY_PORT`），推導出的瀏覽器埠號會相應調整，保持在同一「系列」中。
- `cdpUrl` 預設為中繼埠號，若未設定則採用此值。
- `remoteCdpTimeoutMs` 用於遠端（非 loopback）CDP 可達性檢查。
- `remoteCdpHandshakeTimeoutMs` 用於遠端 CDP WebSocket 可達性檢查。
- 瀏覽器導航或開啟分頁前會進行 SSRF 防護，導航完成後會盡力重新檢查最終 `http(s)` URL。
- `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork` 預設為 `true`（信任網路模型）。若要嚴格限制為公開網路瀏覽，請設為 `false`。
- `browser.ssrfPolicy.allowPrivateNetwork` 仍作為舊版別名保留以維持相容性。
- `attachOnly: true` 表示「絕不啟動本地瀏覽器；僅在瀏覽器已啟動時附加」。
- `color` 加上每個設定檔的 `color`，會為瀏覽器 UI 添加色調，方便辨識當前啟用的設定檔。
- 預設設定檔為 `openclaw`（OpenClaw 管理的獨立瀏覽器）。使用 `defaultProfile: "chrome"` 可選擇啟用 Chrome 擴充中繼。
- 自動偵測順序：系統預設瀏覽器（若為 Chromium 核心）；否則依序為 Chrome → Brave → Edge → Chromium → Chrome Canary。
- 本地 `openclaw` 設定檔會自動分配 `cdpPort`/`cdpUrl`，這兩項僅需為遠端 CDP 設定。

## 使用 Brave（或其他 Chromium 核心瀏覽器）

如果你的 **系統預設** 瀏覽器是 Chromium 核心（Chrome/Brave/Edge 等），
OpenClaw 會自動使用它。若要覆寫自動偵測，請設定 `browser.executablePath`：

CLI 範例：

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

json5
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

## 本地控制 vs 遠端控制

- **本地控制（預設）：** Gateway 啟動 loopback 控制服務，並可啟動本地瀏覽器。
- **遠端控制（節點主機）：** 在有瀏覽器的機器上執行節點主機，Gateway 會代理瀏覽器操作給該節點。
- **遠端 CDP：** 設定 `browser.profiles.<name>.cdpUrl`（或 `browser.cdpUrl`）以附加到遠端 Chromium 核心瀏覽器。此情況下，OpenClaw 不會啟動本地瀏覽器。

遠端 CDP URL 可以包含認證資訊：

- 查詢 token（例如 `https://provider.example?token=<token>`）
- HTTP 基本認證（例如 `https://user:pass@provider.example`）

OpenClaw 在呼叫 `/json/*` 端點及連接 CDP WebSocket 時會保留認證資訊。建議使用環境變數或秘密管理工具來管理 token，避免將它們寫入設定檔。

## Node 瀏覽器代理（零設定預設）

如果你在有瀏覽器的機器上執行 **node host**，OpenClaw 可以自動將瀏覽器工具呼叫導向該 node，無需額外的瀏覽器設定。這是遠端閘道的預設路徑。

注意事項：

- node host 會透過 **proxy command** 來暴露其本地瀏覽器控制伺服器。
- 設定檔來自 node 自身的 `browser.profiles` 設定（與本地相同）。
- 如果不想使用，可以停用：
  - 在 node 上：`nodeHost.browserProxy.enabled=false`
  - 在閘道上：`gateway.nodes.browser.mode="off"`

## Browserless（託管遠端 CDP）

[Browserless](https://browserless.io) 是一個託管的 Chromium 服務，透過 HTTPS 暴露 CDP 端點。你可以將 OpenClaw 瀏覽器設定指向 Browserless 的區域端點，並使用你的 API key 進行驗證。

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

- 將 `<BROWSERLESS_API_KEY>` 替換成你真實的 Browserless token。
- 選擇與你的 Browserless 帳號相符的區域端點（詳見其文件）。

## 直接 WebSocket CDP 供應商

有些託管瀏覽器服務會暴露 **直接 WebSocket** 端點，而非標準的基於 HTTP 的 CDP 探測 (`/json/version`)。OpenClaw 兩者皆支援：

- **HTTP(S) 端點**（例如 Browserless）— OpenClaw 呼叫 `/json/version` 來探測 WebSocket 除錯器 URL，然後連線。
- **WebSocket 端點**（`ws://` / `wss://`）— OpenClaw 直接連線，跳過 `/json/version`。適用於像是
  [Browserbase](https://www.browserbase.com) 或任何提供你 WebSocket URL 的服務。

### Browserbase

[Browserbase](https://www.browserbase.com) 是一個雲端平台，用於執行無頭瀏覽器，內建 CAPTCHA 解決方案、隱身模式及住宅代理。

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserbase",
    remoteCdpTimeoutMs: 3000,
    remoteCdpHandshakeTimeoutMs: 5000,
    profiles: {
      browserbase: {
        cdpUrl: "wss://connect.browserbase.com?apiKey=<BROWSERBASE_API_KEY>",
        color: "#F97316",
      },
    },
  },
}
```

說明：

- [註冊](https://www.browserbase.com/sign-up) 並從 [總覽儀表板](https://www.browserbase.com/overview) 複製您的 **API Key**。
- 將 `<BROWSERBASE_API_KEY>` 替換為您真實的 Browserbase API 金鑰。
- Browserbase 在 WebSocket 連線時會自動建立瀏覽器會話，因此不需要手動建立會話步驟。
- 免費方案允許同時一個會話及每月一小時的瀏覽器使用時間。
  詳情請參考 [價格方案](https://www.browserbase.com/pricing)。
- 請參閱 [Browserbase 文件](https://docs.browserbase.com) 以取得完整 API 參考、SDK 指南及整合範例。

## 安全性

重點：

- 瀏覽器控制僅限本機迴路；存取需透過 Gateway 的認證或節點配對。
- 若啟用瀏覽器控制且未設定認證，OpenClaw 會在啟動時自動產生 `gateway.auth.token` 並保存至設定檔。
- 請將 Gateway 及任何節點主機置於私有網路（如 Tailscale）；避免公開暴露。
- 將遠端 CDP URL/token 視為機密資訊；建議使用環境變數或秘密管理工具。

遠端 CDP 建議：

- 優先使用加密端點（HTTPS 或 WSS）及短期有效的 token。
- 避免在設定檔中直接嵌入長期有效的 token。

## 設定檔（多瀏覽器）

OpenClaw 支援多個命名設定檔（路由設定）。設定檔類型包括：

- **openclaw 管理**：專屬的 Chromium 瀏覽器實例，擁有獨立的使用者資料目錄及 CDP 連接埠
- **遠端**：明確指定的 CDP URL（在其他地方執行的 Chromium 瀏覽器）
- **擴充功能中繼**：透過本地中繼及 Chrome 擴充功能，使用您現有的 Chrome 分頁

預設值：

- 若缺少，會自動建立 `openclaw` 設定檔。
- `chrome` 設定檔為內建的 Chrome 擴充功能中繼（預設指向 `http://127.0.0.1:18792`）。
- 本地 CDP 連接埠預設分配範圍為 **18800–18899**。
- 刪除設定檔會將其本地資料目錄移至垃圾桶。

所有控制端點皆接受 `?profile=<name>`；CLI 使用 `--browser-profile`。

## Chrome 擴充功能中繼（使用您現有的 Chrome）

OpenClaw 也能透過本地 CDP 中繼與 Chrome 擴充功能，驅動 **你現有的 Chrome 分頁**（無需獨立的 “openclaw” Chrome 實例）。

完整指南：[Chrome 擴充功能](/tools/chrome-extension)

流程：

- Gateway 在本機（同一台機器）執行，或在瀏覽器機器上執行一個 node host。
- 本地 **中繼伺服器** 監聽迴圈位址 `cdpUrl`（預設：`http://127.0.0.1:18792`）。
- 你點擊分頁上的 **OpenClaw Browser Relay** 擴充功能圖示來附加（不會自動附加）。
- 代理程式透過正常的 `browser` 工具，選擇正確的設定檔來控制該分頁。

如果 Gateway 執行在其他地方，請在瀏覽器機器上執行 node host，讓 Gateway 能代理瀏覽器操作。

### 沙盒會話

如果代理會話是沙盒環境，`browser` 工具可能預設為 `target="sandbox"`（沙盒瀏覽器）。
Chrome 擴充功能中繼接管需要主機瀏覽器控制，因此必須：

- 以非沙盒模式執行會話，或
- 設定 `agents.defaults.sandbox.browser.allowHostControl: true` 並在呼叫工具時使用 `target="host"`。

### 設定

1. 載入擴充功能（開發者模式/解壓縮）：

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → 啟用「開發者模式」
- 「載入已解壓的擴充功能」→ 選擇 `openclaw browser extension path` 輸出的目錄
- 將擴充功能釘選，然後點擊你想控制的分頁（徽章顯示 `ON`）。

2. 使用方式：

- CLI：`openclaw browser --browser-profile chrome tabs`
- 代理工具：`browser` 搭配 `profile="chrome"`

選用：如果你想要不同的名稱或中繼埠，請建立你自己的設定檔：

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

說明：

- 此模式大部分操作（截圖/快照/動作）依賴 Playwright-on-CDP。
- 再次點擊擴充功能圖示即可分離。
- 預設中繼僅限迴路回送。如果中繼必須能從不同的網路命名空間存取（例如 WSL2 中的 Gateway、Windows 上的 Chrome），請將 `browser.relayBindHost` 設為明確的綁定地址，如 `0.0.0.0`，同時保持周邊網路私密且需驗證。

WSL2 / 跨命名空間範例：

```json5
{
  browser: {
    enabled: true,
    relayBindHost: "0.0.0.0",
    defaultProfile: "chrome",
  },
}
```

## 隔離保證

- **專用使用者資料目錄**：絕不會接觸你的個人瀏覽器設定檔。
- **專用埠口**：避免 `9222`，防止與開發工作流程衝突。
- **確定性分頁控制**：透過 `targetId` 鎖定目標分頁，而非「最後一個分頁」。

## 瀏覽器選擇

本機啟動時，OpenClaw 會選擇第一個可用的：

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

你可以用 `browser.executablePath` 來覆寫。

支援平台：

- macOS：檢查 `/Applications` 和 `~/Applications`。
- Linux：尋找 `google-chrome`、`brave`、`microsoft-edge`、`chromium` 等。
- Windows：檢查常見安裝路徑。

## 控制 API（選用）

僅限本地整合，Gateway 提供一個小型迴路回送 HTTP API：

- 狀態/啟動/停止：`GET /`、`POST /start`、`POST /stop`
- 分頁：`GET /tabs`、`POST /tabs/open`、`POST /tabs/focus`、`DELETE /tabs/:targetId`
- 快照/截圖：`GET /snapshot`、`POST /screenshot`
- 動作：`POST /navigate`、`POST /act`
- 鉤子：`POST /hooks/file-chooser`、`POST /hooks/dialog`
- 下載：`POST /download`、`POST /wait/download`
- 除錯：`GET /console`、`POST /pdf`
- 除錯：`GET /errors`、`GET /requests`、`POST /trace/start`、`POST /trace/stop`、`POST /highlight`
- 網路：`POST /response/body`
- 狀態：`GET /cookies`、`POST /cookies/set`、`POST /cookies/clear`
- 狀態：`GET /storage/:kind`、`POST /storage/:kind/set`、`POST /storage/:kind/clear`
- 設定：`POST /set/offline`、`POST /set/headers`、`POST /set/credentials`、`POST /set/geolocation`、`POST /set/media`、`POST /set/timezone`、`POST /set/locale`、`POST /set/device`

所有端點皆接受 `?profile=<name>`。

如果已設定 gateway 認證，瀏覽器 HTTP 路由也需要認證：

- `Authorization: Bearer <gateway token>`
- `x-openclaw-password: <gateway password>` 或使用該密碼的 HTTP Basic 認證

### Playwright 需求

部分功能（導覽/操作/AI 快照/角色快照、元素截圖、PDF）需要 Playwright。若未安裝 Playwright，這些端點會回傳明確的 501 錯誤。ARIA 快照和基本截圖仍可用於 openclaw 管理的 Chrome。對於 Chrome 擴充功能中繼驅動，ARIA 快照和截圖則需要 Playwright。

如果你看到 `Playwright is not available in this gateway build`，請安裝完整的 Playwright 套件（非 `playwright-core`），並重新啟動 gateway，或重新安裝支援瀏覽器的 OpenClaw。

#### Docker Playwright 安裝

如果你的 Gateway 執行於 Docker，避免使用 `npx playwright`（npm 覆寫衝突）。請改用內建的 CLI：

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

若要持久化瀏覽器下載，請設定 `PLAYWRIGHT_BROWSERS_PATH`（例如 `/home/node/.cache/ms-playwright`），並確保 `/home/node` 透過 `OPENCLAW_HOME_VOLUME` 或綁定掛載持久化。詳見 [Docker](/install/docker)。

## 運作原理（內部）

高階流程：

- 一個小型的 **控制伺服器** 接收 HTTP 請求。
- 它透過 **CDP** 連接 Chromium 系列瀏覽器（Chrome/Brave/Edge/Chromium）。
- 對於進階操作（點擊/輸入/快照/PDF），在 CDP 之上使用 **Playwright**。
- 若缺少 Playwright，僅能使用非 Playwright 的操作。

此設計讓代理維持在穩定且可預期的介面，同時允許你替換本地或遠端瀏覽器及其設定檔。

## CLI 快速參考

所有指令皆接受 `--browser-profile <name>` 以指定特定的設定檔。
所有指令也接受 `--json` 以產生機器可讀的輸出（穩定的資料格式）。

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
- `openclaw browser upload /tmp/openclaw/uploads/file.pdf`
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
- `openclaw browser set headers --headers-json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

備註：

- `upload` 和 `dialog` 是 **預備** 呼叫；請在觸發選擇器/對話框的點擊/按壓前執行。
- 下載與追蹤輸出路徑限制於 OpenClaw 臨時根目錄：
  - 追蹤：`/tmp/openclaw`（備用：`${os.tmpdir()}/openclaw`）
  - 下載：`/tmp/openclaw/downloads`（備用：`${os.tmpdir()}/openclaw/downloads`）
- 上傳路徑限制於 OpenClaw 臨時上傳根目錄：
  - 上傳：`/tmp/openclaw/uploads`（備用：`${os.tmpdir()}/openclaw/uploads`）
- `upload` 也可以透過 `--input-ref` 或 `--element` 直接設定檔案輸入。
- `snapshot`：
  - `--format ai`（Playwright 安裝時的預設）：回傳帶有數字參考的 AI 快照 (`aria-ref="<n>"`)。
  - `--format aria`：回傳無參考的無障礙樹（僅供檢查）。
  - `--efficient`（或 `--mode efficient`）：緊湊角色快照預設（互動 + 緊湊 + 深度 + 較低的最大字元數）。
  - 設定預設（工具/CLI 專用）：設定 `browser.snapshotDefaults.mode: "efficient"`，當呼叫者未傳入模式時使用高效快照（參見 [Gateway 設定](/gateway/configuration#browser-openclaw-managed-browser)）。
  - 角色快照選項 (`--interactive`, `--compact`, `--depth`, `--selector`) 強制使用帶有參考的角色快照，如 `ref=e12`。
  - `--frame "<iframe selector>"` 將角色快照範圍限定於 iframe（與角色參考如 `e12` 配對）。
  - `--interactive` 輸出扁平且易於選擇的互動元素清單（最適合驅動操作）。
  - `--labels` 新增帶有覆蓋參考標籤的視窗截圖（會列印 `MEDIA:<path>`）。
- `click`/`type`/等需要 `ref`，由 `snapshot` 提供（可為數字 `12` 或角色參考 `e12`）。
  CSS 選擇器故意不支援用於操作。

## 快照與參考

OpenClaw 支援兩種「快照」風格：

- **AI 快照（數字參考）**：`openclaw browser snapshot`（預設；`--format ai`）
  - 輸出：包含數字參考的文字快照。
  - 操作：`openclaw browser click 12`、`openclaw browser type 23 "hello"`。
  - 內部參考透過 Playwright 的 `aria-ref` 解析。

- **角色快照（角色參考如 `e12`）**：`openclaw browser snapshot --interactive`（或 `--compact`、`--depth`、`--selector`、`--frame`）
  - 輸出：基於角色的列表/樹狀結構，包含 `[ref=e12]`（以及可選的 `[nth=1]`）。
  - 動作：`openclaw browser click e12`、`openclaw browser highlight e12`。
  - 內部參考透過 `getByRole(...)` 解決（重複專案則加上 `nth()`）。
  - 加上 `--labels` 以包含帶有覆蓋 `e12` 標籤的視窗截圖。

參考行為：

- 參考在導航間**不穩定**；若失敗，請重新執行 `snapshot` 並使用新的參考。
- 若角色快照是用 `--frame` 拍攝，角色參考會限定在該 iframe，直到下一次角色快照。

## 等待強化功能

你可以等待的不只限於時間/文字：

- 等待 URL（Playwright 支援通配符）：
  - `openclaw browser wait --url "**/dash"`
- 等待載入狀態：
  - `openclaw browser wait --load networkidle`
- 等待 JS 條件判斷：
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

## 除錯工作流程

當動作失敗（例如「不可見」、「嚴格模式違規」、「被遮蓋」）時：

1. `openclaw browser snapshot --interactive`
2. 使用 `click <ref>` / `type <ref>`（互動模式下優先使用角色參考）
3. 若仍失敗：使用 `openclaw browser highlight <ref>` 查看 Playwright 目標
4. 若頁面行為異常：
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. 深度除錯：錄製追蹤：
   - `openclaw browser trace start`
   - 重現問題
   - `openclaw browser trace stop`（列印 `TRACE:<path>`）

## JSON 輸出

`--json` 用於腳本與結構化工具。

範例：

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Role 快照的 JSON 包含 `refs` 以及一個小型的 `stats` 區塊（行數/字元/參考/互動），以便工具能夠推斷有效載荷的大小和密度。

## 狀態與環境設定

這些對於「讓網站表現得像 X」的工作流程非常有用：

- Cookies: `cookies`, `cookies set`, `cookies clear`
- 儲存空間: `storage local|session get|set|clear`
- 離線模式: `set offline on|off`
- 標頭: `set headers --headers-json '{"X-Debug":"1"}'`（舊版 `set headers --json '{"X-Debug":"1"}'` 仍受支援）
- HTTP 基本認證: `set credentials user pass`（或 `--clear`）
- 地理位置: `set geo <lat> <lon> --origin "https://example.com"`（或 `--clear`）
- 媒體: `set media dark|light|no-preference|none`
- 時區 / 地區設定: `set timezone ...`, `set locale ...`
- 裝置 / 檢視窗：
  - `set device "iPhone 14"`（Playwright 裝置預設）
  - `set viewport 1280 720`

## 安全性與隱私

- openclaw 瀏覽器設定檔可能包含已登入的會話；請視為敏感資訊。
- `browser act kind=evaluate` / `openclaw browser evaluate` 以及 `wait --fn` 會在頁面上下文中執行任意 JavaScript。提示注入可能會影響此行為。如不需要，請用 `browser.evaluateEnabled=false` 禁用它。
- 關於登入與防機器人說明（X/Twitter 等），請參考 [瀏覽器登入 + X/Twitter 發文](/tools/browser-login)。
- 請保持 Gateway/node 主機私密（僅限回環或 tailnet）。
- 遠端 CDP 端點功能強大；請使用隧道並加以保護。

嚴格模式範例（預設封鎖私人/內部目的地）：

```json5
{
  browser: {
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: false,
      hostnameAllowlist: ["*.example.com", "example.com"],
      allowedHostnames: ["localhost"], // optional exact allow
    },
  },
}
```

## 疑難排解

針對 Linux 特定問題（尤其是 snap Chromium），請參考
[瀏覽器疑難排解](/tools/browser-linux-troubleshooting)。

針對 WSL2 Gateway + Windows Chrome 分割主機設定，請參考
[WSL2 + Windows + 遠端 Chrome CDP 疑難排解](/tools/browser-wsl2-windows-remote-cdp-troubleshooting)。

## 代理工具與控制方式

代理會獲得 **一個工具** 用於瀏覽器自動化：

- `browser` — 狀態/啟動/停止/分頁/開啟/聚焦/關閉/快照/截圖/導覽/操作

它的映射方式：

- `browser snapshot` 回傳穩定的 UI 樹狀結構（AI 或 ARIA）。
- `browser act` 使用快照 `ref` 的 ID 來點擊／輸入／拖曳／選取。
- `browser screenshot` 擷取像素（整頁或元素）。
- `browser` 接受：
  - `profile` 用以選擇命名的瀏覽器設定檔（openclaw、chrome 或遠端 CDP）。
  - `target`（`sandbox` | `host` | `node`）用來選擇瀏覽器所在位置。
  - 在沙盒環境中，`target: "host"` 需要 `agents.defaults.sandbox.browser.allowHostControl=true`。
  - 若省略 `target`：沙盒環境預設為 `sandbox`，非沙盒環境預設為 `host`。
  - 若有可瀏覽器節點連線，工具可能會自動導向該節點，除非你鎖定 `target="host"` 或 `target="node"`。

這可保持代理的決定性，避免使用脆弱的選擇器。
