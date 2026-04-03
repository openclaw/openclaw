---
title: "Diffs"
summary: "代理的只读差异查看器和文件渲染器（可选插件工具）"
read_when:
  - 您想让代理以差异形式显示代码或 markdown 编辑
  - 您想要 canvas 就绪的查看器 URL 或渲染的差异文件
  - 您需要具有安全默认值的受控临时差异制品
---

# Diffs

`diffs` 是一个可选的插件工具，具有简短的内置系统指导和一个配套技能，可以将变更内容转换为代理的只读差异制品。

它接受：

- `before` 和 `after` 文本
- 统一的 `patch`

它可以返回：

- 用于 canvas 呈现的 Gateway 查看器 URL
- 用于消息传递的渲染文件路径（PNG 或 PDF）
- 在一次调用中同时返回两种输出

启用后，插件将简短的用法指导添加到 system-prompt 空间中，同时还暴露一个详细技能，供代理需要更完整说明时使用。

## 快速开始

1. 启用插件。
2. 对于 canvas 优先的流程，使用 `mode: "view"` 调用 `diffs`。
3. 对于聊天文件传递流程，使用 `mode: "file"` 调用 `diffs`。
4. 当您需要两种制品时，使用 `mode: "both"`。

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

## 禁用内置系统指导

如果您想保持 `diffs` 工具启用但禁用其内置 system-prompt 指导，请将 `plugins.entries.diffs.hooks.allowPromptInjection` 设置为 `false`：

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

这会阻止 diffs 插件的 `before_prompt_build` 钩子，同时保持插件、工具和配套技能可用。

如果您想同时禁用指导和工具，请改为禁用插件。

## 典型代理工作流

1. 代理调用 `diffs`。
2. 代理读取 `details` 字段。
3. 代理要么：
   - 使用 `canvas present` 打开 `details.viewerUrl`
   - 使用 `message` 发送 `details.filePath`（使用 `path` 或 `filePath`）
   - 两者都做

## 输入示例

之前和之后：

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

除非特别说明，所有字段都是可选的：

- `before`（`string`）：原始文本。当省略 `patch` 时，与 `after` 一起必需。
- `after`（`string`）：更新后的文本。当省略 `patch` 时，与 `before` 一起必需。
- `patch`（`string`）：统一差异文本。与 `before` 和 `after` 互斥。
- `path`（`string`）：之前和之后模式的显示文件名。
- `lang`（`string`）：之前和之后模式的语言覆盖提示。
- `title`（`string`）：查看器标题覆盖。
- `mode`（`"view" | "file" | "both"`）：输出模式。默认为插件默认 `defaults.mode`。已弃用的别名：`"image"` 的行为与 `"file"` 相同，仍被接受以保持向后兼容。
- `theme`（`"light" | "dark"`）：查看器主题。默认为插件默认 `defaults.theme`。
- `layout`（`"unified" | "split"`）：差异布局。默认为插件默认 `defaults.layout`。
- `expandUnchanged`（`boolean`）：当有完整上下文时展开未更改的部分。仅作为每次调用选项（不是插件默认键）。
- `fileFormat`（`"png" | "pdf"`）：渲染文件格式。默认为插件默认 `defaults.fileFormat`。
- `fileQuality`（`"standard" | "hq" | "print"`）：PNG 或 PDF 渲染的质量预设。
- `fileScale`（`number`）：设备比例覆盖（`1`-`4`）。
- `fileMaxWidth`（`number`）：最大渲染宽度（CSS 像素，`640`-`2400`）。
- `ttlSeconds`（`number`）：查看器制品的 TTL（秒）。默认 1800，最大 21600。
- `baseUrl`（`string`）：查看器 URL 来源覆盖。必须是 `http` 或 `https`，无查询/哈希。

验证和限制：

- `before` 和 `after` 每个最大 512 KiB。
- `patch` 最大 2 MiB。
- `path` 最大 2048 字节。
- `lang` 最大 128 字节。
- `title` 最大 1024 字节。
- Patch 复杂度上限：最多 128 个文件和 120000 总行数。
- `patch` 和 `before` 或 `after` 一起会被拒绝。
- 渲染文件安全限制（适用于 PNG 和 PDF）：
  - `fileQuality: "standard"`：最大 8 MP（8,000,000 渲染像素）。
  - `fileQuality: "hq"`：最大 14 MP（14,000,000 渲染像素）。
  - `fileQuality: "print"`：最大 24 MP（24,000,000 渲染像素）。
  - PDF 最多 50 页。

## 输出详情合同

工具在 `details` 下返回结构化元数据。

对于创建查看器的模式，共享字段：

- `artifactId`
- `viewerUrl`
- `viewerPath`
- `title`
- `expiresAt`
- `inputKind`
- `fileCount`
- `mode`
- `context`（`agentId`、`sessionId`、`messageChannel`、`agentAccountId`，当可用时）

当渲染 PNG 或 PDF 时的文件字段：

- `artifactId`
- `expiresAt`
- `filePath`
- `path`（与 `filePath` 相同的值，用于消息工具兼容性）
- `fileBytes`
- `fileFormat`
- `fileQuality`
- `fileScale`
- `fileMaxWidth`

模式行为摘要：

- `mode: "view"`：仅查看器字段。
- `mode: "file"`：仅文件字段，无查看器制品。
- `mode: "both"`：查看器字段加上文件字段。如果文件渲染失败，查看器仍会返回并带有 `fileError`。

