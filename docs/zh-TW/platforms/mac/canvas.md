---
summary: "透過 WKWebView 與自訂 URL scheme 內嵌的代理程式控制 Canvas 面板"
read_when:
  - 實作 macOS Canvas 面板
  - 為視覺化工作空間加入代理程式控制
  - 偵錯 WKWebView Canvas 載入問題
title: "Canvas"
---

# Canvas（macOS 應用程式）

macOS 應用程式使用 `WKWebView` 內嵌一個由代理程式控制的 **Canvas 面板**。它是一個輕量級的視覺化工作空間，適用於 HTML/CSS/JS、A2UI，以及小型互動式 UI 介面。 它是一個輕量化的視覺化工作空間，用於 HTML/CSS/JS、A2UI，以及小型互動式
UI 介面。

## Canvas 的位置

Canvas 狀態儲存在 Application Support 之下：

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvas 面板會透過 **自訂 URL scheme** 提供這些檔案：

- `openclaw-canvas://<session>/<path>`

範例：

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

如果在根目錄中不存在 `index.html`，應用程式會顯示 **內建的骨架頁面**。

## 面板行為

- 無邊框、可調整大小的面板，錨定在選單列附近（或滑鼠游標旁）。
- 每個工作階段會記住大小與位置。
- 本地 Canvas 檔案變更時會自動重新載入。
- 任一時間只會顯示一個 Canvas 面板（視需要切換工作階段）。

Canvas can be disabled from Settings → **Allow Canvas**. 停用時，Canvas
節點指令會回傳 `CANVAS_DISABLED`。

## 代理程式 API 介面

Canvas 透過 **Gateway WebSocket** 對外提供，因此代理程式可以：

- 顯示／隱藏面板
- 導航至路徑或 URL
- 評估 JavaScript
- 擷取快照影像

CLI 範例：

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

注意事項：

- `canvas.navigate` 可接受 **本機 Canvas 路徑**、`http(s)` URL，以及 `file://` URL。
- 若傳入 `"/"`，Canvas 會顯示本機骨架頁面或 `index.html`。

## Canvas 中的 A2UI

A2UI 由 Gateway 閘道器的 canvas 主機託管，並在 Canvas 面板內渲染。當 Gateway 閘道器宣告可用的 Canvas 主機時，macOS 應用程式會在首次開啟時自動導向至 A2UI 主機頁面。
When the Gateway advertises a Canvas host, the macOS app auto‑navigates to the
A2UI host page on first open.

預設的 A2UI 主機 URL：

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### A2UI 指令（v0.8）

Canvas 目前接受 **A2UI v0.8** 的 server→client 訊息：

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface`（v0.9）尚未支援。

CLI 範例：

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

快速煙霧測試：

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## 從 Canvas 觸發代理程式執行

Canvas 可透過深層連結觸發新的代理程式執行：

- `openclaw://agent?...`

範例（在 JS 中）：

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

除非提供有效的金鑰，否則 App 會要求確認。

## 安全性注意事項

- Canvas 配置會阻擋目錄穿越；檔案必須位於工作階段根目錄之下。
- Local Canvas content uses a custom scheme (no loopback server required).
- 外部 `http(s)` URL 僅在明確導向時才允許。
