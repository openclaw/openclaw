---
summary: "Soporte de Linux + estado de aplicación complementaria"
read_when:
  - Buscando estado de aplicación complementaria de Linux
  - Planificando cobertura de plataforma o contribuciones
title: "Aplicación Linux"
---

# Aplicación Linux

El Gateway está completamente soportado en Linux. **Node es el runtime recomendado**.
Bun no es recomendado para el Gateway (bugs de WhatsApp/Telegram).

Las aplicaciones complementarias nativas de Linux están planificadas. Las contribuciones son bienvenidas si deseas ayudar a construir una.

## Ruta rápida para principiantes (VPS)

1. Instala Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. Desde tu laptop: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Abre `http://127.0.0.1:18789/` y pega tu token

Guía paso a paso de VPS: [exe.dev](/es-ES/install/exe-dev)

## Instalación

- [Primeros Pasos](/es-ES/start/getting-started)
- [Instalación y actualizaciones](/es-ES/install/updating)
- Flujos opcionales: [Bun (experimental)](/es-ES/install/bun), [Nix](/es-ES/install/nix), [Docker](/es-ES/install/docker)

## Gateway

- [Manual del Gateway](/es-ES/gateway)
- [Configuración](/es-ES/gateway/configuration)

## Instalación del servicio Gateway (CLI)

Usa uno de estos:

```
openclaw onboard --install-daemon
```

O:

```
openclaw gateway install
```

O:

```
openclaw configure
```

Selecciona **Servicio Gateway** cuando se te solicite.

Reparar/migrar:

```
openclaw doctor
```

## Control del sistema (unidad de usuario systemd)

OpenClaw instala un servicio de **usuario** systemd por defecto. Usa un servicio de **sistema**
para servidores compartidos o siempre activos. El ejemplo completo de unidad y orientación
viven en el [manual del Gateway](/es-ES/gateway).

Configuración mínima:

Crea `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Habilítalo:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
