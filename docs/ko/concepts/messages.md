---
summary: "메시지 흐름, 세션, 큐잉, 그리고 추론 가시성"
read_when:
  - 수신 메시지가 어떻게 응답으로 변환되는지 설명할 때
  - 세션, 큐잉 모드, 또는 스트리밍 동작을 명확히 할 때
  - 추론 가시성과 사용상의 영향을 문서화할 때
title: "메시지"
---

# 메시지

이 페이지는 OpenClaw 가 수신 메시지, 세션, 큐잉,
스트리밍, 그리고 추론 가시성을 어떻게 처리하는지를 종합적으로 설명합니다.

## 메시지 흐름 (개요)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

주요 설정은 구성에 있습니다:

- 접두사, 큐잉, 그룹 동작을 위한 `messages.*`.
- 블록 스트리밍과 청킹 기본값을 위한 `agents.defaults.*`.
- 캡과 스트리밍 토글을 위한 채널 오버라이드(`channels.whatsapp.*`, `channels.telegram.*` 등). 제한값과 스트리밍 토글을 위한 것입니다.

전체 스키마는 [Configuration](/gateway/configuration)을 참고하십시오.

## 인바운드 중복 제거

채널은 재연결 이후 동일한 메시지를 재전송할 수 있습니다. OpenClaw 는
채널/계정/피어/세션/메시지 ID 로 키된 단기 캐시를 유지하여 중복 전달이
다시 에이전트를 실행하지 않도록 합니다.

## 인바운드 디바운싱

**동일 발신자**로부터의 빠른 연속 메시지는 `messages.inbound` 를 통해 단일
에이전트 턴으로 배치될 수 있습니다. 디바운싱은 채널 + 대화 단위로 범위가
지정되며, 응답 스레딩/ID 를 위해 가장 최근 메시지를 사용합니다.

구성(전역 기본값 + 채널별 오버라이드):

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

참고 사항:

- 디바운스는 **텍스트 전용** 메시지에 적용됩니다. 미디어/첨부 파일은 즉시 플러시됩니다.
- 제어 명령은 디바운싱을 우회하여 단독으로 유지됩니다.

## 세션과 디바이스

세션은 클라이언트가 아니라 게이트웨이가 소유합니다.

- 다이렉트 채팅은 에이전트 메인 세션 키로 통합됩니다.
- 그룹/채널은 각각 고유한 세션 키를 가집니다.
- 세션 저장소와 트랜스크립트는 게이트웨이 호스트에 위치합니다.

여러 디바이스/채널이 동일한 세션에 매핑될 수 있지만, 기록은 모든 클라이언트로
완전히 동기화되지 않습니다. 권장 사항: 컨텍스트 분기를 피하기 위해 장시간
대화에는 하나의 기본 디바이스를 사용하십시오. Control UI 와 TUI 는 항상
게이트웨이 기반 세션 트랜스크립트를 표시하므로, 이것이 단일 진실 소스입니다.

자세한 내용: [Session management](/concepts/session).

## 인바운드 본문 및 히스토리 컨텍스트

OpenClaw 는 **프롬프트 본문**과 **명령 본문**을 분리합니다:

- `Body`: 에이전트로 전송되는 프롬프트 텍스트. 채널 엔벨로프와
  선택적 히스토리 래퍼를 포함할 수 있습니다.
- `CommandBody`: 지시어/명령 파싱을 위한 원시 사용자 텍스트.
- `RawBody`: `CommandBody` 의 레거시 별칭(호환성 유지 목적).

채널이 히스토리를 제공할 때는 공유 래퍼를 사용합니다:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

**비 다이렉트 채팅**(그룹/채널/룸)의 경우, **현재 메시지 본문** 앞에
발신자 라벨이 접두됩니다(히스토리 항목에 사용되는 것과 동일한 스타일). 이는 실시간 메시지와 큐잉/히스토리 메시지를 에이전트 프롬프트에서
일관되게 유지합니다.

히스토리 버퍼는 **보류 전용**입니다. 즉, 실행을 트리거하지 않은 그룹 메시지
(예: 멘션 게이트 메시지)를 포함하고, 이미 세션 트랜스크립트에 있는 메시지는
**제외**합니다.

지시어 스트리핑은 **현재 메시지** 섹션에만 적용되어 히스토리는 보존됩니다. 히스토리를 래핑하는 채널은 원본 메시지 텍스트로 `CommandBody`(또는
`RawBody`)를 설정하고, 결합된 프롬프트로 `Body` 를 유지해야 합니다.
히스토리 버퍼는 `messages.groupChat.historyLimit`(전역 기본값)과 `channels.slack.historyLimit` 또는
`channels.telegram.accounts.<id>.historyLimit` 같은 채널별 오버라이드로 구성할 수 있습니다
(비활성화하려면 `0` 를 설정).

## 큐잉 및 후속 처리

이미 실행이 활성 상태인 경우, 수신 메시지는 큐에 적재되거나 현재 실행으로
유도되거나 후속 턴을 위해 수집될 수 있습니다.

- `messages.queue`(및 `messages.queue.byChannel`)로 구성합니다.
- 모드: `interrupt`, `steer`, `followup`, `collect`,
  그리고 백로그 변형.

자세한 내용: [Queueing](/concepts/queue).

## 스트리밍, 청킹, 배칭

블록 스트리밍은 모델이 텍스트 블록을 생성하는 즉시 부분 응답을 전송합니다.
청킹은 채널의 텍스트 제한을 준수하며 펜스 코드 분할을 피합니다.

주요 설정:

- `agents.defaults.blockStreamingDefault` (`on|off`, 기본값 꺼짐)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (유휴 기반 배칭)
- `agents.defaults.humanDelay` (블록 응답 사이의 사람 같은 일시 정지)
- 채널 오버라이드: `*.blockStreaming` 및 `*.blockStreamingCoalesce` (Telegram 이 아닌 채널은 명시적 `*.blockStreaming: true` 가 필요)

자세한 내용: [Streaming + chunking](/concepts/streaming).

## 추론 가시성과 토큰

OpenClaw 는 모델 추론을 노출하거나 숨길 수 있습니다:

- `/reasoning on|off|stream` 가 가시성을 제어합니다.
- 모델이 생성한 경우, 추론 콘텐츠는 여전히 토큰 사용량에 포함됩니다.
- Telegram 은 드래프트 버블로의 추론 스트림을 지원합니다.

자세한 내용: [Thinking + reasoning directives](/tools/thinking) 및 [Token use](/reference/token-use).

## 접두사, 스레딩, 그리고 응답

아웃바운드 메시지 포매팅은 `messages` 에서 중앙 관리됩니다:

- `messages.responsePrefix`, `channels.<channel>.responsePrefix`, 그리고 `channels.<channel>.accounts.<id>.responsePrefix`(아웃바운드 접두사 캐스케이드), 추가로 `channels.whatsapp.messagePrefix`(WhatsApp 인바운드 접두사)
- `replyToMode` 및 채널별 기본값을 통한 응답 스레딩

자세한 내용: [Configuration](/gateway/configuration#messages) 및 채널 문서를 참고하십시오.
