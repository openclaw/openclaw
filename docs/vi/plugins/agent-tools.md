---
summary: "Viết công cụ cho tác tử trong một plugin (schema, công cụ tùy chọn, danh sách cho phép)"
read_when:
  - Bạn muốn thêm một công cụ tác tử mới trong một plugin
  - Bạn cần biến một công cụ thành tùy chọn thông qua danh sách cho phép
title: "Công cụ tác tử của Plugin"
---

# Công cụ tác tử của plugin

OpenClaw plugins can register **agent tools** (JSON‑schema functions) that are exposed
to the LLM during agent runs. Tools can be **required** (always available) or
**optional** (opt‑in).

Agent tools are configured under `tools` in the main config, or per‑agent under
`agents.list[].tools`. The allowlist/denylist policy controls which tools the agent
can call.

## Công cụ cơ bản

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

## Công cụ tùy chọn (chọn tham gia)

Optional tools are **never** auto‑enabled. Users must add them to an agent
allowlist.

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

Bật công cụ tùy chọn trong `agents.list[].tools.allow` (hoặc toàn cục `tools.allow`):

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

Các nút cấu hình khác ảnh hưởng đến khả dụng của công cụ:

- Danh sách cho phép chỉ nêu tên công cụ plugin được xem là chọn tham gia cho plugin; các công cụ lõi vẫn
  được bật trừ khi bạn cũng đưa các công cụ lõi hoặc nhóm vào danh sách cho phép.
- `tools.profile` / `agents.list[].tools.profile` (danh sách cho phép cơ sở)
- `tools.byProvider` / `agents.list[].tools.byProvider` (cho phép/chặn theo nhà cung cấp)
- `tools.sandbox.tools.*` (chính sách công cụ sandbox khi ở chế độ sandbox)

## Quy tắc + mẹo

- Tên công cụ **không** được trùng với tên công cụ lõi; các công cụ xung đột sẽ bị bỏ qua.
- ID plugin dùng trong danh sách cho phép không được trùng với tên công cụ lõi.
- Ưu tiên `optional: true` cho các công cụ gây tác dụng phụ hoặc yêu cầu
  thêm nhị phân/thông tin xác thực.
