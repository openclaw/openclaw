---
read_when:
  - 你正在更改出站渠道的 Markdown 格式化或分块逻辑
  - 你正在添加新的渠道格式化器或样式映射
  - 你正在调试跨渠道的格式化回归问题
summary: 出站渠道的 Markdown 格式化管道
title: Markdown 格式化
x-i18n:
  generated_at: "2026-02-01T20:22:42Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f9cbf9b744f9a218860730f29435bcad02d3db80b1847fed5f17c063c97d4820
  source_path: concepts/markdown-formatting.md
  workflow: 14
---

# Markdown 格式化

OpenClaw 通过将出站 Markdown 转换为共享的中间表示（IR），然后再渲染为特定渠道的输出来进行格式化。IR 保留源文本不变，同时携带样式/链接跨度信息，使分块和渲染在各渠道间保持一致。

## 目标

- **一致性：**一次解析，多个渲染器。
- **安全分块：**在渲染前拆分文本，确保行内格式不会跨块断裂。
- **渠道适配：**将同一 IR 映射到 Slack mrkdwn、Telegram HTML 和 Signal 样式范围，无需重新解析 Markdown。

## 管道

1. **解析 Markdown -> IR**
   - IR 是纯文本加上样式跨度（粗体/斜体/删除线/代码/剧透）和链接跨度。
   - 偏移量使用 UTF-16 代码单元，以便 Signal 样式范围与其 API 对齐。
   - 仅当渠道启用了表格转换时才会解析表格。
2. **分块 IR（格式优先）**
   - 分块在渲染前对 IR 文本进行操作。
   - 行内格式不会跨块拆分；跨度按块进行切片。
3. **按渠道渲染**
   - **Slack：** mrkdwn 标记（粗体/斜体/删除线/代码），链接格式为 `<url|label>`。
   - **Telegram：** HTML 标签（`<b>`、`<i>`、`<s>`、`<code>`、`<pre><code>`、`<a href>`）。
   - **Signal：** 纯文本 + `text-style` 范围；当标签与 URL 不同时，链接变为 `label (url)`。

## IR 示例

输入 Markdown：

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR（示意）：

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## 使用场景

- Slack、Telegram 和 Signal 的出站适配器从 IR 进行渲染。
- 其他渠道（WhatsApp、iMessage、Microsoft Teams、Discord）仍使用纯文本或各自的格式化规则，启用时会在分块前应用 Markdown 表格转换。

## 表格处理

Markdown 表格在各聊天客户端中的支持并不一致。使用 `markdown.tables` 按渠道（和按账户）控制转换方式。

- `code`：将表格渲染为代码块（大多数渠道的默认设置）。
- `bullets`：将每行转换为项目符号列表（Signal + WhatsApp 的默认设置）。
- `off`：禁用表格解析和转换；原始表格文本直接透传。

配置键：

```yaml
channels:
  discord:
    markdown:
      tables: code
    accounts:
      work:
        markdown:
          tables: off
```

## 分块规则

- 分块限制来自渠道适配器/配置，应用于 IR 文本。
- 代码围栏作为单个块保留，并带有尾部换行符，以确保渠道正确渲染。
- 列表前缀和引用块前缀是 IR 文本的一部分，因此分块不会在前缀中间拆分。
- 行内样式（粗体/斜体/删除线/行内代码/剧透）不会跨块拆分；渲染器会在每个块内重新打开样式。

如需了解更多跨渠道的分块行为，请参见[流式传输 + 分块](/concepts/streaming)。

## 链接策略

- **Slack：** `[label](url)` -> `<url|label>`；裸 URL 保持原样。解析时禁用自动链接以避免重复链接。
- **Telegram：** `[label](url)` -> `<a href="url">label</a>`（HTML 解析模式）。
- **Signal：** `[label](url)` -> `label (url)`，除非标签与 URL 匹配。

## 剧透

剧透标记（`||spoiler||`）仅为 Signal 解析，映射为 SPOILER 样式范围。其他渠道将其视为纯文本。

## 如何添加或更新渠道格式化器

1. **解析一次：**使用共享的 `markdownToIR(...)` 辅助函数，传入适合渠道的选项（自动链接、标题样式、引用块前缀）。
2. **渲染：**使用 `renderMarkdownWithMarkers(...)` 和样式标记映射（或 Signal 样式范围）实现渲染器。
3. **分块：**在渲染前调用 `chunkMarkdownIR(...)`；逐块渲染。
4. **接入适配器：**更新渠道出站适配器以使用新的分块器和渲染器。
5. **测试：**添加或更新格式测试，如果渠道使用分块，还需添加出站投递测试。

## 常见陷阱

- Slack 尖括号标记（`<@U123>`、`<#C123>`、`<https://...>`）必须保留；安全转义原始 HTML。
- Telegram HTML 要求对标签外的文本进行转义，以避免标记损坏。
- Signal 样式范围依赖 UTF-16 偏移量；不要使用码点偏移量。
- 保留代码围栏的尾部换行符，以确保闭合标记独占一行。
