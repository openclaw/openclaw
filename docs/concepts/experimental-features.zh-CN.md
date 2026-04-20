---
title: "实验性功能"
summary: "OpenClaw 中的实验性标志意味着什么以及当前记录了哪些标志"
read_when:
  - 您看到 `.experimental` 配置键并想知道它是否稳定
  - 您想尝试预览运行时功能，而不将它们与正常默认值混淆
  - 您想在一个地方找到当前记录的实验性标志
---

# 实验性功能

OpenClaw 中的实验性功能是**可选的预览表面**。它们处于明确的标志后面，因为它们在获得稳定的默认值或长期的公共契约之前，仍需要真实世界的使用验证。

以不同的方式对待它们，与普通配置不同：

- 保持**默认关闭**，除非相关文档告诉您尝试其中一个。
- 期望**形状和行为**比稳定配置变化更快。
- 当先有稳定路径时，优先选择稳定路径。
- 如果您正在广泛推出 OpenClaw，请在将实验性标志纳入共享基线之前，在较小的环境中测试它们。

## 当前记录的标志

| 表面 | 键 | 使用时机 | 更多 |
| -------- | -------- | -------- | -------- |
| 本地模型运行时 | `agents.defaults.experimental.localModelLean` | 较小或更严格的本地后端在 OpenClaw 的完整默认工具表面上运行不畅 | [本地模型](/gateway/local-models) |
| 记忆搜索 | `agents.defaults.memorySearch.experimental.sessionMemory` | 您希望 `memory_search` 索引之前的会话记录并接受额外的存储/索引成本 | [记忆配置参考](/reference/memory-config#session-memory-search-experimental) |
| 结构化规划工具 | `tools.experimental.planTool` | 您希望在兼容的运行时和 UI 中公开结构化的 `update_plan` 工具，用于多步骤工作跟踪 | [网关配置参考](/gateway/configuration-reference#toolsexperimental) |

## 本地模型精简模式

`agents.defaults.experimental.localModelLean: true` 是较弱本地模型设置的压力释放阀。它会裁剪重量级默认工具，如 `browser`、`cron` 和 `message`，以便提示形状更小，对小上下文或更严格的 OpenAI 兼容后端更不脆弱。

这故意**不是**正常路径。如果您的后端能够干净地处理完整运行时，请保持此选项关闭。

## 实验性并不意味着隐藏

如果一个功能是实验性的，OpenClaw 应该在文档和配置路径本身中清楚地说明这一点。它**不应该**做的是将预览行为偷偷塞进看起来稳定的默认旋钮中，并假装这是正常的。这就是配置表面变得混乱的原因。