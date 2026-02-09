---
summary: "Potok formatowania Markdown dla kanałów wychodzących"
read_when:
  - Zmieniasz formatowanie Markdown lub chunking dla kanałów wychodzących
  - Dodajesz nowy formatter kanału lub mapowanie stylów
  - Debugujesz regresje formatowania między kanałami
title: "Formatowanie Markdown"
---

# Formatowanie Markdown

OpenClaw formatuje wychodzący Markdown, konwertując go do wspólnej pośredniej
reprezentacji (IR) przed renderowaniem wyjścia specyficznego dla kanału. IR
zachowuje tekst źródłowy w nienaruszonym stanie, jednocześnie przenosząc zakresy
stylów/linków, dzięki czemu chunking i renderowanie pozostają spójne między
kanałami.

## Cele

- **Spójność:** jeden etap parsowania, wiele rendererów.
- **Bezpieczny chunking:** dzielenie tekstu przed renderowaniem, aby formatowanie
  inline nigdy nie pękało między chunkami.
- **Dopasowanie do kanału:** mapowanie tego samego IR do mrkdwn Slacka, HTML
  Telegrama i zakresów stylów Signal bez ponownego parsowania Markdown.

## Rurociąg

1. **Parsowanie Markdown -> IR**
   - IR to zwykły tekst plus zakresy stylów (bold/italic/strike/code/spoiler) oraz zakresy linków.
   - Offsety są w jednostkach kodowych UTF-16, aby zakresy stylów Signal były zgodne z jego API.
   - Tabele są parsowane tylko wtedy, gdy kanał zdecyduje się na konwersję tabel.
2. **Chunking IR (najpierw format)**
   - Chunking odbywa się na tekście IR przed renderowaniem.
   - Formatowanie inline nie jest dzielone między chunkami; zakresy są przycinane na chunk.
3. **Renderowanie per kanał**
   - **Slack:** tokeny mrkdwn (bold/italic/strike/code), linki jako `<url|label>`.
   - **Telegram:** tagi HTML (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code>`, `<a href>`).
   - **Signal:** zwykły tekst + zakresy `text-style`; linki stają się `label (url)`, gdy etykieta się różni.

## Przykład IR

Wejściowy Markdown:

```markdown
Hello **world** — see [docs](https://docs.openclaw.ai).
```

IR (schematycznie):

```json
{
  "text": "Hello world — see docs.",
  "styles": [{ "start": 6, "end": 11, "style": "bold" }],
  "links": [{ "start": 19, "end": 23, "href": "https://docs.openclaw.ai" }]
}
```

## Gdzie jest używany

- Adaptery wyjściowe Slack, Telegram i Signal renderują z IR.
- Inne kanały (WhatsApp, iMessage, Microsoft Teams, Discord) nadal używają zwykłego
  tekstu lub własnych reguł formatowania, przy czym konwersja tabel Markdown jest
  stosowana przed chunkingiem, gdy jest włączona.

## Obsługa tabel

Tabele Markdown nie są spójnie wspierane w różnych klientach czatu. Użyj
`markdown.tables`, aby kontrolować konwersję per kanał (i per konto).

- `code`: renderuj tabele jako bloki kodu (domyślnie dla większości kanałów).
- `bullets`: konwertuj każdy wiersz na punkty listy (domyślnie dla Signal + WhatsApp).
- `off`: wyłącz parsowanie i konwersję tabel; surowy tekst tabeli przechodzi bez zmian.

Klucze konfiguracji:

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

## Zasady chunkingu

- Limity chunków pochodzą z adapterów kanałów/konfiguracji i są stosowane do tekstu IR.
- Ogrodzenia kodu (code fences) są zachowywane jako pojedynczy blok z końcowym znakiem
  nowej linii, aby kanały renderowały je poprawnie.
- Prefiksy list i cytatów blokowych są częścią tekstu IR, więc chunking nie dzieli
  ich w połowie prefiksu.
- Style inline (bold/italic/strike/inline-code/spoiler) nigdy nie są dzielone między
  chunkami; renderer ponownie otwiera style wewnątrz każdego chunku.

Jeśli potrzebujesz więcej informacji o zachowaniu chunkingu między kanałami, zobacz
[Streaming + chunking](/concepts/streaming).

## Polityka linków

- **Slack:** `[label](url)` -> `<url|label>`; nagie URL-e pozostają nagie. Autolink
  jest wyłączony podczas parsowania, aby uniknąć podwójnego linkowania.
- **Telegram:** `[label](url)` -> `<a href="url">label</a>` (tryb parsowania HTML).
- **Signal:** `[label](url)` -> `label (url)`, chyba że etykieta jest taka sama jak URL.

## Spoilery

Znaczniki spoilerów (`||spoiler||`) są parsowane tylko dla Signal, gdzie mapują się
na zakresy stylu SPOILER. Inne kanały traktują je jako zwykły tekst.

## Jak dodać lub zaktualizować formatter kanału

1. **Parsuj raz:** użyj wspólnego pomocnika `markdownToIR(...)` z opcjami odpowiednimi
   dla kanału (autolink, styl nagłówków, prefiks cytatu).
2. **Renderuj:** zaimplementuj renderer z `renderMarkdownWithMarkers(...)` oraz mapą znaczników stylów
   (lub zakresami stylów Signal).
3. **Chunkuj:** wywołaj `chunkMarkdownIR(...)` przed renderowaniem; renderuj każdy chunk.
4. **Podłącz adapter:** zaktualizuj adapter wyjściowy kanału, aby używał nowego
   chunkera i renderera.
5. **Testuj:** dodaj lub zaktualizuj testy formatowania oraz test dostarczania
   wyjściowego, jeśli kanał używa chunkingu.

## Czubacz zwyczajny

- Tokeny Slacka w nawiasach ostrych (`<@U123>`, `<#C123>`, `<https://...>`) muszą być
  zachowane; bezpiecznie escapuj surowy HTML.
- HTML Telegrama wymaga escapowania tekstu poza tagami, aby uniknąć uszkodzonego markup.
- Zakresy stylów Signal zależą od offsetów UTF-16; nie używaj offsetów punktów kodowych.
- Zachowuj końcowe znaki nowej linii dla bloków kodu w ogrodzeniach, aby znaczniki
  zamykające lądowały w osobnej linii.
