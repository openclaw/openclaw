---
summary: "Hvordan Gateway, noder og canvas-vært forbinder."
read_when:
  - Du ønsker et kort overblik over Gatewayens netværksmodel
title: "Netværksmodel"
x-i18n:
  source_path: gateway/network-model.md
  source_hash: e3508b884757ef19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:14Z
---

De fleste handlinger går gennem Gateway (`openclaw gateway`), en enkelt langvarigt kørende
proces, der ejer kanalforbindelser og WebSocket-kontrolplanet.

## Grundregler

- Én Gateway pr. vært anbefales. Det er den eneste proces, der må eje WhatsApp Web-sessionen. Til redningsbots eller streng isolation kan du køre flere gateways med isolerede profiler og porte. Se [Flere gateways](/gateway/multiple-gateways).
- Loopback først: Gateway WS bruger som standard `ws://127.0.0.1:18789`. Opsætningsguiden genererer som standard et gateway-token, selv for loopback. For tailnet-adgang skal du køre `openclaw gateway --bind tailnet --token ...`, fordi tokens kræves for ikke-loopback-bindinger.
- Noder forbinder til Gateway WS over LAN, tailnet eller SSH efter behov. Den ældre TCP-bridge er forældet.
- Canvas-vært er en HTTP-filserver på `canvasHost.port` (standard `18793`), der serverer `/__openclaw__/canvas/` til noders WebViews. Se [Gateway-konfiguration](/gateway/configuration) (`canvasHost`).
- Fjernbrug er typisk via SSH-tunnel eller tailnet-VPN. Se [Fjernadgang](/gateway/remote) og [Discovery](/gateway/discovery).
