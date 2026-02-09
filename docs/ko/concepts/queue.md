---
summary: "인바운드 자동 응답 실행을 직렬화하는 명령 큐 설계"
read_when:
  - 자동 응답 실행 또는 동시성을 변경할 때
title: "명령 큐"
---

# 명령 큐 (2026-01-16)

여러 에이전트 실행이 서로 충돌하는 것을 방지하면서도 세션 간 안전한 병렬성을 허용하기 위해, 모든 채널의 인바운드 자동 응답 실행을 작은 인프로세스 큐를 통해 직렬화합니다.

## 이유

- 자동 응답 실행은 비용이 클 수 있으며(LLM 호출), 여러 인바운드 메시지가 짧은 시간 간격으로 도착하면 충돌할 수 있습니다.
- 직렬화는 공유 리소스(세션 파일, 로그, CLI stdin)에 대한 경쟁을 피하고 상위 서비스의 레이트 리밋에 걸릴 가능성을 줄입니다.

## 작동 방식

- 레인 인식 FIFO 큐가 각 레인을 구성 가능한 동시성 상한으로 소진합니다(구성되지 않은 레인의 기본값은 1, main 은 기본값 4, subagent 는 8).
- `runEmbeddedPiAgent` 은 **세션 키**(레인 `session:<key>`) 기준으로 큐에 넣어 세션당 하나의 활성 실행만 보장합니다.
- 각 세션 실행은 이후 **글로벌 레인**(기본값 `main`)에 큐잉되어 전체 병렬성이 `agents.defaults.maxConcurrent` 로 제한됩니다.
- 상세 로깅이 활성화되면, 시작 전에 약 2초 이상 대기한 큐잉된 실행은 짧은 알림을 출력합니다.
- 타이핑 인디케이터는 큐에 넣는 즉시(채널에서 지원하는 경우) 여전히 발동하므로, 순서를 기다리는 동안에도 사용자 경험은 변하지 않습니다.

## 큐 모드 (채널별)

인바운드 메시지는 현재 실행을 조향하거나, 다음 턴을 기다리거나, 또는 둘 다 수행할 수 있습니다.

- `steer`: 현재 실행에 즉시 주입합니다(다음 도구 경계 이후 대기 중인 도구 호출을 취소). 스트리밍이 아닌 경우 followup 으로 폴백됩니다.
- `followup`: 현재 실행이 끝난 후 다음 에이전트 턴을 위해 큐에 넣습니다.
- `collect`: 큐에 쌓인 모든 메시지를 **단일** followup 턴으로 병합합니다(기본값). 메시지가 서로 다른 채널/스레드를 대상으로 하는 경우, 라우팅을 보존하기 위해 개별적으로 소진됩니다.
- `steer-backlog` (일명 `steer+backlog`): 지금 조향하고 **동시에** followup 턴을 위해 메시지를 보존합니다.
- `interrupt` (레거시): 해당 세션의 활성 실행을 중단한 다음, 최신 메시지를 실행합니다.
- `queue` (레거시 별칭): `steer` 와 동일합니다.

Steer-backlog 는 조향된 실행 이후 followup 응답을 받을 수 있음을 의미하므로,
스트리밍 표면에서는 중복처럼 보일 수 있습니다. 인바운드 메시지당
하나의 응답을 원한다면 `collect`/`steer` 를 선호하십시오.
`/queue collect` 를 독립 실행 명령(세션별)으로 보내거나 `messages.queue.byChannel.discord: "collect"` 를 설정하십시오.

기본값(구성에서 설정되지 않은 경우):

- 모든 표면 → `collect`

`messages.queue` 를 통해 전역 또는 채널별로 구성합니다.

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## 큐 옵션

옵션은 `followup`, `collect`, `steer-backlog` 에 적용되며(`steer` 가 followup 으로 폴백될 때도 적용됨):

- `debounceMs`: followup 턴을 시작하기 전에 잠잠해질 때까지 대기합니다(“계속, 계속” 방지).
- `cap`: 세션당 최대 큐잉 메시지 수.
- `drop`: 오버플로 정책(`old`, `new`, `summarize`).

Summarize 는 드롭된 메시지의 짧은 불릿 목록을 유지하고 이를 합성 followup 프롬프트로 주입합니다.
기본값: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## 세션별 오버라이드

- `/queue <mode>` 를 독립 실행 명령으로 보내 현재 세션에 대한 모드를 저장합니다.
- 옵션은 결합할 수 있습니다: `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` 또는 `/queue reset` 는 세션 오버라이드를 해제합니다.

## 범위 및 보장 사항

- Gateway(게이트웨이) 응답 파이프라인을 사용하는 모든 인바운드 채널(WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat 등)의 자동 응답 에이전트 실행에 적용됩니다.
- 기본 레인(`main`)은 인바운드 + main 하트비트에 대해 프로세스 전역이며, 여러 세션을 병렬로 허용하려면 `agents.defaults.maxConcurrent` 를 설정하십시오.
- 추가 레인(예: `cron`, `subagent`)이 존재할 수 있으므로, 백그라운드 작업이 인바운드 응답을 막지 않고 병렬로 실행될 수 있습니다.
- 세션별 레인은 특정 세션을 한 번에 하나의 에이전트 실행만 접근하도록 보장합니다.
- 외부 의존성이나 백그라운드 워커 스레드가 없으며, 순수 TypeScript + promises 로 구현됩니다.

## 문제 해결

- 명령이 멈춘 것처럼 보이면 상세 로그를 활성화하고 “queued for …ms” 라인을 찾아 큐가 소진되고 있는지 확인하십시오.
- 큐 깊이가 필요하다면 상세 로그를 활성화하고 큐 타이밍 라인을 확인하십시오.
