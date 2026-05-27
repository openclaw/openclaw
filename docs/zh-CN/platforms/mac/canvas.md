---
read_when:
  - 实现 macOS Canvas 面板
  - 为可视化工作区添加智能体控制
  - 调试 WKWebView canvas 加载
summary: 通过 WKWebView + 自定义 URL 方案嵌入的智能体控制 Canvas 面板
title: Canvas
x-i18n:
  generated_at: "2026-02-03T07:52:39Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: e39caa21542e839d9f59ad0bf7ecefb379225ed7e8f00cd59131d188f193bec6
  source_path: platforms/mac/canvas.md
  workflow: 15
---

# Canvas（macOS 应用）

macOS 应用使用 `WKWebView` 嵌入一个智能体控制的 **Canvas 面板**。它是一个用于 HTML/CSS/JS、A2UI 和小型交互式界面的轻量级可视化工作区。

## Canvas 存储位置

Canvas 状态存储在 Application Support 下：

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvas 面板通过**自定义 URL 方案**提供这些文件：

- `openclaw-canvas://<session>/<path>`

示例：

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

如果根目录下没有 `index.html`，应用会显示一个**内置脚手架页面**。

## 面板行为

- 无边框、可调整大小的面板，锚定在菜单栏（或鼠标光标）附近。
- 记住每个会话的大小/位置。
- 当本地 canvas 文件更改时自动重新加载。
- 一次只显示一个 Canvas 面板（根据需要切换会话）。

可以从设置 → **允许 Canvas** 禁用 Canvas。禁用时，canvas 节点命令返回 `CANVAS_DISABLED`。

## 智能体 API 接口

Canvas 通过 **Gateway 网关 WebSocket** 暴露，因此智能体可以：

- 显示/隐藏面板
- 导航到路径或 URL
- 执行 JavaScript
- 捕获快照图像

CLI 示例：

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

注意事项：

- `canvas.navigate` 接受**本地 canvas 路径**、`http(s)` URL 和 `file://` URL。
- 如果传递 `"/"`，Canvas 会显示本地脚手架或 `index.html`。

## Canvas 中的 A2UI

A2UI 由 Gateway 网关 canvas 主机托管并在 Canvas 面板内渲染。
当 Gateway 网关广播 Canvas 主机时，macOS 应用在首次打开时自动导航到 A2UI 主机页面。

默认 A2UI 主机 URL：

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### A2UI 命令（v0.8）

Canvas 目前接受 **A2UI v0.8** 服务器→客户端消息：

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface`（v0.9）不受支持。

CLI 示例：

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

快速测试：

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## 从 Canvas 触发智能体运行

Canvas 可以通过深层链接触发新的智能体运行：

- `openclaw://agent?...`

示例（在 JS 中）：

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

除非提供有效密钥，否则应用会提示确认。

## 安全注意事项

- Canvas 方案阻止目录遍历；文件必须位于会话根目录下。
- 本地 Canvas 内容使用自定义方案（不需要 loopback 服务器）。
- 仅在显式导航时允许外部 `http(s)` URL。
