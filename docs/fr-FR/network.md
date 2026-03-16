---
summary: "Hub réseau : surfaces de passerelle, appairage, découverte et sécurité"
read_when:
  - Vous avez besoin de l'architecture réseau + aperçu de sécurité
  - Vous déboguez l'accès local vs tailnet ou l'appairage
  - Vous voulez la liste canonique des docs réseau
title: "Réseau"
---

# Hub réseau

Ce hub lie les docs principales sur la façon dont OpenClaw se connecte, appaire et sécurise les appareils sur localhost, LAN et tailnet.

## Modèle de base

- [Architecture de Passerelle](/fr-FR/concepts/architecture)
- [Protocole de Passerelle](/fr-FR/gateway/protocol)
- [Guide d'exploitation de Passerelle](/fr-FR/gateway)
- [Surfaces web + modes de liaison](/fr-FR/web)

## Appairage + identité

- [Aperçu d'appairage (DM + nœuds)](/fr-FR/channels/pairing)
- [Appairage de nœud détenu par Passerelle](/fr-FR/gateway/pairing)
- [CLI Devices (appairage + rotation de token)](/fr-FR/cli/devices)
- [CLI Pairing (approbations DM)](/fr-FR/cli/pairing)

Confiance locale :

- Les connexions locales (loopback ou l'adresse tailnet propre de l'hôte passerelle) peuvent être auto-approuvées pour l'appairage afin de garder l'UX même-hôte fluide.
- Les clients tailnet/LAN non-locaux nécessitent toujours une approbation d'appairage explicite.

## Découverte + transports

- [Découverte & transports](/fr-FR/gateway/discovery)
- [Bonjour / mDNS](/fr-FR/gateway/bonjour)
- [Accès distant (SSH)](/fr-FR/gateway/remote)
- [Tailscale](/fr-FR/gateway/tailscale)

## Nœuds + transports

- [Aperçu des nœuds](/fr-FR/nodes)
- [Protocole de pont (nœuds hérités)](/fr-FR/gateway/bridge-protocol)
- [Guide d'exploitation nœud : iOS](/fr-FR/platforms/ios)
- [Guide d'exploitation nœud : Android](/fr-FR/platforms/android)

## Sécurité

- [Aperçu de sécurité](/fr-FR/gateway/security)
- [Référence de config de Passerelle](/fr-FR/gateway/configuration)
- [Dépannage](/fr-FR/gateway/troubleshooting)
- [Doctor](/fr-FR/gateway/doctor)
