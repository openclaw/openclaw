---
summary: "Ejecutar OpenClaw en un contenedor Podman rootless"
read_when:
  - Quieres un gateway containerizado con Podman en lugar de Docker
title: "Podman"
---

# Podman

Ejecuta el gateway OpenClaw en un contenedor Podman **rootless**. Usa la misma imagen que Docker (construye desde el [Dockerfile](https://github.com/openclaw/openclaw/blob/main/Dockerfile) del repositorio).

## Requisitos

- Podman (rootless)
- Sudo para configuración única (crear usuario, construir imagen)

## Inicio rápido

**1. Configuración única** (desde la raíz del repositorio; crea usuario, construye imagen, instala script de lanzamiento):

```bash
./setup-podman.sh
```

Esto también crea un `~openclaw/.openclaw/openclaw.json` mínimo (establece `gateway.mode="local"`) para que el gateway pueda iniciar sin ejecutar el wizard.

Por defecto el contenedor **no** está instalado como un servicio systemd, lo inicias manualmente (ver abajo). Para una configuración estilo producción con auto-inicio y reinicios, instálalo como un servicio de usuario Quadlet de systemd en su lugar:

```bash
./setup-podman.sh --quadlet
```

(O establece `OPENCLAW_PODMAN_QUADLET=1`; usa `--container` para instalar solo el contenedor y el script de lanzamiento.)

**2. Iniciar gateway** (manual, para pruebas rápidas):

```bash
./scripts/run-openclaw-podman.sh launch
```

**3. Wizard de onboarding** (ej. para agregar canales o proveedores):

```bash
./scripts/run-openclaw-podman.sh launch setup
```

Luego abre `http://127.0.0.1:18789/` y usa el token de `~openclaw/.openclaw/.env` (o el valor impreso por setup).

## Systemd (Quadlet, opcional)

Si ejecutaste `./setup-podman.sh --quadlet` (o `OPENCLAW_PODMAN_QUADLET=1`), una unidad [Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) está instalada para que el gateway se ejecute como un servicio de usuario systemd para el usuario openclaw. El servicio está habilitado e iniciado al final de la configuración.

- **Iniciar:** `sudo systemctl --machine openclaw@ --user start openclaw.service`
- **Detener:** `sudo systemctl --machine openclaw@ --user stop openclaw.service`
- **Estado:** `sudo systemctl --machine openclaw@ --user status openclaw.service`
- **Logs:** `sudo journalctl --machine openclaw@ --user -u openclaw.service -f`

El archivo quadlet vive en `~openclaw/.config/containers/systemd/openclaw.container`. Para cambiar puertos o env, edita ese archivo (o el `.env` que utiliza), luego `sudo systemctl --machine openclaw@ --user daemon-reload` y reinicia el servicio. Al arrancar, el servicio inicia automáticamente si lingering está habilitado para openclaw (setup hace esto cuando loginctl está disponible).

Para agregar quadlet **después** de una configuración inicial que no lo usó, vuelve a ejecutar: `./setup-podman.sh --quadlet`.

## El usuario openclaw (sin login)

`setup-podman.sh` crea un usuario de sistema dedicado `openclaw`:

- **Shell:** `nologin` — sin login interactivo; reduce superficie de ataque.
- **Home:** ej. `/home/openclaw` — contiene `~/.openclaw` (configuración, workspace) y el script de lanzamiento `run-openclaw-podman.sh`.
- **Podman Rootless:** El usuario debe tener un rango **subuid** y **subgid**. Muchas distros asignan estos automáticamente cuando se crea el usuario. Si setup imprime una advertencia, agrega líneas a `/etc/subuid` y `/etc/subgid`:

  ```text
  openclaw:100000:65536
  ```

  Luego inicia el gateway como ese usuario (ej. desde cron o systemd):

  ```bash
  sudo -u openclaw /home/openclaw/run-openclaw-podman.sh
  sudo -u openclaw /home/openclaw/run-openclaw-podman.sh setup
  ```

- **Configuración:** Solo `openclaw` y root pueden acceder a `/home/openclaw/.openclaw`. Para editar configuración: usa la UI de Control una vez que el gateway esté ejecutándose, o `sudo -u openclaw $EDITOR /home/openclaw/.openclaw/openclaw.json`.

## Entorno y configuración

- **Token:** Almacenado en `~openclaw/.openclaw/.env` como `OPENCLAW_GATEWAY_TOKEN`. `setup-podman.sh` y `run-openclaw-podman.sh` lo generan si falta (usa `openssl`, `python3`, o `od`).
- **Opcional:** En ese `.env` puedes establecer claves de proveedores (ej. `GROQ_API_KEY`, `OLLAMA_API_KEY`) y otras variables de entorno de OpenClaw.
- **Puertos del host:** Por defecto el script mapea `18789` (gateway) y `18790` (bridge). Sobrescribe el mapeo de puerto del **host** con `OPENCLAW_PODMAN_GATEWAY_HOST_PORT` y `OPENCLAW_PODMAN_BRIDGE_HOST_PORT` al lanzar.
- **Rutas:** La configuración del host y workspace por defecto son `~openclaw/.openclaw` y `~openclaw/.openclaw/workspace`. Sobrescribe las rutas del host usadas por el script de lanzamiento con `OPENCLAW_CONFIG_DIR` y `OPENCLAW_WORKSPACE_DIR`.

## Comandos útiles

- **Logs:** Con quadlet: `sudo journalctl --machine openclaw@ --user -u openclaw.service -f`. Con script: `sudo -u openclaw podman logs -f openclaw`
- **Detener:** Con quadlet: `sudo systemctl --machine openclaw@ --user stop openclaw.service`. Con script: `sudo -u openclaw podman stop openclaw`
- **Iniciar de nuevo:** Con quadlet: `sudo systemctl --machine openclaw@ --user start openclaw.service`. Con script: vuelve a ejecutar el script de lanzamiento o `podman start openclaw`
- **Eliminar contenedor:** `sudo -u openclaw podman rm -f openclaw` — la configuración y workspace en el host se mantienen

## Resolución de problemas

- **Permission denied (EACCES) en config o auth-profiles:** El contenedor por defecto usa `--userns=keep-id` y se ejecuta con el mismo uid/gid que el usuario del host ejecutando el script. Asegúrate de que tu `OPENCLAW_CONFIG_DIR` y `OPENCLAW_WORKSPACE_DIR` del host sean propiedad de ese usuario.
- **Inicio de gateway bloqueado (falta `gateway.mode=local`):** Asegúrate de que `~openclaw/.openclaw/openclaw.json` exista y establezca `gateway.mode="local"`. `setup-podman.sh` crea este archivo si falta.
- **Podman rootless falla para el usuario openclaw:** Verifica que `/etc/subuid` y `/etc/subgid` contengan una línea para `openclaw` (ej. `openclaw:100000:65536`). Agrégala si falta y reinicia.
- **Nombre de contenedor en uso:** El script de lanzamiento usa `podman run --replace`, así que el contenedor existente se reemplaza cuando inicias de nuevo. Para limpiar manualmente: `podman rm -f openclaw`.
- **Script no encontrado al ejecutar como openclaw:** Asegúrate de que `setup-podman.sh` se ejecutó para que `run-openclaw-podman.sh` se copie al home de openclaw (ej. `/home/openclaw/run-openclaw-podman.sh`).
- **Servicio quadlet no encontrado o falla al iniciar:** Ejecuta `sudo systemctl --machine openclaw@ --user daemon-reload` después de editar el archivo `.container`. Quadlet requiere cgroups v2: `podman info --format '{{.Host.CgroupsVersion}}'` debería mostrar `2`.

## Opcional: ejecutar como tu propio usuario

Para ejecutar el gateway como tu usuario normal (sin usuario openclaw dedicado): construye la imagen, crea `~/.openclaw/.env` con `OPENCLAW_GATEWAY_TOKEN`, y ejecuta el contenedor con `--userns=keep-id` y montajes a tu `~/.openclaw`. El script de lanzamiento está diseñado para el flujo del usuario openclaw; para una configuración de usuario único puedes en su lugar ejecutar el comando `podman run` del script manualmente, apuntando configuración y workspace a tu home. Recomendado para la mayoría de usuarios: usa `setup-podman.sh` y ejecuta como el usuario openclaw para que la configuración y proceso estén aislados.
