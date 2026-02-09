---
summary: "Netwerkhub: gateway-oppervlakken, koppelen, discovery en beveiliging"
read_when:
  - Je hebt het netwerkarchitectuur- en beveiligingsoverzicht nodig
  - Je debugt lokale versus tailnet-toegang of koppelen
  - Je wilt de canonieke lijst met netwerkdocumentatie
title: "Netwerk"
---

# Netwerkhub

Deze hub koppelt de kern­documentatie voor hoe OpenClaw apparaten verbindt,
koppelt en beveiligt via localhost, LAN en tailnet.

## Kernmodel

- [Gateway-architectuur](/concepts/architecture)
- [Gateway-protocol](/gateway/protocol)
- [Gateway-runbook](/gateway)
- [Weboppervlakken + bindmodi](/web)

## Koppelen + identiteit

- [Overzicht koppelen (DM + nodes)](/channels/pairing)
- [Koppelen van Gateway-eigen nodes](/gateway/pairing)
- [Devices CLI (koppelen + tokenrotatie)](/cli/devices)
- [Pairing CLI (DM-goedkeuringen)](/cli/pairing)

Lokaal vertrouwen:

- Lokale verbindingen (loopback of het eigen tailnet-adres van de Gateway-host)
  kunnen automatisch worden goedgekeurd voor koppelen om de UX op dezelfde host
  soepel te houden.
- Niet-lokale tailnet-/LAN-clients vereisen nog steeds expliciete
  koppelingsgoedkeuring.

## Discovery + transports

- [Discovery & transports](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Toegang op afstand (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Nodes + transports

- [Overzicht nodes](/nodes)
- [Bridge-protocol (legacy nodes)](/gateway/bridge-protocol)
- [Node-runbook: iOS](/platforms/ios)
- [Node-runbook: Android](/platforms/android)

## Beveiliging

- [Beveiligingsoverzicht](/gateway/security)
- [Gateway-configreferentie](/gateway/configuration)
- [Problemen oplossen](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
