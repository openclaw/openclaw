---
summary: "메시지 흐름, 세션, 대기열, 추론 가시성"
read_when:
  - 수신 메시지가 다시 응답이 되는 방법 설명
  - 세션, 대기열 모드, 스트리밍 동작 명확히 하기
  - 추론 가시성과 사용 영향 문서화
title: "메시지"
---

# 메시지

이 페이지는 OpenClaw가 수신 메시지, 세션, 대기열, 스트리밍, 추론 가시성을 어떻게 처리하는지 묶어 설명합니다.

## 메시지 흐름 (고수준)

```
수신 메시지
  -> 라우팅/바인딩 -> 세션 키
  -> 대기열 (실행 중인 경우)
  -> 에이전트 실행 (스트리밍 + 도구)
  -> 발신 응답 (채널 제한 + 청킹)
```

설정의 주요 요소:

- 접두사, 대기열, 그룹 동작을 위한 `messages.*`.
- 블록 스트리밍과 청킹의 기본값을 위한 `agents.defaults.*`.
- 최대값과 스트리밍 전환을 위한 채널 재정의 (`channels.whatsapp.*`, `channels.telegram.*` 등).

전체 스키마는 [구성](/ko-KR/gateway/configuration)을 참조하세요.

## 수신 중복 제거 (Inbound dedupe)

채널은 재연결 후 동일한 메시지를 다시 전달할 수 있습니다. OpenClaw는 채널/계정/피어/세션/메시지 ID로 키를 지정한 단기 캐시를 유지하여 중복 전달이 또 다른 에이전트 실행을 트리거하지 않도록 합니다.

## 수신 디바운스 (Inbound debouncing)

**동일한 발신자**로부터 연속적으로 빠르게 오는 메시지는 `messages.inbound`를 통해 단일 에이전트 차례로 묶일 수 있습니다. 디바운싱은 채널 + 대화 별로 범위가 지정되며 응답 스레딩/ID에 가장 최근의 메시지를 사용합니다.

설정 (글로벌 기본값 + 채널 별 재정의):

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

메모:

- 디바운스는 **텍스트만** 메시지에 적용됩니다; 미디어/첨부파일은 즉시 플러시됩니다.
- 제어 명령은 디바운싱을 우회하여 독립적으로 유지됩니다.

## 세션과 디바이스

세션은 게이트웨이 소유이며, 클라이언트 소유가 아닙니다.

- 직접 채팅은 에이전트의 주요 세션 키로 병합됩니다.
- 그룹/채널은 자체 세션 키를 가집니다.
- 세션 저장소와 기록은 게이트웨이 호스트에 저장됩니다.

여러 디바이스/채널이 동일한 세션에 매핑될 수 있지만, 이 기록은 모든 클라이언트에 완전히 동기화되지 않습니다. 권장 사항: 긴 대화를 위해 하나의 주요 디바이스를 사용하여 문맥의 분기를 방지하세요. 제어 UI와 TUI는 항상 게이트웨이 지원 세션 기록을 보여주므로, 이는 기준 정보가 됩니다.

세부사항: [세션 관리](/ko-KR/concepts/session).

## 수신 본문과 기록 컨텍스트

OpenClaw는 **프롬프트 본문**을 **명령 본문**과 분리합니다:

- `Body`: 에이전트에게 전송된 프롬프트 텍스트. 이는 채널 봉투와 선택적 기록 래퍼를 포함할 수 있습니다.
- `CommandBody`: 지시문/명령 파싱을 위한 원본 사용자 텍스트.
- `RawBody`: `CommandBody`의 레거시 별칭 (호환성을 위해 유지).

채널이 기록을 제공할 때, 공유 래퍼를 사용합니다:

- `[마지막 응답 이후 채팅 메시지 - 컨텍스트용]`
- `[현재 메시지 - 이것에 응답]`

**비-직접 채팅** (그룹/채널/룸)의 경우, **현재 메시지 본문**은 발신자 레이블로 접두사가 붙으며 (기록 항목에 사용되는 동일한 스타일), 이는 실시간 및 대기열/기록 메시지를 에이전트 프롬프트에서 일관되게 유지합니다.

기록 버퍼는 **대기 중**입니다: 이는 실행을 트리거하지 **않은** 그룹 메시지를 포함하고 (예: 언급 제한적 메시지), 세션 기록에 이미 포함된 메시지를 **제외**합니다.

지시문 제거는 **현재 메시지** 섹션에만 적용되므로, 기록은 원형을 유지합니다. 기록을 포함하는 채널은 `CommandBody` (또는 `RawBody`)를 원본 메시지 텍스트로 설정하고 `Body`를 결합된 프롬프트로 유지해야 합니다. 기록 버퍼는 `messages.groupChat.historyLimit` (글로벌 기본값) 및 `channels.slack.historyLimit` 또는 `channels.telegram.accounts.<id>.historyLimit`과 같은 채널 별 재정의를 통해 구성할 수 있습니다 (`0`으로 설정하여 비활성화 가능).

## 대기열 및 후속 처리

실행이 이미 활성 상태인 경우, 수신 메시지는 대기열에 놓이거나, 현재 실행으로 조정되거나, 후속 차례로 수집될 수 있습니다.

- `messages.queue` (및 `messages.queue.byChannel`)를 통해 구성합니다.
- 모드: `interrupt`, `steer`, `followup`, `collect`, 여기에 백로그 변형 추가.

세부사항: [대기열](/ko-KR/concepts/queue).

## 스트리밍, 청킹, 배칭

블록 스트리밍은 모델이 텍스트 블록을 생성할 때 부분적 응답을 전송합니다. 청킹은 채널의 텍스트 제한을 준수하고 울타리 코드 분할을 방지합니다.

주요 설정:

- `agents.defaults.blockStreamingDefault` (`on|off`, 기본값은 off)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (유휴 기반 배칭)
- `agents.defaults.humanDelay` (블록 응답 사이의 인간과 같은 휴지)
- 채널 재정의: `*.blockStreaming`과 `*.blockStreamingCoalesce` (Telegram 이외의 채널은 명시적으로 `*.blockStreaming: true` 설정이 필요)

세부사항: [스트리밍 + 청킹](/ko-KR/concepts/streaming).

## 추론 가시성과 토큰

OpenClaw는 모델의 추론을 노출하거나 숨길 수 있습니다:

- `/reasoning on|off|stream`은 가시성을 제어합니다.
- 추론 콘텐츠는 모델이 생성할 때 여전히 토큰 사용량에 포함됩니다.
- Telegram은 추론 스트림을 초안 버블에 지원합니다.

자세한 내용: [사고 + 추론 지시문](/ko-KR/tools/thinking) 및 [토큰 사용](/ko-KR/reference/token-use).

## 접두사, 스레딩, 응답

발신 메시지 포맷팅은 `messages`에 중앙 집중화되어 있습니다:

- `messages.responsePrefix`, `channels.<channel>.responsePrefix`, 및 `channels.<channel>.accounts.<id>.responsePrefix` (발신 접두사 계단), `channels.whatsapp.messagePrefix` (WhatsApp 수신 접두사)
- `replyToMode` 및 채널 별 기본값을 통한 응답 스레딩

자세한 내용: [구성](/ko-KR/gateway/configuration#messages) 및 채널 문서.