---
summary: "스트리밍 + 청킹 동작 (블록 응답, 초안 스트리밍, 제한)"
read_when:
  - 채널에서 스트리밍 또는 청킹이 어떻게 작동하는지 설명할 때
  - 블록 스트리밍 또는 채널 청킹 동작을 변경할 때
  - 중복되거나 너무 이른 블록 응답 또는 초안 스트리밍을 디버깅할 때
title: "스트리밍과 청킹"
---

# 스트리밍 + 청킹

OpenClaw 에는 서로 분리된 두 가지 '스트리밍' 레이어가 있습니다:

- **블록 스트리밍 (채널):** 어시스턴트가 작성하는 동안 완료된 **블록**을 방출합니다. 이는 토큰 델타가 아닌 일반 채널 메시지입니다.
- **토큰 유사 스트리밍 (Telegram 전용):** 생성 중에 부분 텍스트로 **초안 버블**을 업데이트하며, 최종 메시지는 끝에 전송됩니다.

현재 외부 채널 메시지로의 **실제 토큰 스트리밍은 없습니다**. Telegram 초안 스트리밍이 유일한 부분 스트림 표면입니다.

## 블록 스트리밍 (채널 메시지)

블록 스트리밍은 사용 가능해지는 대로 어시스턴트 출력을 거친 청크로 전송합니다.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Legend:

- `text_delta/events`: 모델 스트림 이벤트 (스트리밍을 지원하지 않는 모델의 경우 드물 수 있음).
- `chunker`: `EmbeddedBlockChunker` 가 최소/최대 경계와 분할 선호도를 적용합니다.
- `channel send`: 실제 발신 메시지 (블록 응답).

