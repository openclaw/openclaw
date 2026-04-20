---
title: "Diffs"
summary: "用于代理的只读差异查看器和文件渲染器（可选插件工具）"
read_when:
  - 你希望代理将代码或Markdown编辑显示为差异
  - 你想要一个画布就绪的查看器URL或渲染的差异文件
  - 你需要具有安全默认值的受控、临时差异工件
---

# Diffs

`diffs` 是一个可选的插件工具，具有内置的简短系统指导和一个配套技能，可将更改内容转换为代理的只读差异工件。

它接受以下任一输入：

- `before` 和 `after` 文本
- 统一的 `patch`

它可以返回：

- 用于画布展示的网关查看器URL
- 用于消息传递的渲染文件路径（PNG或PDF）
- 一次调用中的两种输出

启用后，插件会在系统提示空间中添加简洁的使用指导，并在代理需要更完整指令的情况下提供详细的技能。

## 快速入门

1. 启用插件。
2. 对于画布优先流程，使用 `mode: "view"` 调用 `diffs`。
3. 对于聊天文件传递流程，使用 `mode: "file"` 调用 `diffs`。
4. 当你需要两种工件时，使用 `mode: "both"` 调用 `diffs`。

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

如果你想保持 `diffs` 工具启用但禁用其内置系统提示指导，请将 `plugins.entries.diffs.hooks.allowPromptInjection` 设置为 `false`：

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

如果你想同时禁用指导和工具，请改为禁用插件。

## 典型代理工作流程

1. 代理调用 `diffs`。
2. 代理读取 `details` 字段。
3. 代理执行以下操作之一：
   - 使用 `canvas present` 打开 `details.viewerUrl`
   - 使用 `message` 通过 `path` 或 `filePath` 发送 `details.filePath`
   - 同时执行两者

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

除非另有说明，否则所有字段都是可选的：

- `before` (`string`): 原始文本。当省略 `patch` 时，与 `after` 一起必需。
- `after` (`string`): 更新的文本。当省略 `patch` 时，与 `before` 一起必需。
- `patch` (`string`): 统一差异文本。与 `before` 和 `after` 互斥。
- `path` (`string`): before 和 after 模式的显示文件名。
- `lang` (`string`): before 和 after 模式的语言覆盖提示。未知值回退到纯文本。
- `title` (`string`): 查看器标题覆盖。
- `mode` (`"view" | "file" | "both"`): 输出模式。默认为插件默认值 `defaults.mode`。
  已弃用别名：`"image"` 行为类似于 `"file"`，为向后兼容仍被接受。
- `theme` (`"light" | "dark"`): 查看器主题。默认为插件默认值 `defaults.theme`。
- `layout` (`"unified" | "split"`): 差异布局。默认为插件默认值 `defaults.layout`。
- `expandUnchanged` (`boolean`): 当有完整上下文时展开未更改的部分。仅按调用选项（不是插件默认键）。
- `fileFormat` (`"png" | "pdf"`): 渲染文件格式。默认为插件默认值 `defaults.fileFormat`。
- `fileQuality` (`"standard" | "hq" | "print"`): PNG或PDF渲染的质量预设。
- `fileScale` (`number`): 设备比例覆盖（`1`-`4`）。
- `fileMaxWidth` (`number`): CSS像素的最大渲染宽度（`640`-`2400`）。
- `ttlSeconds` (`number`): 查看器和独立文件输出的工件TTL（秒）。默认1800，最大21600。
- `baseUrl` (`string`): 查看器URL源覆盖。覆盖插件 `viewerBaseUrl`。必须是 `http` 或 `https`，无查询/哈希。

为向后兼容仍接受的旧输入别名：

- `format` -> `fileFormat`
- `imageFormat` -> `fileFormat`
- `imageQuality` -> `fileQuality`
- `imageScale` -> `fileScale`
- `imageMaxWidth` -> `fileMaxWidth`

验证和限制：

