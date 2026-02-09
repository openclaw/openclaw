---
summary: "Network hub: mga surface ng gateway, pairing, discovery, at seguridad"
read_when:
  - Kailangan mo ang overview ng network architecture + seguridad
  - Nagde-debug ka ng local vs tailnet access o pairing
  - Gusto mo ang kanonikal na listahan ng mga networking docs
title: "Network"
---

# Network hub

Iniuugnay ng hub na ito ang mga core docs kung paano kumokonekta, nagpa-pair, at nagsisiguro ang OpenClaw ng mga device sa localhost, LAN, at tailnet.

## Core model

- [Gateway architecture](/concepts/architecture)
- [Gateway protocol](/gateway/protocol)
- [Gateway runbook](/gateway)
- [Web surfaces + bind modes](/web)

## Pairing + identity

- [Pairing overview (DM + nodes)](/channels/pairing)
- [Gateway-owned node pairing](/gateway/pairing)
- [Devices CLI (pairing + token rotation)](/cli/devices)
- [Pairing CLI (DM approvals)](/cli/pairing)

Local trust:

- Ang mga local na koneksyon (loopback o sariling tailnet address ng host ng Gateway) ay maaaring ma-auto‑approve para sa pairing upang maging maayos ang UX sa parehong host.
- Ang mga non‑local na tailnet/LAN client ay nangangailangan pa rin ng tahasang pag-apruba sa pairing.

## Discovery + transports

- [Discovery & transports](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Remote access (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Nodes + transports

- [Nodes overview](/nodes)
- [Bridge protocol (legacy nodes)](/gateway/bridge-protocol)
- [Node runbook: iOS](/platforms/ios)
- [Node runbook: Android](/platforms/android)

## Security

- [Security overview](/gateway/security)
- [Gateway config reference](/gateway/configuration)
- [Troubleshooting](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
