---
summary: "Hur Gateway, noder och canvas-värd ansluter."
read_when:
  - Du vill ha en kortfattad överblick över Gateways nätverksmodell
title: "Nätverksmodell"
x-i18n:
  source_path: gateway/network-model.md
  source_hash: e3508b884757ef19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:20Z
---

De flesta operationer går via Gateway (`openclaw gateway`), en enda långlivad
process som äger kanalanslutningar och WebSocket-kontrollplanet.

## Grundregler

- En Gateway per värd rekommenderas. Det är den enda processen som får äga WhatsApp Web-sessionen. För räddningsbotar eller strikt isolering, kör flera gateways med isolerade profiler och portar. Se [Multiple gateways](/gateway/multiple-gateways).
- Loopback först: Gateway WS har som standard `ws://127.0.0.1:18789`. Guiden genererar som standard en gateway-token, även för loopback. För tailnet-åtkomst, kör `openclaw gateway --bind tailnet --token ...` eftersom token krävs för bindningar som inte är loopback.
- Noder ansluter till Gateway WS över LAN, tailnet eller SSH vid behov. Den äldre TCP-bryggan är föråldrad.
- Canvas-värden är en HTTP-filserver på `canvasHost.port` (standard `18793`) som serverar `/__openclaw__/canvas/` för nodernas WebViews. Se [Gateway-konfiguration](/gateway/configuration) (`canvasHost`).
- Fjärranvändning är vanligtvis via SSH-tunnel eller tailnet-VPN. Se [Remote access](/gateway/remote) och [Discovery](/gateway/discovery).
