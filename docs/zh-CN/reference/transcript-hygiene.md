---
read_when:
  - 你正在调试与对话记录结构相关的提供商请求拒绝问题
  - 你正在修改对话记录清理或工具调用修复逻辑
  - 你正在调查跨提供商的工具调用 id 不匹配问题
summary: 参考：提供商特定的对话记录清理与修复规则
title: 对话记录清理
x-i18n:
  generated_at: "2026-02-01T21:38:16Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 6ce62fad0b07c4d8575c9cdb1c8c2663695ef2d4221cf4a0964fce03461523af
  source_path: reference/transcript-hygiene.md
  workflow: 15
---

# 对话记录清理（提供商修正）

本文档描述了在运行前（构建模型上下文时）应用于对话记录的**提供商特定修正**。这些是**内存中**的调整，用于满足提供商的严格要求。它们**不会**重写磁盘上存储的 JSONL 对话记录。

涵盖范围包括：

- 工具调用 id 清理
- 工具结果配对修复
- 轮次验证 / 排序
- 思考签名清理
- 图片负载清理

如需了解对话记录存储细节，请参阅：

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## 运行位置

所有对话记录清理逻辑集中在嵌入式运行器中：

- 策略选择：`src/agents/transcript-policy.ts`
- 清理/修复应用：`src/agents/pi-embedded-runner/google.ts` 中的 `sanitizeSessionHistory`

策略根据 `provider`、`modelApi` 和 `modelId` 来决定应用哪些规则。

---

## 全局规则：图片清理

图片负载始终会被清理，以防止因大小限制导致提供商端拒绝（对超大 base64 图片进行缩放/重新压缩）。

实现：

- `src/agents/pi-embedded-helpers/images.ts` 中的 `sanitizeSessionMessagesImages`
- `src/agents/tool-images.ts` 中的 `sanitizeContentBlocksImages`

---

## 提供商矩阵（当前行为）

**OpenAI / OpenAI Codex**

- 仅图片清理。
- 切换到 OpenAI Responses/Codex 模型时，丢弃孤立的推理签名（没有后续内容块的独立推理项）。
- 不进行工具调用 id 清理。
- 不进行工具结果配对修复。
- 不进行轮次验证或重新排序。
- 不生成合成工具结果。
- 不剥离思考签名。

**Google (Generative AI / Gemini CLI / Antigravity)**

- 工具调用 id 清理：严格字母数字。
- 工具结果配对修复和合成工具结果。
- 轮次验证（Gemini 风格的轮次交替）。
- Google 轮次排序修正（如果历史记录以助手开头，则在前面添加一个小型用户引导消息）。
- Antigravity Claude：规范化思考签名；丢弃未签名的思考块。

**Anthropic / Minimax（Anthropic 兼容）**

- 工具结果配对修复和合成工具结果。
- 轮次验证（合并连续的用户轮次以满足严格交替要求）。

**Mistral（包括基于 model-id 的检测）**

- 工具调用 id 清理：strict9（字母数字，长度 9）。

**OpenRouter Gemini**

- 思考签名清理：剥离非 base64 的 `thought_signature` 值（保留 base64）。

**其他所有提供商**

- 仅图片清理。

---

## 历史行为（2026.1.22 之前）

在 2026.1.22 版本发布之前，OpenClaw 应用了多层对话记录清理：

- 一个**对话记录清理扩展**在每次上下文构建时运行，可以：
  - 修复工具使用/结果配对。
  - 清理工具调用 id（包括保留 `_`/`-` 的非严格模式）。
- 运行器也执行提供商特定的清理，导致重复工作。
- 在提供商策略之外还存在额外的变更，包括：
  - 在持久化之前从助手文本中剥离 `<final>` 标签。
  - 丢弃空的助手错误轮次。
  - 截断工具调用之后的助手内容。

这种复杂性导致了跨提供商的回归问题（尤其是 `openai-responses` 的 `call_id|fc_id` 配对）。2026.1.22 的清理移除了该扩展，将逻辑集中到运行器中，并使 OpenAI 在图片清理之外**不做任何修改**。
