---
summary: "Markdown-formateringspipeline for udgående kanaler"
read_when:
  - Du ændrer markdown-formatering eller chunking for udgående kanaler
  - Du tilføjer en ny kanalformatter eller style-mapping
  - Du fejlsøger formateringsregressioner på tværs af kanaler
title: "Markdown-formatering"
---

# Markdown-formatering

OpenClaw formater udgående Markdown ved at konvertere det til en delt mellemliggende
repræsentation (IR) før rendering kanal-specifik output. IR holder
kildeteksten intakt, mens du bærer stil/link spænder så chunking og rendering kan
forblive konsekvent på tværs af kanaler.

## Mål

- **Konsistens:** ét parse-trin, flere renderere.
- **Sikker chunking:** opdel tekst før rendering, så inline-formatering aldrig
  brydes på tværs af chunks.
- **Kanaltilpasning:** map den samme IR til Slack mrkdwn, Telegram HTML og Signal
  style ranges uden at genparse Markdown.

## Pipeline

1. **Parse Markdown -> IR**
   - IR er almindelig tekst plus style-spans (fed/kursiv/gennemstreget/kode/spoiler) og link-spans.
   - Offsets er UTF-16-kodeenheder, så Signal style ranges stemmer overens med deres API.
   - Tabeller parses kun, når en kanal tilvælger tabelkonvertering.
2. **Chunk IR (format-first)**
   - Chunking sker på IR-teksten før rendering.
   - Inline-formatering opdeles ikke på tværs af chunks; spans skæres pr. chunk.
3. **Render pr. kanal**
   - **Slack:** mrkdwn-tokens (fed/kursiv/gennemstreget/kode), links som `<url|label>`.
   - **Telegram:** HTML-tags (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).
   - **Signal:** almindelig tekst + `text-style` ranges; links bliver til `label (url)`, når label adskiller sig.

## IR-eksempel

Input Markdown:

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR (skematisk):

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## Hvor det bruges

- Slack-, Telegram- og Signal-udgående adaptere renderer fra IR’en.
- Andre kanaler (WhatsApp, iMessage, MS Teams, Discord) bruger stadig almindelig tekst eller
  deres egne formateringsregler, med Markdown-tabelkonvertering anvendt før
  chunking, når det er aktiveret.

## Tabelhåndtering

Markdown tabeller understøttes ikke konsekvent på tværs af chat-klienter. Brug
`markdown.tables` til at styre konvertering pr. kanal (og pr. konto).

- `code`: render tabeller som kodeblokke (standard for de fleste kanaler).
- `bullets`: konvertér hver række til punktopstillinger (standard for Signal + WhatsApp).
- `off`: deaktivér tabelparsing og -konvertering; rå tabeltekst sendes igennem.

Konfigurationsnøgler:

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

- Chunk-grænser kommer fra kanaladaptere/konfiguration og anvendes på IR-teksten.
- Code fences bevares som én samlet blok med en afsluttende linjeskift, så kanaler
  renderer dem korrekt.
- Listepræfikser og blockquote-præfikser er en del af IR-teksten, så chunking
  ikke splitter midt i et præfiks.
- Inline-styles (fed/kursiv/gennemstreget/inline-kode/spoiler) opdeles aldrig på tværs af
  chunks; rendereren genåbner styles inde i hver chunk.

Hvis du har brug for mere om chunking-adfærd på tværs af kanaler, se
[Streaming + chunking](/concepts/streaming).

## Linkpolitik

- **Slack:** `[label](url)` -> `<url|label>`; nøgne URLer forbliver bare. Autolink
  er deaktiveret under parse for at undgå dobbelt-forbindelse.
- **Telegram:** `[label](url)` -> `<a href="url">label</a>` (HTML-parse-tilstand).
- **Signal:** `[label](url)` -> `label (url)`, medmindre label matcher URL’en.

## Spoilers

Spoilermarkører (`° = spøgelsesskrævende `) er kun fortolket til Signal, hvor de kortlægger til
SPOILER-stilområder. Andre kanaler behandler dem som almindelig tekst.

## Sådan tilføjer eller opdaterer du en kanalformatter

1. **Parse én gang:** brug den fælles `markdownToIR(...)`-helper med kanalpassende
   indstillinger (autolink, overskriftsstil, blockquote-præfiks).
2. **Render:** implementér en renderer med `renderMarkdownWithMarkers(...)` og et
   style marker-map (eller Signal style ranges).
3. **Chunk:** kald `chunkMarkdownIR(...)` før rendering; render hver chunk.
4. **Tilslut adapter:** opdatér den udgående kanaladapter til at bruge den nye chunker
   og renderer.
5. **Test:** tilføj eller opdatér formattests og en udgående leveringstest, hvis
   kanalen bruger chunking.

## Almindelige faldgruber

- Slack angle-bracket-tokens (`<@U123>`, `<#C123>`, `<https://...>`) skal
  bevares; escap rå HTML sikkert.
- Telegram HTML kræver escaping af tekst uden for tags for at undgå ødelagt markup.
- Signal style ranges afhænger af UTF-16-offsets; brug ikke kodepunkt-offsets.
- Bevar afsluttende linjeskift for fenced code blocks, så afsluttende markører
  lander på deres egen linje.
