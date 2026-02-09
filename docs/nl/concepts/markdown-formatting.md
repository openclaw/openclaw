---
summary: "Markdown-opmaakpipeline voor uitgaande kanalen"
read_when:
  - Je wijzigt markdown-opmaak of chunking voor uitgaande kanalen
  - Je voegt een nieuwe kanaalformatter of stijlkoppeling toe
  - Je debugt regressies in opmaak over kanalen heen
title: "Markdown opmaak"
---

# Markdown opmaak

OpenClaw formatteert uitgaande Markdown door deze eerst om te zetten naar een gedeelde
tussenrepresentatie (IR) voordat kanaalspecifieke uitvoer wordt gerenderd. De IR houdt de
brontekst intact en bevat stijl-/linkspans, zodat chunking en rendering consistent kunnen
blijven over kanalen heen.

## Doelen

- **Consistentie:** één parse-stap, meerdere renderers.
- **Veilige chunking:** splits tekst vóór het renderen, zodat inline-opmaak nooit
  over chunks heen breekt.
- **Kanaalgeschiktheid:** koppel dezelfde IR aan Slack mrkdwn, Telegram HTML en Signal
  stijlb ranges zonder Markdown opnieuw te parsen.

## Pipeline

1. **Parse Markdown -> IR**
   - IR is platte tekst plus stijlspans (vet/cursief/doorhalen/code/spoiler) en linkspans.
   - Offsets zijn UTF-16-code-eenheden zodat Signal-stijlranges uitlijnen met de API.
   - Tabellen worden alleen geparsed wanneer een kanaal expliciet kiest voor tabelconversie.
2. **Chunk IR (format-first)**
   - Chunking gebeurt op de IR-tekst vóór het renderen.
   - Inline-opmaak splitst niet over chunks; spans worden per chunk gesliced.
3. **Render per kanaal**
   - **Slack:** mrkdwn-tokens (vet/cursief/doorhalen/code), links als `<url|label>`.
   - **Telegram:** HTML-tags (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).
   - **Signal:** platte tekst + `text-style`-ranges; links worden `label (url)` wanneer het label afwijkt.

## IR-voorbeeld

Invoer-Markdown:

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR (schematisch):

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## Waar het wordt gebruikt

- Slack-, Telegram- en Signal-uitgaande adapters renderen vanuit de IR.
- Andere kanalen (WhatsApp, iMessage, MS Teams, Discord) gebruiken nog platte tekst of
  hun eigen opmaakregels, waarbij Markdown-tabelconversie vóór chunking wordt toegepast
  wanneer ingeschakeld.

## Tabelafhandeling

Markdown-tabellen worden niet consistent ondersteund in chatclients. Gebruik
`markdown.tables` om conversie per kanaal (en per account) te regelen.

- `code`: render tabellen als codeblokken (standaard voor de meeste kanalen).
- `bullets`: converteer elke rij naar opsommingstekens (standaard voor Signal + WhatsApp).
- `off`: schakel tabelparsing en -conversie uit; ruwe tabeltekst wordt doorgegeven.

Config-sleutels:

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

## Chunking-regels

- Chunklimieten komen van kanaaladapters/config en worden toegepast op de IR-tekst.
- Code fences blijven behouden als één blok met een afsluitende nieuwe regel, zodat
  kanalen ze correct renderen.
- Lijstprefixen en blockquote-prefixen maken deel uit van de IR-tekst, zodat chunking
  niet midden in een prefix splitst.
- Inline-stijlen (vet/cursief/doorhalen/inline-code/spoiler) worden nooit over chunks
  gesplitst; de renderer opent stijlen opnieuw binnen elke chunk.

Als je meer nodig hebt over chunking-gedrag over kanalen heen, zie
[Streaming + chunking](/concepts/streaming).

## Linkbeleid

- **Slack:** `[label](url)` -> `<url|label>`; kale URL’s blijven kaal. Autolink
  is tijdens het parsen uitgeschakeld om dubbel linken te voorkomen.
- **Telegram:** `[label](url)` -> `<a href="url">label</a>` (HTML-parsemodus).
- **Signal:** `[label](url)` -> `label (url)` tenzij het label overeenkomt met de URL.

## Spoilers

Spoiler-markeringen (`||spoiler||`) worden alleen geparsed voor Signal, waar ze worden
gekoppeld aan SPOILER-stijlranges. Andere kanalen behandelen ze als platte tekst.

## Een kanaalformatter toevoegen of bijwerken

1. **Eenmalig parsen:** gebruik de gedeelde `markdownToIR(...)`-helper met
   kanaalgeschikte opties (autolink, kopstijl, blockquote-prefix).
2. **Renderen:** implementeer een renderer met `renderMarkdownWithMarkers(...)` en een
   stijlpuntkaart (of Signal-stijlranges).
3. **Chunken:** roep `chunkMarkdownIR(...)` aan vóór het renderen; render elke chunk.
4. **Adapter koppelen:** werk de uitgaande kanaaladapter bij om de nieuwe chunker
   en renderer te gebruiken.
5. **Testen:** voeg format-tests toe of werk ze bij, en een uitgaande leveringstest
   als het kanaal chunking gebruikt.

## Veelvoorkomende hebbers

- Slack-haakjes-tokens (`<@U123>`, `<#C123>`, `<https://...>`) moeten behouden
  blijven; escape ruwe HTML veilig.
- Telegram-HTML vereist het escapen van tekst buiten tags om kapotte markup te voorkomen.
- Signal-stijlranges zijn afhankelijk van UTF-16-offsets; gebruik geen codepunt-offsets.
- Behoud afsluitende nieuwe regels voor fenced code blocks, zodat sluitmarkeringen
  op hun eigen regel terechtkomen.
