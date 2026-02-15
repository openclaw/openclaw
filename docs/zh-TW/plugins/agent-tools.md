---
summary: "在外掛程式中撰寫智慧代理工具（結構定義、選用工具、允許清單）"
read_when:
  - 您想在外掛程式中新增智慧代理工具
  - 您需要透過允許清單讓工具變為選擇性加入 (opt-in)
title: "外掛程式智慧代理工具"
---

# 外掛程式智慧代理工具

OpenClaw 外掛程式可以註冊 **智慧代理工具**（JSON‑schema 函式），這些工具會在智慧代理執行期間提供給 LLM 使用。工具可以是 **必選**（一律可用）或 **選用**（選擇性加入）。

智慧代理工具可在主設定的 `tools` 下進行設定，或在 `agents.list[].tools` 下針對個別智慧代理進行設定。允許清單/拒絕清單政策控制智慧代理可以呼叫哪些工具。

## 基礎工具

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

## 選用工具（選擇性加入）

選用工具 **絕不會** 自動啟用。使用者必須將其新增至智慧代理的允許清單中。

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

在 `agents.list[].tools.allow`（或全域的 `tools.allow`）中啟用選用工具：

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // 特定工具名稱
            "workflow", // 外掛程式 ID（啟用該外掛程式的所有工具）
            "group:plugins", // 所有外掛程式工具
          ],
        },
      },
    ],
  },
}
```

其他影響工具可用性的設定項：

- 僅列出外掛程式工具的允許清單會被視為外掛程式的選擇性加入；核心工具仍會保持啟用，除非您也在允許清單中包含核心工具或群組。
- `tools.profile` / `agents.list[].tools.profile`（基礎允許清單）
- `tools.byProvider` / `agents.list[].tools.byProvider`（特定供應商的允許/拒絕）
- `tools.sandbox.tools.*`（沙箱隔離時的沙箱工具政策）

## 規則與提示

- 工具名稱 **不得** 與核心工具名稱衝突；衝突的工具將被略過。
- 允許清單中使用的外掛程式 ID 不得與核心工具名稱衝突。
- 對於會觸發副作用或需要額外執行檔/憑證的工具，建議使用 `optional: true`。
