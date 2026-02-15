---
summary: "Streaming + chunking behavior (block replies, draft streaming, limits)"
read_when:
  - Explaining how streaming or chunking works on channels
  - Changing block streaming or channel chunking behavior
  - Debugging duplicate/early block replies or draft streaming
title: "Streaming and Chunking"
x-i18n:
  source_hash: f014eb1898c4351b1d6b812223226d91324701e3e809cd0f3faf6679841bc353
---

# 스트리밍 + 청킹

OpenClaw에는 두 개의 별도 "스트리밍" 레이어가 있습니다.

- **블록 스트리밍(채널):** 보조자가 작성하는 대로 완료된 **블록**을 내보냅니다. 이는 일반 채널 메시지입니다(토큰 델타가 아님).
- **토큰형 스트리밍(텔레그램만 해당):** 생성하는 동안 부분 텍스트로 **초안 풍선**을 업데이트합니다. 마지막에 최종 메시지가 전송됩니다.

현재 외부 채널 메시지에 대한 **실제 토큰 스트리밍**은 없습니다. 텔레그램 초안 스트리밍은 유일한 부분 스트림 표면입니다.

## 스트리밍 차단(채널 메시지)

블록 스트리밍은 보조 출력이 사용 가능해지면 대략적인 청크로 전송합니다.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

범례:

- `text_delta/events`: 모델 스트림 이벤트(비스트리밍 모델의 경우 희소할 수 있음).
- `chunker`: `EmbeddedBlockChunker` 최소/최대 경계 + 중단 기본 설정을 적용합니다.
- `channel send`: 실제 아웃바운드 메시지(답장 차단)입니다.