- `before` 和 `after` 各最大512 KiB。
- `patch` 最大2 MiB。
- `path` 最大2048字节。
- `lang` 最大128字节。
- `title` 最大1024字节。
- 补丁复杂度上限：最大128个文件和120000总行数。
- `patch` 与 `before` 或 `after` 一起被拒绝。
- 渲染文件安全限制（适用于PNG和PDF）：
  - `fileQuality: "standard"`: 最大8 MP（8,000,000渲染像素）。
  - `fileQuality: "hq"`: 最大14 MP（14,000,000渲染像素）。
  - `fileQuality: "print"`: 最大24 MP（24,000,000渲染像素）。
  - PDF还有最大50页的限制。

## 输出详情契约

该工具在 `details` 下返回结构化元数据。

创建查看器的模式的共享字段：

- `artifactId`
- `viewerUrl`
- `viewerPath`
- `title`
- `expiresAt`
- `inputKind`
- `fileCount`
- `mode`
- `context`（`agentId`、`sessionId`、`messageChannel`、`agentAccountId`，如果可用）

当渲染PNG或PDF时的文件字段：

- `artifactId`
- `expiresAt`
- `filePath`
- `path`（与 `filePath` 相同值，用于消息工具兼容性）
- `fileBytes`
- `fileFormat`
- `fileQuality`
- `fileScale`
- `fileMaxWidth`

还为现有调用者返回的兼容性别名：

- `format`（与 `fileFormat` 相同值）
- `imagePath`（与 `filePath` 相同值）
- `imageBytes`（与 `fileBytes` 相同值）
- `imageQuality`（与 `fileQuality` 相同值）
- `imageScale`（与 `fileScale` 相同值）
- `imageMaxWidth`（与 `fileMaxWidth` 相同值）

模式行为摘要：

- `mode: "view"`：仅查看器字段。
- `mode: "file"`：仅文件字段，无查看器工件。
- `mode: "both"`：查看器字段加上文件字段。如果文件渲染失败，查看器仍返回，带有 `fileError` 和兼容性别名 `imageError`。

## 折叠的未更改部分

- 查看器可以显示像 `N unmodified lines` 这样的行。
- 这些行上的展开控件是有条件的，并非每种输入类型都保证有。
- 当渲染的差异有可展开的上下文数据时，展开控件会出现，这对于before和after输入是典型的。
- 对于许多统一补丁输入，省略的上下文主体在解析的补丁块中不可用，因此行可能出现而没有展开控件。这是预期行为。
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

明确的工具参数覆盖这些默认值。

持久查看器URL配置：

- `viewerBaseUrl` (`string`, 可选)
  - 当工具调用未传递 `baseUrl` 时，返回的查看器链接的插件拥有的回退。
  - 必须是 `http` 或 `https`，无查询/哈希。

示例：

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        config: {
          viewerBaseUrl: "https://gateway.example.com/openclaw",
        },
      },
    },
  },
}
```

## 安全配置

- `security.allowRemoteViewer` (`boolean`, 默认 `false`)
  - `false`：拒绝查看器路由的非回环请求。
  - `true`：如果标记化路径有效，则允许远程查看器。

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
  - 随机工件ID（20个十六进制字符）
  - 随机令牌（48个十六进制字符）
  - `createdAt` 和 `expiresAt`
  - 存储的 `viewer.html` 路径
- 默认工件TTL为30分钟（未指定时）。
- 最大接受的查看器TTL为6小时。
- 清理在工件创建后 opportunistically 运行。
- 过期的工件被删除。
- 当元数据丢失时，回退清理会删除超过24小时的陈旧文件夹。

## 查看器URL和网络行为

查看器路由：

- `/plugins/diffs/view/{artifactId}/{token}`

查看器资产：

- `/plugins/diffs/assets/viewer.js`
- `/plugins/diffs/assets/viewer-runtime.js`

查看器文档相对于查看器URL解析这些资产，因此可选的 `baseUrl` 路径前缀也为两个资产请求保留。

URL构建行为：

- 如果提供了工具调用 `baseUrl`，则在严格验证后使用。
- 否则，如果配置了插件 `viewerBaseUrl`，则使用它。
- 没有任何覆盖，查看器URL默认为回环 `127.0.0.1`。
- 如果网关绑定模式为 `custom` 且设置了 `gateway.customBindHost`，则使用该主机。

`baseUrl` 规则：

- 必须是 `http://` 或 `https://`。
- 拒绝查询和哈希。
- 允许源加上可选的基础路径。

