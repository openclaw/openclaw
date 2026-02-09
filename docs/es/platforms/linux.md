---
summary: "Compatibilidad con Linux + estado de la aplicación complementaria"
read_when:
  - Buscar el estado de la aplicación complementaria para Linux
  - Planificar la cobertura de plataformas o contribuciones
title: "Aplicación Linux"
---

# Aplicación Linux

El Gateway es totalmente compatible con Linux. **Node es el runtime recomendado**.
Bun no se recomienda para el Gateway (errores con WhatsApp/Telegram).

Las aplicaciones complementarias nativas para Linux están planificadas. Las contribuciones son bienvenidas si desea ayudar a crear una.

## Ruta rápida para principiantes (VPS)

1. Instale Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. Desde su laptop: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Abra `http://127.0.0.1:18789/` y pegue su token

Guía paso a paso para VPS: [exe.dev](/install/exe-dev)

## Instalación

- [Primeros pasos](/start/getting-started)
- [Instalación y actualizaciones](/install/updating)
- Flujos opcionales: [Bun (experimental)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Runbook del Gateway](/gateway)
- [Configuración](/gateway/configuration)

## Instalación del servicio del Gateway (CLI)

Use una de estas opciones:

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

Seleccione **Gateway service** cuando se le solicite.

Reparar/migrar:

```
openclaw doctor
```

## Control del sistema (unidad de usuario systemd)

OpenClaw instala de forma predeterminada un servicio systemd de **usuario**. Use un servicio de **sistema**
para servidores compartidos o siempre activos. El ejemplo completo de la unidad y la guía
se encuentran en el [runbook del Gateway](/gateway).

Configuración mínima:

Cree `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

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

Habilitarlo:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
