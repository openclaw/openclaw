---
title: "Diffs"
summary: "代理的只读差异查看器和文件渲染器（可选插件工具）"
description: "使用可选的 Diffs 插件将变更内容转换为网关托管的差异视图、文件（PNG 或 PDF），或两者兼有。"
read_when:
  - 你希望代理以差异形式显示代码或 Markdown 编辑
  - 你需要画布就绪的查看器 URL 或渲染的差异文件
  - 你需要具有安全默认值的受控临时差异工件
---

# Diffs

`diffs` 是一个可选的插件工具，用于将变更内容转换为代理的只读差异工件。

它接受以下输入：

- `before` 和 `after` 文本
- 统一 `patch`

它可以返回：

- 用于画布展示的网关查看器 URL
- 用于消息传递的渲染文件路径（PNG 或 PDF）
- 一次调用同时返回两种输出

## 快速开始

1. 启用插件。
2. 使用 `mode: "view"` 调用 `diffs`，用于画布优先的流程。
3. 使用 `mode: "file"` 调用 `diffs`，用于聊天文件传递流程。
4. 使用 `mode: "both"` 调用 `diffs`，当你需要两种工件时。

## 启用插件

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

## 典型的代理工作流程

1. 代理调用 `diffs`。
2. 代理读取 `details` 字段。
3. 代理执行以下操作之一：
   - 使用 `canvas present` 打开 `details.viewerUrl`
   - 使用 `path` 或 `filePath` 通过 `message` 发送 `details.filePath`
   - 同时执行上述操作

## 输入示例

Before 和 after：

```json
{
  "before": "# Hello\n\nOne",
  "after": "# Hello\n\nTwo",
  "path": "docs/example.md",
  "mode": "view"
}
```

Patch：

```json
{
  "patch": "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
  "mode": "both"
}
```

## 工具输入参考

所有字段都是可选的，除非另有说明：

- `before` (`string`)：原始文本。当省略 `patch` 时需要与 `after` 一起使用。
- `after` (`string`)：更新后的文本。当省略 `patch` 时需要与 `before` 一起使用。
- `patch` (`string`)：统一差异文本。与 `before` 和 `after` 互斥。
- `path` (`string`)：用于 before 和 after 模式的显示文件名。
- `lang` (`string`)：用于 before 和 after 模式的语言覆盖提示。
- `title` (`string`)：查看器标题覆盖。
- `mode` (`"view" | "file" | "both"`)：输出模式。默认为插件默认值 `defaults.mode`。
- `theme` (`"light" | "dark"`)：查看器主题。默认为插件默认值 `defaults.theme`。
- `layout` (`"unified" | "split"`)：差异布局。默认为插件默认值 `defaults.layout`。
- `expandUnchanged` (`boolean`)：当有完整上下文可用时展开未修改的部分。仅单次调用选项（不是插件默认键）。
- `fileFormat` (`"png" | "pdf"`)：渲染文件格式。默认为插件默认值 `defaults.fileFormat`。
- `fileQuality` (`"standard" | "hq" | "print"`)：PNG 或 PDF 渲染的质量预设。
- `fileScale` (`number`)：设备缩放覆盖（`1`-`4`）。
- `fileMaxWidth` (`number`)：最大渲染宽度，以 CSS 像素为单位（`640`-`2400`）。
- `ttlSeconds` (`number`)：查看器工件 TTL，以秒为单位。默认 1800，最大 21600。
- `baseUrl` (`string`)：查看器 URL 源覆盖。必须是 `http` 或 `https`，无查询/哈希。

验证和限制：

- `before` 和 `after` 每个最大 512 KiB。
- `patch` 最大 2 MiB。
- `path` 最大 2048 字节。
- `lang` 最大 128 字节。
- `title` 最大 1024 字节。
- Patch 复杂性上限：最多 128 个文件和 120000 总行数。
- `patch` 不能与 `before` 或 `after` 一起使用。

## 输出详情合约

工具在 `details` 下返回结构化元数据。

为创建查看器的模式共享的字段：

- `artifactId`
- `viewerUrl`
- `viewerPath`
- `title`
- `expiresAt`
- `inputKind`
- `fileCount`
- `mode`

当渲染 PNG 或 PDF 时的文件字段：

- `filePath`
- `path`（与 `filePath` 值相同，用于消息工具兼容性）
- `fileBytes`
- `fileFormat`
- `fileQuality`
- `fileScale`
- `fileMaxWidth`

模式行为摘要：

- `mode: "view"`：仅查看器字段。
- `mode: "file"`：仅文件字段，无查看器工件。
- `mode: "both"`：查看器字段加文件字段。如果文件渲染失败，查看器仍然返回，带有 `fileError`。

## 折叠未修改的部分

- 查看器可以显示类似 `N unmodified lines` 的行。
- 这些行上的展开控件是有条件的，并非对每种输入类型都保证。
- 当渲染的差异具有可展开的上下文数据时，展开控件会出现，这对 before 和 after 输入很常见。
- 对于许多统一 patch 输入，省略的上下文主体在解析的 patch 块中不可用，因此该行可能出现没有展开控件的情况。这是预期行为。
- `expandUnchanged` 仅在可展开的上下文存在时适用。

