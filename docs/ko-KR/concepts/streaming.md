---
summary: "스트리밍 + 청킹 동작(블록 회신, 채널 미리보기 스트리밍, 모드 매핑)"
read_when:
  - 스트리밍 또는 청킹이 채널에서 어떻게 작동하는지 설명
  - 블록 스트리밍 또는 채널 청킹 동작 변경
  - 중복/조기 블록 회신 또는 채널 미리보기 스트리밍 디버깅
title: "스트리밍 및 청킹"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/concepts/streaming.md
  workflow: 15
---

# 스트리밍 + 청킹

OpenClaw에는 두 가지 별도의 스트리밍 레이어가 있습니다:

- **블록 스트리밍(채널):** 어시스턴트가 작성할 때 완성된 **블록**을 발생시킵니다. 이들은 정상 채널 메시지입니다(토큰 델타 아님).
- **미리보기 스트리밍(Telegram/Discord/Slack):** 생성하는 동안 임시 **미리보기 메시지**를 업데이트합니다.

오늘날 채널 메시지에 대한 **진정한 토큰 델타 스트리밍이 없습니다**. 미리보기 스트리밍은 메시지 기반입니다(전송 + 편집/추가).

## 블록 스트리밍(채널 메시지)

블록 스트리밍은 사용 가능해지자마자 어시스턴트 출력을 거친 청크로 보냅니다.

```
모델 출력
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker는 버퍼가 증가하면서 블록을 발생
       └─ (blockStreamingBreak=message_end)
            └─ chunker는 message_end에서 플러시
                   └─ 채널 전송(블록 회신)
```

범례:

- `text_delta/events`: 모델 스트림 이벤트(비 스트리밍 모델의 경우 스파스할 수 있음).
- `chunker`: 최소/최대 바운드 + 중단 선호도를 적용하는 `EmbeddedBlockChunker`.
- `channel send`: 실제 아웃바운드 메시지(블록 회신).

