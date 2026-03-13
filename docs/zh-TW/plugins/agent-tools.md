---
summary: "Write agent tools in a plugin (schemas, optional tools, allowlists)"
read_when:
  - You want to add a new agent tool in a plugin
  - You need to make a tool opt-in via allowlists
title: Plugin Agent Tools
---

# Plugin 代理工具

OpenClaw 插件可以註冊 **代理工具**（JSON‑schema 函數），這些工具會在代理執行期間暴露給 LLM。工具可以是 **必須的**（始終可用）或 **可選的**（需選擇加入）。

代理工具在主設定的 `tools` 下設定，或在每個代理的 `agents.list[].tools` 下設定。允許清單/拒絕清單政策控制代理可以呼叫哪些工具。

## 基本工具

ts
import { Type } from "@sinclair/typebox";

export default function (api) {
api.registerTool({
name: "my_tool",
description: "執行一個動作",
parameters: Type.Object({
input: Type.String(),
}),
async execute(\_id, params) {
return { content: [{ type: "text", text: params.input }] };
},
});
}

## 可選工具（需選擇加入）

可選工具 **絕不會** 自動啟用。使用者必須將它們加入代理的允許清單。

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

在 `agents.list[].tools.allow`（或全域 `tools.allow`）中啟用可選工具：

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // specific tool name
            "workflow", // plugin id (enables all tools from that plugin)
            "group:plugins", // all plugin tools
          ],
        },
      },
    ],
  },
}
```

其他影響工具可用性的設定選項：

- 僅列出插件工具的允許清單會被視為插件的選擇加入；核心工具會保持啟用，除非你也在允許清單中包含核心工具或群組。
- `tools.profile` / `agents.list[].tools.profile`（基礎允許清單）
- `tools.byProvider` / `agents.list[].tools.byProvider`（特定提供者的允許/拒絕）
- `tools.sandbox.tools.*`（沙盒環境下的工具政策）

## 規則與建議

- 工具名稱不得與核心工具名稱衝突；衝突的工具會被跳過。
- 允許清單中使用的插件 ID 不得與核心工具名稱衝突。
- 建議對於會觸發副作用或需要額外二進位檔/憑證的工具，使用 `optional: true`。
