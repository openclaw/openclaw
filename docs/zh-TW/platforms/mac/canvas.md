---
summary: "透過 WKWebView + 自定義 URL 協議嵌入的智慧代理控制 Canvas 面板"
read_when:
  - 正在實作 macOS Canvas 面板
  - 正在為視覺化工作空間新增智慧代理控制
  - 正在偵錯 WKWebView canvas 載入
title: "Canvas"
---

# Canvas (macOS 應用程式)

macOS 應用程式使用 `WKWebView` 嵌入了一個由智慧代理控制的 **Canvas 面板**。這是一個用於 HTML/CSS/JS、A2UI 以及小型互動式 UI 介面的輕量級視覺化工作空間。

## Canvas 儲存位置

Canvas 狀態儲存於 Application Support 路徑下：

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvas 面板透過 **自定義 URL 協議 (scheme)** 提供這些檔案：

- `openclaw-canvas://<session>/<path>`

範例：

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

若根目錄不存在 `index.html`，應用程式將顯示 **內建的架構頁面 (scaffold page)**。

## 面板行為

- 無邊框、可調整大小的面板，固定在選單列（或滑鼠游標）附近。
- 會紀錄每個工作階段的大小與位置。
- 當本地 Canvas 檔案變更時會自動重新載入。
- 一次只能顯示一個 Canvas 面板（會根據需要切換工作階段）。

可從設定 → **允許 Canvas (Allow Canvas)** 停用 Canvas。停用時，canvas 節點指令會回傳 `CANVAS_DISABLED`。

## 智慧代理 API 介面

Canvas 透過 **Gateway WebSocket** 公開，因此智慧代理可以：

- 顯示/隱藏面板
- 導向至特定路徑或 URL
- 執行 JavaScript
- 擷取快照圖片

CLI 範例：

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

備註：

- `canvas.navigate` 接受 **本地 Canvas 路徑**、`http(s)` URL 以及 `file://` URL。
- 若傳入 `"/"`，Canvas 會顯示本地架構頁面或 `index.html`。

## Canvas 中的 A2UI

A2UI 由 Gateway canvas 主機代管，並在 Canvas 面板中渲染。當 Gateway 宣告 Canvas 主機時，macOS 應用程式在首次開啟時會自動導向至 A2UI 主機頁面。

預設 A2UI 主機 URL：

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### A2UI 指令 (v0.8)

Canvas 目前接受 **A2UI v0.8** 的伺服器至用戶端訊息：

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

不支援 `createSurface` (v0.9)。

CLI 範例：

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

快速測試：

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## 從 Canvas 觸發智慧代理執行

Canvas 可以透過深度連結 (deep links) 觸發新的智慧代理執行：

- `openclaw://agent?...`

範例 (JavaScript)：

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

除非提供有效的金鑰，否則應用程式會提示進行確認。

## 安全性注意事項

- Canvas 協議會封鎖目錄遍歷 (directory traversal)；檔案必須位於工作階段根目錄下。
- 本地 Canvas 內容使用自定義協議（不需要 local loopback 伺服器）。
- 僅在明確導向時才允許外部 `http(s)` URL。
