---
summary: "iOS-node-app: verbinding maken met de Gateway, koppelen, canvas en problemen oplossen"
read_when:
  - Koppelen of opnieuw verbinden van de iOS-node
  - De iOS-app vanuit broncode draaien
  - Gateway Discovery of canvas-opdrachten debuggen
title: "iOS-app"
---

# iOS-app (Node)

Beschikbaarheid: interne preview. De iOS-app wordt nog niet publiekelijk gedistribueerd.

## Wat het doet

- Verbindt met een Gateway via WebSocket (LAN of tailnet).
- Stelt node-mogelijkheden beschikbaar: Canvas, schermafbeelding, cameracapture, locatie, talk-modus, voice wake.
- Ontvangt `node.invoke`-opdrachten en rapporteert node-statusgebeurtenissen.

## Provideropties

- Gateway die op een ander apparaat draait (macOS, Linux of Windows via WSL2).
- Netwerkpad:
  - Dezelfde LAN via Bonjour, **of**
  - Tailnet via unicast DNS-SD (voorbeeld­domein: `openclaw.internal.`), **of**
  - Handmatige host/poort (fallback).

## Snelle start (koppelen + verbinden)

1. Start de Gateway:

```bash
openclaw gateway --port 18789
```

2. Open in de iOS-app **Settings** en kies een ontdekte gateway (of schakel **Manual Host** in en voer host/poort in).

3. Keur het koppelverzoek goed op de Gateway-host:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. Verifieer de verbinding:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Discovery-paden

### Bonjour (LAN)

De Gateway adverteert `_openclaw-gw._tcp` op `local.`. De iOS-app toont deze automatisch.

### Tailnet (cross-network)

Als mDNS is geblokkeerd, gebruik een unicast DNS-SD-zone (kies een domein; voorbeeld: `openclaw.internal.`) en Tailscale split DNS.
Zie [Bonjour](/gateway/bonjour) voor het CoreDNS-voorbeeld.

### Handmatige host/poort

Schakel in **Settings** **Manual Host** in en voer de gateway-host + poort in (standaard `18789`).

## Canvas + A2UI

De iOS-node rendert een WKWebView-canvas. Gebruik `node.invoke` om dit aan te sturen:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

Notities:

- De Gateway-canvas-host serveert `/__openclaw__/canvas/` en `/__openclaw__/a2ui/`.
- De iOS-node navigeert automatisch naar A2UI bij het verbinden wanneer een canvas-host-URL wordt geadverteerd.
- Keer terug naar de ingebouwde scaffold met `canvas.navigate` en `{"url":""}`.

### Canvas eval / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Voice wake + talk-modus

- Voice wake en talk-modus zijn beschikbaar in **Settings**.
- iOS kan audio op de achtergrond pauzeren; beschouw voice-functies als best-effort wanneer de app niet actief is.

## Veelvoorkomende fouten

- `NODE_BACKGROUND_UNAVAILABLE`: breng de iOS-app naar de voorgrond (canvas-/camera-/schermopdrachten vereisen dit).
- `A2UI_HOST_NOT_CONFIGURED`: de Gateway heeft geen canvas-host-URL geadverteerd; controleer `canvasHost` in [Gateway-configuratie](/gateway/configuration).
- Koppelingsprompt verschijnt nooit: voer `openclaw nodes pending` uit en keur handmatig goed.
- Opnieuw verbinden mislukt na herinstallatie: het koppelings-token in de Keychain is gewist; koppel de node opnieuw.

## Gerelateerde documentatie

- [Koppelen](/gateway/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
