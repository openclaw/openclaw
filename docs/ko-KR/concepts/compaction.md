---
summary: "Context window + compaction: how OpenClaw keeps sessions under model limits"
read_when:
  - You want to understand auto-compaction and /compact
  - You are debugging long sessions hitting context limits
title: "Compaction"
x-i18n:
  source_hash: e1d6791f2902044b5798ebf9320a7d055d37211eff4be03caa35d7e328ae803c
---

# 컨텍스트 창 및 압축

모든 모델에는 **컨텍스트 창**(볼 수 있는 최대 토큰)이 있습니다. 장기 실행 채팅은 메시지와 도구 결과를 축적합니다. 창이 빡빡해지면 OpenClaw는 이전 기록을 **압축**하여 한도 내에서 유지합니다.

## 압축이란 무엇입니까?

압축은 **이전 대화**를 간단한 요약 항목으로 요약하고 최근 메시지를 그대로 유지합니다. 요약은 세션 기록에 저장되므로 향후 요청에서는 다음을 사용합니다.

- 압축 요약
- 압축 지점 이후 최근 메시지

세션의 JSONL 기록에 압축이 **지속**됩니다.

## 구성

`agents.defaults.compaction` 설정은 [압축 구성 및 모드](/concepts/compaction)를 참조하세요.

## 자동 압축(기본값은 켜져 있음)

세션이 모델의 컨텍스트 창에 가까워지거나 이를 초과하면 OpenClaw는 자동 압축을 트리거하고 압축된 컨텍스트를 사용하여 원래 요청을 다시 시도할 수 있습니다.

다음 내용이 표시됩니다.

- `🧹 Auto-compaction complete` 상세 모드
- `/status` 표시 `🧹 Compactions: <count>`

압축하기 전에 OpenClaw는 **자동 메모리 플러시** 회전을 실행하여 저장할 수 있습니다.
디스크에 내구성 있는 메모를 남깁니다. 자세한 내용과 구성은 [메모리](/concepts/memory)를 참조하세요.

## 수동 압축

압축 패스를 강제하려면 `/compact`(선택적으로 지침과 함께)를 사용하십시오.

```
/compact Focus on decisions and open questions
```

## 컨텍스트 창 소스

컨텍스트 창은 모델별로 다릅니다. OpenClaw는 구성된 공급자 카탈로그의 모델 정의를 사용하여 제한을 결정합니다.

## 압축 대 가지치기

- **압축**: JSONL에서 요약하고 **지속**합니다.
- **세션 정리**: 요청에 따라 **인메모리**에서 오래된 **도구 결과**만 잘라냅니다.

정리에 대한 자세한 내용은 [/concepts/session-pruning](/concepts/session-pruning)을 참조하세요.

## 팁

- 세션이 오래되었거나 컨텍스트가 부풀어오르는 경우 `/compact`를 사용하세요.
- 큰 도구 출력은 이미 잘렸습니다. 가지치기를 하면 도구 결과 축적을 더욱 줄일 수 있습니다.
- 새로운 슬레이트가 필요한 경우 `/new` 또는 `/reset`가 새 세션 ID를 시작합니다.
