---
summary: "Markdown-formateringspipeline för utgående kanaler"
read_when:
  - Du ändrar Markdown-formatering eller chunking för utgående kanaler
  - Du lägger till en ny kanalformatterare eller stilmappning
  - Du felsöker formateringsregressioner mellan kanaler
title: "Markdown-formatering"
x-i18n:
  source_path: concepts/markdown-formatting.md
  source_hash: f9cbf9b744f9a218
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:59Z
---

# Markdown-formatering

OpenClaw formaterar utgående Markdown genom att konvertera den till en gemensam intermediär representation (IR) innan kanalspecifik utdata renderas. IR behåller källtexten intakt samtidigt som den bär stil-/länkspann, så att chunking och rendering kan förbli konsekventa mellan kanaler.

## Mål

- **Konsekvens:** ett parssteg, flera renderare.
- **Säker chunking:** dela text före rendering så att inline-formatering aldrig bryts mellan chunkar.
- **Kanalanpassning:** mappa samma IR till Slack mrkdwn, Telegram HTML och Signal-stilintervall utan att parsa Markdown på nytt.

## Pipeline

1. **Parsa Markdown -> IR**
   - IR är vanlig text plus stilspann (fet/kursiv/genomstruken/kod/spoiler) och länkspann.
   - Offsetar är UTF-16-kodenheter så att Signal-stilintervall linjerar med dess API.
   - Tabeller parsas endast när en kanal väljer att delta i tabellkonvertering.
2. **Chunka IR (format-först)**
   - Chunking sker på IR-texten före rendering.
   - Inline-formatering delas inte mellan chunkar; spann skärs per chunk.
3. **Rendera per kanal**
   - **Slack:** mrkdwn-tokens (fet/kursiv/genomstruken/kod), länkar som `<url|label>`.
   - **Telegram:** HTML-taggar (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).
   - **Signal:** vanlig text + `text-style`-intervall; länkar blir `label (url)` när etiketten skiljer sig.

## IR-exempel

Indata Markdown:

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR (schematiskt):

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## Var den används

- Utgående adaptrar för Slack, Telegram och Signal renderar från IR.
- Andra kanaler (WhatsApp, iMessage, MS Teams, Discord) använder fortfarande vanlig text eller sina egna formateringsregler, med Markdown-tabellkonvertering tillämpad före chunking när den är aktiverad.

## Tabellhantering

Markdown-tabeller stöds inte konsekvent mellan chattklienter. Använd
`markdown.tables` för att styra konvertering per kanal (och per konto).

- `code`: rendera tabeller som kodblock (standard för de flesta kanaler).
- `bullets`: konvertera varje rad till punktlistor (standard för Signal + WhatsApp).
- `off`: inaktivera tabellparsning och konvertering; rå tabelltext passerar igenom.

Konfig-nycklar:

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

## Chunking-regler

- Chunkgränser kommer från kanaladaptrar/konfig och tillämpas på IR-texten.
- Kodstaket bevaras som ett enda block med en avslutande nyrad så att kanaler renderar dem korrekt.
- Listprefix och blockquote-prefix är en del av IR-texten, så chunking delar inte mitt i ett prefix.
- Inline-stilar (fet/kursiv/genomstruken/inline-kod/spoiler) delas aldrig mellan chunkar; renderaren öppnar stilar igen inuti varje chunk.

Om du behöver mer om chunking-beteende mellan kanaler, se
[Streaming + chunking](/concepts/streaming).

## Länkpolicy

- **Slack:** `[label](url)` -> `<url|label>`; nakna URL:er förblir nakna. Autolänkning är inaktiverad under parsning för att undvika dubbellänkning.
- **Telegram:** `[label](url)` -> `<a href="url">label</a>` (HTML-parsläge).
- **Signal:** `[label](url)` -> `label (url)` om inte etiketten matchar URL:en.

## Spoilers

Spoilermarkörer (`||spoiler||`) parsas endast för Signal, där de mappas till SPOILER-stilintervall. Andra kanaler behandlar dem som vanlig text.

## Hur man lägger till eller uppdaterar en kanalformatterare

1. **Parsa en gång:** använd den delade hjälparen `markdownToIR(...)` med kanal-lämpliga alternativ (autolänkning, rubrikstil, blockquote-prefix).
2. **Rendera:** implementera en renderare med `renderMarkdownWithMarkers(...)` och en stilmärkesmapp (eller Signal-stilintervall).
3. **Chunka:** anropa `chunkMarkdownIR(...)` före rendering; rendera varje chunk.
4. **Koppla adapter:** uppdatera den utgående kanaladaptern för att använda den nya chunkern och renderaren.
5. **Testa:** lägg till eller uppdatera format-tester och ett utgående leveranstest om kanalen använder chunking.

## Vanliga fallgropar

- Slack-vinkelparentes-tokens (`<@U123>`, `<#C123>`, `<https://...>`) måste bevaras; escapa rå HTML säkert.
- Telegram HTML kräver escapning av text utanför taggar för att undvika trasig markup.
- Signal-stilintervall beror på UTF-16-offsetar; använd inte kodpunkts-offsetar.
- Bevara avslutande nyrader för inhägnade kodblock så att stängningsmarkörer hamnar på sin egen rad.
