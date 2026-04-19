---
summary: "出站频道的Markdown格式化管道"
read_when:
  - 你正在为出站频道更改Markdown格式化或分块
  - 你正在添加新的频道格式化器或样式映射
  - 你正在跨频道调试格式化回归

title: "Markdown格式化"
---

# Markdown格式化

OpenClaw通过在呈现频道特定输出之前将其转换为共享的中间表示（IR）来格式化出站Markdown。IR在保持源文本完整的同时携带样式/链接范围，因此分块和呈现可以在不同频道间保持一致。

## 目标

- **一致性**：一个解析步骤，多个渲染器。
- **安全分块**：在呈现前分割文本，使内联格式化永远不会跨块断开。
- **频道适配**：将相同的IR映射到Slack mrkdwn、Telegram HTML和Signal样式范围，而无需重新解析Markdown。

## 管道

1. **解析Markdown -> IR**
   - IR是纯文本加上样式范围（粗体/斜体/删除线/代码/剧透）和链接范围。
   - 偏移量是UTF-16代码单元，因此Signal样式范围与其API对齐。
   - 表格仅在频道选择加入表格转换时解析。
2. **分块IR（先格式化）**
   - 分块在IR文本上发生，然后再呈现。
   - 内联格式化不会跨块分割；范围按块切片。
3. **按频道呈现**
   - **Slack**：mrkdwn标记（粗体/斜体/删除线/代码），链接为`<url|label>`。
   - **Telegram**：HTML标签（`<b>`、`<i>`、`<s>`、`<code>`、`<pre><code>`、`<a href>`）。
   - **Signal**：纯文本 + `text-style`范围；当标签不同时，链接变为`label (url)`。

## IR示例

输入Markdown：

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

## 它的使用位置

- Slack、Telegram和Signal出站适配器从IR渲染。
- 其他频道（WhatsApp、iMessage、Microsoft Teams、Discord）仍然使用纯文本或自己的格式化规则，启用时在分块前应用Markdown表格转换。

## 表格处理

Markdown表格在聊天客户端中没有一致支持。使用`markdown.tables`来控制每个频道（和每个账户）的转换。

- `code`：将表格呈现为代码块（大多数频道的默认值）。
- `bullets`：将每行转换为项目符号（Signal + WhatsApp的默认值）。
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

- 分块限制来自频道适配器/配置，并应用于IR文本。
- 代码围栏保留为单个块，带有尾随换行符，以便频道正确渲染它们。
- 列表前缀和引用前缀是IR文本的一部分，因此分块不会在中间前缀处分割。
- 内联样式（粗体/斜体/删除线/内联代码/剧透）永远不会跨块分割；渲染器在每个块内重新打开样式。

如果你需要更多关于跨频道分块行为的信息，请参阅[流+分块](/concepts/streaming)。

## 链接策略

- **Slack**：`[label](url)` -> `<url|label>`；裸URL保持裸状态。解析期间禁用自动链接以避免双重链接。
- **Telegram**：`[label](url)` -> `<a href="url">label</a>`（HTML解析模式）。
- **Signal**：`[label](url)` -> `label (url)`，除非标签与URL匹配。

## 剧透

剧透标记（`||spoiler||`）仅为Signal解析，在那里它们映射到SPOILER样式范围。其他频道将它们视为纯文本。

## 如何添加或更新频道格式化器

1. **解析一次**：使用共享的`markdownToIR(...)`助手，带有频道适当的选项（自动链接、标题样式、引用前缀）。
2. **渲染**：使用`renderMarkdownWithMarkers(...)`和样式标记映射（或Signal样式范围）实现渲染器。
3. **分块**：在渲染前调用`chunkMarkdownIR(...)`；渲染每个块。
4. **连接适配器**：更新频道出站适配器以使用新的分块器和渲染器。
5. **测试**：如果频道使用分块，添加或更新格式测试和出站传递测试。

## 常见问题

- Slack尖括号标记（`<@U123>`、`<#C123>`、`<https://...>`）必须保留；安全转义原始HTML。
- Telegram HTML需要转义标签外的文本以避免损坏的标记。
- Signal样式范围依赖于UTF-16偏移量；不要使用代码点偏移量。
- 为围栏代码块保留尾随换行符，以便关闭标记位于自己的行上。
