---
read_when:
    - 채널에서 스트리밍 또는 청킹이 작동하는 방식 설명
    - 블록 스트리밍 또는 채널 청크 동작 변경
    - 중복/조기 차단 응답 또는 초안 스트리밍 디버깅
summary: 스트리밍 + 청킹 동작(응답 차단, 초안 스트리밍, 제한)
title: 스트리밍과 청킹
x-i18n:
    generated_at: "2026-02-08T15:55:47Z"
    model: gtx
    provider: google-translate
    source_hash: f014eb1898c4351b1d6b812223226d91324701e3e809cd0f3faf6679841bc353
    source_path: concepts/streaming.md
    workflow: 15
---

# 스트리밍 + 청킹

OpenClaw에는 두 개의 별도 "스트리밍" 레이어가 있습니다.

- **스트리밍 차단(채널):** 방출 완료 **블록** 조수가 쓴대로. 이는 일반 채널 메시지입니다(토큰 델타가 아님).
- **토큰형 스트리밍(텔레그램만 해당):** 업데이트하다 **초안 버블** 생성하는 동안 부분 텍스트가 있습니다. 마지막에 최종 메시지가 전송됩니다.

있다 **실제 토큰 스트리밍이 없습니다** 오늘 외부 채널 메시지에. 텔레그램 초안 스트리밍은 유일한 부분 스트림 표면입니다.

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

전설:

- `text_delta/events`: 모델 스트림 이벤트(비스트리밍 모델의 경우 드물 수 있음)
- `chunker`: `EmbeddedBlockChunker` 최소/최대 경계 + 중단 기본 설정 적용
- `channel send`: 실제 아웃바운드 메시지(답장 차단)

**통제 수단:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (기본값은 꺼짐).
- 채널 재정의: `*.blockStreaming` (및 계정별 변형) 강제 실행 `"on"`/`"off"` 채널당.
- `agents.defaults.blockStreamingBreak`: `"text_end"` 또는 `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (보내기 전에 스트리밍된 블록을 병합합니다).
- 채널 하드 캡: `*.textChunkLimit` (예: `channels.whatsapp.textChunkLimit`).
- 채널 청크 모드: `*.chunkMode` (`length` 기본, `newline` 길이 청크 전에 빈 줄(단락 경계)로 분할됩니다.
- 디스코드 소프트 캡: `channels.discord.maxLinesPerMessage` (기본값 17) UI 잘림을 방지하기 위해 긴 응답을 분할합니다.

**경계 의미:**

- `text_end`: 청커가 방출되자마자 스트림이 차단됩니다. 각각 플러시 `text_end`.
- `message_end`: 보조 메시지가 끝날 때까지 기다린 다음 버퍼링된 출력을 플러시합니다.

`message_end` 버퍼링된 텍스트가 다음을 초과하면 여전히 청커를 사용합니다. `maxChars`, 그래서 마지막에 여러 청크를 방출할 수 있습니다.

## 청킹 알고리즘(낮은/높은 경계)

블록 청킹은 다음과 같이 구현됩니다. `EmbeddedBlockChunker`: 

- **하한:** 버퍼 >=까지 방출하지 않음 `minChars` (강요하지 않는 한).
- **상한:** 이전에 분할을 선호 `maxChars`; 강제로 분할할 경우 `maxChars`.
- **휴식 시간 선호도:** `paragraph` → `newline` → `sentence` → `whitespace` → 힘든 휴식.
- **코드 펜스:** 울타리 안에서는 절대로 갈라지지 마십시오. 강제로 했을 때 `maxChars`, 마크다운을 유효하게 유지하려면 펜스를 닫고 다시 엽니다.

`maxChars` 채널에 고정되어 있습니다 `textChunkLimit`이므로 채널당 한도를 초과할 수 없습니다.

## 병합(스트리밍된 블록 병합)

블록 스트리밍이 활성화되면 OpenClaw는 다음을 수행할 수 있습니다. **연속된 블록 청크 병합**
그들을 보내기 전에. 이렇게 하면 "한 줄 스팸"이 줄어들면서 동시에
프로그레시브 출력.

- 병합이 기다립니다. **유휴 공백** (`idleMs`) 플러시하기 전에.
- 버퍼는 다음으로 제한됩니다. `maxChars` 초과하면 플러시됩니다.
- `minChars` 충분한 텍스트가 축적될 때까지 작은 조각이 전송되는 것을 방지합니다.
  (최종 플러시는 항상 남은 텍스트를 보냅니다).
- 조이너는 다음에서 파생됩니다. `blockStreamingChunk.breakPreference`
   (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → 공간).
- 채널 재정의는 다음을 통해 가능합니다. `*.blockStreamingCoalesce` (계정별 구성 포함)
- 기본 병합 `minChars` 재정의되지 않는 한 Signal/Slack/Discord의 경우 1500으로 증가합니다.

## 블록 간 인간과 같은 속도

블록 스트리밍이 활성화되면 **무작위 일시중지** 사이에
응답을 차단합니다(첫 번째 차단 이후). 이는 다중 버블 반응을 느끼게 합니다.
더 자연스러워요.

- 구성: `agents.defaults.humanDelay` (에이전트당 재정의: `agents.list[].humanDelay`).
- 모드: `off` (기본), `natural` (800~2500ms), `custom` (`minMs`/`maxMs`).
- 다음에만 적용됩니다. **답글 차단**, 최종 답변이나 도구 요약이 아닙니다.

## “청크 또는 모든 것을 스트리밍”

이는 다음에 매핑됩니다.

- **스트림 청크:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (가는대로 방출). 텔레그램이 아닌 채널도 필요합니다. `*.blockStreaming: true`.
- **마지막에 모든 것을 스트리밍하세요.** `blockStreamingBreak: "message_end"` (한 번 플러시하고, 매우 긴 경우 여러 청크를 플러시할 수 있음).
- **블록 스트리밍 없음:** `blockStreamingDefault: "off"` (최종 답변만).

**채널 참고:** Telegram이 아닌 채널의 경우 블록 스트리밍은 **그렇지 않으면 꺼짐**
`*.blockStreaming` 명시적으로 설정되어 있습니다. `true`. 텔레그램은 초안을 스트리밍할 수 있습니다
(`channels.telegram.streamMode`) 차단 응답이 없습니다.

구성 위치 알림: `blockStreaming*` 기본값은 아래에 있습니다.
`agents.defaults`, 루트 구성이 아닙니다.

## 텔레그램 초안 스트리밍(토큰형)

텔레그램은 초안 스트리밍이 가능한 유일한 채널입니다.

- 봇 API 사용 `sendMessageDraft` ~에 **주제별 비공개 채팅**.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: 최신 스트림 텍스트로 업데이트 초안을 작성합니다.
  - `block`: 청크 블록의 초안 업데이트(동일한 청커 규칙)
  - `off`: 초안 스트리밍이 없습니다.
- 초안 청크 구성(에만 해당) `streamMode: "block"`): `channels.telegram.draftChunk` (기본값: `minChars: 200`, `maxChars: 800`).
- 드래프트 스트리밍은 블록 스트리밍과 별개입니다. 답글 차단은 기본적으로 꺼져 있으며 다음 사용자에 의해서만 활성화됩니다. `*.blockStreaming: true` 텔레그램 채널이 아닌 채널에서.
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

전설:

- `sendMessageDraft`: 텔레그램 초안 버블(실제 메시지가 아님)
- `final reply`: 일반 텔레그램 메시지 전송.
