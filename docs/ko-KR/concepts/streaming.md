---
summary: "Streaming + chunking behavior (block replies, Telegram preview streaming, limits)"
read_when:
  - Explaining how streaming or chunking works on channels
  - Changing block streaming or channel chunking behavior
  - Debugging duplicate/early block replies or Telegram preview streaming
title: "Streaming and Chunking"
---

# Streaming + chunking

OpenClaw에는 두 개의 별도 "스트리밍" 계층이 있습니다:

- **블록 스트리밍 (채널):** 조수의 작성이 완료된 **블록**을 발행합니다. 이는 일반적인 채널 메시지입니다 (토큰 델타 아님).
- **유사 토큰 스트리밍 (Telegram 전용):** 생성을 진행하는 동안 임시 **미리보기 메시지**를 부분적으로 업데이트합니다.

오늘날 외부 채널 메시지에 대한 **실제 토큰-델타 스트리밍**은 없습니다. Telegram 미리보기 스트리밍은 유일한 부분 스트림 표면입니다.

## Block streaming (channel messages)

블록 스트리밍은 조수의 출력을 가능한 한 큼직한 청크로 보냅니다.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

전설:

- `text_delta/events`: 모델 스트림 이벤트 (비스트리밍 모델의 경우 드물 수 있음).
- `chunker`: `EmbeddedBlockChunker`가 최소/최대 경계 및 구분 선호도를 적용합니다.
- `channel send`: 실제 발신 메시지 (블록 응답).

