---
summary: "智慧代理控制的 Canvas 面板透過 WKWebView + 自訂 URL Scheme 嵌入"
read_when:
  - 實作 macOS Canvas 面板
  - 為視覺工作區新增智慧代理控制項
  - 偵錯 WKWebView Canvas 載入
title: "Canvas"
---

# Canvas (macOS 應用程式)

macOS 應用程式使用 `WKWebView` 嵌入智慧代理控制的 **Canvas 面板**。這是一個輕量級的視覺工作區，用於 HTML/CSS/JS、A2UI 和小型互動式使用者介面。

## Canvas 所在位置

Canvas 狀態儲存在應用程式支援目錄下：

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvas 面板透過 **自訂 URL Scheme** 提供這些檔案：

- `openclaw-canvas://<session>/<path>`

範例：

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

如果根目錄中沒有 `index.html`，應用程式會顯示一個 **內建鷹架頁面**。

## 面板行為

- 無邊框、可調整大小的面板，錨定在選單列（或滑鼠游標）附近。
- 每個工作階段會記住大小/位置。
- 當地端 Canvas 檔案變更時自動重新載入。
- 每次只會顯示一個 Canvas 面板（根據需要切換工作階段）。

Canvas 可以從「設定」→ **允許 Canvas** 中停用。停用時，canvas 節點命令會傳回 `CANVAS_DISABLED`。

## 智慧代理 API 介面

Canvas 透過 **Gateway WebSocket** 暴露，因此智慧代理可以：

- 顯示/隱藏面板
- 導航到路徑或 URL
- 評估 JavaScript
- 擷取快照圖片

CLI 範例：

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

注意事項：

- `canvas.navigate` 接受 **當地 Canvas 路徑**、`http(s)` URL 和 `file://` URL。
- 如果您傳遞 `"/"`，Canvas 會顯示當地鷹架或 `index.html`。

## Canvas 中的 A2UI

A2UI 由 Gateway Canvas 主機託管，並在 Canvas 面板內呈現。當 Gateway 宣告 Canvas 主機時，macOS 應用程式會在首次開啟時自動導航到 A2UI 主機頁面。

預設 A2UI 主機 URL：

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### A2UI 命令 (v0.8)

Canvas 目前接受 **A2UI v0.8** 伺服器→用戶端訊息：

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) 不支援。

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

Canvas 可以透過深層連結觸發新的智慧代理執行：

- `openclaw://agent?...`

範例 (在 JS 中)：

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

應用程式會提示確認，除非提供有效金鑰。

## 安全注意事項

- Canvas scheme 會阻擋目錄遍歷；檔案必須位於工作階段根目錄下。
- 當地 Canvas 內容使用自訂 scheme (無需 local loopback 伺服器)。
- 外部 `http(s)` URL 只有在明確導航時才允許。
