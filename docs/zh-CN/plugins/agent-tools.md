---
read_when:
  - 你想在插件中添加新的智能体工具
  - 你需要通过允许列表将工具设为可选启用
summary: 在插件中编写智能体工具（模式定义、可选工具、允许列表）
title: 插件智能体工具
x-i18n:
  generated_at: "2026-02-01T21:34:08Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 4479462e9d8b17b664bf6b5f424f2efc8e7bedeaabfdb6a93126e051e635c659
  source_path: plugins/agent-tools.md
  workflow: 15
---

# 插件智能体工具

OpenClaw 插件可以注册**智能体工具**（JSON Schema 函数），这些工具在智能体运行期间暴露给 LLM。工具可以是**必需的**（始终可用）或**可选的**（需主动启用）。

智能体工具在主配置的 `tools` 下进行配置，或在 `agents.list[].tools` 下按智能体单独配置。允许列表/拒绝列表策略控制智能体可以调用哪些工具。

## 基本工具

```ts
import { Type } from "@sinclair/typebox";

export default function (api) {
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({
      input: Type.String(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });
}
```

## 可选工具（主动启用）

可选工具**永远不会**自动启用。用户必须将其添加到智能体的允许列表中。

```ts
export default function (api) {
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a local workflow",
      parameters: {
        type: "object",
        properties: {
          pipeline: { type: "string" },
        },
        required: ["pipeline"],
      },
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.pipeline }] };
      },
    },
    { optional: true },
  );
}
```

在 `agents.list[].tools.allow`（或全局 `tools.allow`）中启用可选工具：

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // 指定工具名称
            "workflow", // 插件 id（启用该插件的所有工具）
            "group:plugins", // 所有插件工具
          ],
        },
      },
    ],
  },
}
```

影响工具可用性的其他配置项：

- 仅包含插件工具名称的允许列表被视为插件启用配置；核心工具仍保持启用状态，除非你在允许列表中同时包含核心工具或工具组。
- `tools.profile` / `agents.list[].tools.profile`（基础允许列表）
- `tools.byProvider` / `agents.list[].tools.byProvider`（按提供商的允许/拒绝配置）
- `tools.sandbox.tools.*`（沙箱环境下的沙箱工具策略）

## 规则与建议

- 工具名称**不得**与核心工具名称冲突；冲突的工具将被跳过。
- 允许列表中使用的插件 id 不得与核心工具名称冲突。
- 对于会触发副作用或需要额外二进制文件/凭据的工具，建议使用 `optional: true`。
