---
title: "PDF 工具"
summary: "通过原生提供商支持和提取回退方案分析一个或多个 PDF 文档"
read_when:
  - 需要从 agent 中分析 PDF
  - 需要了解 pdf 工具的具体参数和限制
  - 调试原生 PDF 模式与提取回退模式的差异
---

# PDF 工具

`pdf` 分析一个或多个 PDF 文档并返回文本。

核心行为：

- Anthropic 和 Google 模型提供商使用**原生模式**（直接发送 PDF 字节）。
- 其他提供商使用**提取回退模式**（先提取文本，需要时再渲染页面图片）。
- 支持单个 (`pdf`) 或多个 (`pdfs`) 输入，每次调用最多 10 个 PDF。

## 可用性

仅当 OpenClaw 能为该 agent 解析到支持 PDF 的模型配置时，工具才会注册：

1. `agents.defaults.pdfModel`
2. 回退到 `agents.defaults.imageModel`
3. 回退到基于可用认证的最佳提供商默认值

如果无法解析到可用模型，`pdf` 工具不会暴露。

## 输入参数

- `pdf` (`string`)：单个 PDF 路径或 URL
- `pdfs` (`string[]`)：多个 PDF 路径或 URL，总计最多 10 个
- `prompt` (`string`)：分析提示词，默认 `Analyze this PDF document.`
- `pages` (`string`)：页码过滤，如 `1-5` 或 `1,3,7-9`
- `model` (`string`)：可选的模型覆盖（`provider/model`）
- `maxBytesMb` (`number`)：单个 PDF 大小上限（MB）

输入说明：

- `pdf` 和 `pdfs` 会合并去重后再加载。
- 如果未提供 PDF 输入，工具会报错。
- `pages` 按 1 起始的页码解析，去重、排序，并限制在配置的最大页数内。
- `maxBytesMb` 默认为 `agents.defaults.pdfMaxBytesMb` 或 `10`。

## 支持的 PDF 引用方式

- 本地文件路径（包括 `~` 展开）
- `file://` URL
- `http://` 和 `https://` URL

引用说明：

- 不支持其他 URI 协议（如 `ftp://`），会返回 `unsupported_pdf_reference` 错误。
- 沙箱模式下，远程 `http(s)` URL 会被拒绝。
- 启用 workspace-only 文件策略时，超出允许范围的本地路径会被拒绝。

## 执行模式

### 原生提供商模式

Anthropic 和 Google 提供商使用原生模式，直接将 PDF 原始字节发送给提供商 API。

原生模式限制：

- 不支持 `pages` 参数。如果设置了，工具会返回错误。

### 提取回退模式

非原生提供商使用提取回退模式。

流程：

1. 从选定页面提取文本（最多 `agents.defaults.pdfMaxPages` 页，默认 `20`）。
2. 如果提取的文本长度低于 `200` 字符，将选定页面渲染为 PNG 图片并附加。
3. 将提取的内容和提示词发送给选定模型。

回退模式细节：

- 页面图片提取使用 `4,000,000` 像素预算。
- 如果目标模型不支持图片输入且无可提取文本，工具会报错。
- 提取回退模式需要 `pdfjs-dist`（图片渲染还需要 `@napi-rs/canvas`）。

## 配置

```json5
{
  agents: {
    defaults: {
      pdfModel: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5-mini"],
      },
      pdfMaxBytesMb: 10,
      pdfMaxPages: 20,
    },
  },
}
```

详见 [配置参考](/gateway/configuration-reference)。

## 输出

工具在 `content[0].text` 中返回文本，在 `details` 中返回结构化元数据。

常见 `details` 字段：

- `model`：解析后的模型引用（`provider/model`）
- `native`：原生模式为 `true`，回退模式为 `false`
- `attempts`：成功前的回退尝试次数

路径字段：

- 单个 PDF 输入：`details.pdf`
- 多个 PDF 输入：`details.pdfs[]`，包含 `pdf` 条目
- 沙箱路径重写元数据（如适用）：`rewrittenFrom`

## 错误行为

- 缺少 PDF 输入：抛出 `pdf required: provide a path or URL to a PDF document`
- PDF 数量过多：返回 `details.error = "too_many_pdfs"`
- 不支持的引用协议：返回 `details.error = "unsupported_pdf_reference"`
- 原生模式使用 `pages`：抛出 `pages is not supported with native PDF providers` 错误

## 示例

单个 PDF：

```json
{
  "pdf": "/tmp/report.pdf",
  "prompt": "用 5 个要点总结这份报告"
}
```

多个 PDF：

```json
{
  "pdfs": ["/tmp/q1.pdf", "/tmp/q2.pdf"],
  "prompt": "对比两份文档中的风险和时间线变化"
}
```

指定页码和模型的回退模式：

```json
{
  "pdf": "https://example.com/report.pdf",
  "pages": "1-3,7",
  "model": "openai/gpt-5-mini",
  "prompt": "仅提取影响客户的事件"
}
```
