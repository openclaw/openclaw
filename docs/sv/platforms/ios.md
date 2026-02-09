---
summary: "iOS-nodapp: anslutning till Gateway, parkoppling, canvas och felsökning"
read_when:
  - Parkoppling eller återanslutning av iOS-noden
  - Köra iOS-appen från källkod
  - Felsökning av gateway-upptäckt eller canvas-kommandon
title: "iOS-app"
---

# iOS-app (Node)

Tillgänglighet: intern förhandsgranskning. iOS-appen distribueras inte offentligt ännu.

## Vad den gör

- Ansluter till en Gateway via WebSocket (LAN eller tailnet).
- Exponerar nodfunktioner: Canvas, skärmbild, kamerainspelning, plats, samtalsläge, röstväckning.
- Tar emot `node.invoke`-kommandon och rapporterar nodstatushändelser.

## Krav

- Gateway som körs på en annan enhet (macOS, Linux eller Windows via WSL2).
- Nätverksväg:
  - Samma LAN via Bonjour, **eller**
  - Tailnet via unicast DNS-SD (exempeldomän: `openclaw.internal.`), **eller**
  - Manuell värd/port (reserv).

## Snabbstart (para + anslut)

1. Starta Gateway:

```bash
openclaw gateway --port 18789
```

2. I iOS-appen öppnar du Inställningar och väljer en upptäckt gateway (eller aktiverar Manuell värd och anger värd/port).

3. Godkänn parkopplingsförfrågan på gateway-värden:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. Verifiera anslutningen:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Upptäcktsvägar

### Bonjour (LAN)

Gateway annonserar `_openclaw-gw._tcp` på `local.`. iOS app listar dessa automatiskt.

### Tailnet (över nätverk)

Om mDNS är blockerad, använd en unicast DNS-SD-zon (välj en domän; exempel: `openclaw.internal.`) och Tailscale split DNS.
Se [Bonjour](/gateway/bonjour) för CoreDNS-exemplet.

### Manuell värd/port

I Inställningar aktiverar du **Manuell värd** och anger gateway-värd + port (standard `18789`).

## Canvas + A2UI

iOS nod renderar en WKWebView canvas. Använd `node.invoke` för att köra den:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

Noteringar:

- Gatewayns canvas-värd serverar `/__openclaw__/canvas/` och `/__openclaw__/a2ui/`.
- iOS-noden navigerar automatiskt till A2UI vid anslutning när en canvas-värd-URL annonseras.
- Återgå till den inbyggda stommen med `canvas.navigate` och `{"url":""}`.

### Canvas eval / ögonblicksbild

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Röstväckning + samtalsläge

- Röstväckning och samtalsläge är tillgängliga i Inställningar.
- iOS kan pausa bakgrundsljud; behandla röstfunktioner som bästa möjliga när appen inte är aktiv.

## Vanliga fel

- `NODE_BACKGROUND_UNAVAILABLE`: ta iOS-appen till förgrunden (canvas-/kamera-/skärmkommandon kräver det).
- `A2UI_HOST_NOT_CONFIGURED`: Gateway annonserade ingen canvas-värd-URL; kontrollera `canvasHost` i [Gateway-konfiguration](/gateway/configuration).
- Parkopplingsprompten visas aldrig: kör `openclaw nodes pending` och godkänn manuellt.
- Återanslutning misslyckas efter ominstallation: parkopplingstoken i nyckelringen rensades; para om noden.

## Relaterad dokumentation

- [Parkoppling](/gateway/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
