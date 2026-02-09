---
summary: "„Panel Canvas sterowany przez agenta, osadzony przez WKWebView + niestandardowy schemat URL”"
read_when:
  - Implementacja panelu Canvas w macOS
  - Dodawanie sterowania agenta dla wizualnego obszaru roboczego
  - Debugowanie ładowań Canvas w WKWebView
title: "„Canvas”"
---

# Canvas (aplikacja macOS)

Aplikacja macOS osadza sterowany przez agenta **panel Canvas** za pomocą `WKWebView`. Jest to lekki wizualny obszar roboczy dla HTML/CSS/JS, A2UI oraz niewielkich interaktywnych powierzchni UI.

## Gdzie znajduje się Canvas

Stan Canvas jest przechowywany w Application Support:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Panel Canvas udostępnia te pliki przez **niestandardowy schemat URL**:

- `openclaw-canvas://<session>/<path>`

Przykłady:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

Jeśli w katalogu głównym nie istnieje `index.html`, aplikacja wyświetla **wbudowaną stronę szkieletową**.

## Zachowanie panelu

- Bezramkowy, skalowalny panel zakotwiczony w pobliżu paska menu (lub kursora myszy).
- Zapamiętuje rozmiar/położenie na sesję.
- Automatycznie przeładowuje się po zmianach lokalnych plików Canvas.
- W danym momencie widoczny jest tylko jeden panel Canvas (sesja jest przełączana w razie potrzeby).

Canvas można wyłączyć w Ustawieniach → **Allow Canvas**. Po wyłączeniu polecenia węzła Canvas zwracają `CANVAS_DISABLED`.

## Powierzchnia API agenta

Canvas jest udostępniany przez **Gateway WebSocket**, dzięki czemu agent może:

- pokazywać/ukrywać panel
- nawigować do ścieżki lub URL
- wykonywać JavaScript
- przechwytywać obraz migawki

Przykłady CLI:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

Uwagi:

- `canvas.navigate` akceptuje **lokalne ścieżki Canvas**, adresy URL `http(s)` oraz adresy URL `file://`.
- Jeśli przekażesz `"/"`, Canvas wyświetli lokalny szkielet lub `index.html`.

## A2UI w Canvas

A2UI jest hostowane przez host Canvas Gateway i renderowane wewnątrz panelu Canvas.
Gdy Gateway ogłasza host Canvas, aplikacja macOS automatycznie nawiguję do strony hosta A2UI przy pierwszym otwarciu.

Domyślny URL hosta A2UI:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### Polecenia A2UI (v0.8)

Canvas obecnie akceptuje komunikaty serwer→klient **A2UI v0.8**:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) nie jest obsługiwane.

Przykład CLI:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Szybki dym:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Wyzwalanie uruchomień agenta z Canvas

Canvas może wyzwalać nowe uruchomienia agenta za pomocą deep linków:

- `openclaw://agent?...`

Przykład (w JS):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

Aplikacja prosi o potwierdzenie, chyba że zostanie podany prawidłowy klucz.

## Uwagi dotyczące bezpieczeństwa

- Schemat Canvas blokuje przechodzenie po katalogach; pliki muszą znajdować się pod katalogiem głównym sesji.
- Lokalna zawartość Canvas używa niestandardowego schematu (serwer loopback nie jest wymagany).
- Zewnętrzne adresy URL `http(s)` są dozwolone tylko przy jawnej nawigacji.
