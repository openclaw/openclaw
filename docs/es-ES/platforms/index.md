---
summary: "Descripción general de soporte de plataformas (Gateway + aplicaciones complementarias)"
read_when:
  - Buscando soporte de SO o rutas de instalación
  - Decidiendo dónde ejecutar el Gateway
title: "Plataformas"
---

# Plataformas

El núcleo de OpenClaw está escrito en TypeScript. **Node es el runtime recomendado**.
Bun no es recomendado para el Gateway (bugs de WhatsApp/Telegram).

Existen aplicaciones complementarias para macOS (aplicación de barra de menús) y nodos móviles (iOS/Android). Las aplicaciones
complementarias de Windows y Linux están planificadas, pero el Gateway está completamente soportado hoy.
Las aplicaciones complementarias nativas para Windows también están planificadas; el Gateway se recomienda vía WSL2.

## Elige tu SO

- macOS: [macOS](/es-ES/platforms/macos)
- iOS: [iOS](/es-ES/platforms/ios)
- Android: [Android](/es-ES/platforms/android)
- Windows: [Windows](/es-ES/platforms/windows)
- Linux: [Linux](/es-ES/platforms/linux)

## VPS y hosting

- Centro de VPS: [Hosting VPS](/es-ES/vps)
- Fly.io: [Fly.io](/es-ES/install/fly)
- Hetzner (Docker): [Hetzner](/es-ES/install/hetzner)
- GCP (Compute Engine): [GCP](/es-ES/install/gcp)
- exe.dev (VM + proxy HTTPS): [exe.dev](/es-ES/install/exe-dev)

## Enlaces comunes

- Guía de instalación: [Primeros Pasos](/es-ES/start/getting-started)
- Manual del Gateway: [Gateway](/es-ES/gateway)
- Configuración del Gateway: [Configuración](/es-ES/gateway/configuration)
- Estado del servicio: `openclaw gateway status`

## Instalación del servicio Gateway (CLI)

Usa uno de estos (todos soportados):

- Asistente (recomendado): `openclaw onboard --install-daemon`
- Directo: `openclaw gateway install`
- Flujo de configuración: `openclaw configure` → selecciona **Servicio Gateway**
- Reparar/migrar: `openclaw doctor` (ofrece instalar o reparar el servicio)

El objetivo del servicio depende del SO:

- macOS: LaunchAgent (`bot.molt.gateway` o `bot.molt.<profile>`; legado `com.openclaw.*`)
- Linux/WSL2: servicio de usuario systemd (`openclaw-gateway[-<profile>].service`)
