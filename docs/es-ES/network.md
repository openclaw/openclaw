---
summary: "Hub de red: superficies del gateway, emparejamiento, descubrimiento y seguridad"
read_when:
  - Necesitas la arquitectura de red + resumen de seguridad
  - Estás depurando acceso local vs tailnet o emparejamiento
  - Deseas la lista canónica de documentación de redes
title: "Red"
---

# Hub de red

Este hub enlaza la documentación principal sobre cómo OpenClaw conecta, empareja y asegura
dispositivos a través de localhost, LAN y tailnet.

## Modelo central

- [Arquitectura del Gateway](/es-ES/concepts/architecture)
- [Protocolo del Gateway](/es-ES/gateway/protocol)
- [Manual del Gateway](/es-ES/gateway)
- [Superficies web + modos de enlace](/es-ES/web)

## Emparejamiento + identidad

- [Resumen de emparejamiento (DM + nodos)](/es-ES/channels/pairing)
- [Emparejamiento de nodo propiedad del Gateway](/es-ES/gateway/pairing)
- [CLI de dispositivos (emparejamiento + rotación de token)](/es-ES/cli/devices)
- [CLI de emparejamiento (aprobaciones DM)](/es-ES/cli/pairing)

Confianza local:

- Las conexiones locales (bucle local o la propia dirección tailnet del host del gateway) pueden
  aprobarse automáticamente para emparejamiento para mantener una UX fluida del mismo host.
- Los clientes tailnet/LAN no locales aún requieren aprobación explícita de emparejamiento.

## Descubrimiento + transportes

- [Descubrimiento y transportes](/es-ES/gateway/discovery)
- [Bonjour / mDNS](/es-ES/gateway/bonjour)
- [Acceso remoto (SSH)](/es-ES/gateway/remote)
- [Tailscale](/es-ES/gateway/tailscale)

## Nodos + transportes

- [Resumen de nodos](/es-ES/nodes)
- [Protocolo de puente (nodos heredados)](/es-ES/gateway/bridge-protocol)
- [Manual de nodo: iOS](/es-ES/platforms/ios)
- [Manual de nodo: Android](/es-ES/platforms/android)

## Seguridad

- [Resumen de seguridad](/es-ES/gateway/security)
- [Referencia de configuración del Gateway](/es-ES/gateway/configuration)
- [Solución de problemas](/es-ES/gateway/troubleshooting)
- [Doctor](/es-ES/gateway/doctor)
