---
title: Diffs
summary: Read-only diff viewer and file renderer for agents (optional plugin tool)
description: >-
  Use the optional Diffs plugin to render before and after text or unified
  patches as a gateway-hosted diff view, a file (PNG or PDF), or both.
read_when:
  - You want agents to show code or markdown edits as diffs
  - You want a canvas-ready viewer URL or a rendered diff file
  - "You need controlled, temporary diff artifacts with secure defaults"
---

`diffs` 是一個可選的外掛工具，內建簡短的系統指引，並附帶一個技能，能將變更內容轉換成只讀的差異檔案供代理使用。

它接受以下任一輸入：

- `before` 和 `after` 文字
- 一個統一格式的 `patch`

它可以回傳：

- 用於畫布展示的閘道檢視器 URL
- 用於訊息傳遞的渲染檔案路徑（PNG 或 PDF）
- 兩種輸出同時回傳

啟用時，該外掛會在系統提示區域前置簡潔的使用指引，並且提供詳細技能，供代理在需要更完整指示時使用。

## 快速開始

1. 啟用外掛。
2. 使用 `mode: "view"` 呼叫 `diffs`，適用於以畫布為主的流程。
3. 使用 `mode: "file"` 呼叫 `diffs`，適用於聊天檔案傳遞流程。
4. 需要兩種產物時，使用 `mode: "both"` 呼叫 `diffs`。

## 啟用外掛

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
      },
    },
  },
}
```

## 停用內建系統指引

如果您想保留 `diffs` 工具啟用，但停用其內建的系統提示指引，請將 `plugins.entries.diffs.hooks.allowPromptInjection` 設為 `false`：

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        hooks: {
          allowPromptInjection: false,
        },
      },
    },
  },
}
```

此設定會阻擋 diffs 外掛的 `before_prompt_build` 鉤子，但仍保留外掛、工具與附屬技能可用。

如果您想同時停用指引和工具，請改為停用插件。

## 典型代理工作流程

1. 代理呼叫 `diffs`。
2. 代理讀取 `details` 欄位。
3. 代理執行以下其中一項：
   - 使用 `canvas present` 開啟 `details.viewerUrl`
   - 使用 `path` 或 `filePath` 傳送 `details.filePath` 搭配 `message`
   - 兩者皆做

## 輸入範例

前後比較：

```json
{
  "before": "# Hello\n\nOne",
  "after": "# Hello\n\nTwo",
  "path": "docs/example.md",
  "mode": "view"
}
```

修補程式：

```json
{
  "patch": "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
  "mode": "both"
}
```

## 工具輸入參考

除非另有說明，所有欄位皆為選填：

- `before` (`string`)：原始文字。當省略 `patch` 時，與 `after` 一起為必填。
- `after` (`string`)：更新後文字。當省略 `patch` 時，與 `before` 一起為必填。
- `patch` (`string`)：統一差異（unified diff）文字。與 `before` 和 `after` 互斥。
- `path` (`string`)：前後模式顯示的檔名。
- `lang` (`string`)：前後模式的語言覆寫提示。
- `title` (`string`)：檢視器標題覆寫。
- `mode` (`"view" | "file" | "both"`)：輸出模式。預設為插件預設 `defaults.mode`。
- `theme` (`"light" | "dark"`)：檢視器主題。預設為插件預設 `defaults.theme`。
- `layout` (`"unified" | "split"`)：差異佈局。預設為插件預設 `defaults.layout`。
- `expandUnchanged` (`boolean`)：當有完整上下文時展開未變更區段。僅限單次呼叫選項（非插件預設鍵）。
- `fileFormat` (`"png" | "pdf"`)：渲染檔案格式。預設為插件預設 `defaults.fileFormat`。
- `fileQuality` (`"standard" | "hq" | "print"`)：PNG 或 PDF 渲染的品質預設。
- `fileScale` (`number`)：裝置縮放覆寫（`1`-`4`）。
- `fileMaxWidth` (`number`)：最大渲染寬度（CSS 像素，`640`-`2400`）。
- `ttlSeconds` (`number`)：檢視器資源存活時間（TTL，秒）。預設 1800，最大 21600。
- `baseUrl` (`string`)：檢視器 URL 原點覆寫。必須是 `http` 或 `https`，且不可有查詢字串或錨點。

