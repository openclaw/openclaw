---
summary: "Netzwerk-Hub: Gateway-Oberflächen, Kopplung, Discovery und Sicherheit"
read_when:
  - Sie benötigen die Netzwerkarchitektur- und Sicherheitsübersicht
  - Sie debuggen lokalen vs. Tailnet-Zugriff oder Kopplung
  - Sie möchten die kanonische Liste der Netzwerkdokumente
title: "Netzwerk"
---

# Netzwerk-Hub

Dieser Hub verlinkt die Kerndokumentation dazu, wie OpenClaw Geräte über
Localhost, LAN und Tailnet verbindet, koppelt und absichert.

## Kernmodell

- [Gateway-Architektur](/concepts/architecture)
- [Gateway-Protokoll](/gateway/protocol)
- [Gateway-Runbook](/gateway)
- [Web-Oberflächen + Bind-Modi](/web)

## Kopplung + Identität

- [Überblick zur Kopplung (Direktnachrichten + Nodes)](/channels/pairing)
- [Kopplung von Gateway-eigenen Nodes](/gateway/pairing)
- [Devices-CLI (Kopplung + Token-Rotation)](/cli/devices)
- [Pairing-CLI (DM-Freigaben)](/cli/pairing)

Lokales Vertrauen:

- Lokale Verbindungen (Loopback oder die eigene Tailnet-Adresse des Gateway-Hosts)
  können für die Kopplung automatisch freigegeben werden, um die UX auf demselben
  Host reibungslos zu halten.
- Nicht-lokale Tailnet-/LAN-Clients erfordern weiterhin eine explizite
  Kopplungsfreigabe.

## Discovery + Transports

- [Discovery & Transports](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Remote-Zugriff (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Nodes + Transports

- [Nodes – Überblick](/nodes)
- [Bridge-Protokoll (Legacy-Nodes)](/gateway/bridge-protocol)
- [Node-Runbook: iOS](/platforms/ios)
- [Node-Runbook: Android](/platforms/android)

## Sicherheit

- [Sicherheitsüberblick](/gateway/security)
- [Gateway-Konfigurationsreferenz](/gateway/configuration)
- [Fehlerbehebung](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
