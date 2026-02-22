---
summary: "플러그인에서 에이전트 도구 작성하기 (스키마, 선택적 도구, 허용 목록)"
read_when:
  - 플러그인에서 새로운 에이전트 도구를 추가하고 싶을 때
  - 허용 목록을 통해 도구를 선택적으로 활성화해야 할 때
title: "플러그인 에이전트 도구"
---

# 플러그인 에이전트 도구

OpenClaw 플러그인은 에이전트 실행 중 LLM에 노출되는 **에이전트 도구**(JSON‑스키마 함수)를 등록할 수 있습니다. 도구는 **필수**(항상 사용 가능)거나 **선택적**(선택 가능)일 수 있습니다.

에이전트 도구는 메인 설정의 `tools`에서, 또는 각 에이전트의 `agents.list[].tools` 아래에서 설정됩니다. 허용/거부 목록 정책은 에이전트가 호출할 수 있는 도구를 제어합니다.

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

## 선택적 도구 (선택 가능)

선택적 도구는 **자동으로** 활성화되지 않습니다. 사용자가 에이전트 허용 목록에 추가해야 합니다.

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

선택적 도구는 `agents.list[].tools.allow` (또는 전역 `tools.allow`)에서 활성화합니다:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // 특정 도구 이름
            "workflow", // 플러그인 id (그 플러그인의 모든 도구를 활성화)
            "group:plugins", // 모든 플러그인 도구
          ],
        },
      },
    ],
  },
}
```

도구 가용성에 영향을 미치는 다른 설정 요소:

- 플러그인 도구만 명명된 허용 목록은 플러그인 선택 허용으로 취급됩니다; 기본 도구는 허용 목록에 기본 도구나 그룹을 포함하지 않는 한 활성화된 상태로 남습니다.
- `tools.profile` / `agents.list[].tools.profile` (기본 허용 목록)
- `tools.byProvider` / `agents.list[].tools.byProvider` (프로바이더‑특정 허용/거부)
- `tools.sandbox.tools.*` (샌드박스 격리 시 샌드박스 도구 정책)

## 규칙 + 팁

- 도구 이름은 기본 도구 이름과 **충돌하지 않아야** 합니다; 충돌하는 도구는 건너뛰어집니다.
- 허용 목록에 사용된 플러그인 id는 기본 도구 이름과 충돌하지 않아야 합니다.
- 부작용을 유발하거나 추가적인 바이너리/자격 증명이 필요한 도구에는 `optional: true`를 선호하십시오.
