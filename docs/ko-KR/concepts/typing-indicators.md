---
summary: "When OpenClaw shows typing indicators and how to tune them"
read_when:
  - Changing typing indicator behavior or defaults
title: "Typing Indicators"
x-i18n:
  source_hash: 8ee82d02829c4ff58462be8bf5bb52f23f519aeda816c2fd8a583e7a317a2e98
---

# 입력 표시기

실행이 활성화된 동안 입력 표시기가 채팅 채널로 전송됩니다. 사용
`agents.defaults.typingMode` **입력 시작** 시기를 제어하고 `typingIntervalSeconds`
**새로고침 빈도**를 제어합니다.

## 기본값

`agents.defaults.typingMode`가 **설정 해제**되면 OpenClaw는 레거시 동작을 유지합니다.

- **직접 채팅**: 모델 루프가 시작되면 입력이 즉시 시작됩니다.
- **멘션이 포함된 그룹 채팅**: 입력이 즉시 시작됩니다.
- **멘션 없는 그룹 채팅**: 메시지 텍스트 스트리밍이 시작될 때만 입력이 시작됩니다.
- **하트비트 실행**: 입력이 비활성화됩니다.

## 모드

`agents.defaults.typingMode`를 다음 중 하나로 설정합니다.

- `never` — 입력 표시가 없습니다.
- `instant` — **모델 루프가 시작되자마자** 입력을 시작합니다.
  나중에 자동 응답 토큰만 반환합니다.
- `thinking` — **첫 번째 추론 델타**에 대해 입력을 시작합니다(필수
  `reasoningLevel: "stream"` 실행용).
- `message` — **첫 번째 비무성 텍스트 델타**에서 입력을 시작합니다(무시
  `NO_REPLY` 자동 토큰).

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

- `message` 모드는 자동 응답에 대한 입력을 표시하지 않습니다(예: `NO_REPLY`
  출력을 억제하는 데 사용되는 토큰).
- `thinking`는 실행이 추론을 스트리밍하는 경우에만 실행됩니다(`reasoningLevel: "stream"`).
  모델이 추론 델타를 내보내지 않으면 입력이 시작되지 않습니다.
- 하트비트는 모드에 관계없이 입력을 표시하지 않습니다.
- `typingIntervalSeconds`는 시작 시간이 아닌 **새로고침 주기**를 제어합니다.
  기본값은 6초입니다.
