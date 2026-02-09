---
summary: "„Agentengesteuertes Canvas-Panel, eingebettet über WKWebView + benutzerdefiniertes URL-Schema“"
read_when:
  - Implementierung des macOS-Canvas-Panels
  - Hinzufügen von Agentensteuerungen für visuelle Arbeitsbereiche
  - Debugging von WKWebView-Canvas-Ladevorgängen
title: "„Canvas“"
---

# Canvas (macOS-App)

Die macOS-App bettet ein agentengesteuertes **Canvas-Panel** mithilfe von `WKWebView` ein. Es
ist ein leichtgewichtiger visueller Arbeitsbereich für HTML/CSS/JS, A2UI und kleine interaktive
UI-Oberflächen.

## Wo Canvas gespeichert ist

Der Canvas-Zustand wird unter „Application Support“ gespeichert:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Das Canvas-Panel stellt diese Dateien über ein **benutzerdefiniertes URL-Schema** bereit:

- `openclaw-canvas://<session>/<path>`

Beispiele:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

Wenn im Stammverzeichnis keine `index.html` vorhanden ist, zeigt die App eine **integrierte Scaffold-Seite** an.

## Verhalten des Panels

- Rahmenloses, in der Größe veränderbares Panel, verankert nahe der Menüleiste (oder am Mauszeiger).
- Merkt sich Größe/Position pro Sitzung.
- Lädt automatisch neu, wenn sich lokale Canvas-Dateien ändern.
- Es ist jeweils nur ein Canvas-Panel sichtbar (die Sitzung wird bei Bedarf gewechselt).

Canvas kann in den Einstellungen → **Allow Canvas** deaktiviert werden. Wenn deaktiviert, geben Canvas-
Node-Befehle `CANVAS_DISABLED` zurück.

## Agent-API-Oberfläche

Canvas wird über den **Gateway WebSocket** bereitgestellt, sodass der Agent Folgendes kann:

- das Panel ein-/ausblenden
- zu einem Pfad oder einer URL navigieren
- JavaScript auswerten
- ein Snapshot-Bild erfassen

CLI-Beispiele:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

Hinweise:

- `canvas.navigate` akzeptiert **lokale Canvas-Pfade**, `http(s)`-URLs und `file://`-URLs.
- Wenn Sie `"/"` übergeben, zeigt Canvas das lokale Scaffold oder `index.html` an.

## A2UI in Canvas

A2UI wird vom Gateway-Canvas-Host gehostet und innerhalb des Canvas-Panels gerendert.
Wenn das Gateway einen Canvas-Host ankündigt, navigiert die macOS-App beim ersten Öffnen automatisch zur
A2UI-Host-Seite.

Standard-A2UI-Host-URL:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### A2UI-Befehle (v0.8)

Canvas akzeptiert derzeit **A2UI v0.8** Server→Client-Nachrichten:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) wird nicht unterstützt.

CLI-Beispiel:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Schneller Smoke-Test:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Auslösen von Agent-Läufen aus Canvas

Canvas kann neue Agent-Läufe über Deep Links auslösen:

- `openclaw://agent?...`

Beispiel (in JS):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

Die App fordert eine Bestätigung an, sofern kein gültiger Schlüssel bereitgestellt wird.

## Sicherheitshinweise

- Das Canvas-Schema blockiert Directory Traversal; Dateien müssen unterhalb des Sitzungs-Root liegen.
- Lokale Canvas-Inhalte verwenden ein benutzerdefiniertes Schema (kein local loopback-Server erforderlich).
- Externe `http(s)`-URLs sind nur erlaubt, wenn explizit zu ihnen navigiert wird.
