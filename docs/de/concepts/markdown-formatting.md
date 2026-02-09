---
summary: "Markdown-Formatierungspipeline für ausgehende Kanäle"
read_when:
  - Sie ändern die Markdown-Formatierung oder das Chunking für ausgehende Kanäle
  - Sie fügen einen neuen Kanal-Formatter oder eine Stilzuordnung hinzu
  - Sie debuggen Formatierungsregressionen über Kanäle hinweg
title: "Markdown-Formatierung"
---

# Markdown-Formatierung

OpenClaw formatiert ausgehendes Markdown, indem es vor dem Rendern kanalspezifischer Ausgabe in eine gemeinsame Zwischenrepräsentation (IR) konvertiert wird. Die IR hält den Quelltext unverändert und trägt gleichzeitig Stil-/Link-Spannen, sodass Chunking und Rendering kanalübergreifend konsistent bleiben.

## Ziele

- **Konsistenz:** ein Parse-Schritt, mehrere Renderer.
- **Sicheres Chunking:** Text vor dem Rendern aufteilen, sodass Inline-Formatierung niemals über Chunk-Grenzen hinweg bricht.
- **Kanaltauglichkeit:** dieselbe IR auf Slack mrkdwn, Telegram HTML und Signal-Stilbereiche abbilden, ohne Markdown erneut zu parsen.

## Pipeline

1. **Markdown parsen -> IR**
   - Die IR besteht aus Klartext plus Stilspannen (fett/kursiv/durchgestrichen/Code/Spoiler) und Link-Spannen.
   - Offsets sind UTF-16-Codeeinheiten, damit Signal-Stilbereiche mit seiner API übereinstimmen.
   - Tabellen werden nur geparst, wenn ein Kanal die Tabellenkonvertierung aktiviert.
2. **IR chunken (format-first)**
   - Das Chunking erfolgt auf dem IR-Text vor dem Rendern.
   - Inline-Formatierung wird nicht über Chunks hinweg geteilt; Spannen werden pro Chunk geschnitten.
3. **Pro Kanal rendern**
   - **Slack:** mrkdwn-Tokens (fett/kursiv/durchgestrichen/Code), Links als `<url|label>`.
   - **Telegram:** HTML-Tags (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).
   - **Signal:** Klartext + `text-style`-Bereiche; Links werden zu `label (url)`, wenn sich das Label unterscheidet.

## IR-Beispiel

Eingabe-Markdown:

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

## Wo es verwendet wird

- Slack-, Telegram- und Signal-Outbound-Adapter rendern aus der IR.
- Andere Kanäle (WhatsApp, iMessage, MS Teams, Discord) verwenden weiterhin Klartext oder
  ihre eigenen Formatierungsregeln; die Markdown-Tabellenkonvertierung wird – wenn aktiviert –
  vor dem Chunking angewendet.

## Tabellenbehandlung

Markdown-Tabellen werden von Chat-Clients nicht einheitlich unterstützt. Verwenden Sie
`markdown.tables`, um die Konvertierung pro Kanal (und pro Account) zu steuern.

- `code`: Tabellen als Codeblöcke rendern (Standard für die meisten Kanäle).
- `bullets`: Jede Zeile in Aufzählungspunkte umwandeln (Standard für Signal + WhatsApp).
- `off`: Tabellenparsing und -konvertierung deaktivieren; der rohe Tabellentext wird durchgereicht.

Konfigurationsschlüssel:

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

## Chunking-Regeln

- Chunk-Limits stammen aus Kanaladaptern/-konfigurationen und werden auf den IR-Text angewendet.
- Code-Fences werden als einzelner Block mit nachgestelltem Zeilenumbruch beibehalten, damit Kanäle sie korrekt rendern.
- Listenpräfixe und Blockquote-Präfixe sind Teil des IR-Texts, sodass das Chunking nicht mitten im Präfix trennt.
- Inline-Stile (fett/kursiv/durchgestrichen/Inline-Code/Spoiler) werden niemals über Chunks hinweg geteilt; der Renderer öffnet Stile innerhalb jedes Chunks erneut.

Wenn Sie mehr zum Chunking-Verhalten über Kanäle hinweg benötigen, siehe
[Streaming + chunking](/concepts/streaming).

## Link-Richtlinie

- **Slack:** `[label](url)` -> `<url|label>`; nackte URLs bleiben nackt. Autolinking
  ist beim Parsen deaktiviert, um doppeltes Verlinken zu vermeiden.
- **Telegram:** `[label](url)` -> `<a href="url">label</a>` (HTML-Parse-Modus).
- **Signal:** `[label](url)` -> `label (url)`, sofern das Label nicht der URL entspricht.

## Spoiler

Spoiler-Markierungen (`||spoiler||`) werden nur für Signal geparst, wo sie auf
SPOILER-Stilbereiche abgebildet werden. Andere Kanäle behandeln sie als Klartext.

## So fügen Sie einen Kanal-Formatter hinzu oder aktualisieren ihn

1. **Einmal parsen:** Verwenden Sie den gemeinsamen `markdownToIR(...)`-Helper mit kanalgerechten
   Optionen (Autolink, Überschriftenstil, Blockquote-Präfix).
2. **Rendern:** Implementieren Sie einen Renderer mit `renderMarkdownWithMarkers(...)` und einer
   Stilmarker-Zuordnung (oder Signal-Stilbereichen).
3. **Chunking:** Rufen Sie `chunkMarkdownIR(...)` vor dem Rendern auf; rendern Sie jeden Chunk.
4. **Adapter verdrahten:** Aktualisieren Sie den Kanal-Outbound-Adapter, um den neuen Chunker
   und Renderer zu verwenden.
5. **Testen:** Fügen Sie Format-Tests hinzu oder aktualisieren Sie sie sowie einen Outbound-Zustelltest,
   falls der Kanal Chunking verwendet.

## Häufige Stolperfallen

- Slack-Winkelklammer-Tokens (`<@U123>`, `<#C123>`, `<https://...>`) müssen
  beibehalten werden; escapen Sie rohes HTML sicher.
- Telegram-HTML erfordert das Escapen von Text außerhalb von Tags, um kaputtes Markup zu vermeiden.
- Signal-Stilbereiche hängen von UTF-16-Offets ab; verwenden Sie keine Codepoint-Offets.
- Behalten Sie abschließende Zeilenumbrüche für eingefasste Codeblöcke bei, damit schließende Marker
  in einer eigenen Zeile landen.