## 折叠未更改的部分

- 查看器可以显示如 `N 未更改的行` 的行。
- 这些行上的展开控件是有条件的，不保证每个输入类型都有。
- 当渲染的差异有可展开的上下文数据时会出现展开控件，这对于之前和之后的输入是典型的。
- 对于许多统一 patch 输入，省略的上下文主体在解析的 patch hunks 中不可用，因此该行可能出现但没有展开控件。这是预期行为。
- `expandUnchanged` 仅在存在可展开上下文时适用。

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

- `security.allowRemoteViewer`（`boolean`，默认 `false`）
  - `false`：对查看器路由的非回环请求被拒绝。
  - `true`：如果令牌化路径有效，则允许远程查看器。

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

## 制品生命周期和存储

- 制品存储在 temp 子文件夹下：`$TMPDIR/openclaw-diffs`。
- 查看器制品元数据包含：
  - 随机制品 ID（20 个十六进制字符）
  - 随机令牌（48 个十六进制字符）
  - `createdAt` 和 `expiresAt`
  - 存储的 `viewer.html` 路径
- 默认查看器 TTL 为 30 分钟（未指定时）。
- 最大接受的查看器 TTL 为 6 小时。
- 在制品创建后机会性地运行清理。
- 过期的制品被删除。
- 当元数据缺失时，回退清理会删除超过 24 小时的陈旧文件夹。

## 查看器 URL 和网络行为

查看器路由：

- `/plugins/diffs/view/{artifactId}/{token}`

查看器资产：

- `/plugins/diffs/assets/viewer.js`
- `/plugins/diffs/assets/viewer-runtime.js`

URL 构建行为：

- 如果提供了 `baseUrl`，则在严格验证后使用它。
- 如果没有 `baseUrl`，查看器 URL 默认为回环 `127.0.0.1`。
- 如果 Gateway 绑定模式为 `custom` 且设置了 `gateway.customBindHost`，则使用该主机。

`baseUrl` 规则：

- 必须是 `http://` 或 `https://`。
- 查询和哈希被拒绝。
- 允许来源加可选的基础路径。

## 安全模型

查看器加固：

- 默认仅回环。
- 具有严格 ID 和令牌验证的令牌化查看器路径。
- 查看器响应 CSP：
  - `default-src 'none'`
  - 脚本和资产仅来自自身
  - 无出站 `connect-src`
- 启用远程访问时的远程未命中节流：
  - 40 次失败/60 秒
  - 60 秒锁定（`429 Too Many Requests`）

文件渲染加固：

- 截图浏览器请求路由默认为拒绝。
- 仅允许来自 `http://127.0.0.1/plugins/diffs/assets/*` 的本地查看器资产。
- 外部网络请求被阻止。

## 浏览器要求（文件模式）

`mode: "file"` 和 `mode: "both"` 需要 Chromium 兼容的浏览器。

解析顺序：

1. OpenClaw 配置中的 `browser.executablePath`。
2. 环境变量：
   - `OPENCLAW_BROWSER_EXECUTABLE_PATH`
   - `BROWSER_EXECUTABLE_PATH`
   - `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
3. 平台命令/路径发现回退。

常见失败文本：

- `Diff PNG/PDF 渲染需要 Chromium 兼容的浏览器...`

通过安装 Chrome、Chromium、Edge 或 Brave 来修复，或设置上述可执行路径选项之一。

## 故障排除

输入验证错误：

- `Provide patch or both before and after text.` — 包含 `before` 和 `after`，或提供 `patch`。
- `Provide either patch or before/after input, not both.` — 不要混合输入模式。
- `Invalid baseUrl: ...` — 使用带可选路径的 http(s) 来源，无查询/哈希。
- `{field} exceeds maximum size (...)` — 减小有效载荷大小。
- Large patch rejection — 减少 patch 文件数或总行数。

查看器可访问性问题：

- 查看器 URL 默认为 `127.0.0.1`。
- 对于远程访问场景，请执行以下操作之一：
  - 每次工具调用传递 `baseUrl`，或
  - 使用 `gateway.bind=custom` 和 `gateway.customBindHost`
- 仅在需要外部查看器访问时才启用 `allowRemoteViewer`。

未修改行行没有展开按钮：

- 对于 patch 输入，当 patch 不携带可展开上下文时，可能会发生这种情况。
- 这是预期的，并不表示查看器失败。

制品未找到：

- 制品因 TTL 过期。
- 令牌或路径更改。
- 清理删除了陈旧数据。

## 操作指导

- 对于 canvas 中的本地交互式审查，首选 `mode: "view"`。
- 对于需要附件的出站聊天频道，首选 `mode: "file"`。
- 除非您的部署需要远程查看器 URL，否则保持 `allowRemoteViewer` 禁用。
- 对于敏感差异设置明确的短 `ttlSeconds`。
- 不需要时不发送 secrets。
- 如果您的频道（如 Telegram 或 WhatsApp）压缩图像较严重，请首选 PDF 输出（`fileFormat: "pdf"`）。

差异渲染引擎：

- 由 [Diffs](https://diffs.com) 提供支持。

## 相关文档

- [工具概述](/tools)
- [插件](/tools/plugin)
- [浏览器](/tools/browser)