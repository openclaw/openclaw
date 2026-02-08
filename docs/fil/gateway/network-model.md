---
summary: "Kung paano kumokonekta ang Gateway, mga node, at ang canvas host."
read_when:
  - "Gusto mo ng maikling pananaw sa networking model ng Gateway"
title: "Network model"
x-i18n:
  source_path: gateway/network-model.md
  source_hash: e3508b884757ef19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:28Z
---

Karamihan ng mga operasyon ay dumadaloy sa Gateway (`openclaw gateway`), isang nag-iisang pangmatagalang
process na may-ari ng mga channel connection at ng WebSocket control plane.

## Mga pangunahing tuntunin

- Inirerekomenda ang isang Gateway bawat host. Ito lamang ang prosesong pinapayagang magmay-ari ng WhatsApp Web session. Para sa rescue bots o mahigpit na isolation, magpatakbo ng maraming gateway na may hiwalay na mga profile at port. Tingnan ang [Multiple gateways](/gateway/multiple-gateways).
- Loopback muna: ang Gateway WS ay default sa `ws://127.0.0.1:18789`. Awtomatikong bumubuo ang wizard ng gateway token, kahit para sa loopback. Para sa tailnet access, patakbuhin ang `openclaw gateway --bind tailnet --token ...` dahil kailangan ang mga token para sa mga non-loopback bind.
- Kumokonekta ang mga node sa Gateway WS sa pamamagitan ng LAN, tailnet, o SSH kung kinakailangan. Deprecated na ang legacy TCP bridge.
- Ang canvas host ay isang HTTP file server sa `canvasHost.port` (default `18793`) na nagsisilbi ng `/__openclaw__/canvas/` para sa mga node WebView. Tingnan ang [Gateway configuration](/gateway/configuration) (`canvasHost`).
- Karaniwang ang remote use ay sa pamamagitan ng SSH tunnel o tailnet VPN. Tingnan ang [Remote access](/gateway/remote) at [Discovery](/gateway/discovery).
