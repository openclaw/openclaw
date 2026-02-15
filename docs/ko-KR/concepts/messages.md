---
summary: "Message flow, sessions, queueing, and reasoning visibility"
read_when:
  - Explaining how inbound messages become replies
  - Clarifying sessions, queueing modes, or streaming behavior
  - Documenting reasoning visibility and usage implications
title: "Messages"
x-i18n:
  source_hash: 773301d5c0c1e3b87d1b7ba6d670400cb8ab65d35943f6d54647490e377c369a
---

# 메시지

이 페이지는 OpenClaw가 인바운드 메시지, 세션, 큐잉,
스트리밍 및 추론 가시성.

## 메시지 흐름(상위 수준)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

주요 손잡이는 구성에 포함됩니다.

- 접두사, 대기열 및 그룹 동작에 대한 `messages.*`.
- 블록 스트리밍 및 청크 기본값의 경우 `agents.defaults.*`입니다.
- 캡 및 스트리밍 토글에 대한 채널 재정의(`channels.whatsapp.*`, `channels.telegram.*` 등).

전체 스키마는 [구성](/gateway/configuration)을 참조하세요.

## 인바운드 중복 제거

채널은 다시 연결된 후 동일한 메시지를 다시 전달할 수 있습니다. OpenClaw는
채널/계정/피어/세션/메시지 ID로 키가 지정된 단기 캐시이므로 중복됩니다.
전달은 다른 에이전트 실행을 트리거하지 않습니다.

## 인바운드 디바운싱

**동일한 발신자**가 보낸 빠른 연속 메시지를 하나의 메시지로 일괄 처리할 수 있습니다.
에이전트는 `messages.inbound`를 통해 차례를 취합니다. 디바운싱은 채널 + 대화별로 범위가 지정됩니다.
응답 스레딩/ID에 가장 최근 메시지를 사용합니다.

구성(전역 기본값 + 채널별 재정의):

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

참고:

- 디바운스는 **텍스트 전용** 메시지에 적용됩니다. 미디어/첨부 파일은 즉시 플러시됩니다.
- 제어 명령은 디바운싱을 우회하여 독립형으로 유지됩니다.

## 세션 및 장치

세션은 클라이언트가 아닌 게이트웨이가 소유합니다.

- 직접 채팅은 상담원 기본 세션 키로 축소됩니다.
- 그룹/채널은 자체 세션 키를 갖습니다.
- 세션 저장소와 기록은 게이트웨이 호스트에 있습니다.

여러 장치/채널이 동일한 세션에 매핑될 수 있지만 기록이 완전하지 않습니다.
모든 클라이언트에 다시 동기화됩니다. 권장 사항: 오랫동안 하나의 기본 장치를 사용하십시오.
다양한 맥락을 피하기 위한 대화. Control UI 및 TUI에는 항상
게이트웨이 지원 세션 기록이므로 이것이 진실의 원천입니다.

세부정보: [세션 관리](/concepts/session).

## 인바운드 본문 및 기록 컨텍스트

OpenClaw는 **프롬프트 본문**을 **명령 본문**에서 분리합니다.

- `Body` : 에이전트에게 전송되는 프롬프트 텍스트입니다. 여기에는 채널 엔벨로프와
  선택적 히스토리 래퍼.
- `CommandBody`: 지시문/명령 구문 분석을 위한 원시 사용자 텍스트입니다.
- `RawBody`: `CommandBody`의 레거시 별칭(호환성을 위해 유지됨).

채널이 기록을 제공할 때 공유 래퍼를 사용합니다.

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

**비직접 채팅**(그룹/채널/방)의 경우 **현재 메시지 본문** 앞에
발신자 라벨(기록 항목에 사용되는 것과 동일한 스타일) 실시간 및 대기/기록을 유지합니다.
에이전트 프롬프트에 일관된 메시지가 표시됩니다.

기록 버퍼는 **보류 전용**입니다. 여기에는 _않은_ 그룹 메시지가 포함됩니다.
실행(예: 멘션 제한 메시지) 및 **제외** 메시지 트리거
이미 세션 기록에 있습니다.

지시문 제거는 **현재 메시지** 섹션에만 적용되므로 기록
그대로 남아있습니다. 히스토리를 래핑하는 채널은 `CommandBody`(또는
`RawBody`)를 원본 메시지 텍스트로 변경하고 `Body`를 결합 프롬프트로 유지합니다.
히스토리 버퍼는 `messages.groupChat.historyLimit`를 통해 구성할 수 있습니다(글로벌
기본값) 및 `channels.slack.historyLimit`와 같은 채널별 재정의 또는
`channels.telegram.accounts.<id>.historyLimit` (`0`를 비활성화하도록 설정)

## 대기열 및 후속 조치

실행이 이미 활성화된 경우 인바운드 메시지를 대기열에 추가하여
현재 실행되거나 후속 턴을 위해 수집됩니다.

- `messages.queue`(및 `messages.queue.byChannel`)을 통해 구성합니다.
- 모드: `interrupt`, `steer`, `followup`, `collect` 및 백로그 변형.

세부정보: [대기열](/concepts/queue).

## 스트리밍, 청크 및 일괄 처리

블록 스트리밍은 모델이 텍스트 블록을 생성할 때 부분 응답을 보냅니다.
청킹은 채널 텍스트 제한을 존중하고 분리된 코드 분할을 방지합니다.

주요 설정:

- `agents.defaults.blockStreamingDefault` (`on|off`, 기본값은 꺼짐)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (유휴 기반 일괄 처리)
- `agents.defaults.humanDelay` (사람처럼 차단 응답 사이에 일시 중지)
- 채널 재정의: `*.blockStreaming` 및 `*.blockStreamingCoalesce` (텔레그램이 아닌 채널에는 명시적인 `*.blockStreaming: true`가 필요함)

세부정보: [스트리밍 + 청킹](/concepts/streaming).

## 가시성 및 토큰 추론

OpenClaw는 모델 추론을 노출하거나 숨길 수 있습니다.

- `/reasoning on|off|stream`는 가시성을 제어합니다.
- 추론 콘텐츠는 모델이 생성할 때 여전히 토큰 사용량에 포함됩니다.
- 텔레그램은 드래프트 버블에 대한 추론 스트림을 지원합니다.

세부정보: [사고 + 추론 지시어](/tools/thinking) 및 [토큰 사용](/reference/token-use).

## 접두사, 스레딩 및 응답

아웃바운드 메시지 형식은 `messages`에 집중되어 있습니다.

- `messages.responsePrefix`, `channels.<channel>.responsePrefix` 및 `channels.<channel>.accounts.<id>.responsePrefix`(아웃바운드 접두사 계단식) 및 `channels.whatsapp.messagePrefix`(WhatsApp 인바운드 접두사)
- `replyToMode` 및 채널별 기본값을 통한 응답 스레딩

세부정보: [구성](/gateway/configuration#messages) 및 채널 문서.