驗證與限制：

- `before` 和 `after` 各最大 512 KiB。
- `patch` 最大 2 MiB。
- `path` 最大 2048 字元。
- `lang` 最大 128 字元。
- `title` 最大 1024 字元。
- 修補程式複雜度上限：最多 128 個檔案及 120000 行總數。
- `patch` 與 `before` 或 `after` 同時存在會被拒絕。
- 渲染檔案安全限制（適用於 PNG 和 PDF）：
  - `fileQuality: "standard"`：最大 8 百萬像素（8,000,000 渲染像素）。
  - `fileQuality: "hq"`：最大 14 百萬像素（14,000,000 渲染像素）。
  - `fileQuality: "print"`：最大 24 百萬像素（24,000,000 渲染像素）。
  - PDF 另有限制最多 50 頁。

## 輸出細節契約

工具會在 `details` 下回傳結構化的元資料。

建立檢視器模式的共用欄位：

- `artifactId`
- `viewerUrl`
- `viewerPath`
- `title`
- `expiresAt`
- `inputKind`
- `fileCount`
- `mode`

當渲染 PNG 或 PDF 時的檔案欄位：

- `filePath`
- `path`（與 `filePath` 值相同，為了訊息工具相容性）
- `fileBytes`
- `fileFormat`
- `fileQuality`
- `fileScale`
- `fileMaxWidth`

模式行為摘要：

- `mode: "view"`：僅檢視器欄位。
- `mode: "file"`：僅檔案欄位，無檢視器產物。
- `mode: "both"`：檢視器欄位加上檔案欄位。若檔案渲染失敗，檢視器仍會回傳 `fileError`。

## 摺疊的未變更區段

- 檢視器可顯示像 `N unmodified lines` 這樣的列。
- 這些列上的展開控制是有條件的，並非每種輸入類型都保證有。
- 當渲染的差異包含可展開的上下文資料時，會出現展開控制，這通常發生在前後輸入的情況。
- 對於許多統一補丁輸入，省略的上下文主體在解析的補丁區塊中不可用，因此該列可能會出現但沒有展開控制。這是預期行為。
- `expandUnchanged` 僅在存在可展開上下文時適用。

## 外掛預設值

在 `~/.openclaw/openclaw.json` 中設定全外掛預設值：

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        config: {
          defaults: {
            fontFamily: "Fira Code",
            fontSize: 15,
            lineSpacing: 1.6,
            layout: "unified",
            showLineNumbers: true,
            diffIndicators: "bars",
            wordWrap: true,
            background: true,
            theme: "dark",
            fileFormat: "png",
            fileQuality: "standard",
            fileScale: 2,
            fileMaxWidth: 960,
            mode: "both",
          },
        },
      },
    },
  },
}
```

支援的預設值：

- `fontFamily`
- `fontSize`
- `lineSpacing`
- `layout`
- `showLineNumbers`
- `diffIndicators`
- `wordWrap`
- `background`
- `theme`
- `fileFormat`
- `fileQuality`
- `fileScale`
- `fileMaxWidth`
- `mode`

明確的工具參數會覆蓋這些預設值。

## 安全性設定

- `security.allowRemoteViewer` (`boolean`，預設為 `false`)
  - `false`：非迴圈回送的請求至 viewer 路由將被拒絕。
  - `true`：若 token 化路徑有效，允許遠端 viewer 存取。

範例：

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        config: {
          security: {
            allowRemoteViewer: false,
          },
        },
      },
    },
  },
}
```

## Artifact 生命週期與儲存

- Artifact 儲存在暫存子資料夾：`$TMPDIR/openclaw-diffs`。
- Viewer artifact 的 metadata 包含：
  - 隨機 artifact ID（20 個十六進位字元）
  - 隨機 token（48 個十六進位字元）
  - `createdAt` 與 `expiresAt`
  - 儲存的 `viewer.html` 路徑
- 預設 viewer TTL 為 30 分鐘（未指定時）。
- 最大允許的 viewer TTL 為 6 小時。
- Artifact 建立後會機會性執行清理。
- 過期的 artifact 將被刪除。
- 當 metadata 遺失時，備援清理會移除超過 24 小時的陳舊資料夾。