## 安全模型

查看器加固：

- 默认仅回环。
- 带有严格ID和令牌验证的标记化查看器路径。
- 查看器响应CSP：
  - `default-src 'none'`
  - 仅来自自身的脚本和资产
  - 无出站 `connect-src`
- 启用远程访问时的远程未命中节流：
  - 每60秒40次失败
  - 60秒锁定（`429 Too Many Requests`）

文件渲染加固：

- 屏幕截图浏览器请求路由默认拒绝。
- 仅允许来自 `http://127.0.0.1/plugins/diffs/assets/*` 的本地查看器资产。
- 阻止外部网络请求。

## 文件模式的浏览器要求

`mode: "file"` 和 `mode: "both"` 需要兼容Chromium的浏览器。

解析顺序：

1. OpenClaw配置中的 `browser.executablePath`。
2. 环境变量：
   - `OPENCLAW_BROWSER_EXECUTABLE_PATH`
   - `BROWSER_EXECUTABLE_PATH`
   - `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
3. 平台命令/路径发现回退。

常见失败文本：

- `Diff PNG/PDF rendering requires a Chromium-compatible browser...`

通过安装Chrome、Chromium、Edge或Brave，或设置上述可执行文件路径选项来修复。

## 故障排除

输入验证错误：

- `Provide patch or both before and after text.`
  - 包含 `before` 和 `after`，或提供 `patch`。
- `Provide either patch or before/after input, not both.`
  - 不要混合输入模式。
- `Invalid baseUrl: ...`
  - 使用带可选路径的 `http(s)` 源，无查询/哈希。
- `{field} exceeds maximum size (...)`
  - 减少有效载荷大小。
- 大补丁拒绝
  - 减少补丁文件数或总行数。

查看器可访问性问题：

- 查看器URL默认解析为 `127.0.0.1`。
- 对于远程访问场景，要么：
  - 设置插件 `viewerBaseUrl`，或
  - 每个工具调用传递 `baseUrl`，或
  - 使用 `gateway.bind=custom` 和 `gateway.customBindHost`
- 如果 `gateway.trustedProxies` 包含同一主机代理（例如Tailscale Serve）的回环，则设计上没有转发客户端IP头的原始回环查看器请求会失败。
- 对于该代理拓扑：
  - 当你只需要附件时，首选 `mode: "file"` 或 `mode: "both"`，或
  - 当你需要可共享的查看器URL时，有意启用 `security.allowRemoteViewer` 并设置插件 `viewerBaseUrl` 或传递代理/公共 `baseUrl`
- 仅当你打算外部查看器访问时，才启用 `security.allowRemoteViewer`。

未修改行没有展开按钮：

- 这可能发生在补丁输入时，当补丁不携带可展开的上下文时。
- 这是预期的，不表示查看器失败。

工件未找到：

- 工件因TTL过期。
- 令牌或路径已更改。
- 清理已删除陈旧数据。

## 操作指导

- 对于画布中的本地交互式审查，首选 `mode: "view"`。
- 对于需要附件的出站聊天通道，首选 `mode: "file"`。
- 除非你的部署需要远程查看器URL，否则保持 `allowRemoteViewer` 禁用。
- 为敏感差异设置明确的短 `ttlSeconds`。
- 不需要时避免在差异输入中发送机密。
- 如果你的通道（例如Telegram或WhatsApp）积极压缩图像，请首选PDF输出（`fileFormat: "pdf"`）。

差异渲染引擎：

- 由 [Diffs](https://diffs.com) 提供支持。

## 相关文档

- [工具概述](/tools)
- [插件](/tools/plugin)
- [浏览器](/tools/browser)