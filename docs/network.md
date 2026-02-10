---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Network hub: gateway surfaces, pairing, discovery, and security"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need the network architecture + security overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are debugging local vs tailnet access or pairing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want the canonical list of networking docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Network"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Network hub（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This hub links the core docs for how OpenClaw connects, pairs, and secures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
devices across localhost, LAN, and tailnet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Core model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway architecture](/concepts/architecture)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway protocol](/gateway/protocol)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway runbook](/gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Web surfaces + bind modes](/web)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pairing + identity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Pairing overview (DM + nodes)](/channels/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway-owned node pairing](/gateway/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Devices CLI (pairing + token rotation)](/cli/devices)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Pairing CLI (DM approvals)](/cli/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Local trust:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Local connections (loopback or the gateway host’s own tailnet address) can be（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  auto‑approved for pairing to keep same‑host UX smooth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Non‑local tailnet/LAN clients still require explicit pairing approval.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Discovery + transports（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Discovery & transports](/gateway/discovery)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Bonjour / mDNS](/gateway/bonjour)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Remote access (SSH)](/gateway/remote)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Tailscale](/gateway/tailscale)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Nodes + transports（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Nodes overview](/nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Bridge protocol (legacy nodes)](/gateway/bridge-protocol)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Node runbook: iOS](/platforms/ios)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Node runbook: Android](/platforms/android)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Security overview](/gateway/security)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway config reference](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Troubleshooting](/gateway/troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Doctor](/gateway/doctor)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
