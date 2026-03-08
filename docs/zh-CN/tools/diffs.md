---
title: "Diffs（差异对比）"
summary: "为代理提供的只读差异查看器和文件渲染器（可选插件工具）"
description: "使用可选的 Diffs 插件将变更内容渲染为 gateway 托管的差异视图、文件（PNG 或 PDF）或两者。"
read_when:
  - 你想让代理将代码或 Markdown 编辑显示为差异
  - 你想要一个 canvas 就绪的查看器 URL 或渲染的差异文件
  - 你需要受控的、临时的差异产物，具有安全默认值
---

# Diffs

`diffs` 是一个可选的插件工具和配套技能，可将变更内容转换为代理的只读差异产物。

它接受：

- `before` 和 `after` 文本
- 统一的 `patch`

它可以返回：

- 用于 canvas 展示的 gateway 查看器 URL
- 用于消息传递的渲染文件路径（PNG 或 PDF）
- 一次调用中的两种输出

## 快速开始

1. 启用插件。
2. 使用 `mode: "view"` 调用 `diffs` 用于 canvas 优先流程。
3. 使用 `mode: "file"` 调用 `diffs` 用于聊天文件传递流程。
4. 使用 `mode: "both"` 调用 `diffs` 当你需要两种产物时。

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

## 典型代理工作流

1. 代理调用 `diffs`。
2. 代理读取 `details` 字段。
3. 代理可以：
   - 使用 `canvas present` 打开 `details.viewerUrl`
   - 使用 `path` 或 `filePath` 通过 `message` 发送 `details.filePath`
   - 两者都做

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

- `before` (`string`): 原始文本。当省略 `patch` 时，与 `after` 一起必需。
- `after` (`string`): 更新后的文本。当省略 `patch` 时，与 `before` 一起必需。
- `patch` (`string`): 统一差异文本。与 `before` 和 `after` 互斥。
- `path` (`string`): before 和 after 模式的显示文件名。
- `lang` (`string`): before 和 after 模式的语言覆盖提示。
- `title` (`string`): 查看器标题覆盖。
- `mode` (`"view" | "file" | "both"`): 输出模式。默认为插件默认值 `defaults.mode`。
- `theme` (`"light" | "dark"`): 查看器主题。默认为插件默认值 `defaults.theme`。
- `layout` (`"unified" | "split"`): 差异布局。默认为插件默认值 `defaults.layout`。
- `expandUnchanged` (`boolean`): 当完整上下文可用时展开未更改的部分。仅每次调用选项（不是插件默认键）。
- `fileFormat` (`"png" | "pdf"`): 渲染文件格式。默认为插件默认值 `defaults.fileFormat`。
- `fileQuality` (`"standard" | "hq" | "print"`): PNG 或 PDF 渲染的质量预设。
- `fileScale` (`number`): 设备缩放覆盖 (`1`-`4`)。
- `fileMaxWidth` (`number`): 最大渲染宽度（CSS 像素）(`640`-`2400`)。
- `ttlSeconds` (`number`): 查看器产物 TTL（秒）。默认 1800，最大 21600。
- `baseUrl` (`string`): 查看器 URL 来源覆盖。必须是 `http` 或 `https`，无 query/hash。

## 输出详情

成功响应在 `details` 中包含产物元数据：

- `mode`: 使用的输出模式
- `viewerUrl`: 当模式为 `"view"` 或 `"both"` 时的 canvas 查看器 URL
- `filePath`: 当模式为 `"file"` 或 `"both"` 时的渲染文件路径
- `fileFormat`: 渲染文件格式（`"png"` 或 `"pdf"`）

## 安全与清理

- 查看器产物是临时的，具有可配置的 TTL（默认 30 分钟，最大 6 小时）。
- 文件产物写入临时目录，具有受控的生命周期。
- 所有产物在 TTL 到期后自动清理。

## 相关文档

- [Tools 总览](/tools)
- [插件文档](/tools/plugin)
- [浏览器工具](/tools/browser)
