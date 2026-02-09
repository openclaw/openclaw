---
summary: "Hub de alojamiento VPS para OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Quiere ejecutar el Gateway en la nube
  - Necesita un mapa rápido de guías de VPS/alojamiento
title: "Alojamiento VPS"
---

# Alojamiento VPS

Este hub enlaza a las guías de VPS/alojamiento compatibles y explica cómo funcionan
los despliegues en la nube a alto nivel.

## Elija un proveedor

- **Railway** (un clic + configuración en el navegador): [Railway](/install/railway)
- **Northflank** (un clic + configuración en el navegador): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — $0/mes (Always Free, ARM; la capacidad/el registro pueden ser caprichosos)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + proxy HTTPS): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: también funciona bien. Guía en video:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Cómo funcionan las configuraciones en la nube

- El **Gateway se ejecuta en el VPS** y posee el estado + el espacio de trabajo.
- Usted se conecta desde su laptop/teléfono mediante la **UI de control** o **Tailscale/SSH**.
- Trate el VPS como la fuente de verdad y **respalde** el estado + el espacio de trabajo.
- Valor predeterminado seguro: mantenga el Gateway en loopback y acceda a él mediante un túnel SSH o Tailscale Serve.
  Si enlaza a `lan`/`tailnet`, requiera `gateway.auth.token` o `gateway.auth.password`.

Acceso remoto: [Gateway remote](/gateway/remote)  
Hub de plataformas: [Platforms](/platforms)

## Uso de nodos con un VPS

Puede mantener el Gateway en la nube y emparejar **nodos** en sus dispositivos locales
(Mac/iOS/Android/sin interfaz). Los nodos proporcionan pantalla/cámara/lienzo locales y
capacidades de `system.run` mientras el Gateway permanece en la nube.

Documentación: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
