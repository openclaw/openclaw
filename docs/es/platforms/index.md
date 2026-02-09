---
summary: "Descripción general de compatibilidad de plataformas (Gateway + aplicaciones complementarias)"
read_when:
  - Buscando compatibilidad de SO o rutas de instalación
  - Decidiendo dónde ejecutar el Gateway
title: "Plataformas"
---

# Plataformas

El núcleo de OpenClaw está escrito en TypeScript. **Node es el runtime recomendado**.
Bun no se recomienda para el Gateway (errores de WhatsApp/Telegram).

Existen aplicaciones complementarias para macOS (app de barra de menú) y nodos móviles (iOS/Android). Las aplicaciones complementarias para Windows y
Linux están planificadas, pero el Gateway cuenta con soporte completo hoy.
También se planifican aplicaciones complementarias nativas para Windows; se recomienda el Gateway mediante WSL2.

## Elige tu sistema operativo

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS y hosting

- Hub VPS: [VPS hosting](/vps)
- Fly.io: [Fly.io](/install/fly)
- Hetzner (Docker): [Hetzner](/install/hetzner)
- GCP (Compute Engine): [GCP](/install/gcp)
- exe.dev (VM + proxy HTTPS): [exe.dev](/install/exe-dev)

## Enlaces comunes

- Guía de instalación: [Primeros pasos](/start/getting-started)
- Manual operativo del Gateway: [Gateway](/gateway)
- Configuración del Gateway: [Configuración](/gateway/configuration)
- Estado del servicio: `openclaw gateway status`

## Instalación del servicio del Gateway (CLI)

Use una de estas opciones (todas compatibles):

- Asistente (recomendado): `openclaw onboard --install-daemon`
- Directo: `openclaw gateway install`
- Configurar flujo: `openclaw configure` → seleccione **Gateway service**
- Reparar/migrar: `openclaw doctor` (ofrece instalar o corregir el servicio)

El destino del servicio depende del SO:

- macOS: LaunchAgent (`bot.molt.gateway` o `bot.molt.<profile>`; legado `com.openclaw.*`)
- Linux/WSL2: servicio de usuario systemd (`openclaw-gateway[-<profile>].service`)
