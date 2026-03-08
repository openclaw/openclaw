# Issue #39324 分析

## 问题描述

Telegram 收到两条消息：原始（含 thinking）+ 清理版（纯文本）
应该只发送一条：清理版（纯文本）

## 根本原因分析

### 场景重现

当文本包含未闭合的 `<thinking>` 标签时：

1. `extractThinkingFromTaggedStreamOutsideCode` 会提取整个文本作为 `taggedReasoning`
2. `stripReasoningTagsFromText` 在 strict 模式下会返回空字符串（因为 unclosed tag 之后的内容被丢弃）
3. `splitTelegramReasoningText` 返回：
   - `reasoningText`: 格式化后的 thinking 内容
   - `answerText`: undefined（因为 `strippedAnswer || undefined`）
4. 如果 reasoning 被禁用（`reasoningLevel === "off"`）：
   - `splitTextIntoLaneSegments` 只会添加 answer segment
   - 但 `answerText` 是 undefined，所以 segments 数组为空
5. `deliver` 函数检测到 `segments.length === 0`
6. 执行 `await sendPayload(payload)`，发送原始的 payload（包含 thinking 标签）

## 修复方案

### 方案1：修改 `splitTelegramReasoningText`

当 `taggedReasoning` 存在但 `strippedAnswer` 为空时，返回原始文本作为 answerText

```typescript
if (taggedReasoning && !strippedAnswer) {
  return { answerText: text };
}
```

**问题**：这会导致 answer lane 收到包含 thinking 标签的原始文本

### 方案2：修改 `stripReasoningTagsFromText`

使用 preserve 模式而不是 strict 模式，保留 unclosed thinking 标签之后的内容

**问题**：这可能不是预期的行为，因为 strict 模式的设计目的就是丢弃 unclosed tags

### 方案3：修改 `deliver` 函数逻辑

在发送原始 payload 之前，先清理 thinking 标签

```typescript
const cleanText = stripReasoningTagsFromText(payload.text, { mode: "strict" });
const cleanPayload = { ...payload, text: cleanText };
await sendPayload(cleanPayload);
```

**优点**：

- 不破坏现有的 `splitTelegramReasoningText` 逻辑
- 确保发送的消息不包含 thinking 标签
- 兼容性好

## 推荐方案

**方案3**，在 `deliver` 函数中清理 thinking 标签

## 实现位置

`src/telegram/bot-message-dispatch.ts` 第 616 行附近
