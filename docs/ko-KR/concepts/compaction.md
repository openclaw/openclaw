---
summary: "컨텍스트 윈도우 + compaction: OpenClaw가 세션을 모델 제한 내로 유지하는 방법"
read_when:
  - auto-compaction 및 /compact를 이해하려고 할 때
  - 컨텍스트 제한에 도달하는 장시간 세션을 디버깅하고 있을 때
title: "Compaction"
---

# 컨텍스트 윈도우 & Compaction

모든 모델은 **컨텍스트 윈도우** (최대 볼 수 있는 토큰)를 갖습니다. 장시간 채팅은 메시지 및 도구 결과를 축적합니다; 윈도우가 타이트할 때, OpenClaw는 제한 내에 머물기 위해 더 오래된 히스토리를 **compacts**합니다.

## Compaction이란

Compaction은 **더 오래된 대화를 요약**하고 최근 메시지를 그대로 유지합니다. 요약은 세션 히스토리에 저장되므로 향후 요청은 다음을 사용합니다:

- Compaction 요약
- Compaction 포인트 이후 최근 메시지

Compaction은 세션의 JSONL 히스토리에 **유지됩니다**.

## 설정

`openclaw.json`의 `agents.defaults.compaction` 설정을 사용하여 compaction 동작을 설정합니다 (모드, target tokens 등).
Compaction 요약은 기본적으로 opaque identifiers를 보존합니다 (`identifierPolicy: "strict"`). 이를 `identifierPolicy: "off"` 또는 custom 텍스트와 `identifierPolicy: "custom"` 및 `identifierInstructions`으로 재정의할 수 있습니다.

## Auto-compaction (기본값 on)

세션이 모델의 컨텍스트 윈도우에 가까워지거나 초과할 때, OpenClaw는 auto-compaction을 trigger하고 compacted 컨텍스트를 사용하여 원본 요청을 재시도할 수 있습니다.

다음을 보게 됩니다:

- verbose 모드에서 `🧹 Auto-compaction complete`
- `/status`에서 `🧹 Compactions: <count>`

Compaction 전, OpenClaw는 **silent memory flush** 턴을 실행하여 durable 노트를 디스크에 저장할 수 있습니다. 세부정보 및 설정은 [메모리](/concepts/memory)를 참조합니다.

## Manual compaction

`/compact` (선택적 지침 포함)을 사용하여 compaction pass를 강제합니다:

```
/compact Focus on decisions and open questions
```

## 컨텍스트 윈도우 소스

컨텍스트 윈도우는 모델별입니다. OpenClaw는 제한을 결정하기 위해 configured provider catalog의 모델 정의를 사용합니다.

## Compaction vs pruning

- **Compaction**: 요약하고 **JSONL에 유지**.
- **Session pruning**: 오래된 **도구 결과만** trimming, **in-memory**, per request.

pruning 세부정보는 [/concepts/session-pruning](/concepts/session-pruning)을 참조합니다.

## OpenAI server-side compaction

OpenClaw는 또한 compatible direct OpenAI models를 위해 OpenAI Responses server-side compaction hints를 지원합니다. 이는 local OpenClaw compaction과 별개이며 함께 실행될 수 있습니다.

- Local compaction: OpenClaw는 요약하고 세션 JSONL에 유지합니다.
- Server-side compaction: `store` + `context_management`가 활성화될 때 OpenAI는 provider 측에서 컨텍스트를 compacts합니다.

모델 params 및 재정의는 [OpenAI provider](/providers/openai)를 참조합니다.

## 팁

- 세션이 stale하거나 컨텍스트가 bloated된 것처럼 느껴질 때 `/compact`를 사용합니다.
- 큰 도구 출력은 이미 잘립니다; pruning은 도구 결과 buildup을 더 줄일 수 있습니다.
- fresh slate가 필요한 경우 `/new` 또는 `/reset`은 새로운 세션 id를 시작합니다.
