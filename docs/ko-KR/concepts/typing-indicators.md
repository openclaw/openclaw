````markdown
---
summary: "OpenClaw에서 입력 중임을 나타내는 지표를 표시하는 시점과 이를 조정하는 방법"
read_when:
  - 입력 지표 동작 또는 기본값 변경
title: "입력 지표"
---

# 입력 지표

입력 지표는 실행이 활성 상태일 때 채팅 채널로 전송됩니다. `agents.defaults.typingMode`를 사용하여 입력이 시작되는 **시점**을 제어하고 `typingIntervalSeconds`를 사용하여 **갱신 빈도**를 제어합니다.

## 기본값

`agents.defaults.typingMode`가 **설정되지 않으면**, OpenClaw는 기존 동작을 유지합니다:

- **다이렉트 채팅**: 모델 루프가 시작되면 즉시 입력 시작.
- **멘션이 있는 그룹 채팅**: 즉시 입력 시작.
- **멘션이 없는 그룹 채팅**: 메시지 텍스트 스트리밍이 시작될 때만 입력 시작.
- **하트비트 실행**: 입력 비활성화.

## 모드

`agents.defaults.typingMode`를 다음 중 하나로 설정하십시오:

- `never` — 입력 지표가 전혀 표시되지 않음.
- `instant` — 모델 루프가 시작되면 **즉시 입력 시작** (실행 후 깜짝 응답 전용 토큰이 반환되더라도).
- `thinking` — **첫 번째 추론 델타**에서 입력 시작 (`reasoningLevel: "stream"` 필요).
- `message` — **첫 번째 비침묵 텍스트 델타**에서 입력 시작 (`NO_REPLY` 깜짝 토큰 무시).

"얼마나 빨리 시작하는가"의 순서:
`never` → `message` → `thinking` → `instant`

## 설정

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```
````

각 세션별로 모드나 주기를 재정의할 수 있습니다:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## 주의사항

- `message` 모드는 깜짝 응답 전용일 경우 입력을 표시하지 않습니다 (예: 출력 억제에 사용되는 `NO_REPLY` 토큰).
- `thinking`은 실행이 추론을 스트리밍할 경우에만 시작합니다 (`reasoningLevel: "stream"`). 모델이 추론 델타를 방출하지 않으면 입력이 시작되지 않습니다.
- 하트비트에서는 모드와 관계없이 입력이 표시되지 않습니다.
- `typingIntervalSeconds`는 **갱신 주기**를 제어하며, 시작 시간을 제어하지는 않습니다. 기본값은 6초입니다.

```

```