## Viewer URL 與網路行為

Viewer 路由：

- `/plugins/diffs/view/{artifactId}/{token}`

Viewer 資源：

- `/plugins/diffs/assets/viewer.js`
- `/plugins/diffs/assets/viewer-runtime.js`

URL 建構行為：

- 若提供 `baseUrl`，經嚴格驗證後會使用該值。
- 若無 `baseUrl`，viewer URL 預設為迴圈回送 `127.0.0.1`。
- 若 gateway 綁定模式為 `custom` 且設定了 `gateway.customBindHost`，則使用該主機。

`baseUrl` 規則：

- 必須是 `http://` 或 `https://`。
- 不接受查詢字串與雜湊值。
- 允許使用來源加上可選的基底路徑。

## 安全模型

Viewer 強化：

- 預設僅限迴路回送（loopback）。
- 觀察器路徑使用 token 化，並嚴格驗證 ID 與 token。
- 觀察器回應的內容安全政策（CSP）：
  - `default-src 'none'`
  - 僅允許來自自身的腳本與資源
  - 禁止外發 `connect-src`
- 啟用遠端存取時的遠端失敗限制：
  - 60 秒內 40 次失敗
  - 60 秒鎖定 (`429 Too Many Requests`)

檔案渲染強化：

- 截圖瀏覽器請求路由預設拒絕。
- 僅允許來自 `http://127.0.0.1/plugins/diffs/assets/*` 的本地觀察器資源。
- 阻擋外部網路請求。

## 檔案模式的瀏覽器需求

`mode: "file"` 與 `mode: "both"` 需要相容 Chromium 的瀏覽器。

解析順序：

1. OpenClaw 設定中的 `browser.executablePath`。
2. 環境變數：
   - `OPENCLAW_BROWSER_EXECUTABLE_PATH`
   - `BROWSER_EXECUTABLE_PATH`
   - `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
3. 平台命令/路徑偵測備援。

常見錯誤訊息：

- `Diff PNG/PDF rendering requires a Chromium-compatible browser...`

請透過安裝 Chrome、Chromium、Edge 或 Brave，或設定上述其中一個執行檔路徑選項來修正。

## 疑難排解

輸入驗證錯誤：

- `Provide patch or both before and after text.`
  - 請同時包含 `before` 與 `after`，或提供 `patch`。
- `Provide either patch or before/after input, not both.`
  - 請勿混用輸入模式。
- `Invalid baseUrl: ...`
  - 使用 `http(s)` 的來源，路徑可選，但不可有查詢字串或錨點。
- `{field} exceeds maximum size (...)`
  - 減少負載大小。
- 大型補丁拒絕
  - 減少補丁檔案數量或總行數。

Viewer 可及性問題：

- 預設情況下，檢視器 URL 會解析為 `127.0.0.1`。
- 對於遠端存取情境，請選擇：
  - 每次工具呼叫時傳入 `baseUrl`，或
  - 使用 `gateway.bind=custom` 和 `gateway.customBindHost`。
- 僅在您打算讓外部檢視器存取時啟用 `security.allowRemoteViewer`。

未修改行列沒有展開按鈕：

- 當 patch 輸入不包含可展開的上下文時，可能會發生此情況。
- 這是預期行為，並不表示檢視器失敗。

找不到 Artifact：

- Artifact 因 TTL 過期。
- Token 或路徑已變更。
- 清理程序移除過期資料。

## 操作指引

- 本地互動式檢視建議使用 `mode: "view"`。
- 需要附加檔案的外發聊天頻道建議使用 `mode: "file"`。
- 除非部署需求遠端檢視器 URL，否則保持 `allowRemoteViewer` 關閉。
- 對敏感差異設定明確且短暫的 `ttlSeconds`。
- 非必要時避免在差異輸入中傳送機密資訊。
- 若您的頻道會積極壓縮圖片（例如 Telegram 或 WhatsApp），建議使用 PDF 輸出 (`fileFormat: "pdf"`)。

差異渲染引擎：

- 由 [Diffs](https://diffs.com) 提供技術支援。

## 相關文件

- [工具總覽](/tools)
- [外掛](/tools/plugin)
- [瀏覽器](/tools/browser)
