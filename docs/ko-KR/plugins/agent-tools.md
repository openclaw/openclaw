---
summary: "플러그인에서 agent 도구 작성 (스키마, 선택적 도구, allowlist)"
read_when:
  - "플러그인에서 새로운 agent 도구를 추가하고 싶을 때"
  - "allowlist를 통해 도구를 선택적으로 만들어야 할 때"
title: "플러그인 Agent 도구"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/plugins/agent-tools.md
  workflow: 15
---

# 플러그인 agent 도구

OpenClaw 플러그인은 agent 실행 중에 LLM에 노출되는 **agent 도구** (JSON 스키마 함수)를 등록할 수 있습니다. 도구는 **필수** (항상 사용 가능) 또는 **선택적** (선택).

Agent 도구는 메인 구성의 `tools` 아래 또는 에이전트별로 `agents.list[].tools` 아래에서 구성됩니다. allowlist/denylist 정책이 에이전트가 호출할 수 있는 도구를 제어합니다.

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

## 선택적 도구 (선택)

선택적 도구는 **자동 활성화되지 않습니다**. 사용자는 에이전트 allowlist에 추가해야 합니다.

```ts
export default function (api) {
  api.registerTool(
    {
      name: "workflow_tool",
      description: "로컬 워크플로우 실행",
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

선택적 도구를 `agents.list[].tools.allow`에서 활성화합니다 (또는 글로벌 `tools.allow`):

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

도구 가용성에 영향을 주는 다른 구성 노브:

- Allowlist가 플러그인 도구만 명시하는 경우 플러그인 선택 항목으로 취급됩니다. allowlist에 핵심 도구나 그룹도 포함하지 않으면 핵심 도구가 활성화 상태로 유지됩니다.
- `tools.profile` / `agents.list[].tools.profile` (기본 allowlist)
- `tools.byProvider` / `agents.list[].tools.byProvider` (제공자별 allow/deny)
- `tools.sandbox.tools.*` (샌드박싱할 때 샌드박스 도구 정책)

## 규칙 + 팁

- 도구 이름은 핵심 도구 이름과 **충돌하면 안 됩니다**; 충돌하는 도구를 건너뜁니다.
- allowlist에서 사용되는 플러그인 id는 핵심 도구 이름과 충돌하면 안 됩니다.
- 부작용을 트리거하거나 추가 바이너리/자격증명이 필요한 도구에 `optional: true`를 선호합니다.
