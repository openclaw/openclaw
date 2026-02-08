---
read_when:
    - 플러그인에 새 에이전트 도구를 추가하고 싶습니다.
    - 허용 목록을 통해 도구를 선택해야 합니다.
summary: 플러그인에 에이전트 도구 작성(스키마, 선택적 도구, 허용 목록)
title: 플러그인 에이전트 도구
x-i18n:
    generated_at: "2026-02-08T16:01:36Z"
    model: gtx
    provider: google-translate
    source_hash: 4479462e9d8b17b664bf6b5f424f2efc8e7bedeaabfdb6a93126e051e635c659
    source_path: plugins/agent-tools.md
    workflow: 15
---

# 플러그인 에이전트 도구

OpenClaw 플러그인 등록 가능 **에이전트 도구** (JSON-스키마 함수)이 노출됩니다.
에이전트가 실행되는 동안 LLM에. 도구는 다음과 같습니다. **필수의** (항상 사용 가능) 또는
**선택 과목** (선택).

에이전트 도구는 다음에서 구성됩니다. `tools` 기본 구성에서 또는 에이전트별로
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

선택적 도구는 다음과 같습니다. **절대** 자동 활성화됩니다. 사용자는 이를 에이전트에 추가해야 합니다.
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

다음에서 선택적 도구 활성화 `agents.list[].tools.allow` (또는 글로벌 `tools.allow`):

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

- 도구 이름은 다음과 같아야 합니다. **~ 아니다** 핵심 도구 이름과 충돌합니다. 충돌하는 도구는 건너뜁니다.
- 허용 목록에 사용되는 플러그인 ID는 핵심 도구 이름과 충돌해서는 안 됩니다.
- 선호하다 `optional: true` 부작용을 유발하거나 추가 비용이 필요한 도구의 경우
  바이너리/자격 증명.
