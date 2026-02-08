---
read_when:
    - 워크플로 내부에 JSON 전용 LLM 단계가 필요합니다.
    - 자동화를 위해서는 스키마 검증된 LLM 출력이 필요합니다.
summary: 워크플로를 위한 JSON 전용 LLM 작업(선택적 플러그인 도구)
title: LLM 작업
x-i18n:
    generated_at: "2026-02-08T16:06:23Z"
    model: gtx
    provider: google-translate
    source_hash: b7aa78f179cb0f6361084bf6d0b895856f116d7077669c5ef995b92959211001
    source_path: tools/llm-task.md
    workflow: 15
---

# LLM 작업

`llm-task` 은 **선택적 플러그인 도구** JSON 전용 LLM 작업을 실행하고
구조화된 출력을 반환합니다(선택적으로 JSON 스키마에 대해 검증됨).

이는 Lobster와 같은 워크플로 엔진에 이상적입니다. 단일 LLM 단계를 추가할 수 있습니다.
각 워크플로에 대한 맞춤형 OpenClaw 코드를 작성하지 않고도 가능합니다.

## 플러그인 활성화

1. 플러그인을 활성화합니다:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. 도구를 허용 목록에 추가합니다(다음으로 등록됨). `optional: true`):

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

## 구성(선택사항)

```json
{
  "plugins": {
    "entries": {
      "llm-task": {
        "enabled": true,
        "config": {
          "defaultProvider": "openai-codex",
          "defaultModel": "gpt-5.2",
          "defaultAuthProfileId": "main",
          "allowedModels": ["openai-codex/gpt-5.3-codex"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`allowedModels` 허용 목록은 다음과 같습니다. `provider/model` 문자열. 설정된 경우 모든 요청
목록 외부에서는 거부됩니다.

## 도구 매개변수

- `prompt` (문자열, 필수)
- `input` (임의, 선택사항)
- `schema` (객체, 선택적 JSON 스키마)
- `provider` (문자열, 선택사항)
- `model` (문자열, 선택사항)
- `authProfileId` (문자열, 선택사항)
- `temperature` (숫자, 선택사항)
- `maxTokens` (숫자, 선택사항)
- `timeoutMs` (숫자, 선택사항)

## 산출

보고 `details.json` 구문 분석된 JSON을 포함하고
`schema` 제공되는 경우).

## 예: 랍스터 워크플로 단계

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": {
    "subject": "Hello",
    "body": "Can you help?"
  },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

## 안전 참고사항

- 도구는 **JSON 전용** 모델에 JSON만 출력하도록 지시합니다(아니요.
  코드 펜스, 해설 없음).
- 이 실행에서는 모델에 도구가 노출되지 않습니다.
- 검증하지 않는 한 출력을 신뢰할 수 없는 것으로 처리합니다. `schema`.
- 부작용을 일으키는 단계(보내기, 게시, 실행)보다 먼저 승인을 받으세요.
