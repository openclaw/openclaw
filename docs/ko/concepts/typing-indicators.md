---
read_when:
    - 입력 표시 동작 또는 기본값 변경
summary: OpenClaw가 입력 표시기를 표시하는 경우와 이를 조정하는 방법
title: 입력 표시기
x-i18n:
    generated_at: "2026-02-08T15:53:54Z"
    model: gtx
    provider: google-translate
    source_hash: 8ee82d02829c4ff58462be8bf5bb52f23f519aeda816c2fd8a583e7a317a2e98
    source_path: concepts/typing-indicators.md
    workflow: 15
---

# 입력 표시기

실행이 활성화된 동안 입력 표시기가 채팅 채널로 전송됩니다. 사용
`agents.defaults.typingMode` 통제하다 **언제** 타이핑이 시작되고 `typingIntervalSeconds`
 통제하다 **얼마나 자주** 새로 고침됩니다.

## 기본값

언제 `agents.defaults.typingMode` ~이다 **설정되지 않음**, OpenClaw는 레거시 동작을 유지합니다.

- **직접 채팅**: 모델 루프가 시작되면 입력이 즉시 시작됩니다.
- **멘션이 포함된 그룹 채팅**: 입력이 즉시 시작됩니다.
- **멘션 없는 그룹채팅**: 메시지 텍스트 스트리밍이 시작될 때만 입력이 시작됩니다.
- **심장박동이 뛰다**: 입력이 비활성화되었습니다.

## 모드

세트 `agents.defaults.typingMode` 다음 중 하나에:

- `never` — 입력 표시기가 없습니다.
- `instant` — 입력 시작 **모델 루프가 시작되자마자**, 실행하더라도
  나중에 자동 응답 토큰만 반환합니다.
- `thinking` —에 입력을 시작합니다 **첫 번째 추론 델타** (요구
  `reasoningLevel: "stream"` 달리기를 위해).
- `message` —에 입력을 시작합니다 **최초의 무음 텍스트 델타** (무시
  는 `NO_REPLY` 자동 토큰).

"얼마나 일찍 발생하는지" 순서:
`never` → `message` → `thinking` → `instant`

## 구성

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

세션당 모드 또는 케이던스를 재정의할 수 있습니다.

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## 메모

- `message` 모드에서는 자동 응답에만 입력하는 내용이 표시되지 않습니다(예: `NO_REPLY`
  출력을 억제하는 데 사용되는 토큰).
- `thinking` 실행이 추론을 스트리밍하는 경우에만 실행됩니다(`reasoningLevel: "stream"`).
  모델이 추론 델타를 내보내지 않으면 입력이 시작되지 않습니다.
- 하트비트는 모드에 관계없이 입력을 표시하지 않습니다.
- `typingIntervalSeconds` 제어 **새로 고침 케이던스**, 시작 시간이 아닙니다.
  기본값은 6초입니다.
