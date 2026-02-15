---
summary: "Write agent tools in a plugin (schemas, optional tools, allowlists)"
read_when:
  - You want to add a new agent tool in a plugin
  - You need to make a tool opt-in via allowlists
title: "Plugin Agent Tools"
x-i18n:
  source_hash: 4479462e9d8b17b664bf6b5f424f2efc8e7bedeaabfdb6a93126e051e635c659
---

# 플러그인 에이전트 도구

OpenClaw 플러그인은 노출된 **에이전트 도구**(JSON-스키마 기능)를 등록할 수 있습니다.
에이전트가 실행되는 동안 LLM에. 도구는 **필수**(항상 사용 가능) 또는
**선택 사항**(선택).

에이전트 도구는 기본 구성의 `tools`에서 구성되거나 아래의 에이전트별로 구성됩니다.
`agents.list[].tools`. 허용 목록/거부 목록 정책은 에이전트가 사용할 도구를 제어합니다.
전화할 수 있습니다.

## 기본 도구

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

## 선택적 도구(선택)

선택적 도구는 **절대** 자동으로 활성화되지 않습니다. 사용자는 이를 에이전트에 추가해야 합니다.
허용 목록.

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

`agents.list[].tools.allow`(또는 전역 `tools.allow`)에서 선택적 도구를 활성화합니다.

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

도구 가용성에 영향을 미치는 기타 구성 손잡이:

- 플러그인 도구 이름만 지정하는 허용 목록은 플러그인 선택으로 처리됩니다. 핵심 도구는 남아있다
  허용 목록에 핵심 도구나 그룹도 포함하지 않는 한 활성화됩니다.
- `tools.profile` / `agents.list[].tools.profile` (기본 허용 목록)
- `tools.byProvider` / `agents.list[].tools.byProvider` (공급자별 허용/거부)
- `tools.sandbox.tools.*` (샌드박스 처리 시 샌드박스 도구 정책)

## 규칙 + 팁

- 도구 이름은 핵심 도구 이름과 **충돌해서는 안** 됩니다. 충돌하는 도구는 건너뜁니다.
- 허용 목록에 사용되는 플러그인 ID는 핵심 도구 이름과 충돌해서는 안 됩니다.
- 부작용을 유발하거나 추가가 필요한 도구에는 `optional: true`를 선호합니다.
  바이너리/자격 증명.
