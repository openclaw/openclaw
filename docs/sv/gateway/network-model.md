---
summary: "Hur Gateway, noder och canvas-värd ansluter."
read_when:
  - Du vill ha en kortfattad överblick över Gateways nätverksmodell
title: "Nätverksmodell"
---

De flesta operationer går via Gateway (`openclaw gateway`), en enda långlivad
process som äger kanalanslutningar och WebSocket-kontrollplanet.

## Grundregler

- En Gateway per värd rekommenderas. Det är den enda processen som tillåts att äga WhatsApp Web session. För räddningsbots eller strikt isolering, kör flera gateways med isolerade profiler och hamnar. Se [Flera gateways](/gateway/multiple-gateways).
- Loopback först: Gateway WS standard är `ws://127.0.0.1:18789`. Guiden genererar en gateway-token som standard, även för loopback. För tailnet access, kör `openclaw gateway --bind tailnet --token ...` eftersom tokens krävs för icke-loopback bindningar.
- Noder ansluter till Gateway WS över LAN, tailnet eller SSH efter behov. Den äldre TCP-bron är föråldrad.
- Canvas värd är en HTTP-filserver på `canvasHost.port` (standard `18793`) som betjänar `/__openclaw__/canvas/` för node WebViews. Se [Gateway konfiguration](/gateway/configuration) (`canvasHost`).
- Fjärranvändning är typisk SSH-tunnel eller tailnet VPN. Se [Fjärråtkomst](/gateway/remote) och [Discovery](/gateway/discovery).
