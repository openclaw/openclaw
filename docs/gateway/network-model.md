---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "How the Gateway, nodes, and canvas host connect."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a concise view of the Gateway networking model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Network model"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Most operations flow through the Gateway (`openclaw gateway`), a single long-running（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
process that owns channel connections and the WebSocket control plane.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Core rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- One Gateway per host is recommended. It is the only process allowed to own the WhatsApp Web session. For rescue bots or strict isolation, run multiple gateways with isolated profiles and ports. See [Multiple gateways](/gateway/multiple-gateways).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Loopback first: the Gateway WS defaults to `ws://127.0.0.1:18789`. The wizard generates a gateway token by default, even for loopback. For tailnet access, run `openclaw gateway --bind tailnet --token ...` because tokens are required for non-loopback binds.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nodes connect to the Gateway WS over LAN, tailnet, or SSH as needed. The legacy TCP bridge is deprecated.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Canvas host is an HTTP file server on `canvasHost.port` (default `18793`) serving `/__openclaw__/canvas/` for node WebViews. See [Gateway configuration](/gateway/configuration) (`canvasHost`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remote use is typically SSH tunnel or tailnet VPN. See [Remote access](/gateway/remote) and [Discovery](/gateway/discovery).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