**제어:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (기본값 off).
- 채널 재정의: `*.blockStreaming` (및 계정별 변형)로 채널 당 `"on"`/`"off"`를 강제 적용합니다.
- `agents.defaults.blockStreamingBreak`: `"text_end"` 또는 `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (보내기 전에 스트리밍된 블록을 병합).
- 채널 하드 캡: `*.textChunkLimit` (예: `channels.whatsapp.textChunkLimit`).
- 채널 청크 모드: `*.chunkMode` (`length` 기본값, 길이 청크 전에 빈 줄 (문단 경계)로 분할하는 `newline`).
- Discord 소프트 캡: `channels.discord.maxLinesPerMessage` (기본값 17)로 UI 클리핑을 피하기 위해 긴 응답을 분할.

**경계 의미:**

- `text_end`:chunker가 발행하는 즉시 블록을 스트리밍합니다; 각 `text_end`에서 플러시.
- `message_end`: 조수 메시지가 끝날 때까지 기다렸다가 버퍼된 출력을 플러시.

`message_end`는 버퍼된 텍스트가 `maxChars`를 초과하면 여전히 chunker를 사용하여 여러 청크를 끝에서 발행할 수 있습니다.

## Chunking algorithm (low/high bounds)

블록 청크는 `EmbeddedBlockChunker`로 구현됩니다:

- **낮은 경계:** 버퍼가 `minChars` 이상이 될 때까지 발행하지 않습니다 (강제되지 않은 경우).
- **높은 경계:** `maxChars` 이전의 분할을 선호합니다; 강제된 경우 `maxChars`에서 분할합니다.
- **구분 선호도:** `paragraph` → `newline` → `sentence` → `whitespace` → 강제 줄바꿈.
- **코드 펜스:** 펜스 내에서는 절대 분할하지 않습니다; `maxChars`에서 강제된 경우, 펜스를 닫고 다시 열어 Markdown을 유효하게 유지합니다.

`maxChars`는 채널의 `textChunkLimit`에 고정되므로 채널별 캡을 초과할 수 없습니다.

## Coalescing (merge streamed blocks)

블록 스트리밍이 활성화되어 있을 때, OpenClaw는 **연속 블록 청크를 병합**하여 보내기 전까지 밀어냅니다. 이는 "단일 라인 스팸"을 줄이면서도 진행 상황을 제공합니다.

- 합성은 **유휴 간격**(`idleMs`)이 될 때까지 기다립니다.
- 버퍼는 `maxChars`로 제한되며 초과하면 플러시됩니다.
- `minChars`는 충분한 텍스트가 축적될 때까지 작은 조각의 전송을 방지합니다 (최종 플러시는 항상 남은 텍스트를 보냅니다).
- 조인은 `blockStreamingChunk.breakPreference`에서 파생됩니다
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → 공백).
- 채널 재정의는 `*.blockStreamingCoalesce`를 통해 가능합니다 (계정별 설정 포함).
- 기본 합성 `minChars`는 Signal/Slack/Discord의 경우 1500으로 증가하며, 재정의되지 않는 한 유지됩니다.

## Human-like pacing between blocks

블록 스트리밍이 켜져 있을 때, 블록 응답 사이에 **랜덤하게 멈춤**을 추가할 수 있습니다 (첫 번째 블록 이후). 이는 다중 버블 응답이 더 자연스럽게 느껴지도록 합니다.

- 설정: `agents.defaults.humanDelay` (에이전트별로 `agents.list[].humanDelay`로 재정의).
- 모드: `off` (기본값), `natural` (800–2500ms), `custom` (`minMs`/`maxMs`).
- 이는 **블록 응답**에만 적용되며, 최종 응답이나 도구 요약에는 적용되지 않습니다.

## “Stream chunks or everything”

이는 다음과 같이 매핑됩니다:

- **Stream chunks:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (즉시 발행). Telegram이 아닌 채널에는 `*.blockStreaming: true`가 필요합니다.
- **Stream everything at end:** `blockStreamingBreak: "message_end"` (한 번 플러시, 매우 긴 경우 여러 청크).
- **No block streaming:** `blockStreamingDefault: "off"` (최종 응답만).

**채널 참고:** Telegram이 아닌 채널의 경우 `*.blockStreaming`이 명시적으로 `true`로 설정되지 않는 한 블록 스트리밍은 **해제**됩니다. Telegram은 블록 응답 없이 실시간 미리보기를 스트리밍할 수 있습니다 (`channels.telegram.streamMode`).

구성 위치 알림: `blockStreaming*` 기본값은 루트 구성 아닌 `agents.defaults`에 있습니다.

## Telegram preview streaming (token-ish)

Telegram은 실시간 미리보기 스트리밍을 지원하는 유일한 채널입니다:

- Bot API `sendMessage` (첫 번째 업데이트) 및 `editMessageText` (후속 업데이트)를 사용합니다.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: 최신 스트림 텍스트로 미리보기를 업데이트합니다.
  - `block`: 청크된 블록에서 미리보기를 업데이트합니다 (동일한 청크 규칙).
  - `off`: 미리보기 스트리밍 없음.
- 미리보기 청크 구성 (`streamMode: "block"` 전용): `channels.telegram.draftChunk` (기본값: `minChars: 200`, `maxChars: 800`).
- 미리보기 스트리밍은 블록 스트리밍과 별도입니다.
- Telegram 블록 스트리밍이 명시적으로 활성화되면, 중복 스트리밍을 피하기 위해 미리보기 스트리밍이 건너뜁니다.
- 텍스트 전용 최종은 동일한 미리보기 메시지를 편집하여 적용됩니다.
- 비텍스트/복잡한 최종은 정상적인 최종 메시지 전달로 되돌아갑니다.
- `/reasoning stream`이 실시간 미리보기에 추론을 기록합니다 (Telegram 전용).

```
Telegram
  └─ sendMessage (임시 미리보기 메시지)
       ├─ streamMode=partial → 최신 텍스트 편집
       └─ streamMode=block   → chunker + 편집 업데이트
  └─ 최종 텍스트 전용 응답 → 동일한 메시지에서 최종 편집
  └─ 대체: 미리보기 정리 + 정상 최종 전달 (미디어/복잡한)
```

전설:

- `preview message`: 생성 중 업데이트되는 임시 Telegram 메시지.
- `final edit`: 동일한 미리보기 메시지에서의 제자리 편집 (텍스트 전용).