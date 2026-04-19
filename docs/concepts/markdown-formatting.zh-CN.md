---
summary: "出站通道的 Markdown 格式化管道"
read_when:
  - 你正在更改出站通道的 Markdown 格式化或分块
  - 你正在添加新的通道格式化器或样式映射
  - 你正在调试跨通道的格式化回归
---

# Markdown 格式化

OpenClaw 通过在渲染通道特定输出之前将其转换为共享的中间表示（IR）来格式化出站 Markdown。IR 保持源文本完整，同时携带样式/链接跨度，以便分块和渲染可以在通道之间保持一致。

## 目标

- **一致性：** 一个解析步骤，多个渲染器。
- **安全分块：** 在渲染前分割文本，使内联格式永远不会跨块断裂。
- **通道适配：** 将相同的 IR 映射到 Slack mrkdwn、Telegram HTML 和 Signal 样式范围，而无需重新解析 Markdown。

## 管道

1. **解析 Markdown -> IR**
   - IR 是纯文本加上样式跨度（粗体/斜体/删除线/代码/剧透）和链接跨度。
   - 偏移量是 UTF-16 代码单元，因此 Signal 样式范围与其 API 对齐。
   - 只有当通道选择加入表格转换时才解析表格。
2. **分块 IR（格式优先）**
   - 分块在渲染前对 IR 文本进行。
   - 内联格式不会跨块分割；跨度按块切片。
3. **按通道渲染**
   - **Slack：** mrkdwn 令牌（粗体/斜体/删除线/代码），链接为 `<url|label>`。
   - **Telegram：** HTML 标签（`<b>`、`<i>`、`<s>`、`<code>`、`<pre><code>`、`<a href>`）。
   - **Signal：** 纯文本 + `text-style` 范围；当标签不同时，链接变为 `label (url)`。

## IR 示例

输入 Markdown：

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR（示意图）：

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## 使用场景

- Slack、Telegram 和 Signal 出站适配器从 IR 渲染。
- 其他通道（WhatsApp、iMessage、Microsoft Teams、Discord）仍然使用纯文本或
  它们自己的格式化规则，启用时在分块前应用 Markdown 表格转换。

## 表格处理

Markdown 表格在聊天客户端中支持不一致。使用
`markdown.tables` 控制每个通道（和每个账户）的转换。

- `code`：将表格渲染为代码块（大多数通道的默认值）。
- `bullets`：将每行转换为项目符号（Signal + WhatsApp 的默认值）。
- `off`：禁用表格解析和转换；原始表格文本通过。

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

- 分块限制来自通道适配器/配置，并应用于 IR 文本。
- 代码围栏保留为单个块，带有尾随换行符，以便通道正确渲染它们。
- 列表前缀和块引用前缀是 IR 文本的一部分，因此分块不会在前缀中间分割。
- 内联样式（粗体/斜体/删除线/内联代码/剧透）永远不会跨块分割；渲染器在每个块内重新打开样式。

如果你需要了解更多关于跨通道的分块行为，请参阅
[流式传输 + 分块](/concepts/streaming)。

## 链接政策

- **Slack：** `[label](url)` -> `<url|label>`；裸 URL 保持裸状态。解析期间禁用自动链接以避免双重链接。
- **Telegram：** `[label](url)` -> `<a href="url">label</a>`（HTML 解析模式）。
- **Signal：** `[label](url)` -> `label (url)`，除非标签与 URL 匹配。

## 剧透

剧透标记（`||spoiler||`）仅为 Signal 解析，在那里它们映射到 SPOILER 样式范围。其他通道将它们视为纯文本。

## 如何添加或更新通道格式化器

1. **解析一次：** 使用共享的 `markdownToIR(...)` 辅助函数，带有通道适当的选项（自动链接、标题样式、块引用前缀）。
2. **渲染：** 实现一个带有 `renderMarkdownWithMarkers(...)` 和样式标记映射（或 Signal 样式范围）的渲染器。
3. **分块：** 在渲染前调用 `chunkMarkdownIR(...)`；渲染每个块。
4. **连接适配器：** 更新通道出站适配器以使用新的分块器和渲染器。
5. **测试：** 添加或更新格式测试，如果通道使用分块，则添加出站传递测试。

## 常见陷阱

- Slack 尖括号令牌（`<@U123>`、`<#C123>`、`<https://...>`）必须保留；安全地转义原始 HTML。
- Telegram HTML 需要转义标签外的文本以避免损坏的标记。
- Signal 样式范围依赖于 UTF-16 偏移量；不要使用代码点偏移量。
- 为围栏代码块保留尾随换行符，以便关闭标记落在自己的行上。
