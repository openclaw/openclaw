---
title: "PDF 工具"
summary: "通过原生提供商支持和提取回退方式分析一个或多个 PDF 文档"
read_when:
  - 你想通过智能体分析 PDF
  - 你需要了解 PDF 工具的确切参数和限制
  - 你在调试原生 PDF 模式与提取回退
x-i18n:
  source_path: tools/pdf.md
---

# PDF 工具

`pdf` 分析一个或多个 PDF 文档并返回文本。

快速行为概览：

- 对 Anthropic 和 Google 模型提供商使用原生提供商模式。
- 对其他提供商使用提取回退模式（先提取文本，需要时再提取页面图片）。
- 支持单个（`pdf`）或多个（`pdfs`）输入，每次调用最多 10 个 PDF。

## 可用性

仅当 OpenClaw 能为智能体解析到支持 PDF 的模型配置时，工具才会注册：

1. `agents.defaults.pdfModel`
2. 回退到 `agents.defaults.imageModel`
3. 根据可用的认证信息回退到最佳提供商默认值

如果无法解析到可用模型，`pdf` 工具不会被暴露。

## 输入参考

- `pdf`（`string`）：一个 PDF 路径或 URL
- `pdfs`（`string[]`）：多个 PDF 路径或 URL，总计最多 10 个
- `prompt`（`string`）：分析提示，默认为 `Analyze this PDF document.`
- `pages`（`string`）：页面过滤，如 `1-5` 或 `1,3,7-9`
- `model`（`string`）：可选的模型覆盖（`provider/model`）
- `maxBytesMb`（`number`）：每个 PDF 的大小上限（MB）

输入说明：

- `pdf` 和 `pdfs` 在加载前会被合并和去重。
- 如果没有提供 PDF 输入，工具会报错。
- `pages` 以 1 开始的页码解析，去重、排序并限制在配置的最大页数内。
- `maxBytesMb` 默认为 `agents.defaults.pdfMaxBytesMb` 或 `10`。

## 支持的 PDF 引用方式

- 本地文件路径（包括 `~` 展开）
- `file://` URL
- `http://` 和 `https://` URL

引用说明：

- 其他 URI 方案（例如 `ftp://`）会被拒绝，错误为 `unsupported_pdf_reference`。
- 在沙箱模式下，远程 `http(s)` URL 会被拒绝。
- 启用仅工作区文件策略时，允许根目录之外的本地文件路径会被拒绝。

## 执行模式

### 原生提供商模式

原生模式用于 `anthropic` 和 `google` 提供商。
工具直接将原始 PDF 字节发送到提供商 API。

原生模式限制：

- 不支持 `pages`。如果设置了，工具会返回错误。

### 提取回退模式

回退模式用于非原生提供商。

流程：

1. 从选定页面提取文本（最多 `agents.defaults.pdfMaxPages` 页，默认 `20`）。
2. 如果提取的文本长度低于 `200` 个字符，将选定页面渲染为 PNG 图片并包含在内。
3. 将提取的内容加上提示发送到选定的模型。

回退细节：

- 页面图片提取使用 `4,000,000` 的像素预算。
- 如果目标模型不支持图片输入且没有可提取的文本，工具会报错。
- 提取回退需要 `pdfjs-dist`（图片渲染还需要 `@napi-rs/canvas`）。

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

详见[配置参考](/gateway/configuration-reference)。

## 输出详情

工具在 `content[0].text` 中返回文本，在 `details` 中返回结构化元数据。

常见 `details` 字段：

- `model`：解析后的模型引用（`provider/model`）
- `native`：原生提供商模式为 `true`，回退为 `false`
- `attempts`：成功前失败的回退尝试次数

路径字段：

- 单个 PDF 输入：`details.pdf`
- 多个 PDF 输入：`details.pdfs[]`，包含 `pdf` 条目
- 沙箱路径重写元数据（适用时）：`rewrittenFrom`

## 错误行为

- 缺少 PDF 输入：抛出 `pdf required: provide a path or URL to a PDF document`
- PDF 过多：在 `details.error = "too_many_pdfs"` 中返回结构化错误
- 不支持的引用方案：返回 `details.error = "unsupported_pdf_reference"`
- 原生模式使用 `pages`：抛出明确的 `pages is not supported with native PDF providers` 错误

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

带页面过滤的回退模型：

```json
{
  "pdf": "https://example.com/report.pdf",
  "pages": "1-3,7",
  "model": "openai/gpt-5-mini",
  "prompt": "Extract only customer-impacting incidents"
}
```
