---
summary: "Pipeline ng pag-format ng Markdown para sa mga outbound channel"
read_when:
  - Binabago mo ang pag-format o pag-chunk ng Markdown para sa mga outbound channel
  - Nagdadagdag ka ng bagong channel formatter o style mapping
  - Nagde-debug ka ng mga formatting regression sa iba’t ibang channel
title: "Pag-format ng Markdown"
---

# Pag-format ng Markdown

Ine-format ng OpenClaw ang outbound Markdown sa pamamagitan ng pag-convert nito sa isang shared intermediate
representation (IR) bago i-render ang channel-specific na output. Pinananatili ng IR ang
source text na buo habang dinadala ang mga style/link span upang manatiling consistent ang chunking at rendering sa iba’t ibang channel.

## Mga layunin

- **Consistency:** isang parse step, maraming renderer.
- **Safe chunking:** hatiin ang text bago mag-render para hindi kailanman maputol ang inline formatting sa pagitan ng mga chunk.
- **Channel fit:** i-map ang parehong IR sa Slack mrkdwn, Telegram HTML, at Signal style ranges nang hindi muling nagpa-parse ng Markdown.

## Pipeline

1. **I-parse ang Markdown -> IR**
   - Ang IR ay plain text kasama ang mga style span (bold/italic/strike/code/spoiler) at mga link span.
   - Ang mga offset ay UTF-16 code units para umayon ang Signal style ranges sa API nito.
   - Ang mga table ay pini-parse lamang kapag ang isang channel ay nag-opt in sa table conversion.
2. **I-chunk ang IR (format-first)**
   - Nagaganap ang pag-chunk sa IR text bago ang rendering.
   - Hindi nahahati ang inline formatting sa pagitan ng mga chunk; hinihiwa ang mga span kada chunk.
3. **I-render kada channel**
   - **Slack:** mrkdwn tokens (bold/italic/strike/code), mga link bilang `<url|label>`.
   - **Telegram:** mga HTML tag (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).
   - **Signal:** plain text + mga `text-style` range; ang mga link ay nagiging `label (url)` kapag magkaiba ang label.

## Halimbawa ng IR

Input na Markdown:

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR (iskematiko):

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## Saan ito ginagamit

- Ang mga outbound adapter ng Slack, Telegram, at Signal ay nagre-render mula sa IR.
- Ang ibang channel (WhatsApp, iMessage, MS Teams, Discord) ay gumagamit pa rin ng plain text o
  sarili nilang mga patakaran sa pag-format, na may Markdown table conversion na inilalapat bago
  ang pag-chunk kapag naka-enable.

## Paghawak ng table

Ang mga Markdown table ay hindi pare-parehong sinusuportahan sa iba’t ibang chat client. Gamitin ang
`markdown.tables` upang kontrolin ang conversion kada channel (at kada account).

- `code`: i-render ang mga table bilang code block (default para sa karamihan ng channel).
- `bullets`: i-convert ang bawat row bilang bullet points (default para sa Signal + WhatsApp).
- `off`: i-disable ang pag-parse at conversion ng table; dadaan lang ang raw table text.

Mga config key:

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

## Mga tuntunin sa pag-chunk

- Ang mga limit ng chunk ay nagmumula sa mga channel adapter/config at inilalapat sa IR text.
- Ang mga code fence ay pinananatili bilang iisang block na may trailing newline para ma-render
  nang tama ng mga channel.
- Ang mga prefix ng list at blockquote ay bahagi ng IR text, kaya hindi nahahati ang pag-chunk sa gitna ng prefix.
- Ang mga inline style (bold/italic/strike/inline-code/spoiler) ay hindi kailanman nahahati sa pagitan ng mga chunk; muling binubuksan ng renderer ang mga style sa loob ng bawat chunk.

Kung kailangan mo ng higit pang detalye tungkol sa behavior ng pag-chunk sa iba’t ibang channel, tingnan ang
[Streaming + chunking](/concepts/streaming).

## Patakaran sa link

- **Slack:** `[label](url)` -> `<url|label>`; nananatiling bare ang mga bare URL. Ang autolink
  ay naka-disable habang nagpa-parse upang maiwasan ang double-linking.
- **Telegram:** `[label](url)` -> `<a href="url">label</a>` (HTML parse mode).
- **Signal:** `[label](url)` -> `label (url)` maliban kung tumutugma ang label sa URL.

## Mga spoiler

Ang mga spoiler marker (`||spoiler||`) ay pina-parse lamang para sa Signal, kung saan sila ay mina-map sa
SPOILER style ranges. Tinatrato ng ibang channel ang mga ito bilang plain text.

## Paano magdagdag o mag-update ng channel formatter

1. **Mag-parse nang isang beses:** gamitin ang shared `markdownToIR(...)` helper na may mga opsyong angkop sa channel
   (autolink, heading style, blockquote prefix).
2. **Mag-render:** mag-implement ng renderer gamit ang `renderMarkdownWithMarkers(...)` at isang
   style marker map (o Signal style ranges).
3. **Mag-chunk:** tawagin ang `chunkMarkdownIR(...)` bago mag-render; i-render ang bawat chunk.
4. **I-wire ang adapter:** i-update ang outbound adapter ng channel para gamitin ang bagong chunker
   at renderer.
5. **Mag-test:** magdagdag o mag-update ng mga format test at isang outbound delivery test kung ang
   channel ay gumagamit ng pag-chunk.

## Mga karaniwang gotcha

- Ang mga Slack angle-bracket token (`<@U123>`, `<#C123>`, `<https://...>`) ay dapat
  mapanatili; ligtas na i-escape ang raw HTML.
- Kinakailangan ng Telegram HTML ang pag-escape ng text sa labas ng mga tag para maiwasan ang sirang markup.
- Ang mga Signal style range ay umaasa sa UTF-16 offset; huwag gumamit ng code point offset.
- Panatilihin ang mga trailing newline para sa mga fenced code block para mapunta ang mga closing marker sa sarili nilang linya.
