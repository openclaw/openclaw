---
summary: "Centro de red: superficies del Gateway, emparejamiento, descubrimiento y seguridad"
read_when:
  - Necesita la arquitectura de red y la visión general de seguridad
  - Está depurando el acceso local vs. tailnet o el emparejamiento
  - Quiere la lista canónica de documentos de red
title: "network.md"
---

# Centro de red

Este centro enlaza la documentación principal sobre cómo OpenClaw conecta, empareja y protege
dispositivos a través de localhost, LAN y tailnet.

## Modelo central

- [Arquitectura del Gateway](/concepts/architecture)
- [Protocolo del Gateway](/gateway/protocol)
- [Runbook del Gateway](/gateway)
- [Superficies web + modos de enlace](/web)

## Emparejamiento + identidad

- [Visión general del emparejamiento (MD + nodos)](/channels/pairing)
- [Emparejamiento de nodos propiedad del Gateway](/gateway/pairing)
- [CLI de dispositivos (emparejamiento + rotación de tokens)](/cli/devices)
- [CLI de emparejamiento (aprobaciones por MD)](/cli/pairing)

Confianza local:

- Las conexiones locales (loopback o la propia dirección tailnet del host del Gateway) pueden
  aprobarse automáticamente para el emparejamiento, a fin de mantener una UX fluida en el mismo host.
- Los clientes tailnet/LAN no locales aún requieren aprobación explícita de emparejamiento.

## Descubrimiento + transportes

- [Descubrimiento y transportes](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Acceso remoto (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Nodos + transportes

- [Visión general de nodos](/nodes)
- [Protocolo Bridge (nodos heredados)](/gateway/bridge-protocol)
- [Runbook de nodos: iOS](/platforms/ios)
- [Runbook de nodos: Android](/platforms/android)

## Seguridad

- [Visión general de seguridad](/gateway/security)
- [Referencia de configuración del Gateway](/gateway/configuration)
- [Solución de problemas](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
