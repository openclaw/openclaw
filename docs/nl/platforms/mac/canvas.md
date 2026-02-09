---
summary: "Door agent aangestuurd Canvas-paneel ingebed via WKWebView + aangepast URL-schema"
read_when:
  - Implementatie van het macOS Canvas-paneel
  - Agentbediening toevoegen voor een visuele werkruimte
  - Debuggen van WKWebView Canvas-ladingen
title: "Canvas"
---

# Canvas (macOS-app)

De macOS-app embedt een door agent aangestuurd **Canvas-paneel** met behulp van `WKWebView`. Het
is een lichtgewicht visuele werkruimte voor HTML/CSS/JS, A2UI en kleine interactieve
UI-oppervlakken.

## Waar Canvas zich bevindt

De Canvas-status wordt opgeslagen onder Application Support:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Het Canvas-paneel bedient deze bestanden via een **aangepast URL-schema**:

- `openclaw-canvas://<session>/<path>`

Voorbeelden:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

Als er geen `index.html` bestaat in de root, toont de app een **ingebouwde scaffold-pagina**.

## Paneelgedrag

- Randloos, schaalbaar paneel verankerd nabij de menubalk (of de muiscursor).
- Onthoudt grootte/positie per sessie.
- Herlaadt automatisch wanneer lokale canvasbestanden wijzigen.
- Er is slechts één Canvas-paneel tegelijk zichtbaar (de sessie wordt zo nodig gewisseld).

Canvas kan worden uitgeschakeld via Instellingen → **Canvas toestaan**. Wanneer uitgeschakeld, retourneren canvas
node-opdrachten `CANVAS_DISABLED`.

## Agent-API-oppervlak

Canvas wordt beschikbaar gesteld via de **Gateway WebSocket**, zodat de agent kan:

- het paneel tonen/verbergen
- navigeren naar een pad of URL
- JavaScript evalueren
- een snapshotafbeelding vastleggen

CLI-voorbeelden:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

Notities:

- `canvas.navigate` accepteert **lokale canvaspaden**, `http(s)`-URL's en `file://`-URL's.
- Als je `"/"` doorgeeft, toont Canvas de lokale scaffold of `index.html`.

## A2UI in Canvas

A2UI wordt gehost door de Gateway canvas-host en gerenderd binnen het Canvas-paneel.
Wanneer de Gateway een Canvas-host adverteert, navigeert de macOS-app bij de eerste opening automatisch naar de
A2UI-hostpagina.

Standaard A2UI-host-URL:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### A2UI-opdrachten (v0.8)

Canvas accepteert momenteel **A2UI v0.8** server→client-berichten:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) wordt niet ondersteund.

CLI-voorbeeld:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Snelle rooktest:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Agent-runs triggeren vanuit Canvas

Canvas kan nieuwe agent-runs triggeren via deep links:

- `openclaw://agent?...`

Voorbeeld (in JS):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

De app vraagt om bevestiging tenzij een geldige sleutel wordt meegegeven.

## Beveiligingsnotities

- Het Canvas-schema blokkeert directory traversal; bestanden moeten onder de sessieroot staan.
- Lokale Canvas-inhoud gebruikt een aangepast schema (geen local loopback-server vereist).
- Externe `http(s)`-URL's zijn alleen toegestaan wanneer er expliciet naartoe wordt genavigeerd.
