---
summary: "在插件中編寫智慧代理工具（Schema、選用工具、允許清單）"
read_when:
  - 您想在插件中新增智慧代理工具
  - 您需要透過允許清單讓工具選擇啟用
title: "插件智慧代理工具"
---

# 插件智慧代理工具

OpenClaw 插件可以註冊**智慧代理工具** (JSON-schema functions)，這些工具會在智慧代理執行期間暴露給 LLM。工具可以是**必備**（始終可用）或**選用**（選擇啟用）。

智慧代理工具的設定位於主要設定檔中的 `tools`，或每個智慧代理的 `agents.list[].tools`。允許清單/拒絕清單政策控制智慧代理可以呼叫哪些工具。

## 基本工具

```ts
import { Type } from " @sinclair/typebox";

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

## 選用工具（選擇啟用）

選用工具**絕不會**自動啟用。使用者必須將它們新增到智慧代理的允許清單中。

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

在 `agents.list[].tools.allow`（或全域 `tools.allow`）中啟用選用工具：

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

其他影響工具可用性的設定開關：

- 只命名插件工具的允許清單會被視為插件的選擇啟用；核心工具仍會啟用，除非您在允許清單中也包含核心工具或群組。
- `tools.profile` / `agents.list[].tools.profile` (基礎允許清單)
- `tools.byProvider` / `agents.list[].tools.byProvider` (供應商專屬允許/拒絕)
- `tools.sandbox.tools.*` (沙箱隔離時的沙箱工具政策)

## 規則 + 提示

- 工具名稱**不得**與核心工具名稱衝突；衝突的工具將被跳過。
- 允許清單中使用的插件 ID 不得與核心工具名稱衝突。
- 對於會觸發副作用或需要額外二進位檔案/憑證的工具，請優先使用 `optional: true`。
