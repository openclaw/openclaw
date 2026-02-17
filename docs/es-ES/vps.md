---
summary: "Hub de alojamiento VPS para OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Quieres ejecutar el Gateway en la nube
  - Necesitas un mapa rápido de guías de VPS/alojamiento
title: "Alojamiento VPS"
---

# Alojamiento VPS

Este hub enlaza a las guías de VPS/alojamiento compatibles y explica cómo funcionan los
despliegues en la nube a alto nivel.

## Elige un proveedor

- **Railway** (un clic + configuración en navegador): [Railway](/es-ES/install/railway)
- **Northflank** (un clic + configuración en navegador): [Northflank](/es-ES/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/es-ES/platforms/oracle) — $0/mes (Always Free, ARM; la capacidad/registro puede ser delicado)
- **Fly.io**: [Fly.io](/es-ES/install/fly)
- **Hetzner (Docker)**: [Hetzner](/es-ES/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/es-ES/install/gcp)
- **exe.dev** (VM + proxy HTTPS): [exe.dev](/es-ES/install/exe-dev)
- **AWS (EC2/Lightsail/nivel gratuito)**: también funciona bien. Guía en video:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Cómo funcionan las configuraciones en la nube

- El **Gateway se ejecuta en el VPS** y posee el estado + espacio de trabajo.
- Te conectas desde tu laptop/teléfono mediante la **Interfaz de Control** o **Tailscale/SSH**.
- Trata el VPS como la fuente de verdad y **respalda** el estado + espacio de trabajo.
- Seguridad predeterminada: mantén el Gateway en bucle local y accede a él mediante túnel SSH o Tailscale Serve.
  Si vinculas a `lan`/`tailnet`, requiere `gateway.auth.token` o `gateway.auth.password`.

Acceso remoto: [Gateway remoto](/es-ES/gateway/remote)  
Hub de plataformas: [Plataformas](/es-ES/platforms)

## Uso de nodos con un VPS

Puedes mantener el Gateway en la nube y emparejar **nodos** en tus dispositivos locales
(Mac/iOS/Android/headless). Los nodos proporcionan capacidades locales de pantalla/cámara/lienzo y `system.run`
mientras el Gateway permanece en la nube.

Documentos: [Nodos](/es-ES/nodes), [CLI de Nodos](/es-ES/cli/nodes)
