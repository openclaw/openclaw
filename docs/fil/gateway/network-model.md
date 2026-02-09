---
summary: "Kung paano kumokonekta ang Gateway, mga node, at ang canvas host."
read_when:
  - Gusto mo ng maikling pananaw sa networking model ng Gateway
title: "Network model"
---

Karamihan ng mga operasyon ay dumadaloy sa Gateway (`openclaw gateway`), isang nag-iisang pangmatagalang
process na may-ari ng mga channel connection at ng WebSocket control plane.

## Mga pangunahing tuntunin

- One Gateway per host is recommended. Ito lamang ang prosesong pinapayagang magmay-ari ng WhatsApp Web session. For rescue bots or strict isolation, run multiple gateways with isolated profiles and ports. Tingnan ang [Multiple gateways](/gateway/multiple-gateways).
- Unahin ang loopback: ang default ng Gateway WS ay `ws://127.0.0.1:18789`. The wizard generates a gateway token by default, even for loopback. Para sa tailnet access, patakbuhin ang `openclaw gateway --bind tailnet --token ...` dahil kinakailangan ang mga token para sa mga non-loopback bind.
- Nodes connect to the Gateway WS over LAN, tailnet, or SSH as needed. The legacy TCP bridge is deprecated.
- Ang Canvas host ay isang HTTP file server sa `canvasHost.port` (default `18793`) na nagsisilbi ng `/__openclaw__/canvas/` para sa mga node WebView. Tingnan ang [Gateway configuration](/gateway/configuration) (`canvasHost`).
- Ang remote na paggamit ay karaniwang SSH tunnel o tailnet VPN. Tingnan ang [Remote access](/gateway/remote) at [Discovery](/gateway/discovery).
