---
summary: "在 OpenClaw 中使用 xAI Grok 模型"
read_when:
  - 您想在 OpenClaw 中使用 Grok 模型
  - 您正在配置 xAI 认证或模型 ID
title: "xAI"
---

# xAI

OpenClaw 捆绑了用于 Grok 模型的 `xai` 提供商插件。

## 设置

1. 在 xAI 控制台创建 API 密钥。
2. 设置 `XAI_API_KEY`，或运行：

```bash
openclaw onboard --auth-choice xai-api-key
```

3. 选择一个模型，例如：

```json5
{
  agents: { defaults: { model: { primary: "xai/grok-4" } } },
}
```

## 当前捆绑的模型目录

OpenClaw 现已开箱即用地包含以下 xAI 模型系列：

- `grok-4`、`grok-4-0709`
- `grok-4-fast-reasoning`、`grok-4-fast-non-reasoning`
- `grok-4-1-fast-reasoning`、`grok-4-1-fast-non-reasoning`
- `grok-4.20-reasoning`、`grok-4.20-non-reasoning`
- `grok-code-fast-1`

插件还会在遵循相同 API 形状时向前解析较新的 `grok-4*` 和 `grok-code-fast*` ID。

## 网络搜索

捆绑的 `grok` 网络搜索提供商也使用 `XAI_API_KEY`：

```bash
openclaw config set tools.web.search.provider grok
```

## 已知限制

- 认证目前仅支持 API 密钥。OpenClaw 尚不支持 xAI OAuth/设备代码流程。
- `grok-4.20-multi-agent-experimental-beta-0304` 不支持正常的 xAI 提供商路径，因为它需要与标准 OpenClaw xAI 传输不同的上游 API 表面。
- 原生 xAI 服务器端工具（如 `x_search` 和 `code_execution`）还不是捆绑插件中的一等模型提供商功能。

## 备注

- OpenClaw 在共享运行器路径上自动应用 xAI 特定的工具模式和工具调用兼容性修复。
- 有关更广泛的提供商概述，请参阅 [模型提供商](/providers/index)。