---
summary: "Jak łączą się Gateway, węzły i host canvas."
read_when:
  - Chcesz uzyskać zwięzły obraz modelu sieciowego Gateway
title: "Model sieciowy"
---

Większość operacji przechodzi przez Gateway (`openclaw gateway`), pojedynczy, długotrwale działający
proces, który zarządza połączeniami kanałów oraz płaszczyzną sterowania WebSocket.

## Zasady podstawowe

- Zalecany jest jeden Gateway na host. Jest to jedyny proces, który może posiadać sesję WhatsApp Web. W przypadku botów ratunkowych lub ścisłej izolacji uruchom wiele gatewayów z odizolowanymi profilami i portami. Zobacz [Multiple gateways](/gateway/multiple-gateways).
- Loopback przede wszystkim: WS Gateway domyślnie używa `ws://127.0.0.1:18789`. Kreator domyślnie generuje token gateway, nawet dla loopback. Dla dostępu przez tailnet uruchom `openclaw gateway --bind tailnet --token ...`, ponieważ tokeny są wymagane dla powiązań innych niż loopback.
- Węzły łączą się z WS Gateway przez LAN, tailnet lub SSH — w zależności od potrzeb. Starszy most TCP jest wycofywany.
- Host canvas to serwer plików HTTP na `canvasHost.port` (domyślnie `18793`), udostępniający `/__openclaw__/canvas/` dla WebView węzłów. Zobacz [Gateway configuration](/gateway/configuration) (`canvasHost`).
- Zdalne użycie odbywa się zazwyczaj przez tunel SSH lub VPN tailnet. Zobacz [Remote access](/gateway/remote) oraz [Discovery](/gateway/discovery).
