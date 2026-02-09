---
summary: "整合式瀏覽器控制服務 + 動作指令"
read_when:
  - 新增由代理程式控制的瀏覽器自動化
  - 疑難排解為何 OpenClaw 正在干擾你自己的 Chrome
  - 在 macOS 應用程式中實作瀏覽器設定與生命週期
title: "瀏覽器（由 OpenClaw 管理）"
---

# 瀏覽器（由 openclaw 管理）

OpenClaw 可以執行一個 **專用的 Chrome／Brave／Edge／Chromium 設定檔**，由代理程式控制。
它與你的個人瀏覽器隔離，並透過 Gateway 閘道器 內部的一個小型本地
控制服務來管理（僅限 local loopback）。
It is isolated from your personal browser and is managed through a small local
control service inside the Gateway (loopback only).

新手視角：

- 把它想成一個 **僅供代理程式使用的獨立瀏覽器**。
- The `openclaw` profile does **not** touch your personal browser profile.
- The agent can **open tabs, read pages, click, and type** in a safe lane.
- 預設的 `chrome` 設定檔透過
  擴充功能轉送使用 **系統預設的 Chromium 瀏覽器**；切換至 `openclaw` 以使用隔離的受管瀏覽器。

## 你可以獲得什麼

- 一個名為 **openclaw** 的獨立瀏覽器設定檔（預設為橘色強調）。
- Deterministic tab control (list/open/focus/close).
- 代理程式動作（點擊／輸入／拖曳／選取）、快照、螢幕截圖、PDF。
- 可選的多設定檔支援（`openclaw`、`work`、`remote`、…）。

此瀏覽器 **不是** 你的日常主力。它是用於
代理程式自動化與驗證的安全、隔離介面。 It is a safe, isolated surface for
agent automation and verification.

## 快速開始

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

如果你看到「Browser disabled」，請在設定中啟用它（見下文），並重新啟動
Gateway 閘道器。

## 設定檔：`openclaw` vs `chrome`

- `openclaw`：受管、隔離的瀏覽器（不需要擴充功能）。
- `chrome`：透過 **系統瀏覽器** 的擴充功能轉送（需要將 OpenClaw
  擴充功能附加到某個分頁）。

若你希望預設使用受管模式，請設定 `browser.defaultProfile: "openclaw"`。

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

- 瀏覽器控制服務會綁定到來自 `gateway.port` 推導出的 loopback 連接埠
  （預設：`18791`，也就是 Gateway 閘道器 + 2）。轉送會使用下一個連接埠（`18792`）。 The relay uses the next port (`18792`).
- 如果你覆寫 Gateway 閘道器 連接埠（`gateway.port` 或 `OPENCLAW_GATEWAY_PORT`），
  推導出的瀏覽器連接埠會一起平移以保持在同一「家族」中。
- `cdpUrl` 在未設定時預設為轉送連接埠。
- `remoteCdpTimeoutMs` 套用於遠端（非 loopback）的 CDP 可達性檢查。
- `remoteCdpHandshakeTimeoutMs` 套用於遠端 CDP WebSocket 可達性檢查。
- `attachOnly: true` 表示「永不啟動本地瀏覽器；僅在其已執行時才附加」。
- `color` + per-profile `color` tint the browser UI so you can see which profile is active.
- Default profile is `chrome` (extension relay). Use `defaultProfile: "openclaw"` for the managed browser.
- 自動偵測順序：若系統預設瀏覽器為 Chromium 系列則優先；否則 Chrome → Brave → Edge → Chromium → Chrome Canary。
- 本地 `openclaw` 設定檔會自動指派 `cdpPort`／`cdpUrl` —— 僅在遠端 CDP 時才需要設定這些。

## 使用 Brave（或其他 Chromium 系列瀏覽器）

如果你的 **系統預設** 瀏覽器是 Chromium 系列（Chrome／Brave／Edge 等），
OpenClaw 會自動使用它。設定 `browser.executablePath` 以覆寫
自動偵測： Set `browser.executablePath` to override
auto-detection:

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

