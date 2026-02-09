---
summary: "Agentstyrd Canvas-panel inbäddad via WKWebView + anpassat URL-schema"
read_when:
  - Implementering av macOS Canvas-panelen
  - Lägga till agentkontroller för visuell arbetsyta
  - Felsökning av WKWebView-inläsningar för Canvas
title: "Canvas"
---

# Canvas (macOS-app)

MacOS appen bäddar in en agentkontrollerad **Canvas panel** med `WKWebView`. Det
är en lätt visuell arbetsyta för HTML/CSS/JS, A2UI och små interaktiva
UI-ytor.

## Var Canvas finns

Canvas-tillstånd lagras under Application Support:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvas-panelen tillhandahåller dessa filer via ett **anpassat URL-schema**:

- `openclaw-canvas://<session>/<path>`

Exempel:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

Om ingen `index.html` finns i roten visar appen en **inbyggd scaffold-sida**.

## Panelbeteende

- Kantlös, storleksändringsbar panel förankrad nära menyraden (eller muspekaren).
- Kommer ihåg storlek/position per session.
- Laddar om automatiskt när lokala canvas-filer ändras.
- Endast en Canvas-panel är synlig åt gången (sessionen växlas vid behov).

Canvas kan inaktiveras från Inställningar → **Tillåt Canvas**. När inaktiverad, kanvas
nod kommandon returnera `CANVAS_DISABLED`.

## Agent-API-yta

Canvas exponeras via **Gateway WebSocket**, så agenten kan:

- visa/dölja panelen
- navigera till en sökväg eller URL
- utvärdera JavaScript
- fånga en ögonblicksbild

CLI-exempel:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

Noteringar:

- `canvas.navigate` accepterar **lokala canvas-sökvägar**, `http(s)`-URL:er och `file://`-URL:er.
- Om du skickar `"/"` visar Canvas den lokala scaffolden eller `index.html`.

## A2UI i Canvas

A2UI är värd för Gateway canvas värd och återges inuti Canvas-panelen.
När Gateway annonserar en Canvas-värd navigerar macOS-appen automatiskt till
A2UI-värdsidan först öppen.

Standard-URL för A2UI-värd:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### A2UI-kommandon (v0.8)

Canvas accepterar för närvarande **A2UI v0.8** server→klient-meddelanden:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) stöds inte.

CLI-exempel:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Snabb rök-test:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Utlösa agentkörningar från Canvas

Canvas kan utlösa nya agentkörningar via djuplänkar:

- `openclaw://agent?...`

Exempel (i JS):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

Appen ber om bekräftelse om inte en giltig nyckel tillhandahålls.

## Säkerhetsnoteringar

- Canvas-schemat blockerar katalogtraversering; filer måste ligga under sessionsroten.
- Lokalt Canvas-innehåll använder ett anpassat schema (ingen local loopback-server krävs).
- Externa `http(s)`-URL:er tillåts endast när de navigeras till explicit.
