---
title: "PDF 工具"
summary: "使用原生提供者支持和提取回退分析一个或多个 PDF 文档"
read_when:
  - 你想要从代理分析 PDF
  - 你需要准确的 pdf 工具参数和限制
  - 你正在调试原生 PDF 模式与提取回退
---

# PDF 工具

`pdf` 分析一个或多个 PDF 文档并返回文本。

快速行为：

- Anthropic 和 Google 模型提供者的原生提供者模式。
- 其他提供者的提取回退模式（先提取文本，然后在需要时提取页面图像）。
- 支持单个（`pdf`）或多个（`pdfs`）输入，每次调用最多 10 个 PDF。

## 可用性

该工具仅在 OpenClaw 可以为代理解析 PDF 功能模型配置时注册：

1. `agents.defaults.pdfModel`
2. 回退到 `agents.defaults.imageModel`
3. 回退到代理的解析会话/默认模型
4. 如果原生 PDF 提供者支持认证，则优先于通用图像回退候选

如果无法解析可用模型，则不暴露 `pdf` 工具。

可用性说明：

- 回退链是认证感知的。配置的 `provider/model` 仅在 OpenClaw 实际上可以为代理认证该提供者时计数。
- 原生 PDF 提供者目前是 **Anthropic** 和 **Google**。
- 如果解析的会话/默认提供者已经配置了视觉/PDF 模型，PDF 工具会在回退到其他支持认证的提供者之前重用该模型。

## 输入参考

- `pdf`（`string`）：一个 PDF 路径或 URL
- `pdfs`（`string[]`）：多个 PDF 路径或 URL，最多 10 个
- `prompt`（`string`）：分析提示，默认为 `Analyze this PDF document.`
- `pages`（`string`）：页面过滤器，如 `1-5` 或 `1,3,7-9`
- `model`（`string`）：可选的模型覆盖（`provider/model`）
- `maxBytesMb`（`number`）：每个 PDF 的大小上限（MB）

输入说明：

- `pdf` 和 `pdfs` 在加载前会被合并和去重。
- 如果未提供 PDF 输入，工具会出错。
- `pages` 被解析为基于 1 的页码，去重、排序并限制在配置的最大页面数内。
- `maxBytesMb` 默认为 `agents.defaults.pdfMaxBytesMb` 或 `10`。

## 支持的 PDF 引用

- 本地文件路径（包括 `~` 扩展）
- `file://` URL
- `http://` 和 `https://` URL

引用说明：

- 其他 URI 方案（例如 `ftp://`）被拒绝，返回 `unsupported_pdf_reference`。
- 在沙箱模式下，远程 `http(s)` URL 被拒绝。
- 启用工作区唯一文件策略时，允许根目录外的本地文件路径被拒绝。

## 执行模式

### 原生提供者模式

原生模式用于提供者 `anthropic` 和 `google`。
工具将原始 PDF 字节直接发送到提供者 API。

原生模式限制：

- 不支持 `pages`。如果设置，工具会返回错误。
- 支持多 PDF 输入；每个 PDF 在提示前作为原生文档块 / 内联 PDF 部分发送。

### 提取回退模式

回退模式用于非原生提供者。

流程：

1. 从选定页面提取文本（最多 `agents.defaults.pdfMaxPages`，默认为 `20`）。
2. 如果提取的文本长度低于 `200` 字符，将选定页面渲染为 PNG 图像并包含它们。
3. 将提取的内容加上提示发送到选定的模型。

回退详情：

- 页面图像提取使用 `4,000,000` 的像素预算。
- 如果目标模型不支持图像输入且没有可提取的文本，工具会出错。
- 如果文本提取成功但图像提取需要在纯文本模型上使用视觉，OpenClaw 会丢弃渲染的图像并继续使用提取的文本。
- 提取回退需要 `pdfjs-dist`（以及用于图像渲染的 `@napi-rs/canvas`）。

## 配置

```json5
{
  agents: {
    defaults: {
      pdfModel: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5.4-mini"],
      },
      pdfMaxBytesMb: 10,
      pdfMaxPages: 20,
    },
  },
}
```

有关完整字段详细信息，请参阅 [配置参考](/gateway/configuration-reference)。

## 输出详情

工具在 `content[0].text` 中返回文本，在 `details` 中返回结构化元数据。

常见的 `details` 字段：

- `model`：解析的模型引用（`provider/model`）
- `native`：原生提供者模式为 `true`，回退为 `false`
- `attempts`：成功前失败的回退尝试

路径字段：

- 单个 PDF 输入：`details.pdf`
- 多个 PDF 输入：带有 `pdf` 条目的 `details.pdfs[]`
- 沙箱路径重写元数据（适用时）：`rewrittenFrom`

## 错误行为

- 缺少 PDF 输入：抛出 `pdf required: provide a path or URL to a PDF document`
- PDF 过多：在 `details.error = "too_many_pdfs"` 中返回结构化错误
- 不支持的引用方案：返回 `details.error = "unsupported_pdf_reference"`
- 带 `pages` 的原生模式：抛出明确的 `pages is not supported with native PDF providers` 错误

## 示例

单个 PDF：

```json
{
  "pdf": "/tmp/report.pdf",
  "prompt": "Summarize this report in 5 bullets"
}
```

多个 PDF：

```json
{
  "pdfs": ["/tmp/q1.pdf", "/tmp/q2.pdf"],
  "prompt": "Compare risks and timeline changes across both documents"
}
```

页面过滤的回退模型：

```json
{
  "pdf": "https://example.com/report.pdf",
  "pages": "1-3,7",
  "model": "openai/gpt-5.4-mini",
  "prompt": "Extract only customer-impacting incidents"
}
```

## 相关

- [工具概述](/tools) — 所有可用的代理工具
- [配置参考](/gateway/configuration-reference#agent-defaults) — pdfMaxBytesMb 和 pdfMaxPages 配置
