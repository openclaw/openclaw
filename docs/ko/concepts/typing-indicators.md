---
summary: "OpenClaw 가 타이핑 표시기를 표시하는 경우와 이를 조정하는 방법"
read_when:
  - 타이핑 표시기 동작 또는 기본값을 변경할 때
title: "타이핑 표시기"
---

# 타이핑 표시기

타이핑 표시기는 실행이 활성 상태일 때 채팅 채널로 전송됩니다. `agents.defaults.typingMode` 를 사용해 타이핑이 **언제** 시작되는지 제어하고, `typingIntervalSeconds` 을 사용해 **얼마나 자주** 새로 고침되는지 제어합니다.

## 기본값

`agents.defaults.typingMode` 가 **설정되지 않으면**, OpenClaw 는 레거시 동작을 유지합니다:

- **다이렉트 메시지**: 모델 루프가 시작되면 즉시 타이핑이 시작됩니다.
- **멘션이 있는 그룹 채팅**: 즉시 타이핑이 시작됩니다.
- **멘션이 없는 그룹 채팅**: 메시지 텍스트 스트리밍이 시작될 때만 타이핑이 시작됩니다.
- **하트비트 실행**: 타이핑이 비활성화됩니다.

## 모드

`agents.defaults.typingMode` 를 다음 중 하나로 설정합니다:

- `never` — 타이핑 표시기를 절대 표시하지 않습니다.
- `instant` — 실행이 나중에 무음 응답 토큰만 반환하더라도 **모델 루프가 시작되는 즉시** 타이핑을 시작합니다.
- `thinking` — **첫 번째 추론 델타**에서 타이핑을 시작합니다(해당 실행에 `reasoningLevel: "stream"` 가 필요).
- `message` — **첫 번째 비-무음 텍스트 델타**에서 타이핑을 시작합니다(`NO_REPLY` 무음 토큰을 무시).

“얼마나 이르게 발동하는지”의 순서:
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

세션별로 모드나 주기를 재정의할 수 있습니다:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## 참고

- `message` 모드는 무음 전용 응답(예: 출력 억제를 위해 사용되는 `NO_REPLY` 토큰)에 대해 타이핑을 표시하지 않습니다.
- `thinking` 는 실행이 추론을 스트리밍할 때만(`reasoningLevel: "stream"`) 발동합니다.
  모델이 추론 델타를 방출하지 않으면 타이핑은 시작되지 않습니다.
- 하트비트는 모드와 관계없이 타이핑을 표시하지 않습니다.
- `typingIntervalSeconds` 는 시작 시간이 아니라 **새로 고침 주기**를 제어합니다.
  기본값은 6초입니다.
