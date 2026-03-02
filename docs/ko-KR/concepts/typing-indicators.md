---
summary: "OpenClaw가 typing indicators를 표시할 때 및 이를 튜닝하는 방법"
read_when:
  - Typing indicator 동작 또는 기본값을 변경할 때
title: "Typing Indicators"
---

# Typing Indicators

Typing indicators는 실행이 활성화되는 동안 chat 채널로 전송됩니다. `agents.defaults.typingMode`를 사용하여 **언제** typing이 시작되는지를 제어하고 `typingIntervalSeconds`를 사용하여 **얼마나 자주** 새로고쳐지는지를 제어합니다.

## 기본값

`agents.defaults.typingMode`가 **설정되지 않은** 경우, OpenClaw는 legacy 동작을 유지합니다:

- **Direct chats**: 모델 루프가 시작되면 typing이 즉시 시작됩니다.
- **Mention이 있는 Group chats**: typing이 즉시 시작됩니다.
- **Mention이 없는 Group chats**: typing은 message 텍스트가 스트리밍을 시작할 때만 시작됩니다.
- **Heartbeat runs**: typing이 비활성화됩니다.

## 모드

`agents.defaults.typingMode`를 다음 중 하나로 설정합니다:

- `never` — typing indicator를 절대 표시하지 않습니다.
- `instant` — 모델 루프가 시작되자마자 typing을 **시작합니다**, 실행이 나중에 silent reply token만 반환하더라도.
- `thinking` — **첫 reasoning delta**에서 typing을 시작합니다 (실행을 위해 `reasoningLevel: "stream"`이 필요함).
- `message` — **첫 non-silent 텍스트 delta**에서 typing을 시작합니다 (`NO_REPLY` silent token을 무시함).

"얼마나 빨리 작동하는지"의 순서:
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

당신은 per-session 모드 또는 cadence를 재정의할 수 있습니다:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## 노트

- `message` 모드는 silent-only 응답에 대해 typing을 표시하지 않습니다 (예: `NO_REPLY` silent-only replies).
- `thinking`은 실행이 reasoning을 스트리밍할 때만 작동합니다 (`reasoningLevel: "stream"`).
  모델이 reasoning deltas를 내보내지 않으면 typing이 시작되지 않습니다.
- Heartbeats는 mode와 관계없이 절대 typing을 표시하지 않습니다.
- `typingIntervalSeconds`는 **refresh cadence**를 제어합니다, start time이 아닙니다.
  기본값은 6초입니다.
