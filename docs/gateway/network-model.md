---
summary: "How the Gateway, nodes, and canvas host connect."
read_when:
  - You want a concise view of the Gateway networking model
title: "Network model"
---

Most operations flow through the Gateway (`openclaw gateway`), a single long-running
process that owns channel connections and the WebSocket control plane.

## Core rules

- One Gateway per host is recommended. It is the only process allowed to own the WhatsApp Web session. For rescue bots or strict isolation, run multiple gateways with isolated profiles and ports. See [Multiple gateways](/gateway/multiple-gateways).
- Loopback first: the Gateway WS defaults to `ws://127.0.0.1:18789`. The wizard generates a gateway token by default, even for loopback. For tailnet access, run `openclaw gateway --bind tailnet --token ...` because tokens are required for non-loopback binds. For other overlay networks, use `--bind zerotier`, `--bind wireguard`, or `--bind overlay` (auto-detect).
- Nodes connect to the Gateway WS over LAN, tailnet, overlay networks (ZeroTier, WireGuard, Nebula), or SSH as needed. The legacy TCP bridge is deprecated.
- Canvas host is an HTTP file server on `canvasHost.port` (default `18793`) serving `/__openclaw__/canvas/` for node WebViews. See [Gateway configuration](/gateway/configuration) (`canvasHost`).
- Remote use is typically SSH tunnel or tailnet VPN. See [Remote access](/gateway/remote) and [Discovery](/gateway/discovery).
