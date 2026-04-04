---
title: Diffs
summary: 为智能体提供的只读 diff 查看器和文件渲染器（可选插件工具）
read_when:
  - 你希望智能体将代码或 Markdown 编辑以 diff 形式展示
  - 你需要可在画布中使用的查看器 URL 或渲染后的 diff 文件
  - 你需要带安全默认值的受控临时 diff 制品
x-i18n:
  source_path: tools/diffs.md
  source_hash: a9f0c2da0fe2729a7267a83037101901879a9687da58ad05cba6026145d54ae0
  provider: openai
  model: gpt-5.4
  workflow: 15
  generated_at: "2026-03-29T23:41:59Z"
---

# Diffs

`diffs` 是一个可选插件工具，带有简短的内置系统引导和配套技能，可将变更内容转换为供智能体使用的只读 diff 制品。

它接受以下两种输入之一：

- `before` 和 `after` 文本
- 统一格式的 `patch`

可返回：

- 用于画布展示的 Gateway 网关查看器 URL
- 用于消息投递的渲染文件路径（PNG 或 PDF）
- 在一次调用中同时返回两种输出

启用后，插件会在系统提示空间中注入简洁的使用引导，同时还提供一个详细技能供智能体在需要更完整指令时使用。

## 快速开始

1. 启用插件。
2. 使用 `diffs`，设置 `mode: "view"` 以走画布优先流程。
3. 使用 `diffs`，设置 `mode: "file"` 以走聊天文件投递流程。
4. 使用 `diffs`，设置 `mode: "both"` 以同时获取两种制品。

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

## 禁用内置系统引导

如果你想保留 `diffs` 工具但禁用其内置系统提示引导，将 `plugins.entries.diffs.hooks.allowPromptInjection` 设为 `false`：

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

这会阻止 diffs 插件的 `before_prompt_build` 钩子，同时保留插件、工具和配套技能可用。

如果你想同时禁用引导和工具，请直接禁用插件。

## 典型智能体工作流

1. 智能体调用 `diffs`。
2. 智能体读取 `details` 字段。
3. 智能体执行以下操作之一：
   - 用 `canvas present` 打开 `details.viewerUrl`
   - 用 `message` 工具通过 `path` 或 `filePath` 发送 `details.filePath`
   - 两者都做

## 输入示例

前后文本：

```json
{
  "before": "# Hello\n\nOne",
  "after": "# Hello\n\nTwo",
  "path": "docs/example.md",
  "mode": "view"
}
```

补丁：

```json
{
  "patch": "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
  "mode": "both"
}
```

## 工具输入参考

除特别说明外，所有字段均为可选：

- `before`（`string`）：原始文本。省略 `patch` 时需与 `after` 一起提供。
- `after`（`string`）：更新后文本。省略 `patch` 时需与 `before` 一起提供。
- `patch`（`string`）：统一 diff 文本。与 `before` 和 `after` 互斥。
- `path`（`string`）：前后对比模式下的显示文件名。
- `lang`（`string`）：前后对比模式下的语言覆盖提示。
- `title`（`string`）：查看器标题覆盖。
- `mode`（`"view" | "file" | "both"`）：输出模式。默认为插件默认值 `defaults.mode`。
  已弃用别名：`"image"` 的行为与 `"file"` 相同，出于向后兼容仍然接受。
- `theme`（`"light" | "dark"`）：查看器主题。默认为插件默认值 `defaults.theme`。
- `layout`（`"unified" | "split"`）：diff 布局。默认为插件默认值 `defaults.layout`。
- `expandUnchanged`（`boolean`）：在有完整上下文时展开未变更部分。仅限单次调用选项，不是插件默认值键。
- `fileFormat`（`"png" | "pdf"`）：渲染文件格式。默认为插件默认值 `defaults.fileFormat`。
- `fileQuality`（`"standard" | "hq" | "print"`）：PNG 或 PDF 渲染的质量预设。
- `fileScale`（`number`）：设备缩放覆盖（`1`-`4`）。
- `fileMaxWidth`（`number`）：最大渲染宽度（CSS 像素，`640`-`2400`）。
- `ttlSeconds`（`number`）：查看器制品 TTL（秒）。默认 1800，最大 21600。
- `baseUrl`（`string`）：查看器 URL 来源覆盖。必须为 `http` 或 `https`，不含查询参数或哈希。

验证和限制：

- `before` 和 `after` 各最大 512 KiB。
- `patch` 最大 2 MiB。
- `path` 最大 2048 字节。
- `lang` 最大 128 字节。
- `title` 最大 1024 字节。
- 补丁复杂度上限：最多 128 个文件，总计 120000 行。
- `patch` 和 `before` 或 `after` 不能同时使用。
- 渲染文件安全限制（适用于 PNG 和 PDF）：
  - `fileQuality: "standard"`：最大 8 MP（8,000,000 渲染像素）。
  - `fileQuality: "hq"`：最大 14 MP（14,000,000 渲染像素）。
  - `fileQuality: "print"`：最大 24 MP（24,000,000 渲染像素）。
  - PDF 还有最多 50 页的限制。

## 输出详情约定

工具在 `details` 下返回结构化元数据。

创建查看器的模式共享字段：

- `artifactId`
- `viewerUrl`
- `viewerPath`
- `title`
- `expiresAt`
- `inputKind`
- `fileCount`
- `mode`
- `context`（可用时包含 `agentId`、`sessionId`、`messageChannel`、`agentAccountId`）

