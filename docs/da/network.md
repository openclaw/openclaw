---
summary: "Netværkshub: gateway‑overflader, parring, discovery og sikkerhed"
read_when:
  - Du har brug for overblik over netværksarkitektur og sikkerhed
  - Du fejlsøger lokal vs. tailnet‑adgang eller parring
  - Du vil have den kanoniske liste over netværksdokumentation
title: "Netværk"
---

# Netværkshub

Denne hub samler kernedokumentationen for, hvordan OpenClaw forbinder, parrer og sikrer
enheder på tværs af localhost, LAN og tailnet.

## Kernemodel

- [Gateway‑arkitektur](/concepts/architecture)
- [Gateway‑protokol](/gateway/protocol)
- [Gateway‑runbook](/gateway)
- [Web‑overflader + bind‑tilstande](/web)

## Parring + identitet

- [Overblik over parring (DM + noder)](/channels/pairing)
- [Gateway‑ejet nodeparring](/gateway/pairing)
- [Enheder CLI (parring + token‑rotation)](/cli/devices)
- [Parrings‑CLI (DM‑godkendelser)](/cli/pairing)

Lokal tillid:

- Lokale forbindelser (loopback eller gateway‑værtens egen tailnet‑adresse) kan
  auto‑godkendes til parring for at holde same‑host‑UX smidig.
- Ikke‑lokale tailnet/LAN‑klienter kræver stadig eksplicit parring‑godkendelse.

## Discovery + transporter

- [Discovery & transporter](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Fjernadgang (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Noder + transporter

- [Overblik over noder](/nodes)
- [Bridge‑protokol (legacy‑noder)](/gateway/bridge-protocol)
- [Node‑runbook: iOS](/platforms/ios)
- [Node‑runbook: Android](/platforms/android)

## Sikkerhed

- [Overblik over sikkerhed](/gateway/security)
- [Gateway konfigurationsreference](/gateway/configuration)
- [Fejlfinding](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