**컨트롤:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (기본값 off).
- 채널 무시: `*.blockStreaming` (및 계정별 변형)을 채널당 `"on"`/`"off"`로 강제.
- `agents.defaults.blockStreamingBreak`: `"text_end"` 또는 `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (전송 전 스트리밍된 블록 병합).
- 채널 하드 제한: `*.textChunkLimit` (예: `channels.whatsapp.textChunkLimit`).
- 채널 청킹 모드: `*.chunkMode` (`length` 기본값, `newline`은 길이 청킹 전에 빈 줄(단락 경계)에서 분할).
- Discord 소프트 제한: `channels.discord.maxLinesPerMessage` (기본값 17)은 UI 클리핑을 피하기 위해 큰 회신을 분할합니다.

**경계 의미론:**

- `text_end`: chunker가 발생하면 즉시 스트림 블록; 각 `text_end`에서 플러시.
- `message_end`: 어시스턴트 메시지가 완료될 때까지 기다린 다음 버퍼된 출력을 플러시합니다.

`message_end`는 버퍼된 텍스트가 `maxChars`를 초과하면 여전히 chunker를 사용하므로 끝에서 여러 청크를 발생할 수 있습니다.

## 청킹 알고리즘(낮음/높음 바운드)

블록 청킹은 `EmbeddedBlockChunker`로 구현됩니다:

- **낮음 바운드:** 버퍼 >= `minChars` 없이는 발생하지 않음(강제하지 않는 한).
- **높음 바운드:** `maxChars` 전에 분할을 선호합니다; 강제되면 `maxChars`에서 분할.
- **중단 선호도:** `paragraph` → `newline` → `sentence` → `whitespace` → 하드 중단.
- **코드 펜스:** 펜스 내에서 절대 분할하지 않음; `maxChars`에서 강제되면 펜스를 닫았다가 다시 열어 Markdown을 유효하게 유지.

`maxChars`는 채널 `textChunkLimit`로 클램프되므로 채널별 제한을 초과할 수 없습니다.

## 압축(스트리밍된 블록 병합)

블록 스트리밍이 활성화되면 OpenClaw는 **연속 블록 청크를 병합**할 수 있습니다.
이것은 여전히 점진적 출력을 제공하면서 "한 줄 스팸"을 줄입니다.

- 압축은 **유휴 간격**(`idleMs`) 전에 플러시할 때까지 기다립니다.
- 버퍼는 `maxChars`로 제한되며 초과하면 플러시됩니다.
- `minChars`는 충분한 텍스트가 누적될 때까지 작은 조각이 전송되지 않도록 합니다.
  (최종 플러시는 항상 남은 텍스트를 보냅니다).
- 조인은 `blockStreamingChunk.breakPreference`에서 파생됩니다.
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → space).
- 채널 무시는 `*.blockStreamingCoalesce`를 통해 사용 가능합니다(계정별 구성 포함).
- 기본 압축 `minChars`는 재정의하지 않은 경우 Signal/Slack/Discord에서 1500으로 범프됩니다.

## 블록 간 인간다운 속도

블록 스트리밍이 활성화되면 **블록 회신 간에 무작위 일시 중지**를 추가할 수 있습니다(첫 번째 블록 후). 이것은 다중 버블 응답을 더 자연스럽게 느끼게 합니다.

- 설정: `agents.defaults.humanDelay` (에이전트별로 `agents.list[].humanDelay`로 무시).
- 모드: `off` (기본값), `natural` (800–2500ms), `custom` (`minMs`/`maxMs`).
- **블록 회신**에만 적용됩니다(최종 회신 또는 도구 요약 아님).

## "청크 스트림 또는 모든 것"

이것은 다음으로 매핑됩니다:

- **스트림 청크:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (계속 발생). 비 Telegram 채널도 `*.blockStreaming: true` 필요합니다.
- **끝에서 모든 것 스트림:** `blockStreamingBreak: "message_end"` (한 번 플러시하면 매우 길면 여러 청크).
- **블록 스트리밍 없음:** `blockStreamingDefault: "off"` (최종 회신만).

**채널 주의:** 블록 스트리밍은 **`*.blockStreaming`이 명시적으로 `true`로 설정되지 않은 한 off**입니다. 채널은 블록 회신 없이 실시간 미리보기(`channels.<channel>.streaming`)를 스트림할 수 있습니다.

설정 위치 상기: `blockStreaming*` 기본값은 근본 설정이 아닌 `agents.defaults` 아래에 있습니다.

## 미리보기 스트리밍 모드

정규 키: `channels.<channel>.streaming`

모드:

- `off`: 미리보기 스트리밍 비활성화.
- `partial`: 최신 텍스트로 대체되는 단일 미리보기.
- `block`: 청크된/추가된 단계로 미리보기 업데이트.
- `progress`: 생성 중 진행 상태/상태 미리보기, 완료 시 최종 답변.

### 채널 매핑

| 채널     | `off` | `partial` | `block` | `progress`       |
| -------- | ----- | --------- | ------- | ---------------- |
| Telegram | ✅    | ✅        | ✅      | `partial`로 매핑 |
| Discord  | ✅    | ✅        | ✅      | `partial`로 매핑 |
| Slack    | ✅    | ✅        | ✅      | ✅               |

Slack 전용:

- `channels.slack.nativeStreaming` - `streaming=partial`일 때 Slack 기본 스트리밍 API 호출 전환(기본값: `true`).

레거시 키 마이그레이션:

- Telegram: `streamMode` + 부울 `streaming`은 `streaming` enum으로 자동 마이그레이션.
- Discord: `streamMode` + 부울 `streaming`은 `streaming` enum으로 자동 마이그레이션.
- Slack: `streamMode`는 `streaming` enum으로 자동 마이그레이션; 부울 `streaming`은 `nativeStreaming`으로 자동 마이그레이션.

### 런타임 동작

Telegram:

- Bot API `sendMessage` + `editMessageText` 사용.
- Telegram 블록 스트리밍이 명시적으로 활성화되면 미리보기 스트리밍을 건너뜁니다(이중 스트리밍 피하기).
- `/reasoning stream`은 추론을 미리보기에 쓸 수 있습니다.

Discord:

- 메시지 미리보기 전송 + 편집 사용.
- `block` 모드는 드래프트 청킹(`draftChunk`) 사용.
- Discord 블록 스트리밍이 명시적으로 활성화되면 미리보기 스트리밍을 건너뜁니다.

Slack:

- `partial`은 사용 가능할 때 Slack 기본 스트리밍(`chat.startStream`/`append`/`stop`) 사용 가능.
- `block`은 추가 스타일 드래프트 미리보기 사용.
- `progress`는 상태 미리보기 텍스트, 그 다음 최종 답변 사용.
