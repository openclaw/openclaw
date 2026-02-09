---
summary: "플러그인에서 에이전트 도구 작성하기 (스키마, 선택적 도구, 허용 목록)"
read_when:
  - 플러그인에 새로운 에이전트 도구를 추가하려는 경우
  - 허용 목록을 통해 도구를 옵트인으로 설정해야 하는 경우
title: "플러그인 에이전트 도구"
---

# 플러그인 에이전트 도구

OpenClaw 플러그인은 에이전트 실행 중 LLM 에 노출되는 **에이전트 도구**(JSON‑스키마 함수)를 등록할 수 있습니다. 도구는 **필수**(항상 사용 가능) 또는 **선택적**(옵트인)일 수 있습니다.

에이전트 도구는 메인 구성의 `tools` 아래에서, 또는 에이전트별로 `agents.list[].tools` 아래에서 구성합니다. 허용 목록/차단 목록 정책은 에이전트가 호출할 수 있는 도구를 제어합니다.

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

## 선택적 도구 (옵트인)

선택적 도구는 **절대** 자동으로 활성화되지 않습니다. 사용자는 에이전트 허용 목록에 이를 추가해야 합니다.

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

`agents.list[].tools.allow` (또는 전역 `tools.allow`)에서 선택적 도구를 활성화합니다:

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

도구 가용성에 영향을 미치는 기타 구성 항목:

- 플러그인 도구만 이름으로 지정한 허용 목록은 플러그인 옵트인으로 처리됩니다. 허용 목록에 코어 도구나 그룹을 함께 포함하지 않는 한 코어 도구는 활성화된 상태로 유지됩니다.
- `tools.profile` / `agents.list[].tools.profile` (기본 허용 목록)
- `tools.byProvider` / `agents.list[].tools.byProvider` (프로바이더별 허용/차단)
- `tools.sandbox.tools.*` (샌드박스화된 경우의 샌드박스 도구 정책)

## 규칙 + 팁

- 도구 이름은 코어 도구 이름과 **충돌해서는 안 됩니다**. 충돌하는 도구는 건너뜁니다.
- 허용 목록에 사용되는 플러그인 id 는 코어 도구 이름과 충돌해서는 안 됩니다.
- 부작용을 유발하거나 추가 바이너리/자격 증명이 필요한 도구에는 `optional: true` 사용을 권장합니다.
