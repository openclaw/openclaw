---
summary: 「在外掛中撰寫代理程式工具（結構描述、選用工具、允許清單）」
read_when:
  - 「你想在外掛中新增一個代理程式工具」
  - 「你需要透過允許清單讓工具成為選用」
title: 「外掛代理程式工具」
x-i18n:
  source_path: plugins/agent-tools.md
  source_hash: 4479462e9d8b17b6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:52Z
---

# 外掛代理程式工具

OpenClaw 外掛可以註冊 **代理程式工具**（JSON‑schema 函式），在代理程式執行期間向 LLM 曝露。工具可以是 **必要**（永遠可用）或 **選用**（需選擇加入）。

代理程式工具在主要設定中的 `tools` 下進行設定，或在每個代理程式的 `agents.list[].tools` 下設定。允許清單／拒絕清單政策會控制代理程式可以呼叫哪些工具。

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

## 選用工具（需選擇加入）

選用工具 **永遠不會** 自動啟用。使用者必須將其加入代理程式的允許清單。

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

其他會影響工具可用性的設定旋鈕：

- 只列出外掛工具的允許清單會被視為外掛選擇加入；除非你也在允許清單中包含核心工具或群組，否則核心工具仍會保持啟用。
- `tools.profile` / `agents.list[].tools.profile`（基礎允許清單）
- `tools.byProvider` / `agents.list[].tools.byProvider`（提供者特定的允許／拒絕）
- `tools.sandbox.tools.*`（在沙箱隔離時的沙箱工具政策）

## 規則＋提示

- 工具名稱 **不得** 與核心工具名稱衝突；發生衝突的工具會被略過。
- 允許清單中使用的外掛 id 不得與核心工具名稱衝突。
- 對於會觸發副作用或需要額外二進位檔／認證的工具，優先使用 `optional: true`。
