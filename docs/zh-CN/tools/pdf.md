---
title: "PDF 工具"
summary: "使用原生提供商支持或提取回退模式分析一个或多个 PDF 文档"
read_when:
  - 你想从代理分析 PDF
  - 你需要确切的 pdf 工具参数和限制
  - 你正在调试原生 PDF 模式与提取回退模式
---

# PDF 工具

`pdf` 分析一个或多个 PDF 文档并返回文本。

快速行为：

- Anthropic 和 Google 模型提供商使用原生提供商模式。
- 其他提供商使用提取回退模式（先提取文本，需要时再提取页面图像）。
- 支持单个 (`pdf`) 或多个 (`pdfs`) 输入，每次调用最多 10 个 PDF。

## 可用性

只有当 OpenClaw 可以为代理解析到支持 PDF 的模型配置时，该工具才会被注册：

1. `agents.defaults.pdfModel`
2. 回退到 `agents.defaults.imageModel`
3. 基于可用认证回退到尽力而为的提供商默认值

如果无法解析到可用的模型，则不会暴露 `pdf` 工具。

## 输入参考

- `pdf` (`string`): 一个 PDF 路径或 URL
- `pdfs` (`string[]`): 多个 PDF 路径或 URL，总共最多 10 个
- `prompt` (`string`): 分析提示，默认 `分析此 PDF 文档。`
- `pages` (`string`): 页面过滤器，如 `1-5` 或 `1,3,7-9`
- `model` (`string`): 可选的模型覆盖 (`provider/model`)
- `maxBytesMb` (`number`): 每个 PDF 的大小限制（MB）

输入说明：

- `pdf` 和 `pdfs` 在加载前会合并并去重。
- 如果没有提供 PDF 输入，工具会报错。
- `pages` 解析为 1-based 页码，去重、排序，并限制在配置的最大页数内。
- `maxBytesMb` 默认为 `agents.defaults.pdfMaxBytesMb` 或 `10`。

## 支持的 PDF 引用

- 本地文件路径（包括 `~` 扩展）
- `file://` URL
- `http://` 和 `https://` URL

引用说明：

- 其他 URI 方案（例如 `ftp://`）会被拒绝并返回 `unsupported_pdf_reference`。
- 在沙盒模式下，远程 `http(s)` URL 会被拒绝。
- 启用仅工作区文件策略时，允许根目录外的本地文件路径会被拒绝。

## 执行模式

### 原生提供商模式

原生模式用于 `anthropic` 和 `google` 提供商。
该工具将原始 PDF 字节直接发送到提供商 API。

原生模式限制：

- 不支持 `pages`。如果设置，工具会返回错误。

### 提取回退模式

回退模式用于非原生提供商。

流程：

1. 从选定页面提取文本（最多 `agents.defaults.pdfMaxPages`，默认 `20`）。
2. 如果提取的文本长度低于 `200` 个字符，将选定页面渲染为 PNG 图像并包含它们。
3. 将提取的内容加提示发送到选定的模型。

回退详情：

- 页面图像提取使用 `4,000,000` 像素的预算。
- 如果目标模型不支持图像输入且没有可提取的文本，工具会报错。
- 提取回退需要 `pdfjs-dist`（和 `@napi-rs/canvas` 用于图像渲染）。

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

完整字段详情见 [配置参考](/gateway/configuration-reference)。

## 输出详情

该工具在 `content[0].text` 中返回文本，在 `details` 中返回结构化元数据。

常见的 `details` 字段：

- `model`: 解析的模型引用 (`provider/model`)
- `native`: 原生提供商模式为 `true`，回退模式为 `false`
- `attempts`: 成功前的回退尝试失败次数

路径字段：

- 单个 PDF 输入: `details.pdf`
- 多个 PDF 输入: `details.pdfs[]` 带 `pdf` 条目
- 沙盒路径重写元数据（如适用）: `rewrittenFrom`

## 错误行为

- 缺少 PDF 输入: 抛出 `pdf required: provide a path or URL to a PDF document`
- PDF 过多: 在 `details.error = "too_many_pdfs"` 中返回结构化错误
- 不支持的引用方案: 返回 `details.error = "unsupported_pdf_reference"`
- 原生模式使用 `pages`: 抛出明确的 `pages is not supported with native PDF providers` 错误

## 示例

单个 PDF：

```json
{
  "pdf": "/tmp/report.pdf",
  "prompt": "用 5 个要点总结此报告"
}
```

多个 PDF：

```json
{
  "pdfs": ["/tmp/q1.pdf", "/tmp/q2.pdf"],
  "prompt": "比较两份文档中的风险和时间线变化"
}
```

页面过滤的回退模型：

```json
{
  "pdf": "https://example.com/report.pdf",
  "pages": "1-3,7",
  "model": "openai/gpt-5-mini",
  "prompt": "仅提取影响客户的事件"
}
```
