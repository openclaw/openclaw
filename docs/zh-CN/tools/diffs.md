---
title: Diffs
summary: 为代理提供的只读差异查看器和文件渲染器（可选插件工具）
description: 使用可选的 Diffs 插件将变更内容渲染为 gateway 托管的差异视图、文件（PNG 或 PDF）或两者。
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
4. 使用 `mode: "both"` 当你需要两种产物时。

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
3. 代理可以：使用 `canvas present` 打开 `details.viewerUrl`；使用 `path` 或 `filePath` 通过 `message` 发送 `details.filePath`；或两者都做。

## 工具输入参考

所有字段可选，除非另有说明：`before`、`after`、`patch`、`path`、`lang`、`title`、`mode`（`"view"` | `"file"` | `"both"`）、`theme`、`layout`、`expandUnchanged`、`fileFormat`、`fileQuality`、`fileScale`、`fileMaxWidth`、`ttlSeconds`、`baseUrl`。校验与限制见英文版 [Diffs](/tools/diffs)。

## 相关文档

- [Tools 总览](/tools)
- [插件](/tools/plugin)
- [浏览器](/tools/browser)
