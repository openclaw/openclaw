---
summary: "Inbound auto-reply runs을 직렬화하는 명령 큐 디자인"
read_when:
  - Auto-reply execution 또는 동시성을 변경할 때
title: "명령 큐"
---

# 명령 큐 (2026-01-16)

우리는 여러 에이전트 실행이 충돌하지 않도록 하면서 여전히 sessions 간 safe parallelism을 허용하기 위해 작은 in-process 큐를 통해 inbound auto-reply runs를 직렬화합니다.

## 왜

- Auto-reply runs은 비쌀 수 있고 (LLM 호출) 여러 inbound 메시지가 close together에 도착할 때 충돌할 수 있습니다.
- 직렬화는 shared resources (session files, logs, CLI stdin)에 대한 경쟁을 피하고 upstream rate limits의 가능성을 줄입니다.

## 어떻게 작동하는가

- Lane-aware FIFO 큐는 configurable concurrency cap을 갖는 각 lane을 drain합니다 (unconfigured lanes의 default 1; main defaults to 4, subagent to 8).
- `runEmbeddedPiAgent`는 **session key** (lane `session:<key>`)에 의해 enqueue하여 오직 한 active run per session을 보장합니다.
- 각 세션 실행은 그 다음 **global lane** (`main` by default)으로 enqueue되어 overall parallelism이 `agents.defaults.maxConcurrent`에 의해 cap됩니다.
- Verbose logging이 활성화되는 경우, queued runs는 시작 전에 ~2s보다 오래 대기했으면 short notice를 emit합니다.
- Typing indicators는 여전히 enqueue에서 즉시 작동합니다 (채널에서 지원하는 경우) 따라서 user experience는 우리가 우리 차례를 기다리는 동안 변경되지 않습니다.

## 큐 모드 (per channel)

Inbound 메시지는 현재 실행을 조향하거나, followup turn을 기다리거나, 둘 다 할 수 있습니다:

- `steer`: 현재 실행에 즉시 inject합니다 (다음 tool boundary 후 pending tool 호출을 취소함). 스트리밍하지 않으면 followup으로 fallback합니다.
- `followup`: 현재 실행이 끝난 후 다음 에이전트 turn을 위해 enqueue합니다.
- `collect`: 모든 queued 메시지를 **single** followup turn으로 coalesce합니다 (default). 메시지가 다른 channels/threads를 target하면 라우팅을 preserve하기 위해 개별적으로 drain합니다.
- `steer-backlog` (aka `steer+backlog`): now를 steer **및** followup turn을 위한 메시지를 preserve합니다.
- `interrupt` (legacy): 그 세션에 대한 활성 실행을 abort한 다음 newest 메시지를 실행합니다.
- `queue` (legacy alias): `steer`와 같습니다.

Steer-backlog는 steered run 후 followup 응답을 얻을 수 있다는 의미이므로, streaming surfaces는 duplicates처럼 보일 수 있습니다. 한 응답 per inbound 메시지를 원하면 `collect`/`steer`를 선호합니다.
Standalone 명령으로 `/queue collect`를 send하십시오 (per-session) 또는 `messages.queue.byChannel.discord: "collect"`를 설정하십시오.

기본값 (unset일 때):

- 모든 surfaces → `collect`

Globally 또는 per channel을 통해 `messages.queue` via 설정합니다:

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

옵션은 `followup`, `collect`, 및 `steer-backlog`에 적용됩니다 (및 fallback to followup할 때 `steer`):

- `debounceMs`: followup turn을 시작하기 전에 quiet을 기다립니다 ("continue, continue" 방지).
- `cap`: per session max queued 메시지.
- `drop`: overflow 정책 (`old`, `new`, `summarize`).

Summarize는 dropped 메시지의 short bullet list를 유지하고 synthetic followup 프롬프트로 inject합니다.
기본값: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Per-session overrides

- Standalone 명령으로 `/queue <mode>`를 send하여 current 세션에 대한 모드를 저장합니다.
- 옵션은 combined될 수 있습니다: `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` 또는 `/queue reset`은 세션 override를 clears합니다.

## 범위 및 보장

- 모든 inbound channels에서 auto-reply 에이전트 runs에 적용되며 gateway reply pipeline를 사용합니다 (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat, 등).
- 기본 lane (`main`)은 inbound + main heartbeats에 대해 process-wide입니다; 여러 세션이 parallel에서 실행되도록 하려면 `agents.defaults.maxConcurrent`를 설정합니다.
- 추가 lanes이 존재할 수 있습니다 (예: `cron`, `subagent`) 따라서 background 작업들은 inbound replies를 block하지 않고 parallel에서 실행할 수 있습니다.
- Per-session lanes는 오직 한 에이전트 실행이 주어진 세션을 건드린다는 것을 보장합니다.
- No external dependencies 또는 background worker 스레드; pure TypeScript + promises.

## 문제 해결

- 명령이 stuck된 것 같으면 verbose logs를 활성화하고 "queued for …ms" 라인을 찾아 큐가 draining하는 것을 확인합니다.
- 큐 깊이가 필요하면 verbose logs를 활성화하고 큐 timing lines를 보세요.
