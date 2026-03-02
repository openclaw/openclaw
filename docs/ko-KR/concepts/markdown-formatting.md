---
summary: "Outbound 채널에 대한 Markdown formatting 파이프라인"
read_when:
  - outbound 채널에 대한 markdown formatting 또는 chunking을 변경할 때
  - 새로운 채널 formatter 또는 style mapping을 추가할 때
  - 채널 간 formatting regressions을 디버깅할 때
title: "Markdown Formatting"
---

# Markdown formatting

OpenClaw는 outbound Markdown을 shared intermediate representation (IR)으로 변환하여 format합니다. IR은 소스 텍스트를 그대로 유지하면서 style/link spans을 수행하므로 chunking 및 rendering이 채널 간에 일관되게 유지됩니다.

## 목표

- **Consistency:** 한 번의 parse step, 여러 renderer.
- **Safe chunking:** inline formatting이 절대 청크 간에 끊어지지 않도록 rendering 전에 텍스트를 분할합니다.
- **Channel fit:** Slack mrkdwn, Telegram HTML, 및 Signal style ranges에 같은 IR을 mapping하면 Markdown을 재파싱할 필요가 없습니다.

## 파이프라인

1. **Markdown 파싱 -> IR**
   - IR은 일반 텍스트 더하기 style spans (bold/italic/strike/code/spoiler) 및 link spans입니다.
   - Offsets은 UTF-16 code units이므로 Signal style ranges가 API와 정렬됩니다.
   - 테이블은 채널이 table conversion에 opt in할 때만 파싱됩니다.
2. **Chunk IR (format-first)**
   - Chunking은 rendering 전에 IR 텍스트에서 발생합니다.
   - Inline formatting은 청크 간에 분할되지 않습니다; spans은 청크마다 sliced됩니다.
3. **채널별 rendering**
   - **Slack:** mrkdwn tokens (bold/italic/strike/code), `<url|label>`로 링크.
   - **Telegram:** HTML tags (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).
   - **Signal:** 일반 텍스트 + `text-style` ranges; 링크는 label이 URL과 다를 때 `label (url)`이 됩니다.

## IR 예시

Input Markdown:

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR (schematic):

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## 사용되는 곳

- Slack, Telegram, Signal outbound adapters는 IR에서 rendering합니다.
- 다른 채널 (WhatsApp, iMessage, MS Teams, Discord)는 여전히 일반 텍스트 또는 고유한 formatting 규칙을 사용하며, 활성화될 때 chunking 전에 Markdown table conversion을 적용합니다.

## 테이블 처리

Markdown 테이블은 chat clients 간에 일관되게 지원되지 않습니다. `markdown.tables`를 사용하여 채널별로 (및 계정별로) conversion을 제어합니다.

- `code`: 테이블을 code 블록으로 rendering합니다 (대부분 채널의 기본값).
- `bullets`: 각 행을 bullet points로 변환합니다 (Signal + WhatsApp의 기본값).
- `off`: table parsing을 비활성화하고 conversion; 원본 테이블 텍스트가 통과합니다.

설정 키:

```yaml
channels:
  discord:
    markdown:
      tables: code
    accounts:
      work:
        markdown:
          tables: off
```

## Chunking 규칙

- Chunk 제한은 channel adapters/config에서 오며 IR 텍스트에 적용됩니다.
- Code fences는 trailing newline과 함께 단일 블록으로 보존되므로 채널이 올바르게 rendering합니다.
- 리스트 접두사 및 blockquote 접두사는 IR 텍스트의 일부이므로 chunking은 mid-prefix를 분할하지 않습니다.
- Inline styles (bold/italic/strike/inline-code/spoiler)는 절대 청크 간에 분할되지 않습니다; renderer는 각 청크 내에서 styles을 다시 엽니다.

채널 간 chunking 동작에 대한 더 많은 정보가 필요한 경우 [스트리밍 + chunking](/concepts/streaming)을 참조합니다.

## 링크 정책

- **Slack:** `[label](url)` -> `<url|label>`; 베어 URL은 베어로 유지됩니다. Autolink는
  parse 중에 비활성화되어 double-linking을 피합니다.
- **Telegram:** `[label](url)` -> `<a href="url">label</a>` (HTML parse 모드).
- **Signal:** `[label](url)` -> `label (url)` unless label이 URL과 일치합니다.

## 스포일러

스포일러 마커 (`||spoiler||`)는 Signal에만 파싱되며 SPOILER style ranges에 mapping됩니다. 다른 채널은 이를 일반 텍스트로 취급합니다.

## 채널 formatter를 추가하거나 업데이트하는 방법

1. **한 번 파싱:** channel-appropriate 옵션 (autolink, heading style, blockquote prefix)과 함께 shared `markdownToIR(...)` helper를 사용합니다.
2. **Render:** `renderMarkdownWithMarkers(...)`로 renderer를 구현하고 style marker map (또는 Signal style ranges)을 구현합니다.
3. **Chunk:** rendering 전에 `chunkMarkdownIR(...)`을 호출합니다; 각 청크를 rendering합니다.
4. **Wire adapter:** 새 chunker 및 renderer를 사용하도록 channel outbound adapter를 업데이트합니다.
5. **테스트:** format 테스트 및 outbound delivery 테스트를 추가하거나 업데이트합니다 (채널이 chunking을 사용하는 경우).

## 일반적인 gotchas

- Slack angle-bracket tokens (`<@U123>`, `<#C123>`, `<https://...>`)는 보존되어야 합니다; raw HTML을 안전하게 escape합니다.
- Telegram HTML은 broken markup을 피하기 위해 tags 외부의 텍스트를 escape해야 합니다.
- Signal style ranges는 UTF-16 offsets에 따라 달라집니다; code point offsets을 사용하지 마십시오.
- Fenced code 블록에 trailing newlines을 보존하여 closing markers가 자신의 라인에 착지합니다.