**제어 항목:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (기본값 꺼짐).
- 채널 재정의: 채널별로 `"on"`/`"off"` 을 강제하기 위한 `*.blockStreaming` (계정별 변형 포함).
- `agents.defaults.blockStreamingBreak`: `"text_end"` 또는 `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (전송 전에 스트리밍된 블록 병합).
- 채널 하드 캡: `*.textChunkLimit` (예: `channels.whatsapp.textChunkLimit`).
- 채널 청크 모드: `*.chunkMode` (`length` 기본값, `newline` 은 길이 기반 청킹 전에 빈 줄(문단 경계)에서 분할).
- Discord 소프트 캡: `channels.discord.maxLinesPerMessage` (기본값 17) 은 UI 클리핑을 피하기 위해 긴 응답을 분할합니다.

**경계 의미:**

- `text_end`: 청커가 방출하는 즉시 스트림 블록을 전송하며, 각 `text_end` 마다 플러시합니다.
- `message_end`: 어시스턴트 메시지가 끝날 때까지 기다린 다음 버퍼링된 출력을 플러시합니다.

`message_end` 도 버퍼링된 텍스트가 `maxChars` 를 초과하면 청커를 사용하므로, 끝에서 여러 청크를 방출할 수 있습니다.

## 청킹 알고리즘 (저/고 경계)

블록 청킹은 `EmbeddedBlockChunker` 에 의해 구현됩니다:

- **하한:** 버퍼가 `minChars` 이상이 될 때까지 방출하지 않습니다 (강제되지 않는 한).
- **상한:** `maxChars` 이전에서 분할을 선호하며, 강제 시 `maxChars` 에서 분할합니다.
- **분할 선호도:** `paragraph` → `newline` → `sentence` → `whitespace` → 하드 분할.
- **코드 펜스:** 펜스 내부에서는 절대 분할하지 않으며, `maxChars` 에서 강제될 경우 Markdown 유효성을 유지하기 위해 펜스를 닫았다가 다시 엽니다.

`maxChars` 는 채널 `textChunkLimit` 에 의해 클램프되므로, 채널별 캡을 초과할 수 없습니다.

## 병합 (스트리밍된 블록 병합)

블록 스트리밍이 활성화되면, OpenClaw 는 전송 전에 **연속된 블록 청크를 병합**할 수 있습니다. 이는 점진적 출력을 유지하면서도 '단일 줄 스팸'을 줄입니다.

- 병합은 플러시 전에 **유휴 간격** (`idleMs`) 을 기다립니다.
- 버퍼는 `maxChars` 로 제한되며, 이를 초과하면 플러시됩니다.
- `minChars` 는 충분한 텍스트가 누적될 때까지 작은 조각의 전송을 방지합니다
  (최종 플러시는 항상 남은 텍스트를 전송합니다).
- 조인 문자열은 `blockStreamingChunk.breakPreference` 에서 파생됩니다
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → 공백).
- 채널 재정의는 `*.blockStreamingCoalesce` (계정별 설정 포함) 을 통해 사용할 수 있습니다.
- 기본 병합 `minChars` 은 재정의되지 않는 한 Signal/Slack/Discord 에 대해 1500 으로 상향됩니다.

## 블록 간 사람 같은 페이싱

블록 스트리밍이 활성화되면, 블록 응답 사이(첫 번째 블록 이후)에 **무작위 지연**을 추가할 수 있습니다. 이는 여러 버블로 구성된 응답이 더 자연스럽게 느껴지도록 합니다.

- 설정: `agents.defaults.humanDelay` (에이전트별로 `agents.list[].humanDelay` 를 통해 재정의).
- 모드: `off` (기본값), `natural` (800–2500ms), `custom` (`minMs`/`maxMs`).
- **블록 응답**에만 적용되며, 최종 응답이나 도구 요약에는 적용되지 않습니다.

## '청크를 스트림할지 전체를 보낼지'

이는 다음에 매핑됩니다:

- **청크 스트림:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (진행하면서 방출). Telegram 이 아닌 채널도 `*.blockStreaming: true` 이 필요합니다.
- **끝에서 모두 스트림:** `blockStreamingBreak: "message_end"` (한 번 플러시하며, 매우 길 경우 여러 청크일 수 있음).
- **블록 스트리밍 없음:** `blockStreamingDefault: "off"` (최종 응답만).

**채널 참고:** Telegram 이 아닌 채널의 경우, `*.blockStreaming` 가 명시적으로 `true` 로 설정되지 않는 한 블록 스트리밍은 **꺼짐**입니다. Telegram 은 블록 응답 없이도 초안을 스트림할 수 있습니다
(`channels.telegram.streamMode`).

설정 위치 알림: `blockStreaming*` 기본값은 루트 설정이 아니라
`agents.defaults` 아래에 있습니다.

## Telegram 초안 스트리밍 (토큰 유사)

Telegram 은 초안 스트리밍을 지원하는 유일한 채널입니다:

- **주제가 있는 개인 채팅**에서 Bot API `sendMessageDraft` 를 사용합니다.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: 최신 스트림 텍스트로 초안을 업데이트합니다.
  - `block`: 청킹된 블록으로 초안을 업데이트합니다 (동일한 청커 규칙).
  - `off`: 초안 스트리밍 없음.
- 초안 청크 설정 (`streamMode: "block"` 전용): `channels.telegram.draftChunk` (기본값: `minChars: 200`, `maxChars: 800`).
- 초안 스트리밍은 블록 스트리밍과 분리되어 있으며, 블록 응답은 기본적으로 꺼져 있고 Telegram 이 아닌 채널에서는 `*.blockStreaming: true` 로만 활성화됩니다.
- 최종 응답은 여전히 일반 메시지입니다.
- `/reasoning stream` 는 추론을 초안 버블에 기록합니다 (Telegram 전용).

초안 스트리밍이 활성화되면, OpenClaw 는 이중 스트리밍을 피하기 위해 해당 응답에 대해 블록 스트리밍을 비활성화합니다.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Legend:

- `sendMessageDraft`: Telegram 초안 버블 (실제 메시지가 아님).
- `final reply`: 일반 Telegram 메시지 전송.