## 插件默认值

在 `~/.openclaw/openclaw.json` 中设置插件范围的默认值：

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

支持的默认值：

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

显式工具参数会覆盖这些默认值。

## 安全配置

- `security.allowRemoteViewer` (`boolean`，默认 `false`)
  - `false`：拒绝对查看器路由的非环回请求。
  - `true`：如果标记化的路径有效，则允许远程查看器。

示例：

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

## 工件生命周期和存储

- 工件存储在临时子文件夹下：`$TMPDIR/openclaw-diffs`。
- 查看器工件元数据包含：
  - 随机工件 ID（20 个十六进制字符）
  - 随机令牌（48 个十六进制字符）
  - `createdAt` 和 `expiresAt`
  - 存储的 `viewer.html` 路径
- 默认查看器 TTL 为 30 分钟（未指定时）。
- 接受的最大查看器 TTL 为 6 小时。
- 清理在工件创建后机会性地运行。
- 过期的工件将被删除。
- 当元数据丢失时，回退清理会删除超过 24 小时的陈旧文件夹。

## 查看器 URL 和网络行为

查看器路由：

- `/plugins/diffs/view/{artifactId}/{token}`

查看器资源：

- `/plugins/diffs/assets/viewer.js`
- `/plugins/diffs/assets/viewer-runtime.js`

URL 构造行为：

- 如果提供了 `baseUrl`，则在严格验证后使用它。
- 没有 `baseUrl` 时，查看器 URL 默认为环回 `127.0.0.1`。
- 如果网关绑定模式是 `custom` 且设置了 `gateway.customBindHost`，则使用该主机。

`baseUrl` 规则：

- 必须是 `http://` 或 `https://`。
- 拒绝查询和哈希。
- 允许源加可选的基本路径。

## 安全模型

查看器加固：

- 默认仅环回。
- 带有严格 ID 和令牌验证的标记化查看器路径。
- 查看器响应 CSP：
  - `default-src 'none'`
  - 脚本和资源仅来自 self
  - 无出站 `connect-src`
- 当启用远程访问时的远程未命中限制：
  - 每 60 秒 40 次失败
  - 60 秒锁定（`429 Too Many Requests`）

文件渲染加固：

- 屏幕截图浏览器请求路由默认拒绝。
- 仅允许来自 `http://127.0.0.1/plugins/diffs/assets/*` 的本地查看器资源。
- 外部网络请求被阻止。

## 文件模式的浏览器要求

`mode: "file"` 和 `mode: "both"` 需要兼容 Chromium 的浏览器。

解析顺序：

1. OpenClaw 配置中的 `browser.executablePath`。
2. 环境变量：
   - `OPENCLAW_BROWSER_EXECUTABLE_PATH`
   - `BROWSER_EXECUTABLE_PATH`
   - `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
3. 平台命令/路径发现回退。

常见失败文本：

- `Diff PNG/PDF rendering requires a Chromium-compatible browser...`

通过安装 Chrome、Chromium、Edge 或 Brave，或设置上述可执行路径选项之一来修复。

## 故障排除

输入验证错误：

- `Provide patch or both before and after text.`
  - 包含 `before` 和 `after`，或提供 `patch`。
- `Provide either patch or before/after input, not both.`
  - 不要混合输入模式。
- `Invalid baseUrl: ...`
  - 使用带有可选路径的 `http(s)` 源，无查询/哈希。
- `{field} exceeds maximum size (...)`
  - 减少负载大小。
- 大 patch 拒绝
  - 减少 patch 文件数或总行数。

查看器可访问性问题：

- 查看器 URL 默认解析为 `127.0.0.1`。
- 对于远程访问场景，要么：
  - 每次工具调用时传递 `baseUrl`，或
  - 使用 `gateway.bind=custom` 和 `gateway.customBindHost`
- 仅当你打算进行外部查看器访问时才启用 `security.allowRemoteViewer`。

未修改行没有展开按钮：

- 对于 patch 输入，当 patch 不携带可展开的上下文时，可能会发生这种情况。
- 这是预期行为，并不表示查看器失败。

工件未找到：

- 工件因 TTL 过期。
- 令牌或路径已更改。
- 清理删除了陈旧数据。

## 操作指导

- 对于画布中的本地交互式审查，优先使用 `mode: "view"`。
- 对于需要附件的出站聊天通道，优先使用 `mode: "file"`。
- 除非你的部署需要远程查看器 URL，否则保持 `allowRemoteViewer` 禁用。
- 为敏感的差异设置显式的短 `ttlSeconds`。
- 非必要时避免在差异输入中发送机密信息。
- 如果你的通道积极压缩图像（例如 Telegram 或 WhatsApp），优先使用 PDF 输出（`fileFormat: "pdf"`）。

差异渲染引擎：

- 由 [Diffs](https://diffs.com) 提供支持。

## 相关文档

- [工具概览](/tools)
- [插件](/tools/plugin)
- [浏览器](/tools/browser)
