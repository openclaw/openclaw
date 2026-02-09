---
summary: "Hub reseau : surfaces de la Gateway (passerelle), appairage, decouverte et securite"
read_when:
  - Vous avez besoin d'une vue d'ensemble de l'architecture reseau et de la securite
  - Vous depannez l'acces local vs tailnet ou l'appairage
  - Vous voulez la liste canonique des documents reseau
title: "network.md"
---

# Hub reseau

Ce hub relie la documentation centrale expliquant comment OpenClaw se connecte,
s’apparie et securise les appareils via localhost, le LAN et le tailnet.

## Modele central

- [Architecture de la Gateway (passerelle)](/concepts/architecture)
- [Protocole de la Gateway (passerelle)](/gateway/protocol)
- [Runbook de la Gateway (passerelle)](/gateway)
- [Surfaces web + modes de bind](/web)

## Appairage + identite

- [Vue d'ensemble du jumelage (DM + nœuds)](/channels/pairing)
- [Appairage des noeuds appartenant a la Gateway (passerelle)](/gateway/pairing)
- [CLI des appareils (appairage + rotation de jetons)](/cli/devices)
- [CLI d’appairage (approbations par Message prive)](/cli/pairing)

Confiance locale :

- Les connexions locales (local loopback ou l’adresse tailnet propre a l’hote de la Gateway (passerelle)) peuvent etre auto‑approuvees pour l’appairage afin de garder une experience utilisateur fluide sur le meme hote.
- Les clients tailnet/LAN non locaux necessitent toujours une approbation explicite d’appairage.

## Decouverte + transports

- [Decouverte et transports](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Acces distant (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Noeuds + transports

- [Vue d’ensemble des noeuds](/nodes)
- [Protocole Bridge (noeuds legacy)](/gateway/bridge-protocol)
- [Runbook des noeuds : iOS](/platforms/ios)
- [Runbook des noeuds : Android](/platforms/android)

## Securite

- [Vue d’ensemble de la securite](/gateway/security)
- [Reference de configuration de la Gateway (passerelle)](/gateway/configuration)
- [Depannage](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