**컨트롤:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (기본값은 꺼짐).
- 채널 재정의: `*.blockStreaming`(및 계정별 변형)는 채널당 `"on"`/`"off"`를 강제합니다.
- `agents.defaults.blockStreamingBreak`: `"text_end"` 또는 `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (보내기 전에 스트리밍된 블록을 병합합니다).
- 채널 하드 캡: `*.textChunkLimit` (예: `channels.whatsapp.textChunkLimit`).
- 채널 청크 모드: `*.chunkMode` (`length` 기본값, `newline`는 길이 청크 전에 빈 줄(단락 경계)로 분할됩니다.
- Discord 소프트 캡: `channels.discord.maxLinesPerMessage` (기본값 17) UI 잘림을 방지하기 위해 긴 응답을 분할합니다.

**경계 의미:**

- `text_end`: 청커가 방출되자마자 스트림이 차단됩니다. 각 `text_end`를 플러시합니다.
- `message_end`: 보조 메시지가 끝날 때까지 기다린 다음 버퍼링된 출력을 플러시합니다.

`message_end` 버퍼링된 텍스트가 `maxChars`를 초과하는 경우에도 여전히 청커를 사용하므로 끝에 여러 청크를 내보낼 수 있습니다.

## 청킹 알고리즘(낮은/높은 경계)

블록 청킹은 `EmbeddedBlockChunker`에 의해 구현됩니다.

- **낮은 경계:** 버퍼 >= `minChars`(강제하지 않는 한)까지 방출하지 않습니다.
- **상한:** `maxChars` 이전에 분할을 선호합니다. 강제로 적용할 경우 `maxChars`에서 분할됩니다.
- ** 브레이크 기본 설정 : ** `paragraph` → `newline` → `sentence` → `whitespace` → 하드 브레이크.
- **코드 펜스:** 펜스 내부에서 분리되지 않습니다. `maxChars`에서 강제로 실행되면 울타리를 닫고 다시 열어 마크다운을 유효하게 유지하세요.

`maxChars`는 `textChunkLimit` 채널에 고정되어 있으므로 채널당 한도를 초과할 수 없습니다.

## 병합(스트리밍된 블록 병합)

블록 스트리밍이 활성화되면 OpenClaw는 **연속적인 블록 청크**를 병합할 수 있습니다.
그들을 보내기 전에. 이렇게 하면 "한 줄 스팸"이 줄어들면서 동시에
프로그레시브 출력.

- 병합은 플러시하기 전에 **유휴 간격**(`idleMs`)을 기다립니다.
- 버퍼는 `maxChars`로 제한되며 이를 초과하면 플러시됩니다.
- `minChars` 충분한 텍스트가 쌓일 때까지 작은 조각이 전송되는 것을 방지합니다.
  (최종 플러시는 항상 남은 텍스트를 보냅니다).
- Joiner는 `blockStreamingChunk.breakPreference`에서 파생됩니다.
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → 공백).
- 채널 재정의는 `*.blockStreamingCoalesce`을 통해 가능합니다(계정별 구성 포함).
- 재정의되지 않는 한 Signal/Slack/Discord에 대한 기본 통합 `minChars`은 1500으로 증가합니다.

## 블록 간 인간과 같은 속도

블록 스트리밍이 활성화되면 스트리밍 사이에 **무작위 일시중지**를 추가할 수 있습니다.
응답을 차단합니다(첫 번째 차단 이후). 이는 다중 버블 반응을 느끼게 합니다.
더 자연스러워요.

- 구성: `agents.defaults.humanDelay` (`agents.list[].humanDelay`를 통해 에이전트별로 재정의).
- 모드: `off` (기본값), `natural` (800–2500ms), `custom` (`minMs`/`maxMs`).
- 최종 답변이나 도구 요약이 아닌 **답글 차단**에만 적용됩니다.

## “스트림 청크 또는 모든 것”

이는 다음에 매핑됩니다.

- **스트림 청크:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (진행하면서 방출). 텔레그램이 아닌 채널에도 `*.blockStreaming: true`가 필요합니다.
- **끝 부분에 모든 것을 스트리밍합니다:** `blockStreamingBreak: "message_end"` (한 번 플러시하고 매우 긴 경우 여러 청크를 플러시할 수 있음).
- **블록 스트리밍 없음:** `blockStreamingDefault: "off"` (최종 응답만).

**채널 참고 사항:** Telegram 채널이 아닌 경우 블록 스트리밍은 **해당되지 않는 한** 꺼집니다.
`*.blockStreaming`는 명시적으로 `true`로 설정됩니다. 텔레그램은 초안을 스트리밍할 수 있습니다
(`channels.telegram.streamMode`) 차단 응답이 없습니다.

구성 위치 알림: `blockStreaming*` 기본값은 다음 위치에 있습니다.
`agents.defaults`, 루트 구성이 아닙니다.

## 텔레그램 초안 스트리밍(토큰형)

텔레그램은 초안 스트리밍이 가능한 유일한 채널입니다.

- **주제별 비공개 채팅**에서 Bot API `sendMessageDraft`를 사용합니다.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: 최신 스트림 텍스트로 초안 업데이트.
  - `block`: 청크 블록의 초안 업데이트(동일 청커 규칙).
  - `off`: 초안 스트리밍이 없습니다.
- 초안 청크 구성(`streamMode: "block"`에만 해당): `channels.telegram.draftChunk` (기본값: `minChars: 200`, `maxChars: 800`).
- 드래프트 스트리밍은 블록 스트리밍과 별개입니다. 차단 답글은 기본적으로 꺼져 있으며 텔레그램이 아닌 채널에서는 `*.blockStreaming: true`로만 활성화됩니다.
- 최종 답변은 여전히 ​​정상적인 메시지입니다.
- `/reasoning stream` 초안 풍선에 추론을 씁니다(텔레그램에만 해당).

초안 스트리밍이 활성화되면 OpenClaw는 이중 스트리밍을 방지하기 위해 해당 응답에 대한 블록 스트리밍을 비활성화합니다.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

범례:

- `sendMessageDraft`: 텔레그램 초안 풍선(실제 메시지가 아님).
- `final reply` : 정상적인 텔레그램 메시지 전송입니다.
