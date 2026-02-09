---
summary: "iOS-Node-App: Verbindung zum Gateway, Pairing, Canvas und Fehlerbehebung"
read_when:
  - Pairing oder erneutes Verbinden des iOS-Nodes
  - Ausführen der iOS-App aus dem Quellcode
  - Debugging der Gateway-Discovery oder von Canvas-Befehlen
title: "iOS-App"
---

# iOS-App (Node)

Verfügbarkeit: interne Vorschau. Die iOS-App wird derzeit noch nicht öffentlich verteilt.

## Was sie tut

- Stellt eine Verbindung zu einem Gateway über WebSocket her (LAN oder Tailnet).
- Stellt Node-Funktionen bereit: Canvas, Bildschirm-Snapshot, Kameraaufnahme, Standort, Talk-Modus, Sprachaktivierung.
- Empfängt `node.invoke`-Befehle und meldet Node-Statusereignisse.

## Anforderungen

- Gateway läuft auf einem anderen Gerät (macOS, Linux oder Windows über WSL2).
- Netzwerkpfad:
  - Gleiches LAN über Bonjour, **oder**
  - Tailnet über Unicast-DNS-SD (Beispieldomain: `openclaw.internal.`), **oder**
  - Manueller Host/Port (Fallback).

## Schnellstart (Pairing + Verbinden)

1. Starten Sie das Gateway:

```bash
openclaw gateway --port 18789
```

2. Öffnen Sie in der iOS-App die Einstellungen und wählen Sie ein gefundenes Gateway aus (oder aktivieren Sie „Manual Host“ und geben Sie Host/Port ein).

3. Genehmigen Sie die Pairing-Anfrage auf dem Gateway-Host:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. Verbindung prüfen:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Discovery-Pfade

### Bonjour (LAN)

Das Gateway kündigt `_openclaw-gw._tcp` auf `local.` an. Die iOS-App listet diese automatisch auf.

### Tailnet (netzwerkübergreifend)

Wenn mDNS blockiert ist, verwenden Sie eine Unicast-DNS-SD-Zone (wählen Sie eine Domain; Beispiel: `openclaw.internal.`) und Tailscale Split DNS.
Siehe [Bonjour](/gateway/bonjour) für das CoreDNS-Beispiel.

### Manueller Host/Port

Aktivieren Sie in den Einstellungen **Manual Host** und geben Sie den Gateway-Host + Port ein (Standard `18789`).

## Canvas + A2UI

Der iOS-Node rendert ein WKWebView-Canvas. Verwenden Sie `node.invoke`, um es zu steuern:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

Hinweise:

- Der Gateway-Canvas-Host stellt `/__openclaw__/canvas/` und `/__openclaw__/a2ui/` bereit.
- Der iOS-Node navigiert bei Verbindung automatisch zu A2UI, wenn eine Canvas-Host-URL angekündigt wird.
- Kehren Sie mit `canvas.navigate` und `{"url":""}` zur integrierten Scaffold-Ansicht zurück.

### Canvas eval / Snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Sprachaktivierung + Talk-Modus

- Sprachaktivierung und Talk-Modus sind in den Einstellungen verfügbar.
- iOS kann Hintergrundaudio anhalten; behandeln Sie Sprachfunktionen als Best-Effort, wenn die App nicht aktiv ist.

## Häufige Fehler

- `NODE_BACKGROUND_UNAVAILABLE`: Bringen Sie die iOS-App in den Vordergrund (Canvas-/Kamera-/Bildschirmbefehle erfordern dies).
- `A2UI_HOST_NOT_CONFIGURED`: Das Gateway hat keine Canvas-Host-URL angekündigt; prüfen Sie `canvasHost` in der [Gateway-Konfiguration](/gateway/configuration).
- Pairing-Eingabeaufforderung erscheint nie: führen Sie `openclaw nodes pending` aus und genehmigen Sie manuell.
- Wiederverbinden schlägt nach Neuinstallation fehl: Das Pairing-Token im Schlüsselbund wurde gelöscht; pairen Sie den Node erneut.

## Verwandte Dokumente

- [Pairing](/gateway/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