- **本地控制（預設）：** Gateway 閘道器 會啟動 loopback 控制服務並可啟動本地瀏覽器。
- **遠端控制（節點主機）：** 在有瀏覽器的機器上執行節點主機；Gateway 閘道器 會將瀏覽器動作代理到該主機。
- **遠端 CDP：** 設定 `browser.profiles.<name>.cdpUrl`（或 `browser.cdpUrl`）以
  附加到遠端的 Chromium 系列瀏覽器。在此情況下，OpenClaw 不會啟動本地瀏覽器。 In this case, OpenClaw will not launch a local browser.

遠端 CDP URL 可以包含驗證資訊：

- 查詢權杖（例如 `https://provider.example?token=<token>`）
- HTTP Basic auth（例如 `https://user:pass@provider.example`）

OpenClaw 在呼叫 `/json/*` 端點以及連線到
CDP WebSocket 時會保留這些驗證資訊。請優先使用環境變數或秘密管理器來保存
權杖，而不是將其提交到設定檔。 Prefer environment variables or secrets managers for
tokens instead of committing them to config files.

## Node 瀏覽器代理（零設定預設）

如果你在擁有瀏覽器的機器上執行 **node host**，OpenClaw 可以
自動將瀏覽器工具呼叫路由到該節點，而無需任何額外的瀏覽器設定。
這是遠端 Gateway 閘道器 的預設路徑。
This is the default path for remote gateways.

注意事項：

- node host 會透過 **代理指令** 暴露其本地瀏覽器控制伺服器。
- 設定檔來自該節點自身的 `browser.profiles` 設定（與本地相同）。
- 若你不想要此功能，可停用：
  - 在節點上：`nodeHost.browserProxy.enabled=false`
  - 在 Gateway 閘道器 上：`gateway.nodes.browser.mode="off"`

## Browserless（託管的遠端 CDP）

