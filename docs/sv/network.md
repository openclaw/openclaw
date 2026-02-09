---
summary: "Nätverkshubb: gateway-ytor, parning, discovery och säkerhet"
read_when:
  - Du behöver en översikt över nätverksarkitektur och säkerhet
  - Du felsöker lokal vs tailnet-åtkomst eller parning
  - Du vill ha den kanoniska listan över nätverksdokumentation
title: "Nätverk"
---

# Nätverkshubb

Den här hubben länkar till kärndokumentationen för hur OpenClaw ansluter, parar och säkrar
enheter över localhost, LAN och tailnet.

## Kärnmodell

- [Gateway-arkitektur](/concepts/architecture)
- [Gateway-protokoll](/gateway/protocol)
- [Gateway-runbook](/gateway)
- [Webbytor + bindningslägen](/web)

## Parning + identitet

- [Översikt över parning (DM + noder)](/channels/pairing)
- [Gateway-ägd nodparning](/gateway/pairing)
- [Enheter CLI (parning + tokenrotation)](/cli/devices)
- [Parnings-CLI (DM-godkännanden)](/cli/pairing)

Lokalt förtroende:

- Lokala anslutningar (loopback eller gateway-värdens egen tailnet-adress) kan
  auto‑godkännas för parning för att hålla användarupplevelsen smidig på samma värd.
- Icke‑lokala tailnet-/LAN‑klienter kräver fortfarande explicit parningsgodkännande.

## Discovery + transporter

- [Discovery och transporter](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Fjärråtkomst (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Noder + transporter

- [Översikt över noder](/nodes)
- [Bridge-protokoll (äldre noder)](/gateway/bridge-protocol)
- [Node-runbook: iOS](/platforms/ios)
- [Node-runbook: Android](/platforms/android)

## Säkerhet

- [Säkerhetsöversikt](/gateway/security)
- [Referens för Gateway-konfig](/gateway/configuration)
- [Felsökning](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