渲染 PNG 或 PDF 时的文件字段：

- `artifactId`
- `expiresAt`
- `filePath`
- `path`（与 `filePath` 相同，兼容 `message` 工具）
- `fileBytes`
- `fileFormat`
- `fileQuality`
- `fileScale`
- `fileMaxWidth`

模式行为汇总：

- `mode: "view"`：仅查看器字段。
- `mode: "file"`：仅文件字段，无查看器制品。
- `mode: "both"`：查看器字段加文件字段。如果文件渲染失败，查看器仍然返回并附带 `fileError`。

## 折叠的未变更部分

- 查看器可以显示类似 `N unmodified lines` 的行。
- 这些行上的展开控件是有条件的，并非每种输入都保证提供。
- 当渲染的 diff 具有可展开的上下文数据时会出现展开控件，这在前后对比输入中很常见。
- 对于许多统一补丁输入，省略的上下文主体在解析后的补丁块中不可用，因此该行可能没有展开控件。这是预期行为。
- `expandUnchanged` 仅在存在可展开上下文时生效。

## 插件默认值

在 `~/.openclaw/openclaw.json` 中设置插件全局默认值：

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
  - `false`：拒绝非本地回环请求访问查看器路由。
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

- 制品存储在临时子目录下：`$TMPDIR/openclaw-diffs`。
- 查看器制品元数据包含：
  - 随机制品 ID（20 个十六进制字符）
  - 随机令牌（48 个十六进制字符）
  - `createdAt` 和 `expiresAt`
  - 存储的 `viewer.html` 路径
- 未指定时默认查看器 TTL 为 30 分钟。
- 可接受的最大查看器 TTL 为 6 小时。
- 清理会在制品创建后择机运行。
- 过期的制品会被删除。
- 当元数据缺失时，回退清理会移除超过 24 小时的陈旧文件夹。

## 查看器 URL 和网络行为

查看器路由：

- `/plugins/diffs/view/{artifactId}/{token}`

查看器资源：

- `/plugins/diffs/assets/viewer.js`
- `/plugins/diffs/assets/viewer-runtime.js`

URL 构建行为：

- 如果提供了 `baseUrl`，会在严格校验后使用。
- 没有 `baseUrl` 时，查看器 URL 默认使用本地回环 `127.0.0.1`。
- 如果 Gateway 网关绑定模式为 `custom` 且设置了 `gateway.customBindHost`，则使用该主机。

`baseUrl` 规则：

- 必须以 `http://` 或 `https://` 开头。
- 查询参数和哈希会被拒绝。
- 允许使用来源加可选基础路径。

## 安全模型

查看器加固：

- 默认仅限本地回环。
- 带严格 ID 和令牌验证的令牌化查看器路径。
- 查看器响应 CSP：
  - `default-src 'none'`
  - 脚本和资源仅来自 self
  - 无出站 `connect-src`
- 启用远程访问时的未命中节流：
  - 60 秒内 40 次失败
  - 60 秒锁定（`429 Too Many Requests`）

文件渲染加固：

- 截图浏览器请求路由默认拒绝。
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
3. 平台命令或路径发现回退。

常见失败文本：

- `Diff PNG/PDF rendering requires a Chromium-compatible browser...`

通过安装 Chrome、Chromium、Edge 或 Brave 修复，或设置上述可执行路径选项之一。

## 故障排除

输入校验错误：

- `Provide patch or both before and after text.`
  - 同时提供 `before` 和 `after`，或提供 `patch`。
- `Provide either patch or before/after input, not both.`
  - 不要混用输入模式。
- `Invalid baseUrl: ...`
  - 使用带可选路径的 `http(s)` 来源，不含查询参数或哈希。
- `{field} exceeds maximum size (...)`
  - 减小有效负载大小。
- 大型补丁被拒绝
  - 减少补丁文件数或总行数。

查看器访问问题：

- 查看器 URL 默认解析到 `127.0.0.1`。
- 对于远程访问场景，可以：
  - 在每次工具调用时传入 `baseUrl`，或
  - 使用 `gateway.bind=custom` 和 `gateway.customBindHost`
- 仅在确实需要外部查看器访问时启用 `security.allowRemoteViewer`。

未变更行没有展开按钮：

- 当补丁输入未携带可展开上下文时可能出现此情况。
- 这是预期行为，不表示查看器故障。

制品未找到：

- 制品因 TTL 过期。
- 令牌或路径已更改。
- 清理移除了陈旧数据。

## 操作指南

- 对于本地画布中的交互式审阅，优先使用 `mode: "view"`。
- 对于需要附件的出站聊天渠道，优先使用 `mode: "file"`。
- 除非你的部署需要远程查看器 URL，否则保持 `allowRemoteViewer` 禁用。
- 对于敏感 diff，设置明确且较短的 `ttlSeconds`。
- 在不需要时避免在 diff 输入中发送密钥。
- 如果你的渠道会大幅压缩图片，例如 Telegram 或 WhatsApp，优先使用 PDF 输出（`fileFormat: "pdf"`）。

Diff 渲染引擎：

- 由 [Diffs](https://diffs.com) 提供支持。

## 相关文档

- [工具概览](/tools)
- [插件](/tools/plugin)
- [浏览器](/tools/browser)