[Browserless](https://browserless.io) 是一個託管的 Chromium 服務，透過 HTTPS
暴露 CDP 端點。你可以將 OpenClaw 的瀏覽器設定檔指向
Browserless 的區域端點，並使用你的 API 金鑰進行驗證。 You can point a OpenClaw browser profile at a
Browserless region endpoint and authenticate with your API key.

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

- 將 `<BROWSERLESS_API_KEY>` 替換為你實際的 Browserless 權杖。
- Choose the region endpoint that matches your Browserless account (see their docs).

## 安全性

核心概念：

- Browser control is loopback-only; access flows through the Gateway’s auth or node pairing.
- 將 Gateway 閘道器 與任何 node host 保持在私有網路（Tailscale）中；避免公開暴露。
- Treat remote CDP URLs/tokens as secrets; prefer env vars or a secrets manager.

遠端 CDP 建議：

- Prefer HTTPS endpoints and short-lived tokens where possible.
- 避免直接在設定檔中嵌入長期有效的權杖。

## Profiles (multi-browser)

OpenClaw supports multiple named profiles (routing configs). Profiles can be:

- **openclaw-managed**：具有自身使用者資料目錄與 CDP 連接埠的專用 Chromium 系列瀏覽器實例
- **remote**：明確的 CDP URL（在其他地方執行的 Chromium 系列瀏覽器）
- **extension relay**：透過本地轉送 + Chrome 擴充功能控制你現有的 Chrome 分頁

Defaults:

- The `openclaw` profile is auto-created if missing.
- The `chrome` profile is built-in for the Chrome extension relay (points at `http://127.0.0.1:18792` by default).
- 本地 CDP 連接埠預設配置自 **18800–18899**。
- Deleting a profile moves its local data directory to Trash.

所有控制端點都接受 `?profile=<name>`；CLI 使用 `--browser-profile`。

## Chrome 擴充功能轉送（使用你現有的 Chrome）

OpenClaw 也可以透過本地 CDP 轉送 + Chrome 擴充功能
驅動 **你現有的 Chrome 分頁**（不會啟動獨立的「openclaw」Chrome 實例）。

完整指南：[Chrome extension](/tools/chrome-extension)

流程：

- Gateway 閘道器 在本地執行（同一台機器），或在瀏覽器機器上執行 node host。
- 本地 **轉送伺服器** 會在 loopback 的 `cdpUrl`（預設：`http://127.0.0.1:18792`）監聽。
- You click the **OpenClaw Browser Relay** extension icon on a tab to attach (it does not auto-attach).
- The agent controls that tab via the normal `browser` tool, by selecting the right profile.

如果 Gateway 閘道器 在其他地方執行，請在瀏覽器機器上執行 node host，
以便 Gateway 閘道器 能代理瀏覽器動作。

### Sandboxed sessions

If the agent session is sandboxed, the `browser` tool may default to `target="sandbox"` (sandbox browser).
Chrome extension relay takeover requires host browser control, so either:

- run the session unsandboxed, or
- 設定 `agents.defaults.sandbox.browser.allowHostControl: true`，並在呼叫工具時使用 `target="host"`。

### 設定

1. 載入擴充功能（dev／unpacked）：

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → 啟用「Developer mode」
- 「Load unpacked」→ 選取 `openclaw browser extension path` 輸出的目錄
- Pin the extension, then click it on the tab you want to control (badge shows `ON`).

2. 使用方式：

- CLI：`openclaw browser --browser-profile chrome tabs`
- 代理程式工具：`browser` 搭配 `profile="chrome"`

選用：如果你想要不同的名稱或轉送連接埠，請建立你自己的設定檔：

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

注意事項：

- 此模式在多數操作（螢幕截圖／快照／動作）上依賴 Playwright-on-CDP。
- Detach by clicking the extension icon again.

## 隔離保證

- **Dedicated user data dir**: never touches your personal browser profile.
- **專用連接埠**：避免 `9222`，以防與開發流程發生衝突。
- **可預期的分頁控制**：以 `targetId` 為目標，而不是「最後一個分頁」。

## 瀏覽器選擇

在本地啟動時，OpenClaw 會選擇第一個可用的：

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

你可以使用 `browser.executablePath` 覆寫。

平台：

- macOS：檢查 `/Applications` 與 `~/Applications`。
- Linux：尋找 `google-chrome`、`brave`、`microsoft-edge`、`chromium` 等。
- Windows：檢查常見的安裝位置。

## 控制 API（選用）

僅供本地整合，Gateway 閘道器 會暴露一個小型的 loopback HTTP API：

- 狀態／啟動／停止：`GET /`、`POST /start`、`POST /stop`
- 分頁：`GET /tabs`、`POST /tabs/open`、`POST /tabs/focus`、`DELETE /tabs/:targetId`
- 快照／螢幕截圖：`GET /snapshot`、`POST /screenshot`
- 動作：`POST /navigate`、`POST /act`
- Hooks：`POST /hooks/file-chooser`、`POST /hooks/dialog`
- 下載：`POST /download`、`POST /wait/download`
- 偵錯：`GET /console`、`POST /pdf`
- 偵錯：`GET /errors`、`GET /requests`、`POST /trace/start`、`POST /trace/stop`、`POST /highlight`
- 網路：`POST /response/body`
- 狀態：`GET /cookies`、`POST /cookies/set`、`POST /cookies/clear`
- 狀態：`GET /storage/:kind`、`POST /storage/:kind/set`、`POST /storage/:kind/clear`
- 設定：`POST /set/offline`、`POST /set/headers`、`POST /set/credentials`、`POST /set/geolocation`、`POST /set/media`、`POST /set/timezone`、`POST /set/locale`、`POST /set/device`

所有端點都接受 `?profile=<name>`。

### Playwright 需求

Some features (navigate/act/AI snapshot/role snapshot, element screenshots, PDF) require
Playwright. If Playwright isn’t installed, those endpoints return a clear 501
error. ARIA snapshots and basic screenshots still work for openclaw-managed Chrome.
For the Chrome extension relay driver, ARIA snapshots and screenshots require Playwright.

如果你看到 `Playwright is not available in this gateway build`，請安裝完整的
Playwright 套件（不是 `playwright-core`）並重新啟動 gateway，
或重新安裝包含瀏覽器支援的 OpenClaw。

#### Docker 中安裝 Playwright

如果你的 Gateway 閘道器 在 Docker 中執行，請避免 `npx playwright`（npm 覆寫衝突）。
請改用隨附的 CLI：
Use the bundled CLI instead:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

若要保留瀏覽器下載內容，請設定 `PLAYWRIGHT_BROWSERS_PATH`（例如
`/home/node/.cache/ms-playwright`），並確保 `/home/node` 透過
`OPENCLAW_HOME_VOLUME` 或 bind mount 被保留。請參閱 [Docker](/install/docker)。 See [Docker](/install/docker).

## How it works (internal)

高層流程：

- 一個小型 **控制伺服器** 接受 HTTP 請求。
- 它透過 **CDP** 連線到 Chromium 系列瀏覽器（Chrome／Brave／Edge／Chromium）。
- 對於進階動作（點擊／輸入／快照／PDF），它在 CDP 之上使用 **Playwright**。
- 當缺少 Playwright 時，只能使用非 Playwright 的操作。

This design keeps the agent on a stable, deterministic interface while letting
you swap local/remote browsers and profiles.

## CLI 快速參考

All commands accept `--browser-profile <name>` to target a specific profile.
All commands also accept `--json` for machine-readable output (stable payloads).

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

檢視：

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
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

State:

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

- `upload` 與 `dialog` 是 **預備** 呼叫；請在觸發選擇器／對話框的點擊或按鍵前執行。
- `upload` 也可以透過 `--input-ref` 或 `--element` 直接設定檔案輸入。
- `snapshot`：
  - `--format ai`（安裝 Playwright 時的預設）：回傳帶有數字參照的 AI 快照（`aria-ref="<n>"`）。
  - `--format aria`：回傳可及性樹（無參照；僅供檢視）。
  - `--efficient`（或 `--mode efficient`）：精簡的角色快照預設（互動式 + 精簡 + 深度 + 較低的 maxChars）。
  - 設定預設（僅工具／CLI）：設定 `browser.snapshotDefaults.mode: "efficient"`，當呼叫端未指定模式時使用高效率快照（見 [Gateway 設定](/gateway/configuration#browser-openclaw-managed-browser)）。
  - 角色快照選項（`--interactive`、`--compact`、`--depth`、`--selector`）會強制使用角色式快照，並產生如 `ref=e12` 的參照。
  - `--frame "<iframe selector>"` 會將角色快照限定於某個 iframe（搭配如 `e12` 的角色參照）。
  - `--interactive` 會輸出扁平、易於挑選的互動元素清單（最適合驅動動作）。
  - `--labels` 會加入僅限視窗的螢幕截圖，並疊加參照標籤（輸出 `MEDIA:<path>`）。
- `click`／`type`／等需要一個來自 `snapshot` 的 `ref`（可以是數字 `12` 或角色參照 `e12`）。
  動作刻意不支援 CSS 選擇器。
  CSS selectors are intentionally not supported for actions.

## Snapshots and refs

OpenClaw 支援兩種「快照」樣式：

- **AI 快照（數字參照）**：`openclaw browser snapshot`（預設；`--format ai`）
  - Output: a text snapshot that includes numeric refs.
  - 動作：`openclaw browser click 12`、`openclaw browser type 23 "hello"`。
  - Internally, the ref is resolved via Playwright’s `aria-ref`.

- **角色快照（角色參照如 `e12`）**：`openclaw browser snapshot --interactive`（或 `--compact`、`--depth`、`--selector`、`--frame`）
  - Output: a role-based list/tree with `[ref=e12]` (and optional `[nth=1]`).
  - 動作：`openclaw browser click e12`、`openclaw browser highlight e12`。
  - 內部透過 `getByRole(...)`（以及重複項目的 `nth()`）解析參照。
  - 加上 `--labels` 以包含帶有疊加 `e12` 標籤的視窗螢幕截圖。

參照行為：

- Refs are **not stable across navigations**; if something fails, re-run `snapshot` and use a fresh ref.
- 如果角色快照是以 `--frame` 取得，角色參照會限定於該 iframe，直到下一次角色快照為止。

## 等待強化功能

你不只能等待時間／文字：

- 等待 URL（Playwright 支援 glob）：
  - `openclaw browser wait --url "**/dash"`
- 等待載入狀態：
  - `openclaw browser wait --load networkidle`
- 等待 JS 條件：
  - `openclaw browser wait --fn "window.ready===true"`
- 等待選擇器顯示：
  - `openclaw browser wait "#main"`

這些可以組合使用：

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Debug workflows

當動作失敗時（例如「不可見」、「嚴格模式違規」、「被遮擋」）：

1. `openclaw browser snapshot --interactive`
2. 使用 `click <ref>`／`type <ref>`（在互動模式下優先使用角色參照）
3. 若仍失敗：`openclaw browser highlight <ref>` 以查看 Playwright 的目標
4. 若頁面行為異常：
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. For deep debugging: record a trace:
   - `openclaw browser trace start`
   - 重現問題
   - `openclaw browser trace stop`（輸出 `TRACE:<path>`）

## JSON 輸出

`--json` is for scripting and structured tooling.

範例：

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

JSON 中的角色快照包含 `refs`，以及一小段 `stats` 區塊（行數／字元數／參照／互動性），以便工具評估負載大小與密度。

## State and environment knobs

這些對於「讓網站表現得像 X」的工作流程很有用：

- Cookies：`cookies`、`cookies set`、`cookies clear`
- 儲存空間：`storage local|session get|set|clear`
- 離線：`set offline on|off`
- 標頭：`set headers --json '{"X-Debug":"1"}'`（或 `--clear`）
- HTTP basic auth：`set credentials user pass`（或 `--clear`）
- 地理位置：`set geo <lat> <lon> --origin "https://example.com"`（或 `--clear`）
- 媒體：`set media dark|light|no-preference|none`
- 時區／語系：`set timezone ...`、`set locale ...`
- 裝置／視窗：
  - `set device "iPhone 14"`（Playwright 裝置預設）
  - `set viewport 1280 720`

## 安全性與隱私

- The openclaw browser profile may contain logged-in sessions; treat it as sensitive.
- `browser act kind=evaluate`／`openclaw browser evaluate` 與 `wait --fn`
  會在頁面情境中執行任意 JavaScript。提示注入可能引導此行為。
  若不需要，請使用 `browser.evaluateEnabled=false` 停用。 Prompt injection can steer
  this. Disable it with `browser.evaluateEnabled=false` if you do not need it.
- 登入與反機器人注意事項（X／Twitter 等），請參閱 [Browser login + X/Twitter posting](/tools/browser-login)。
- 保持 Gateway 閘道器／node host 為私有（僅 loopback 或 tailnet）。
- 遠端 CDP 端點權力強大；請進行通道化並妥善保護。

## Troubleshooting

Linux 特定問題（尤其是 snap Chromium），請參閱
[Browser troubleshooting](/tools/browser-linux-troubleshooting)。

## 代理程式工具 + 控制方式

代理程式只有 **一個工具** 用於瀏覽器自動化：

- `browser` — 狀態／啟動／停止／分頁／開啟／聚焦／關閉／快照／螢幕截圖／導覽／動作

How it maps:

- `browser snapshot` 回傳穩定的 UI 樹（AI 或 ARIA）。
- `browser act` 使用快照的 `ref` ID 來點擊／輸入／拖曳／選取。
- `browser screenshot` 擷取像素（全頁或元素）。
- `browser` 接受：
  - `profile` 以選擇具名瀏覽器設定檔（openclaw、chrome 或遠端 CDP）。
  - `target`（`sandbox` | `host` | `node`）以選擇瀏覽器所在位置。
  - 在沙箱化工作階段中，`target: "host"` 需要 `agents.defaults.sandbox.browser.allowHostControl=true`。
  - 若省略 `target`：沙箱化工作階段預設為 `sandbox`，非沙箱化工作階段預設為 `host`。
  - 若連線了具備瀏覽器能力的節點，工具可能會自動路由到該節點，除非你固定 `target="host"` 或 `target="node"`。

This keeps the agent deterministic and avoids brittle selectors.
