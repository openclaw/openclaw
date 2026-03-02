---
summary: "메시지 흐름, 세션, 큐잉, 추론 가시성"
read_when:
  - 인바운드 메시지가 응답으로 변하는 방식 설명
  - 세션, 큐잉 모드 또는 스트리밍 동작 명확화
  - 추론 가시성과 사용 의미 설명
title: "메시지"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: concepts/messages.md
  workflow: 15
---

# 메시지

이 페이지는 OpenClaw이 인바운드 메시지, 세션, 큐잉, 스트리밍 및 추론 가시성을 처리하는 방식을 함께 연결합니다.

## 메시지 흐름 (높은 수준)

```
인바운드 메시지
  -> 라우팅/바인딩 -> 세션 키
  -> 큐 (실행 중인 경우)
  -> 에이전트 실행 (스트리밍 + 도구)
  -> 아웃바운드 응답 (채널 제한 + 청킹)
```

핵심 제어 기능은 구성에 있습니다:

- `messages.*`는 접두사, 큐잉 및 그룹 동작을 위한 것입니다.
- `agents.defaults.*`는 블록 스트리밍 및 청킹 기본값을 위한 것입니다.
- 채널 재정의 (`channels.whatsapp.*`, `channels.telegram.*` 등)는 제한 및 스트리밍 토글을 위한 것입니다.

[구성](/gateway/configuration)을 참조하세요.

## 인바운드 중복 제거

채널은 재연결 후 동일한 메시지를 재배달할 수 있습니다. OpenClaw는 채널/계정/피어/세션/메시지 ID로 키된 단기 캐시를 유지하므로 중복 배달은 다른 에이전트 실행을 트리거하지 않습니다.

## 인바운드 디바운싱

동일한 **발신자**의 빠른 연속 메시지는 `messages.inbound`를 통해 단일 에이전트 턴으로 배치될 수 있습니다. 디바운싱은 채널 + 대화 범위이며 응답 스레딩/ID에 대해 최신 메시지를 사용합니다.

구성 (전역 기본값 + 채널별 재정의):

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

노트:

- 디바운스는 **텍스트 전용** 메시지에 적용됩니다; 미디어/첨부는 즉시 플러시됩니다.
- 제어 명령은 디바운싱을 바이패스하므로 독립적으로 유지됩니다.

## 세션 및 기기

세션은 클라이언트가 아니라 게이트웨이에서 소유합니다.

- 직접 채팅은 에이전트 메인 세션 키로 축소됩니다.
- 그룹/채널은 자신의 세션 키를 얻습니다.
- 세션 저장소와 대사는 게이트웨이 호스트에 있습니다.

여러 기기/채널은 동일한 세션에 매핑될 수 있지만, 기록은 모든 클라이언트로 완전히 동기화되지 않습니다. 권장 사항: 장시간 대화를 위해 하나의 기본 기기를 사용하여 분산된 컨텍스트를 피하세요. Control UI와 TUI는 항상 게이트웨이 지원 세션 대사를 표시하므로, 그것이 진실의 원천입니다.

자세히: [세션 관리](/concepts/session).

## 인바운드 본문 및 기록 컨텍스트

OpenClaw는 **프롬프트 본문**과 **명령 본문**을 분리합니다:

- `Body`: 에이전트로 전송된 프롬프트 텍스트입니다. 이는 채널 봉투 및 선택적 기록 래퍼를 포함할 수 있습니다.
- `CommandBody`: 지시문/명령 구문 분석을 위한 원본 사용자 텍스트입니다.
- `RawBody`: `CommandBody`의 레거시 별칭 (호환성 유지).

채널이 기록을 제공할 때, 공유 래퍼를 사용합니다:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

**비직접 채팅** (그룹/채널/방)의 경우, **현재 메시지 본문**에는 발신자 레이블이 접두사로 붙습니다 (기록 항목에 사용하는 것과 동일한 스타일). 이는 실시간 및 큐/기록 메시지를 에이전트 프롬프트에서 일관되게 유지합니다.

기록 버퍼는 **대기만 해당**: 실행을 트리거하지 않은 그룹 메시지 (예: 언급 게이트된 메시지)를 포함하고 **제외** 세션 대사에 이미 있는 메시지.

지시문 제거는 **현재 메시지** 섹션에만 적용되므로 기록은 그대로 유지됩니다. 기록을 래핑하는 채널은 원본 메시지 텍스트로 `CommandBody` (또는 `RawBody`)를 설정하고 결합 프롬프트로 `Body`를 유지해야 합니다.
기록 버퍼는 `messages.groupChat.historyLimit` (전역 기본값)과 `channels.slack.historyLimit` 또는 `channels.telegram.accounts.<id>.historyLimit` (채널별 재정의)를 통해 구성 가능합니다 (`0`은 비활성화함).

## 큐잉 및 팔로우업

실행이 이미 활성화되어 있으면, 인바운드 메시지는 큐될 수 있으며, 현재 실행으로 조종되거나 팔로우업 턴을 위해 수집됩니다.

- `messages.queue` (및 `messages.queue.byChannel`)를 통해 구성합니다.
- 모드: `interrupt`, `steer`, `followup`, `collect`, 플러스 백로그 변형.

자세히: [큐잉](/concepts/queue).

## 스트리밍, 청킹 및 배치

블록 스트리밍은 모델이 텍스트 블록을 생성할 때 부분 응답을 보냅니다.
청킹은 채널 텍스트 제한을 고려하고 울타리된 코드를 분할하지 않습니다.

핵심 설정:

- `agents.defaults.blockStreamingDefault` (`on|off`, 기본값 off)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (유휴 기반 배치)
- `agents.defaults.humanDelay` (블록 응답 사이의 인간 같은 일시 중지)
- 채널 재정의: `*.blockStreaming` 및 `*.blockStreamingCoalesce` (비 Telegram 채널은 명시적 `*.blockStreaming: true` 필요)

자세히: [스트리밍 + 청킹](/concepts/streaming).

## 추론 가시성 및 토큰

OpenClaw는 모델 추론을 노출하거나 숨길 수 있습니다:

- `/reasoning on|off|stream`은 가시성을 제어합니다.
- 추론 콘텐츠는 모델에서 생성될 때 여전히 토큰 사용에 계산됩니다.
- Telegram은 드래프트 버블로 추론 스트림을 지원합니다.

자세히: [생각하기 + 추론 지시문](/tools/thinking) 및 [토큰 사용](/reference/token-use).

## 접두사, 스레딩 및 응답

아웃바운드 메시지 형식화는 `messages`에서 중앙화됩니다:

- `messages.responsePrefix`, `channels.<channel>.responsePrefix`, `channels.<channel>.accounts.<id>.responsePrefix` (아웃바운드 접두사 계단식), 플러스 `channels.whatsapp.messagePrefix` (인바운드 접두사)
- `replyToMode`를 통한 응답 스레딩 및 채널별 기본값

자세히: [구성](/gateway/configuration#messages) 및 채널 문서.
