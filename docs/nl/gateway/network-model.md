---
summary: "Hoe de Gateway, nodes en canvas-host verbinding maken."
read_when:
  - Je wilt een beknopt overzicht van het netwerkmodel van de Gateway
title: "Netwerkmodel"
---

De meeste bewerkingen verlopen via de Gateway (`openclaw gateway`), een enkel langlopend
proces dat kanaalverbindingen en het WebSocket-besturingsvlak beheert.

## Kernregels

- Eén Gateway per host wordt aanbevolen. Het is het enige proces dat de WhatsApp Web-sessie mag bezitten. Voor reddingsbots of strikte isolatie kun je meerdere gateways draaien met geïsoleerde profielen en poorten. Zie [Multiple gateways](/gateway/multiple-gateways).
- Eerst loopback: de Gateway WS staat standaard op `ws://127.0.0.1:18789`. De wizard genereert standaard een gateway-token, zelfs voor loopback. Voor tailnet-toegang voer je `openclaw gateway --bind tailnet --token ...` uit, omdat tokens vereist zijn voor niet-loopback-binds.
- Nodes maken verbinding met de Gateway WS via LAN, tailnet of SSH indien nodig. De legacy TCP-bridge is verouderd.
- De canvas-host is een HTTP-bestandsserver op `canvasHost.port` (standaard `18793`) die `/__openclaw__/canvas/` serveert voor node-WebViews. Zie [Gateway configuration](/gateway/configuration) (`canvasHost`).
- Gebruik op afstand is doorgaans via een SSH-tunnel of tailnet-VPN. Zie [Remote access](/gateway/remote) en [Discovery](/gateway/discovery).
