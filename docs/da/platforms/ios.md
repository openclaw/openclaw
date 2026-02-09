---
summary: "iOS-nodeapp: forbindelse til Gateway, parring, canvas og fejlfinding"
read_when:
  - Parring eller genforbindelse af iOS-noden
  - Kørsel af iOS-appen fra kildekode
  - Fejlfinding af gateway-discovery eller canvas-kommandoer
title: "iOS-app"
---

# iOS-app (Node)

Tilgængelighed: intern forhåndsvisning. IOS-appen er endnu ikke offentligt distribueret.

## Hvad den gør

- Opretter forbindelse til en Gateway over WebSocket (LAN eller tailnet).
- Eksponerer node-funktioner: Canvas, skærmbillede, kamerafangst, placering, taletilstand, stemmevækkelse.
- Modtager `node.invoke`-kommandoer og rapporterer node-statushændelser.

## Krav

- Gateway kører på en anden enhed (macOS, Linux eller Windows via WSL2).
- Netværkssti:
  - Samme LAN via Bonjour, **eller**
  - Tailnet via unicast DNS-SD (eksempeldomæne: `openclaw.internal.`), **eller**
  - Manuel vært/port (fallback).

## Hurtig start (par + forbind)

1. Start Gateway:

```bash
openclaw gateway --port 18789
```

2. I iOS-appen skal du åbne Indstillinger og vælge en fundet gateway (eller aktivere Manuel vært og indtaste vært/port).

3. Godkend parringsanmodningen på gateway-værten:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. Bekræft forbindelsen:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Discovery-stier

### Bonjour (LAN)

Gateway annoncerer `_openclaw-gw._tcp` på `local.`. IOS-appen viser disse automatisk.

### Tailnet (på tværs af netværk)

Hvis mDNS er blokeret, skal du bruge en unicast DNS-SD-zone (vælg et domæne; eksempel: `openclaw.internal.`) og Tailscale split DNS.
Se [Bonjour](/gateway/bonjour) for CoreDNS-eksemplet.

### Manuel vært/port

I Indstillinger skal du aktivere **Manuel vært** og indtaste gateway-vært + port (standard `18789`).

## Canvas + A2UI

iOS node gør en WKWebView lærred. Brug `node.invoke` til at drive den:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

Noter:

- Gateway-canvasværten serverer `/__openclaw__/canvas/` og `/__openclaw__/a2ui/`.
- iOS-noden navigerer automatisk til A2UI ved forbindelse, når en canvas-vært-URL annonceres.
- Gå tilbage til det indbyggede skelet med `canvas.navigate` og `{"url":""}`.

### Canvas eval / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Stemmevækkelse + taletilstand

- Stemmevækkelse og taletilstand er tilgængelige i Indstillinger.
- iOS kan suspendere baggrundslyd; betragt stemmefunktioner som best-effort, når appen ikke er aktiv.

## Almindelige fejl

- `NODE_BACKGROUND_UNAVAILABLE`: bring iOS-appen i forgrunden (canvas-/kamera-/skærmkommandoer kræver det).
- `A2UI_HOST_NOT_CONFIGURED`: Gateway annoncerede ikke en canvas-vært-URL; tjek `canvasHost` i [Gateway-konfiguration](/gateway/configuration).
- Parringsprompten vises aldrig: kør `openclaw nodes pending` og godkend manuelt.
- Genforbindelse mislykkes efter geninstallation: nøglerings-parringstokenet blev ryddet; par noden igen.

## Relaterede dokumenter

- [Parring](/gateway/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
